import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { CONSOLE_ACTIVITY_DEFAULT_PAGE_SIZE, CONSOLE_ACTIVITY_MAX_PAGE_SIZE, ConsoleActivityStore } from './activity.js';
import { CONSOLE_OPERATION_RETENTION, CONSOLE_RESULT_EXPIRED, ConsoleCommandRunner, ConsoleRunnerBusyError, type ConsoleOperation } from './commandRunner.js';
import { ConsoleInputError, consoleCommand, parseConsoleCommandInput } from './commandCatalog.js';
import { consoleStateRoot, removeConsoleProcessState, writeConsoleProcessState } from './processState.js';
import { ConsoleSecurity, ConsoleSecurityError } from './security.js';

export interface DkbConsoleServerOptions {
  cliEntrypoint: string;
  bootstrapSecret: string;
  controlToken?: string;
  host?: '127.0.0.1';
  port?: number;
  cwd?: string;
  webRoot?: string;
}

export async function startDkbConsoleServer(options: DkbConsoleServerOptions): Promise<{ app: FastifyInstance; url: string; close(): Promise<void> }> {
  const host = options.host ?? '127.0.0.1';
  let port = options.port ?? 7338;
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, requestTimeout: 30_000, forceCloseConnections: true });
  await app.register(cookie);
  const webRoot = options.webRoot ?? fileURLToPath(new URL('../web', import.meta.url));
  let url = `http://${host}:${port}`;
  const controlToken = options.controlToken ?? randomBytes(32).toString('base64url');
  let security = new ConsoleSecurity({ bootstrapSecret: options.bootstrapSecret, port });
  let ready = false;
  const activity = new ConsoleActivityStore(path.join(consoleStateRoot(), 'activity.sqlite'));
  const runner = new ConsoleCommandRunner({ cliEntrypoint: path.resolve(options.cliEntrypoint), cwd: path.resolve(options.cwd ?? process.cwd()), activity });

  app.addHook('onRequest', async (request, reply) => {
    if (!ready) throw new ConsoleSecurityError(503, 'Console is starting. Retry shortly.');
    security.assertRequestBoundary(request);
    reply.headers({
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      'cache-control': 'no-store',
    });
  });
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/assets/') && reply.statusCode < 400) {
      reply.header('cache-control', 'public, max-age=31536000, immutable');
    }
    return payload;
  });

  // Resolve hashed Vite assets from disk at request time. Console builds may be
  // refreshed while the local server is running, so a startup-time file glob
  // would leave the new asset names unreachable until the server restarted.
  await app.register(fastifyStatic, { root: webRoot, wildcard: true });

  app.get('/healthz', async () => ({ status: 'ready', service: 'dkb-console', version: '0.1.0' }));
  app.post('/control/bootstrap', async (request) => {
    if (request.headers.authorization !== `Bearer ${controlToken}`) throw new ConsoleSecurityError(401, 'Invalid Console control credential.');
    return { secret: security.issueBootstrap() };
  });
  app.post('/shutdown', async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${controlToken}`) throw new ConsoleSecurityError(401, 'Invalid Console control credential.');
    await reply.send({ status: 'stopping' });
    setImmediate(() => void close());
  });
  app.post('/api/session/bootstrap', async (request, reply) => {
    const body = objectBody(request.body);
    const session = security.bootstrap(body.secret, reply);
    return { csrf: session.csrf, expiresAt: new Date(session.expiresAt).toISOString() };
  });
  app.get('/api/session', async (request) => {
    const session = security.session(request);
    return { csrf: session.csrf, expiresAt: new Date(session.expiresAt).toISOString() };
  });

  app.get('/api/v1/overview', async (request) => {
    security.session(request);
    const [libraries, runtimes, registries, stacks] = await Promise.all([
      runner.run('library.list', {}),
      runner.run('runtime.list', {}),
      runner.run('registry.list', {}),
      runner.run('stack.list', {}),
    ]);
    return { libraries: resultOf(libraries), runtimes: resultOf(runtimes), registries: resultOf(registries), stacks: resultOf(stacks) };
  });
  app.get<{ Params: { kind: string }; Querystring: { check?: string } }>('/api/v1/resources/:kind', async (request) => {
    security.session(request);
    const commandId = resourceCommand(request.params.kind);
    return resultOf(await runner.run(commandId, { check: request.query.check === '1' }));
  });
  app.get<{ Params: { name: string } }>('/api/v1/libraries/:name/packages', async (request) => {
    security.session(request);
    return resultOf(await runner.run('library.packages', { library: request.params.name }));
  });
  app.get<{ Params: { name: string } }>('/api/v1/libraries/:name/runtimes', async (request) => {
    security.session(request);
    const listing = resultOf(await runner.run('runtime.list', {}));
    const runtimes = records(listing, 'runtimes').filter((runtime) => runtime.library === request.params.name);
    return {
      runtimes: await Promise.all(runtimes.map(async (runtime) => {
        try {
          return { ...runtime, runtime: resultOf(await runner.run('runtime.show', { runtime: runtime.name })) };
        } catch (error) {
          return { ...runtime, status: 'offline', message: errorMessage(error) };
        }
      })),
    };
  });
  app.get<{ Params: { name: string } }>('/api/v1/runtimes/:name', async (request) => {
    security.session(request);
    const listing = records(resultOf(await runner.run('runtime.list', {})), 'runtimes');
    const inventory = listing.find((runtime) => runtime.name === request.params.name);
    if (!inventory) throw new ConsoleInputError(`Unknown host Runtime: ${request.params.name}.`);
    return { inventory, runtime: resultOf(await runner.run('runtime.show', { runtime: request.params.name })) };
  });
  app.get<{ Params: { name: string } }>('/api/v1/runtimes/:name/pipelines', async (request) => {
    security.session(request);
    return resultOf(await runner.run('pipeline.list', { runtime: request.params.name }));
  });
  app.get<{ Params: { name: string }; Querystring: { limit?: string } }>('/api/v1/runtimes/:name/audit', async (request) => {
    security.session(request);
    return resultOf(await runner.run('runtime.audit.list', {
      runtime: request.params.name,
      limit: request.query.limit ? Number(request.query.limit) : 100,
    }));
  });
  app.get<{ Params: { registry: string } }>('/api/v1/registries/:registry', async (request) => {
    security.session(request);
    const context = await registryContext(runner, request.params.registry);
    return context;
  });
  app.get<{ Params: { registry: string } }>('/api/v1/registries/:registry/pipelines', async (request) => {
    security.session(request);
    const context = await registryContext(runner, request.params.registry);
    return resultOf(await runner.run('registry.pipeline.list', { url: context.registry.url }));
  });
  app.get<{
    Params: { registry: string };
    Querystring: { q?: string; type?: string; page?: string; perPage?: string };
  }>('/api/v1/registries/:registry/catalog', async (request) => {
    security.session(request);
    const context = await registryContext(runner, request.params.registry);
    return resultOf(await runner.run('registry.catalog', {
      url: context.registry.url,
      ...(request.query.q ? { query: request.query.q } : {}),
      type: request.query.type ?? 'all',
      page: request.query.page ? Number(request.query.page) : 1,
      perPage: request.query.perPage ? Number(request.query.perPage) : 20,
    }));
  });
  app.get<{
    Params: { registry: string; kind: string; namespace: string; name: string };
    Querystring: { version?: string; revision?: string };
  }>('/api/v1/registries/:registry/:kind/:namespace/:name', async (request) => {
    security.session(request);
    assertRegistryEntryKind(request.params.kind);
    const context = await registryContext(runner, request.params.registry);
    return resultOf(await runner.run('registry.entry', {
      url: context.registry.url,
      identity: installedEntryIdentity(request.params.namespace, request.params.name),
      ...(request.query.version ? { version: request.query.version } : {}),
      ...(request.query.revision ? { revision: Number(request.query.revision) } : {}),
    }));
  });
  app.get<{
    Params: { registry: string; namespace: string; name: string };
    Querystring: { version?: string; path?: string; cursor?: string; limit?: string };
  }>('/api/v1/registries/:registry/dkbs/:namespace/:name/contents', async (request) => {
    security.session(request);
    if (!request.query.version) throw new ConsoleInputError('An exact DKB version is required for remote Contents.');
    const context = await registryContext(runner, request.params.registry);
    return resultOf(await runner.run('registry.contents', {
      url: context.registry.url,
      identity: installedEntryIdentity(request.params.namespace, request.params.name),
      version: request.query.version,
      path: request.query.path ?? '.',
      ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
      ...(request.query.limit ? { limit: Number(request.query.limit) } : {}),
    }));
  });
  app.get<{
    Params: { library: string; namespace: string; name: string };
    Querystring: { path?: string; cursor?: string; limit?: string };
  }>('/api/v1/libraries/:library/entries/:namespace/:name/contents', async (request) => {
    security.session(request);
    return resultOf(await runner.run('package.contents', {
      library: request.params.library,
      identity: installedEntryIdentity(request.params.namespace, request.params.name),
      directory: request.query.path ?? '.',
      ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
      ...(request.query.limit ? { limit: Number(request.query.limit) } : {}),
    }));
  });
  app.get<{
    Params: { library: string; namespace: string; name: string };
    Querystring: { path?: string };
  }>('/api/v1/libraries/:library/entries/:namespace/:name/preview', async (request) => {
    security.session(request);
    if (!request.query.path) throw new ConsoleInputError('Package preview path is required.');
    return resultOf(await runner.run('package.preview', {
      library: request.params.library,
      identity: installedEntryIdentity(request.params.namespace, request.params.name),
      file: request.query.path,
    }));
  });
  app.get<{
    Params: { library: string; namespace: string; name: string };
    Querystring: { version?: string; evidenceDigest?: string; evidenceId?: string };
  }>('/api/v1/libraries/:library/entries/:namespace/:name/evidence', async (request) => {
    security.session(request);
    return resultOf(await runner.run('package.evidence', {
      library: request.params.library, identity: installedEntryIdentity(request.params.namespace, request.params.name),
      version: request.query.version, evidenceDigest: request.query.evidenceDigest, evidenceId: request.query.evidenceId,
    }));
  });
  app.get<{ Params: { library: string; namespace: string; name: string } }>('/api/v1/libraries/:library/entries/:namespace/:name', async (request) => {
    security.session(request);
    return resultOf(await runner.run('package.show', {
      library: request.params.library,
      identity: installedEntryIdentity(request.params.namespace, request.params.name),
    }));
  });
  app.get<{ Querystring: { page?: string; perPage?: string } }>('/api/v1/activity', async (request) => {
    security.session(request);
    const page = queryInteger(request.query.page, 1, Number.MAX_SAFE_INTEGER, 'Activity page');
    const perPage = queryInteger(request.query.perPage, CONSOLE_ACTIVITY_DEFAULT_PAGE_SIZE, CONSOLE_ACTIVITY_MAX_PAGE_SIZE, 'Activity page size');
    return activity.list(page, perPage);
  });
  app.post('/api/v1/operations', async (request, reply) => {
    security.assertMutation(request);
    const body = objectBody(request.body);
    if (typeof body.commandId !== 'string') throw new ConsoleInputError('commandId is required.');
    const input = parseConsoleCommandInput(consoleCommand(body.commandId), body.input);
    const operation = runner.start(body.commandId, input);
    return reply.code(202).send({ operationId: operation.id, status: operation.status });
  });
  app.get<{ Params: { id: string } }>('/api/v1/operations/:id', async (request, reply) => {
    security.session(request);
    const operation = runner.get(request.params.id);
    if (!operation) return reply.code(404).send({ error: CONSOLE_RESULT_EXPIRED });
    return operation;
  });
  app.post<{ Params: { id: string } }>('/api/v1/operations/:id/cancel', async (request, reply) => {
    security.assertMutation(request);
    const cancelling = runner.cancel(request.params.id);
    return reply.code(cancelling ? 202 : 409).send({ status: cancelling ? 'cancelling' : 'not_running' });
  });
  app.get<{ Params: { id: string } }>('/api/v1/operations/:id/events', async (request, reply) => {
    security.session(request);
    const operation = runner.get(request.params.id);
    if (!operation) return reply.code(404).send({ error: CONSOLE_RESULT_EXPIRED });
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let unsubscribe = () => undefined as void;
    let keepAlive: NodeJS.Timeout | undefined;
    const cleanup = () => { unsubscribe(); clearInterval(keepAlive); };
    reply.raw.once('close', cleanup);
    reply.raw.once('error', cleanup);
    reply.raw.setTimeout(30_000, () => reply.raw.destroy());
    const write = (data: string) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      // A slow reader must not create an unbounded Node socket write queue.
      // Disconnecting this subscription never cancels or retries the command.
      if (reply.raw.writableLength + Buffer.byteLength(data) > CONSOLE_OPERATION_RETENTION.replayBytes) {
        cleanup();
        reply.raw.destroy();
        return;
      }
      reply.raw.write(data);
    };
    const send = (event: unknown) => write(`data: ${JSON.stringify(event)}\n\n`);
    for (const event of operation.events) send(event);
    if (reply.raw.destroyed) return;
    if (['succeeded', 'failed', 'cancelled'].includes(operation.status)) return reply.raw.end();
    unsubscribe = runner.subscribe(operation.id, (event) => {
      send(event);
      if (event.event === 'completion') { cleanup(); reply.raw.end(); }
    });
    keepAlive = setInterval(() => write(': keepalive\n\n'), 15_000);
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.method === 'GET' && request.headers.accept?.includes('text/html')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'Not found.' });
  });
  app.setErrorHandler(async (error, _request, reply) => {
    const statusCode = error instanceof ConsoleSecurityError
      ? error.statusCode
      : error instanceof ConsoleRunnerBusyError
        ? 503
        : error instanceof ConsoleInputError
        ? 400
        : error instanceof ConsoleCommandError
          ? 422
          : 500;
    return reply.code(statusCode).send({ error: statusCode === 500 ? 'Console operation failed.' : errorMessage(error) });
  });

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await runner.close();
    activity.close();
    await removeConsoleProcessState(process.pid);
    await app.close();
  };
  try {
    // Bind the real server: probing and releasing a port permits another Console
    // to claim it before startup. Explicit port requests never silently change.
    try { await app.listen({ host, port }); }
    catch (error) {
      if (options.port !== undefined || !error || typeof error !== 'object' || !('code' in error) || error.code !== 'EADDRINUSE') throw error;
      await app.listen({ host, port: 0 });
    }
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Console did not bind a loopback TCP address.');
    port = address.port;
    url = `http://${host}:${port}`;
    security = new ConsoleSecurity({ bootstrapSecret: options.bootstrapSecret, port });
    await writeConsoleProcessState({ format: 'dkb.console-process.v1', pid: process.pid, port, url, controlToken, startedAt: new Date().toISOString() });
    ready = true;
  } catch (error) {
    await runner.close();
    activity.close();
    await app.close();
    throw error;
  }
  return { app, url, close };
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConsoleInputError('Request body must be a JSON object.');
  return value as Record<string, unknown>;
}

function queryInteger(value: string | undefined, fallback: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/u.test(value)) throw new ConsoleInputError(`${label} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) throw new ConsoleInputError(`${label} must be between 1 and ${maximum}.`);
  return parsed;
}

function resourceCommand(kind: string): 'library.list' | 'runtime.list' | 'registry.list' | 'stack.list' {
  if (kind === 'libraries') return 'library.list';
  if (kind === 'runtimes') return 'runtime.list';
  if (kind === 'registries') return 'registry.list';
  if (kind === 'stacks') return 'stack.list';
  throw new ConsoleInputError(`Unknown resource kind: ${kind}.`);
}

function resultOf(operation: ConsoleOperation): unknown {
  if (operation.status === 'succeeded') return operation.result;
  const failure = [...operation.events].reverse().find((event) => event.event === 'failure');
  throw new ConsoleCommandError(failure && 'error' in failure ? String((failure.error as { message?: unknown }).message ?? 'CLI command failed.') : 'CLI command failed.');
}

class ConsoleCommandError extends Error {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function installedEntryIdentity(namespace: string, name: string): string {
  const normalizedNamespace = namespace.replace(/^@/u, '').toLowerCase();
  const normalizedName = name.toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(normalizedNamespace) || !/^[a-z0-9][a-z0-9._-]*$/u.test(normalizedName)) {
    throw new ConsoleInputError('Installed entry identity is invalid.');
  }
  return `@${normalizedNamespace}/${normalizedName}`;
}

function assertRegistryEntryKind(value: string): void {
  if (value !== 'dkbs' && value !== 'collections') throw new ConsoleInputError('Registry entry kind must be dkbs or collections.');
}

async function registryContext(runner: ConsoleCommandRunner, name: string): Promise<{
  registry: Record<string, unknown>;
  libraries: Record<string, unknown>[];
}> {
  const [registryListing, libraryListing] = await Promise.all([
    runner.run('registry.list', {}),
    runner.run('library.list', {}),
  ]);
  const registries = records(resultOf(registryListing), 'registries');
  const libraries = records(resultOf(libraryListing), 'libraries');
  const registry = registries.find((item) => item.name === name);
  if (!registry || typeof registry.url !== 'string') throw new ConsoleInputError(`Unknown host Registry: ${name}.`);
  return { registry, libraries: libraries.filter((library) => library.registry === name) };
}

function records(value: unknown, key: string): Record<string, unknown>[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const list = (value as Record<string, unknown>)[key];
  return Array.isArray(list) ? list.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
}
