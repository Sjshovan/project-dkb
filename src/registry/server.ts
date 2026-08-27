import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DkbError } from '@dkb/protocol/errors.js';
import { DKB_PACKAGE_MEDIA_TYPE, DKB_SOURCE_ARCHIVE_MEDIA_TYPE, extractDkbPackageArchive } from './archive.js';
import {
  downloadDkbFromMockRegistry,
  ensureMockRegistry,
  exportMockRegistryPackageArchive,
  listMockRegistryPackages,
  loginMockRegistry,
  publishDkbToMockRegistry,
  registryPublicKeys,
  revokeMockRegistryKey,
  rotateMockRegistryAccountKey,
  rotateMockRegistrySigningKey,
  verifyDownloadedMockRelease,
} from './packageRegistry.js';

export interface ServeDkbRegistryOptions {
  host?: string;
  port?: number;
  registryRoot?: string;
}

export async function serveDkbRegistry(options: ServeDkbRegistryOptions = {}): Promise<http.Server> {
  const registryRoot = options.registryRoot ?? process.env.DKB_REGISTRY_ROOT ?? '.dkb/mock-registry';
  const host = options.host ?? process.env.DKB_REGISTRY_HOST ?? '127.0.0.1';
  const port = options.port ?? Number.parseInt(process.env.DKB_REGISTRY_PORT ?? '7332', 10);

  await ensureMockRegistry(registryRoot);

  const server = http.createServer(async (request, response) => {
    await routeRequest(request, response, registryRoot);
  });

  await new Promise<void>((resolve) => {
    server.listen(port, host, resolve);
  });

  console.error(JSON.stringify({
    event: 'dkb.registry.started',
    host,
    port,
    registryRoot,
  }));

  return server;
}

async function routeRequest(request: IncomingMessage, response: ServerResponse, registryRoot: string): Promise<void> {
  setCommonHeaders(response);

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();

    return;
  }

  try {
    const url = new URL(request.url ?? '/', 'http://dkb-registry.local');
    const pathName = url.pathname;

    if (request.method === 'GET' && (pathName === '/health' || pathName === '/api/health')) {
      return sendJson(response, 200, { ok: true, registryRoot });
    }

    if (request.method === 'GET' && pathName === '/.well-known/dkb-registry-keys.json') {
      return sendJson(response, 200, await registryPublicKeys(registryRoot));
    }

    if (request.method === 'POST' && pathName === '/api/login') {
      const body = await readJsonBody<{ accountId?: string; name?: string; email?: string }>(request);

      return sendJson(response, 201, await loginMockRegistry({
        registryRoot,
        accountId: body.accountId,
        name: body.name,
        email: body.email,
      }));
    }

    if (request.method === 'GET' && pathName === '/api/packages') {
      return sendJson(response, 200, await listMockRegistryPackages(registryRoot));
    }

    if (request.method === 'POST' && pathName === '/api/packages/publish') {
      return sendJson(response, 201, await publishUploadedArchive(request, registryRoot, url));
    }

    const packageMatch = pathName.match(/^\/api\/packages\/([^/]+)(?:\/(verify|package))?$/);

    if (packageMatch && request.method === 'GET' && !packageMatch[2]) {
      return sendJson(response, 200, await downloadDkbFromMockRegistry({
        registryRoot,
        packageId: decodeURIComponent(packageMatch[1]!),
        version: url.searchParams.get('version') ?? undefined,
      }));
    }

    if (packageMatch && request.method === 'POST' && packageMatch[2] === 'verify') {
      const body = await readJsonBody<{ version?: string }>(request);

      return sendJson(response, 200, await verifyDownloadedMockRelease({
        registryRoot,
        packageId: decodeURIComponent(packageMatch[1]!),
        version: body.version,
      }));
    }

    if (packageMatch && request.method === 'GET' && packageMatch[2] === 'package') {
      const packaged = await exportMockRegistryPackageArchive({
        registryRoot,
        packageId: decodeURIComponent(packageMatch[1]!),
        version: url.searchParams.get('version') ?? undefined,
      });

      return sendBinaryFile(response, packaged.archivePath, DKB_PACKAGE_MEDIA_TYPE, packaged.fileName);
    }

    const rotateMatch = pathName.match(/^\/api\/accounts\/([^/]+)\/keys\/rotate$/);

    if (rotateMatch && request.method === 'POST') {
      return sendJson(response, 200, await rotateMockRegistryAccountKey({
        registryRoot,
        accountId: decodeURIComponent(rotateMatch[1]!),
      }));
    }

    if (pathName === '/api/registry/keys/rotate' && request.method === 'POST') {
      return sendJson(response, 200, await rotateMockRegistrySigningKey({
        registryRoot,
      }));
    }

    const revokeMatch = pathName.match(/^\/api\/keys\/([^/]+)\/revoke$/);

    if (revokeMatch && request.method === 'POST') {
      return sendJson(response, 200, await revokeMockRegistryKey({
        registryRoot,
        keyId: decodeURIComponent(revokeMatch[1]!),
      }));
    }

    return sendJson(response, 404, { error: 'not_found', message: `Unknown DKB Registry route: ${request.method} ${pathName}` });
  } catch (error) {
    const status = error instanceof DkbError ? 400 : 500;
    const message = error instanceof Error ? error.message : String(error);

    return sendJson(response, status, {
      error: status === 400 ? 'bad_request' : 'registry_error',
      message,
    });
  }
}

async function publishUploadedArchive(request: IncomingMessage, registryRoot: string, url: URL) {
  const contentType = String(request.headers['content-type'] ?? '');

  if (!contentType.startsWith(DKB_SOURCE_ARCHIVE_MEDIA_TYPE)) {
    throw new DkbError(`Registry publish requires ${DKB_SOURCE_ARCHIVE_MEDIA_TYPE}.`);
  }

  const uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-registry-upload-'));
  const uploadPath = path.join(uploadRoot, 'source.dkbpkg');
  const sourceRoot = path.join(uploadRoot, safeId(url.searchParams.get('sourceName') ?? 'source'));

  try {
    await fs.writeFile(uploadPath, await readRequestBody(request));
    await extractDkbPackageArchive(uploadPath, sourceRoot);

    return await publishDkbToMockRegistry({
      registryRoot,
      sourcePath: sourceRoot,
      accountId: url.searchParams.get('accountId') ?? undefined,
      accountName: url.searchParams.get('accountName') ?? undefined,
      accountEmail: url.searchParams.get('accountEmail') ?? undefined,
      force: url.searchParams.get('force') === 'true',
    });
  } finally {
    await fs.rm(uploadRoot, { recursive: true, force: true });
  }
}

function safeId(value: string): string {
  const id = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

  return id || 'source';
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const body = (await readRequestBody(request)).toString('utf8').trim();

  if (!body) {
    return {} as T;
  }

  return JSON.parse(body) as T;
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body, null, 2));
}

async function sendBinaryFile(response: ServerResponse, target: string, contentType: string, fileName: string): Promise<void> {
  const stat = await fs.stat(target);

  response.writeHead(200, {
    'content-type': contentType,
    'content-disposition': `attachment; filename="${fileName}"`,
    'content-length': String(stat.size),
  });
  response.end(await fs.readFile(target));
}

function setCommonHeaders(response: ServerResponse): void {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type,authorization');
}
