import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { resolveProviderRetrievalProfile } from '@sjshovan/dkb-pipeline/profile.js';
import { DkbProviderHost } from '@sjshovan/dkb-pipeline/host.js';
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

export interface ServeDkbRegistryCompilerOptions {
  host?: string;
  port?: number;
}

export async function serveDkbRegistryCompiler(options: ServeDkbRegistryCompilerOptions = {}): Promise<http.Server> {
  const host = options.host ?? process.env.DKB_REGISTRY_COMPILER_HOST ?? '127.0.0.1';
  const port = options.port ?? Number.parseInt(process.env.DKB_REGISTRY_COMPILER_PORT ?? '7333', 10);
  const server = http.createServer(async (request, response) => {
    await routeRequest(request, response);
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  console.error(JSON.stringify({ event: 'dkb.registry.compiler.started', host, port }));
  return server;
}

async function routeRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  setCommonHeaders(response);
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    const url = new URL(request.url ?? '/', 'http://dkb-registry-compiler.local');
    if (request.method === 'GET' && url.pathname === '/health') {
      const capabilities = await registryCompilerCapabilities();
      return sendJson(response, 200, {
        ok: true,
        service: 'dkb.registry.compiler',
        version: DKB_COMPILER_VERSION,
        target: capabilities.activeTarget,
        buildDigest: capabilities.buildDigest,
        compatibilityDigest: capabilities.compatibilityDigest,
      });
    }
    if (request.method === 'GET' && url.pathname === '/capabilities') {
      return sendJson(response, 200, await registryCompilerCapabilities());
    }
    if (request.method === 'POST' && url.pathname === '/compile') {
      const body = await readJsonBody<RegistryCompileRequest>(request);
      const contextRoot = registryCompilerContextRoot();
      if ((request.headers.accept ?? '').includes(DKB_COMPILER_RESULT_MEDIA_TYPE)) {
        await compileRegistryPackage(body, {
          distribution: DEFAULT_DKB_DISTRIBUTION,
          contextRoot,
          deliver: async (compiled) => sendCompiledArchive(response, compiled),
        });
        return;
      }
      return sendJson(response, 200, await compileRegistryPackage(body, {
        distribution: DEFAULT_DKB_DISTRIBUTION,
        contextRoot,
      }));
    }
    return sendJson(response, 404, { error: 'not_found', message: `Unknown compiler route: ${request.method} ${url.pathname}` });
  } catch (error) {
    const status = error instanceof DkbError ? 400 : 500;
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: 'dkb.registry.compiler.failed', status, message }));
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined);
      return;
    }
    return sendJson(response, status, {
      error: status === 400 ? 'bad_request' : 'compiler_error',
      message,
    });
  }
}

export async function registryCompilerCapabilities(): Promise<{
  service: 'dkb.registry.compiler';
  version: string;
  contextRoot: string;
  activeTarget: string;
  providers: ReturnType<DkbProviderHost['describe']>['providers'];
  processors: ReturnType<DkbProviderHost['describe']>['processors'];
  buildDigest: string;
  evidenceProfileDigest: string;
  retrievalProfileDigest: string;
  compatibility: Awaited<ReturnType<typeof resolveProviderRetrievalProfile>>['compatibility'];
  compatibilityDigest: string;
}> {
  const contextRoot = registryCompilerContextRoot();
  const host = await DkbProviderHost.create({ root: contextRoot, distribution: DEFAULT_DKB_DISTRIBUTION });
  try {
    const description = host.describe();
    const profile = await resolveProviderRetrievalProfile(host);
    return {
      service: 'dkb.registry.compiler',
      version: DKB_COMPILER_VERSION,
      contextRoot,
      activeTarget: description.target,
      providers: description.providers,
      processors: description.processors,
      buildDigest: description.buildDigest,
      evidenceProfileDigest: profile.evidenceProfileDigest,
      retrievalProfileDigest: profile.retrievalProfileDigest,
      compatibility: profile.compatibility,
      compatibilityDigest: stableHash(profile.compatibility),
    };
  } finally {
    await host.dispose();
  }
}

function registryCompilerContextRoot(): string {
  return path.resolve(process.env.DKB_CONTEXT_ROOT ?? process.cwd());
}

async function sendCompiledArchive(response: ServerResponse, compiled: CompiledRegistryPackageDelivery): Promise<void> {
  const prefix = compilerResultEnvelopePrefix(compiled.payload);
  response.writeHead(200, {
    'content-type': DKB_COMPILER_RESULT_MEDIA_TYPE,
    'content-length': prefix.byteLength + compiled.archiveSize,
  });
  response.write(prefix);
  await pipeline(createReadStream(compiled.archivePath), response);
}

function setCommonHeaders(response: ServerResponse): void {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type,authorization');
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
