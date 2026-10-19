import http, { type IncomingMessage, type ServerResponse } from 'node:http';
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
import { getTrace, latestTrace, listTraces } from './trace.js';
import { closeQueryAuditQueue, listQueryAudit } from './queryAudit.js';
import { readLibraryState } from '@sjshovan/dkb-library/state.js';
import { DKB_RUNTIME_VERSION } from '../version.js';
import { createDkbMcpHttpHandler, type DkbMcpHttpHandler } from '../mcp/http.js';
import { refreshRuntimeActivation, switchRuntimeLibrary, switchRuntimePipelineFromRegistry } from './pipelineSwitch.js';
import { withRuntimeMutation } from './mutation.js';
import { inspectRuntimePipelines, validateRuntimePipelinePreparation } from './pipelinePreparation.js';
import { DEFAULT_DKB_RUNTIME_CONTEXT } from '../defaultComposition.js';
import type { DkbRuntimeContext } from './context.js';
import { runtimeClientForRequest, withRuntimeClient } from './clientContext.js';
import { describeRuntimeTargets, readRuntime, searchRuntime } from './queryAccess.js';
import type { DkbReadRequest } from '@sjshovan/dkb-protocol/types.js';
import { RuntimeHttpSecurity, type RuntimeHttpReadAccess } from './runtimeHttpSecurity.js';

export interface ServeRuntimeOptions {
  runtime?: DkbRuntimeContext;
  host?: string;
  port?: number;
  stateRoot?: string;
  libraryPath?: string;
  runtimeId?: string;
  target?: string;
  adminToken?: string;
  readToken?: string;
  readAccess?: RuntimeHttpReadAccess;
  allowedHosts?: string[];
  allowedOrigins?: string[];
}

export async function serveDkbRuntime(options: ServeRuntimeOptions = {}): Promise<http.Server> {
  const stateRoot = options.stateRoot ?? defaultRuntimeStateRoot();
  const host = options.host ?? process.env.DKB_RUNTIME_HOST ?? '127.0.0.1';
  const port = options.port ?? Number.parseInt(process.env.DKB_RUNTIME_PORT ?? '7331', 10);
  const runtime = options.runtime ?? DEFAULT_DKB_RUNTIME_CONTEXT;
  const security = new RuntimeHttpSecurity({ ...options, host });

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
    await withRuntimeClient(runtimeClientForRequest(request), async () => {
      try {
        if (mcp && await mcp.handle(request, response)) return;
        await routeRequest(request, response, stateRoot, runtime, security);
      } catch (error) {
        if (!response.headersSent) {
          sendJson(response, 500, {
            error: 'runtime_http_error',
            message: security.errorMessage(error, request),
          });
        } else {
          response.end();
        }
      }
    });
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
  security: RuntimeHttpSecurity,
): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', 'http://dkb-runtime.local');
    const pathName = url.pathname;

    if (!security.authorize(request, response, pathName)) return;

    if (request.method === 'GET' && (pathName === '/api/health' || pathName === '/health')) {
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === 'GET' && pathName === '/.well-known/dkb.json') {
      return sendJson(response, 200, await runtimeDiscoveryDocument(stateRoot, request.headers.host));
    }

    if (request.method === 'GET' && pathName === '/api/runtime') {
      return sendJson(response, 200, await runtimePublicStatus(stateRoot));
    }

    if (request.method === 'GET' && pathName === '/api/runtime/pipelines') {
      return sendJson(response, 200, await inspectRuntimePipelines(stateRoot, runtime));
    }

    if (request.method === 'GET' && pathName === '/api/runtime/audit') {
      const requested = Number(url.searchParams.get('limit') ?? 100);
      if (!Number.isInteger(requested) || requested < 1 || requested > 100) {
        throw new DkbError('Runtime audit limit must be an integer between 1 and 100.');
      }
      return sendJson(response, 200, { events: await listQueryAudit(stateRoot, requested), limit: requested });
    }

    if (request.method === 'POST' && pathName === '/api/runtime/reload') {
      return sendJson(response, 200, await withRuntimeMutation(stateRoot, async () => {
        const refreshed = await refreshRuntimeActivation({ runtime, stateRoot });
        return { ...await reloadRuntimeState(stateRoot), indexCleanup: refreshed.indexCleanup,
          ...(refreshed.warning ? { warning: refreshed.warning } : {}) };
      }));
    }

    if (request.method === 'POST' && pathName === '/api/runtime/pipeline') {
      const body = await readJsonBody<{
        target: string;
        registryUrl?: string;
        grants?: Record<string, { plan: unknown; installGrant: string; registryTransportUrl?: string }>;
        expected?: unknown;
      }>(request);

      const { validateInstallPlan } = await import('@sjshovan/dkb-protocol/builds.js');
      const grants = Object.fromEntries(Object.entries(body.grants ?? {}).map(([identity, grant]) => [identity, {
        installGrant: requiredString(grant.installGrant, `grants.${identity}.installGrant`),
        plan: validateInstallPlan(grant.plan, `Runtime pipeline install plan for ${identity}`),
        ...(grant.registryTransportUrl !== undefined ? { registryTransportUrl: requiredString(grant.registryTransportUrl, 'registryTransportUrl') } : {}),
      }]));

      return sendJson(response, 200, await withRuntimeMutation(stateRoot, () => switchRuntimePipelineFromRegistry({
        runtime,
        stateRoot,
        target: requiredString(body.target, 'target'),
        ...(body.registryUrl ? { registryUrl: body.registryUrl } : {}),
        ...(body.expected !== undefined ? { expected: validateRuntimePipelinePreparation(body.expected) } : {}),
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
        registryUrl: requiredString(body.registryUrl, 'registryUrl'),
        ...(process.env.DKB_REGISTRY_URL ? { registryTransportUrl: process.env.DKB_REGISTRY_URL } : {}),
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

    if (request.method === 'POST' && pathName === '/api/search') {
      const body = await readJsonBody<{ query: string; limit?: number; dkbId?: string }>(request);
      return sendJson(response, 200, await searchRuntime({
        stateRoot,
        runtime,
        channel: 'runtime-http',
        query: requiredString(body.query, 'query'),
        limit: body.limit,
        ...(body.dkbId ? { scope: { dkbId: requiredString(body.dkbId, 'dkbId') } } : {}),
      }));
    }

    if (request.method === 'POST' && pathName === '/api/read-targets') {
      const body = await readJsonBody<{ query: string; limit?: number }>(request);
      return sendJson(response, 200, await describeRuntimeTargets({
        stateRoot,
        runtime,
        channel: 'runtime-http',
        query: requiredString(body.query, 'query'),
        limit: body.limit,
      }));
    }

    if (request.method === 'POST' && pathName === '/api/read') {
      const body = await readJsonBody<DkbReadRequest>(request);
      return sendJson(response, 200, await readRuntime({ stateRoot, runtime, channel: 'runtime-http', request: body }));
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

    return sendJson(response, 404, { error: 'not_found', message: 'Unknown DKB Runtime route.' });
  } catch (error) {
    const status = error instanceof DkbError
      ? (['runtime_refresh_required', 'runtime_pipeline_conflict', 'library_recovery_required', 'library_busy'].includes(error.code) ? 409 : 400)
      : 500;
    const message = security.errorMessage(error, request);

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
  const libraryState = await readLibraryState(runtime.libraryPath);
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
    packages: packages.map((item) => {
      const id = String(item.id ?? item.packageId ?? '');
      const version = typeof item.version === 'string' ? item.version : undefined;
      const packageTreeHash = typeof item.packageTreeHash === 'string' ? item.packageTreeHash : undefined;
      const entry = libraryState.entries[id];
      const installable = entry?.kind === 'dkb'
        && entry.status === 'installed'
        && entry.source === 'registry'
        && typeof entry.registryUrl === 'string'
        && entry.version === version
        && entry.digest === packageTreeHash;
      return {
        id,
        ...(version ? { version } : {}),
        ...(packageTreeHash ? { packageTreeHash } : {}),
        ...(installable
          ? {
              install: {
                registryUrl: entry.registryUrl,
                packageId: id,
                version,
                packageTreeHash,
              },
            }
          : {}),
      };
    }),
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

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new DkbError('Runtime request body must contain valid JSON.', 'runtime_request_invalid');
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body, null, 2));
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
