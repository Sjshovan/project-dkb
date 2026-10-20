import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { DEFAULT_DKB_DISTRIBUTION } from '@sjshovan/dkb-distribution-default';
import { DKB_COMPILER_VERSION } from './version.js';
import {
  compileRegistryPackage,
  type CompiledRegistryPackageDelivery,
  type RegistryCompileRequest,
} from './registryCompilation.js';
import {
  compilerResultEnvelopePrefix,
  DKB_COMPILER_RESULT_MEDIA_TYPE,
} from './compilerResultEnvelope.js';
import { registryCompilerCapabilities as resolveCompilerCapabilities } from './compilerCapabilities.js';
import { RegistryJobControl, type RegistryCompileControl } from './registryJobControl.js';
import { pendingExecutionReconciler } from './providerExecution.js';

export interface ServeDkbRegistryCompilerOptions {
  host?: string;
  port?: number;
}

export async function serveDkbRegistryCompiler(options: ServeDkbRegistryCompilerOptions = {}): Promise<http.Server> {
  const serviceTokenDigest = compilerServiceTokenDigest();
  const host = options.host ?? process.env.DKB_REGISTRY_COMPILER_HOST ?? '127.0.0.1';
  const port = options.port ?? Number.parseInt(process.env.DKB_REGISTRY_COMPILER_PORT ?? '7333', 10);
  const contextRoot = registryCompilerContextRoot();
  const jobs = new RegistryJobControl(contextRoot, pendingExecutionReconciler(DEFAULT_DKB_DISTRIBUTION, contextRoot));
  const server = http.createServer(async (request, response) => {
    await routeRequest(request, response, jobs, contextRoot, serviceTokenDigest);
  });
  server.on('close', () => jobs.close());
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  console.error(JSON.stringify({ event: 'dkb.registry.compiler.started', host, port }));
  return server;
}

async function routeRequest(request: IncomingMessage, response: ServerResponse, jobs: RegistryJobControl, contextRoot: string, serviceTokenDigest: Buffer): Promise<void> {
  response.setHeader('cache-control', 'no-store');
  try {
    const url = new URL(request.url ?? '/', 'http://dkb-registry-compiler.local');
    if (request.method === 'GET' && url.pathname === '/health') {
      return sendJson(response, 200, {
        ok: true,
        service: 'dkb.registry.compiler',
        version: DKB_COMPILER_VERSION,
      });
    }
    if (!validCompilerAuthorization(request, serviceTokenDigest)) {
      response.setHeader('www-authenticate', 'Bearer realm="DKB Compiler"');
      response.setHeader('connection', 'close');
      return sendJson(response, 401, {
        error: 'compiler_unauthorized',
        message: 'Compiler service authentication is required.',
      });
    }
    if (request.method === 'GET' && url.pathname === '/capabilities') {
      return sendJson(response, 200, await registryCompilerCapabilities());
    }
    if (request.method === 'POST' && url.pathname === '/compile/cancel') {
      const control = await readJsonBody<RegistryCompileControl>(request);
      const result = await jobs.cancel(control);
      return sendJson(response, result.status === 'cancelling' ? 202 : 200, result);
    }
    if (request.method === 'POST' && url.pathname === '/compile') {
      const body = await readJsonBody<RegistryCompileRequest>(request);
      const disconnected = new AbortController();
      const onClose = () => {
        if (!response.writableFinished) disconnected.abort(new DkbError('Registry disconnected from compilation.', 'compile_disconnected'));
      };
      response.once('close', onClose);
      try {
        const binary = (request.headers.accept ?? '').includes(DKB_COMPILER_RESULT_MEDIA_TYPE);
        const result = await jobs.run({
          registryId: body.request?.package?.registryId ?? '',
          jobId: body.jobId,
          execution: body.request?.execution!,
        }, async (signal, execution) => {
          const compileOptions = { distribution: DEFAULT_DKB_DISTRIBUTION, contextRoot, signal, execution };
          if (binary) {
            return compileRegistryPackage(body, {
              ...compileOptions,
              deliver: async (compiled) => sendCompiledArchive(response, compiled, signal),
            });
          } else {
            return compileRegistryPackage(body, compileOptions);
          }
        }, disconnected.signal);
        if (!binary) sendJson(response, 200, result);
      } finally {
        response.off('close', onClose);
      }
      return;
    }
    return sendJson(response, 404, { error: 'not_found', message: `Unknown compiler route: ${request.method} ${url.pathname}` });
  } catch (error) {
    const code = error instanceof DkbError ? error.code : 'compiler_error';
    const status = ['compile_cancelled', 'compile_expired', 'compile_already_running', 'compile_termination_unconfirmed'].includes(code) ? 409 : error instanceof DkbError ? 400 : 500;
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: 'dkb.registry.compiler.failed', status, message }));
    if (response.headersSent || response.destroyed) {
      response.destroy(error instanceof Error ? error : undefined);
      return;
    }
    return sendJson(response, status, {
      error: code,
      message,
    });
  }
}

export async function registryCompilerCapabilities() {
  return resolveCompilerCapabilities(DEFAULT_DKB_DISTRIBUTION, registryCompilerContextRoot());
}

function registryCompilerContextRoot(): string {
  return path.resolve(process.env.DKB_CONTEXT_ROOT ?? process.cwd());
}

async function sendCompiledArchive(response: ServerResponse, compiled: CompiledRegistryPackageDelivery, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const prefix = compilerResultEnvelopePrefix(compiled.payload);
  response.writeHead(200, {
    'content-type': DKB_COMPILER_RESULT_MEDIA_TYPE,
    'content-length': prefix.byteLength + compiled.archiveSize,
  });
  response.write(prefix);
  await pipeline(createReadStream(compiled.archivePath), response, { signal });
}

function compilerServiceTokenDigest(): Buffer {
  const token = process.env.DKB_COMPILER_SERVICE_TOKEN?.trim();
  if (!token || !/^[A-Za-z0-9._~+\/-]+=*$/u.test(token)) {
    throw new DkbError(
      'Set DKB_COMPILER_SERVICE_TOKEN to a nonempty Bearer token shared by the Registry and compiler service.',
      'compiler_auth_required',
    );
  }
  return createHash('sha256').update(token).digest();
}

function validCompilerAuthorization(request: IncomingMessage, expectedDigest: Buffer): boolean {
  const headerCount = request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization').length;
  if (headerCount !== 1) return false;
  const match = /^Bearer ([A-Za-z0-9._~+\/-]+=*)$/iu.exec(request.headers.authorization ?? '');
  if (!match) return false;
  return timingSafeEqual(createHash('sha256').update(match[1]!).digest(), expectedDigest);
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const body = (await readRequestBody(request)).toString('utf8').trim();
  if (!body) return {} as T;
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new DkbError('Request body must be valid JSON');
  }
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 256 * 1024 * 1024) throw new DkbError('Compiler request exceeds the 256 MiB limit');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}
