import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ConsoleActivityStore } from './activity.js';
import { ConsoleCommandRunner, type ConsoleOperation } from './commandRunner.js';
import { ConsoleInputError } from './commandCatalog.js';
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
  const port = options.port ?? await availableLoopbackPort(7338);
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, requestTimeout: 30_000 });
  await app.register(cookie);
  const webRoot = options.webRoot ?? fileURLToPath(new URL('../web', import.meta.url));
  const url = `http://${host}:${port}`;
  const controlToken = options.controlToken ?? randomBytes(32).toString('base64url');
  const security = new ConsoleSecurity({ bootstrapSecret: options.bootstrapSecret, port });
  const activity = new ConsoleActivityStore(path.join(consoleStateRoot(), 'activity.sqlite'));
  const runner = new ConsoleCommandRunner({ cliEntrypoint: path.resolve(options.cliEntrypoint), cwd: path.resolve(options.cwd ?? process.cwd()), activity });

  app.addHook('onRequest', async (request, reply) => {
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

  await app.register(fastifyStatic, { root: webRoot, wildcard: false });

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
  app.get<{ Params: { library: string; namespace: string; name: string } }>('/api/v1/libraries/:library/entries/:namespace/:name', async (request) => {
    security.session(request);
    return resultOf(await runner.run('package.show', {
      library: request.params.library,
      identity: installedEntryIdentity(request.params.namespace, request.params.name),
    }));
  });
  app.get('/api/v1/activity', async (request) => {
    security.session(request);
    return { activities: activity.list() };
  });
  app.post('/api/v1/operations', async (request, reply) => {
    security.assertMutation(request);
    const body = objectBody(request.body);
    if (typeof body.commandId !== 'string') throw new ConsoleInputError('commandId is required.');
    const operation = runner.start(body.commandId, body.input);
    return reply.code(202).send({ operationId: operation.id, status: operation.status });
  });
  app.get<{ Params: { id: string } }>('/api/v1/operations/:id', async (request, reply) => {
    security.session(request);
    const operation = runner.get(request.params.id);
    if (!operation) return reply.code(404).send({ error: 'Operation not found.' });
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
    if (!operation) return reply.code(404).send({ error: 'Operation not found.' });
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (event: unknown) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    for (const event of operation.events) send(event);
    if (['succeeded', 'failed', 'cancelled'].includes(operation.status)) return reply.raw.end();
    const unsubscribe = runner.subscribe(operation.id, (event) => {
      send(event);
      if (event.event === 'completion') { unsubscribe(); clearInterval(keepAlive); reply.raw.end(); }
    });
    const keepAlive = setInterval(() => reply.raw.write(': keepalive\n\n'), 15_000);
    request.raw.once('close', () => { unsubscribe(); clearInterval(keepAlive); });
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.method === 'GET' && request.headers.accept?.includes('text/html')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'Not found.' });
  });
  app.setErrorHandler(async (error, _request, reply) => {
    const statusCode = error instanceof ConsoleSecurityError ? error.statusCode : error instanceof ConsoleInputError ? 400 : 500;
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
  await app.listen({ host, port });
  await writeConsoleProcessState({ format: 'dkb.console-process.v1', pid: process.pid, port, url, controlToken, startedAt: new Date().toISOString() });
  return { app, url, close };
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConsoleInputError('Request body must be a JSON object.');
  return value as Record<string, unknown>;
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
  throw new Error(failure && 'error' in failure ? String((failure.error as { message?: unknown }).message ?? 'CLI command failed.') : 'CLI command failed.');
}

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

async function availableLoopbackPort(preferred: number): Promise<number> {
  for (const candidate of [preferred, 0]) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(candidate, '127.0.0.1', () => {
        const address = server.address();
        const resolved = address && typeof address !== 'string' ? address.port : 0;
        server.close((error) => error ? reject(error) : resolve(resolved));
      });
    }).catch(() => 0);
    if (port > 0) return port;
  }
  throw new Error('No loopback port is available for DKB Console.');
}
