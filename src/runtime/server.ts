import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { watchComposeProject } from '../watch/index.js';
import { DkbError } from '../protocol/errors.js';
import {
  compileRuntimeDkb,
  defaultRuntimeStateRoot,
  ensureRuntimeState,
  importCompiledDkbArtifactIntoRuntime,
  importDkbIntoRuntime,
  listRuntimeRegistries,
  removeDkbFromRuntime,
  retrieveFromRuntime,
  runtimeStatus,
} from './state.js';
import type { DkbRetrieveKnowledgeRequest } from '../read/runtime.js';
import { attachRemoteSession, detachRemoteSession, listRemoteSessions, retrieveFromRemoteSession } from '../remote/sessions.js';
import { discoverRemoteDkb } from '../remote/discovery.js';
import { getTrace, latestTrace, listTraces } from './trace.js';
import { closeQueryAuditQueue } from './queryAudit.js';
import { configuredRegistry } from '../registry/config.js';

export interface ServeRuntimeOptions {
  host?: string;
  port?: number;
  stateRoot?: string;
}

interface RuntimeWatch {
  close(): Promise<void>;
}

const watchers = new Map<string, RuntimeWatch>();

export async function serveDkbRuntime(options: ServeRuntimeOptions = {}): Promise<http.Server> {
  const stateRoot = options.stateRoot ?? defaultRuntimeStateRoot();
  const host = options.host ?? process.env.DKB_RUNTIME_HOST ?? '127.0.0.1';
  const port = options.port ?? Number.parseInt(process.env.DKB_RUNTIME_PORT ?? '7331', 10);

  await ensureRuntimeState(stateRoot);

  const server = http.createServer(async (request, response) => {
    await routeRequest(request, response, stateRoot);
  });
  installGracefulAuditDrain(server);

  await new Promise<void>((resolve) => {
    server.listen(port, host, resolve);
  });

  console.error(JSON.stringify({
    event: 'dkb.runtime.started',
    host,
    port,
    stateRoot,
  }));

  return server;
}

async function routeRequest(request: IncomingMessage, response: ServerResponse, stateRoot: string): Promise<void> {
  setCommonHeaders(response);

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();

    return;
  }

  try {
    const url = new URL(request.url ?? '/', 'http://dkb-runtime.local');
    const pathName = url.pathname;

    if (request.method === 'GET' && (pathName === '/api/health' || pathName === '/health')) {
      return sendJson(response, 200, { ok: true, runtime: await runtimeStatus(stateRoot) });
    }

    if (request.method === 'GET' && pathName === '/.well-known/dkb.json') {
      return sendJson(response, 200, await runtimeDiscoveryDocument(stateRoot, request.headers.host));
    }

    if (request.method === 'GET' && pathName === '/api/runtime') {
      return sendJson(response, 200, await runtimeStatus(stateRoot));
    }

    if (request.method === 'GET' && pathName === '/api/registries') {
      return sendJson(response, 200, await listRuntimeRegistries(stateRoot));
    }

    if (request.method === 'POST' && pathName === '/api/registries') {
      await ensureRuntimeState(stateRoot);

      return sendJson(response, 201, await listRuntimeRegistries(stateRoot));
    }

    if (request.method === 'POST' && pathName === '/api/dkbs/import') {
      const body = await readJsonBody<{
        sourcePath: string;
        id?: string;
        name?: string;
        force?: boolean;
        compile?: boolean;
      }>(request);

      return sendJson(response, 201, await importDkbIntoRuntime(body, stateRoot));
    }

    if (request.method === 'POST' && pathName === '/api/dkbs/import-artifact') {
      const body = await readJsonBody<{
        sourcePath: string;
        id?: string;
        force?: boolean;
      }>(request);

      return sendJson(response, 201, await importCompiledDkbArtifactIntoRuntime(body, stateRoot));
    }

    const dkbMatch = pathName.match(/^\/api\/dkbs\/([^/]+)(?:\/(compile))?$/);

    if (dkbMatch && request.method === 'DELETE' && !dkbMatch[2]) {
      return sendJson(response, 200, await removeDkbFromRuntime(decodeURIComponent(dkbMatch[1]!), stateRoot));
    }

    if (dkbMatch && request.method === 'POST' && dkbMatch[2] === 'compile') {
      return sendJson(response, 200, await compileRuntimeDkb(decodeURIComponent(dkbMatch[1]!), stateRoot));
    }

    if (request.method === 'POST' && pathName === '/api/compile') {
      return sendJson(response, 200, await compileRuntimeDkb(undefined, stateRoot));
    }

    if (request.method === 'POST' && pathName === '/api/watch/start') {
      return sendJson(response, 200, await startRuntimeWatch(stateRoot));
    }

    if (request.method === 'POST' && pathName === '/api/watch/stop') {
      return sendJson(response, 200, await stopRuntimeWatch(stateRoot));
    }

    if (request.method === 'POST' && pathName === '/api/retrieve') {
      const body = await readJsonBody<DkbRetrieveKnowledgeRequest>(request);

      return sendJson(response, 200, await retrieveFromRuntime(body, stateRoot));
    }

    if (request.method === 'GET' && pathName === '/api/traces/latest') {
      return sendJson(response, 200, await latestTrace(stateRoot));
    }

    if (request.method === 'GET' && pathName === '/api/traces') {
      return sendJson(response, 200, await listTraces(stateRoot, parseLimit(url.searchParams.get('limit'), 20)));
    }

    const traceMatch = pathName.match(/^\/api\/traces\/([^/]+)$/);

    if (request.method === 'GET' && traceMatch) {
      return sendJson(response, 200, await getTrace(stateRoot, decodeURIComponent(traceMatch[1]!)));
    }

    if (request.method === 'POST' && pathName === '/api/remote/discover') {
      const body = await readJsonBody<{ url: string }>(request);

      return sendJson(response, 200, await discoverRemoteDkb(requiredString(body.url, 'url')));
    }

    if (request.method === 'POST' && pathName === '/api/remote/session/attach') {
      const body = await readJsonBody<{ url: string; ttlSeconds?: number }>(request);

      return sendJson(response, 201, await attachRemoteSession({
        url: requiredString(body.url, 'url'),
        ttlSeconds: body.ttlSeconds,
      }));
    }

    if (request.method === 'GET' && pathName === '/api/remote/sessions') {
      return sendJson(response, 200, { sessions: listRemoteSessions() });
    }

    const remoteSessionMatch = pathName.match(/^\/api\/remote\/session\/([^/]+)(?:\/(retrieve))?$/);

    if (remoteSessionMatch && request.method === 'DELETE' && !remoteSessionMatch[2]) {
      return sendJson(response, 200, detachRemoteSession(decodeURIComponent(remoteSessionMatch[1]!)));
    }

    if (remoteSessionMatch && request.method === 'POST' && remoteSessionMatch[2] === 'retrieve') {
      const body = await readJsonBody<DkbRetrieveKnowledgeRequest>(request);

      return sendJson(response, 200, await retrieveFromRemoteSession(decodeURIComponent(remoteSessionMatch[1]!), body));
    }

    return sendJson(response, 404, { error: 'not_found', message: `Unknown DKB Runtime route: ${request.method} ${pathName}` });
  } catch (error) {
    const status = error instanceof DkbError ? 400 : 500;
    const message = error instanceof Error ? error.message : String(error);

    return sendJson(response, status, {
      error: status === 400 ? 'bad_request' : 'runtime_error',
      message,
    });
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DkbError(`Runtime request requires ${label}.`);
  }

  return value;
}

async function runtimeDiscoveryDocument(stateRoot: string, requestHost?: string) {
  const runtime = await runtimeStatus(stateRoot);
  const registry = await configuredRegistry({ root: stateRoot });
  const registryUrl = registry.source === 'default' ? undefined : registry.url;
  const site = process.env.DKB_PUBLIC_URL
    ?? (requestHost ? 'http://' + requestHost : 'http://127.0.0.1:' + (process.env.DKB_RUNTIME_PORT ?? '7331'));
  const packages = Array.isArray((runtime as { packages?: unknown }).packages)
    ? (runtime as { packages: Array<Record<string, unknown>> }).packages
    : [];

  return {
    version: '0.2',
    type: 'dkb-discovery',
    site,
    publisher: process.env.DKB_PUBLISHER_NAME ? {
      name: process.env.DKB_PUBLISHER_NAME,
      ...(process.env.DKB_PUBLISHER_URL ? { url: process.env.DKB_PUBLISHER_URL } : {}),
    } : undefined,
    endpoints: [{
      type: 'dkb-runtime-http',
      url: site,
      access: 'public-read',
    }],
    packages: packages.map((item) => ({
      id: String(item.id ?? item.packageId ?? ''),
      version: typeof item.version === 'string' ? item.version : undefined,
      ...(typeof item.packageTreeHash === 'string' ? { packageTreeHash: item.packageTreeHash } : {}),
      ...(registryUrl && typeof item.id === 'string' && typeof item.version === 'string' && typeof item.packageTreeHash === 'string'
        ? {
            install: {
              registryUrl,
              packageId: item.id,
              version: item.version,
              packageTreeHash: item.packageTreeHash,
            },
          }
        : {}),
    })),
    policy: {
      scrape: 'disallow',
      ttlSeconds: 300,
    },
  };
}

function parseLimit(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : fallback;
}

async function startRuntimeWatch(stateRoot: string) {
  if (watchers.has(stateRoot)) {
    return {
      status: 'already_running',
      stateRoot,
    };
  }

  const watcher = await watchComposeProject(stateRoot, {
    onEvent: (event) => console.error(JSON.stringify({
      event: 'dkb.runtime.watch',
      detail: event,
    })),
  });

  watchers.set(stateRoot, watcher);

  return {
    status: 'started',
    stateRoot,
  };
}

async function stopRuntimeWatch(stateRoot: string) {
  const watcher = watchers.get(stateRoot);

  if (!watcher) {
    return {
      status: 'not_running',
      stateRoot,
    };
  }

  await watcher.close();
  watchers.delete(stateRoot);

  return {
    status: 'stopped',
    stateRoot,
  };
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString('utf8').trim();

  if (!body) {
    return {} as T;
  }

  return JSON.parse(body) as T;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body, null, 2));
}

function setCommonHeaders(response: ServerResponse): void {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type,authorization');
}

function installGracefulAuditDrain(server: http.Server): void {
  const close = server.close.bind(server);

  server.close = ((callback?: (error?: Error) => void) => close(async (error?: Error) => {
    try {
      await closeQueryAuditQueue();
      callback?.(error);
    } catch (auditError) {
      callback?.(auditError instanceof Error ? auditError : new Error(String(auditError)));
    }
  })) as typeof server.close;
}
