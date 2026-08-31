import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import {
  defaultRuntimeStateRoot,
  ensureRuntimeState,
  importCompiledDkbArtifactIntoRuntime,
  runtimeLibrary,
  removeDkbFromRuntime,
  reloadRuntimeState,
  resolveRuntimeLibraryHandle,
  retrieveFromRuntime,
  runtimePublicStatus,
  runtimeStatus,
} from './state.js';
import type { DkbRetrieveKnowledgeRequest } from '../read/runtime.js';
import { attachRemoteSession, detachRemoteSession, listRemoteSessions, retrieveFromRemoteSession } from '../remote/sessions.js';
import { discoverRemoteDkb } from '../remote/discovery.js';
import { getTrace, latestTrace, listTraces } from './trace.js';
import { closeQueryAuditQueue } from './queryAudit.js';
import { resolveRegistryContext } from '@sjshovan/dkb-registry-client/config.js';
import { DKB_RUNTIME_VERSION } from '../version.js';
import { createDkbMcpHttpHandler, type DkbMcpHttpHandler } from '../mcp/http.js';
import { refreshRuntimeActivation, switchRuntimeLibrary, switchRuntimePipelineFromRegistry } from './pipelineSwitch.js';
import { withRuntimeMutation } from './mutation.js';
import { runtimePipelineCatalog } from './pipelineCatalog.js';
import { DEFAULT_DKB_RUNTIME_CONTEXT } from '../defaultComposition.js';
import type { DkbRuntimeContext } from './context.js';

export interface ServeRuntimeOptions {
  runtime?: DkbRuntimeContext;
  host?: string;
  port?: number;
  stateRoot?: string;
  libraryPath?: string;
  runtimeId?: string;
  target?: string;
  adminToken?: string;
}

export async function serveDkbRuntime(options: ServeRuntimeOptions = {}): Promise<http.Server> {
  const stateRoot = options.stateRoot ?? defaultRuntimeStateRoot();
  const host = options.host ?? process.env.DKB_RUNTIME_HOST ?? '127.0.0.1';
  const port = options.port ?? Number.parseInt(process.env.DKB_RUNTIME_PORT ?? '7331', 10);
  const adminToken = options.adminToken ?? process.env.DKB_RUNTIME_ADMIN_TOKEN;
  const runtime = options.runtime ?? DEFAULT_DKB_RUNTIME_CONTEXT;

  if (!adminToken && !isLoopbackHost(host)) {
    throw new DkbError(
      'DKB Runtime management routes require DKB_RUNTIME_ADMIN_TOKEN when listening beyond localhost.',
    );
  }

  const instance = await ensureRuntimeState(stateRoot, {
    ...(options.libraryPath ? { libraryRoot: options.libraryPath } : {}),
    ...(options.runtimeId ? { runtimeId: options.runtimeId } : {}),
    ...(options.target ? { target: options.target } : {}),
  });
  const mcp = process.env.DKB_MCP_HTTP_ENABLED === 'true'
      ? await createDkbMcpHttpHandler({
        runtime,
        host,
        stateRoot: instance.stateRoot,
      })
    : null;

  const server = http.createServer(async (request, response) => {
    try {
      if (mcp && await mcp.handle(request, response)) return;
      await routeRequest(request, response, stateRoot, runtime, adminToken);
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, 500, {
          error: 'runtime_http_error',
          message: error instanceof Error ? error.message : String(error),
        });
      } else {
        response.end();
      }
    }
  });
  installGracefulShutdown(server, mcp);

  await new Promise<void>((resolve) => {
    server.listen(port, host, resolve);
  });

  console.error(JSON.stringify({
    event: 'dkb.runtime.started',
    version: DKB_RUNTIME_VERSION,
    host,
    port,
    stateRoot,
    libraryPath: instance.libraryRoot,
    runtimeId: instance.runtimeId,
    target: instance.target,
  }));

  return server;
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  stateRoot: string,
  runtime: DkbRuntimeContext,
  adminToken?: string,
): Promise<void> {
  setCommonHeaders(response);

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();

    return;
  }

  try {
    const url = new URL(request.url ?? '/', 'http://dkb-runtime.local');
    const pathName = url.pathname;

    if (isManagementRoute(request.method, pathName) && !isAuthorized(request, adminToken)) {
      return sendJson(response, 401, {
        error: 'unauthorized',
        message: 'This DKB Runtime management route requires a valid admin bearer token.',
      });
    }

    if (request.method === 'GET' && (pathName === '/api/health' || pathName === '/health')) {
      return sendJson(response, 200, { ok: true, runtime: await runtimePublicStatus(stateRoot) });
    }

    if (request.method === 'GET' && pathName === '/.well-known/dkb.json') {
      return sendJson(response, 200, await runtimeDiscoveryDocument(stateRoot, request.headers.host));
    }

    if (request.method === 'GET' && pathName === '/api/runtime') {
      return sendJson(response, 200, await runtimePublicStatus(stateRoot));
    }

    if (request.method === 'GET' && pathName === '/api/runtime/pipelines') {
      const current = await ensureRuntimeState(stateRoot);
      return sendJson(response, 200, await runtimePipelineCatalog({
        distribution: runtime.distribution,
        root: current.stateRoot,
        libraryRoot: current.libraryRoot,
        activeTarget: current.target,
      }));
    }

    if (request.method === 'POST' && pathName === '/api/runtime/reload') {
      return sendJson(response, 200, await withRuntimeMutation(stateRoot, async () => {
        await refreshRuntimeActivation({ runtime, stateRoot });
        return reloadRuntimeState(stateRoot);
      }));
    }

    if (request.method === 'POST' && pathName === '/api/runtime/pipeline') {
      const body = await readJsonBody<{
        target: string;
        registryUrl?: string;
        grants?: Record<string, { build: unknown; installGrant: string }>;
      }>(request);

      const { validateRetrievalBuildGrant } = await import('@sjshovan/dkb-protocol/builds.js');
      const grants = Object.fromEntries(Object.entries(body.grants ?? {}).map(([identity, grant]) => [identity, {
        installGrant: requiredString(grant.installGrant, `grants.${identity}.installGrant`),
        build: validateRetrievalBuildGrant(grant.build, `Runtime pipeline grant for ${identity}`),
      }]));

      return sendJson(response, 200, await withRuntimeMutation(stateRoot, () => switchRuntimePipelineFromRegistry({
        runtime,
        stateRoot,
        target: requiredString(body.target, 'target'),
        ...(process.env.DKB_REGISTRY_URL || body.registryUrl ? { registryUrl: process.env.DKB_REGISTRY_URL ?? body.registryUrl } : {}),
        grants,
      })));
    }

    if (request.method === 'GET' && pathName === '/api/library') {
      return sendJson(response, 200, await runtimeLibrary(stateRoot));
    }

    if (request.method === 'POST' && pathName === '/api/runtime/library') {
      const body = await readJsonBody<{ libraryPath?: string; libraryHandle?: string; target?: string }>(request);
      if (Boolean(body.libraryPath) === Boolean(body.libraryHandle)) {
        throw new DkbError('Choose exactly one Runtime-local libraryPath or libraryHandle.');
      }
      const libraryRoot = body.libraryPath
        ? requiredString(body.libraryPath, 'libraryPath')
        : await resolveRuntimeLibraryHandle(requiredString(body.libraryHandle, 'libraryHandle'));
      return sendJson(response, 200, await withRuntimeMutation(stateRoot, () => switchRuntimeLibrary({
        runtime,
        stateRoot,
        libraryRoot,
        ...(body.libraryHandle ? { libraryBinding: { kind: 'remote' as const, handle: body.libraryHandle } } : {}),
        ...(body.target ? { target: body.target } : {}),
      })));
    }

    if (request.method === 'POST' && pathName === '/api/dkbs/import-artifact') {
      const body = await readJsonBody<{
        sourcePath: string;
        id?: string;
        force?: boolean;
      }>(request);

      return sendJson(response, 201, await withRuntimeMutation(stateRoot, () => importCompiledDkbArtifactIntoRuntime({ runtime, ...body }, stateRoot)));
    }

    if (request.method === 'POST' && pathName === '/api/dkbs/install-registry') {
      const body = await readJsonBody<{
        registryUrl: string;
        installGrant: string;
        plan: unknown;
        force?: boolean;
      }>(request);

      const [{ validateInstallPlan }, { installDkbFromRuntimeGrant }] = await Promise.all([
        import('@sjshovan/dkb-protocol/builds.js'),
        import('./registryInstall.js'),
      ]);

      return sendJson(response, 201, await withRuntimeMutation(stateRoot, () => installDkbFromRuntimeGrant({
        runtime,
        registryUrl: process.env.DKB_REGISTRY_URL ?? requiredString(body.registryUrl, 'registryUrl'),
        installGrant: requiredString(body.installGrant, 'installGrant'),
        plan: validateInstallPlan(body.plan, 'Runtime install plan'),
        force: body.force,
        runtimeRoot: stateRoot,
      })));
    }

    const dkbMatch = pathName.match(/^\/api\/dkbs\/([^/]+)$/);

    if (dkbMatch && request.method === 'DELETE') {
      return sendJson(response, 200, await withRuntimeMutation(stateRoot, () => removeDkbFromRuntime(decodeURIComponent(dkbMatch[1]!), stateRoot, { runtime })));
    }

    if (request.method === 'POST' && pathName === '/api/retrieve') {
      const body = await readJsonBody<DkbRetrieveKnowledgeRequest>(request);

      return sendJson(response, 200, await retrieveFromRuntime(body, stateRoot, runtime));
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
    const status = error instanceof DkbError ? (error.code === 'runtime_refresh_required' ? 409 : 400) : 500;
    const message = error instanceof Error ? error.message : String(error);

    return sendJson(response, status, {
      error: error instanceof DkbError ? error.code : 'runtime_error',
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
  const registry = await resolveRegistryContext({ root: runtime.libraryPath });
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

function isManagementRoute(method: string | undefined, pathName: string): boolean {
  if (method === 'GET' && pathName === '/api/runtime/pipelines') return true;
  if (pathName === '/api/runtime/reload' || pathName === '/api/runtime/pipeline' || pathName === '/api/runtime/library' || pathName === '/api/dkbs/import-artifact' || pathName === '/api/dkbs/install-registry') return true;
  if (method === 'DELETE' && pathName.startsWith('/api/dkbs/')) return true;
  if (pathName.startsWith('/api/traces')) return true;
  if (pathName.startsWith('/api/remote/')) return true;

  return false;
}

function isAuthorized(request: IncomingMessage, adminToken?: string): boolean {
  if (!adminToken) return true;
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(authorization.slice('Bearer '.length), 'utf8');
  const expected = Buffer.from(adminToken, 'utf8');

  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function installGracefulShutdown(server: http.Server, mcp: DkbMcpHttpHandler | null): void {
  const close = server.close.bind(server);

  server.close = ((callback?: (error?: Error) => void) => close(async (error?: Error) => {
    try {
      await closeQueryAuditQueue();
      await mcp?.close();
      callback?.(error);
    } catch (auditError) {
      callback?.(auditError instanceof Error ? auditError : new Error(String(auditError)));
    }
  })) as typeof server.close;
}
