import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { compileComposeProject } from '../compiler/compile.js';
import { stableHash } from '../contracts/hash.js';
import { DkbError } from '../protocol/errors.js';
import { loadDkb } from '../protocol/manifest.js';
import { DKB_ARTIFACTS_DIR, manifestPath, resolveFrom } from '../protocol/paths.js';
import { DKB_ARTIFACT_MANIFEST_PATH } from '../artifacts/manifest.js';
import { DKB_PACKAGE_RECEIPT_PATH } from '../signing/index.js';
import { createDkbPackageArchive, DKB_PACKAGE_EXTENSION, extractDkbPackageArchive } from './archive.js';
import { readRetrievalProfileLock } from '../profiles/retrievalProfile.js';

const DKB_COMPILER_RESULT_MEDIA_TYPE = 'application/vnd.dkb.compiler-result+gzip';
const DKB_COMPILER_RESULT_HEADER = 'x-dkb-compiler-result';

export interface ServeDkbRegistryCompilerOptions {
  host?: string;
  port?: number;
}

interface CompileRequest {
  jobId: string;
  request: {
    package?: {
      id?: string;
      name?: string;
      version?: string;
      publisherId?: string;
      registryId?: string;
    };
    compiler?: {
      image?: string;
      model?: string;
      profile?: string;
    };
  };
  sourceArchive: {
    fileName?: string;
    hash?: string;
    contents: string;
  };
}

export async function serveDkbRegistryCompiler(options: ServeDkbRegistryCompilerOptions = {}): Promise<http.Server> {
  const host = options.host ?? process.env.DKB_REGISTRY_COMPILER_HOST ?? '127.0.0.1';
  const port = options.port ?? Number.parseInt(process.env.DKB_REGISTRY_COMPILER_PORT ?? '7333', 10);

  const server = http.createServer(async (request, response) => {
    await routeRequest(request, response);
  });

  await new Promise<void>((resolve) => {
    server.listen(port, host, resolve);
  });

  console.error(JSON.stringify({
    event: 'dkb.registry.compiler.started',
    host,
    port,
  }));

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
      return sendJson(response, 200, {
        ok: true,
        service: 'dkb.registry.compiler',
        compilerId: 'dkb.registry.package',
      });
    }

    if (request.method === 'POST' && url.pathname === '/compile') {
      const body = await readJsonBody<CompileRequest>(request);

      if ((request.headers.accept ?? '').includes(DKB_COMPILER_RESULT_MEDIA_TYPE)) {
        await compileRegistryPackage(body, async (compiled) => sendCompiledArchive(response, compiled));

        return;
      }

      return sendJson(response, 200, await compileRegistryPackage(body));
    }

    return sendJson(response, 404, { error: 'not_found', message: `Unknown compiler route: ${request.method} ${url.pathname}` });
  } catch (error) {
    const status = error instanceof DkbError ? 400 : 500;
    const message = error instanceof Error ? error.message : String(error);

    console.error(JSON.stringify({
      event: 'dkb.registry.compiler.failed',
      status,
      message,
    }));

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

interface CompiledRegistryPackageDelivery {
  payload: Record<string, unknown>;
  archivePath: string;
  archiveSize: number;
}

async function compileRegistryPackage(
  input: CompileRequest,
  deliver?: (compiled: CompiledRegistryPackageDelivery) => Promise<void>,
): Promise<Record<string, unknown>> {
  if (!/^[a-zA-Z0-9._-]+$/.test(input.jobId)) {
    throw new DkbError('jobId may contain only letters, numbers, dots, dashes, and underscores');
  }

  const sourceArchive = Buffer.from(input.sourceArchive.contents, 'base64');
  const expectedHash = input.sourceArchive.hash;
  const actualHash = `sha256:${createHash('sha256').update(sourceArchive).digest('hex')}`;

  if (expectedHash && expectedHash !== actualHash) {
    throw new DkbError(`Source archive hash mismatch: expected ${expectedHash}, got ${actualHash}`);
  }

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), `dkb-registry-compile-${input.jobId}-`));
  const uploadPath = path.join(scratch, input.sourceArchive.fileName ?? 'source.dkbpkg');
  const extractedRoot = path.join(scratch, 'source');
  const requestedPackageId = input.request.package?.id;
  const buildRoot = path.join(scratch, safeId(requestedPackageId ?? 'build'));
  const archivePath = path.join(scratch, 'compiled.dkbpkg');
  const compilerImage = input.request.compiler?.image ?? process.env.DKB_LLAMA_COMPILER_IMAGE ?? 'dkb-compiler-llamaindex:0.3.6';
  const compilerModel = input.request.compiler?.model ?? process.env.DKB_COMPILER_MODEL ?? 'BAAI/bge-small-en-v1.5';
  const previousFaissDockerImage = process.env.DKB_FAISS_DOCKER_IMAGE;
  const previousLlamaCompilerService = process.env.DKB_LLAMA_COMPILER_SERVICE;

  try {
    process.env.DKB_FAISS_DOCKER_IMAGE = previousFaissDockerImage ?? compilerImage;
    // This HTTP process is already the registry compiler service. Running the
    // persistent LlamaIndex service from inside it duplicates the source tree
    // and returns large compiler payloads over a second HTTP boundary. Use the
    // one-shot Docker path, which streams JSONL directly from its mounted job.
    process.env.DKB_LLAMA_COMPILER_SERVICE = '0';

    await fs.writeFile(uploadPath, sourceArchive);
    await extractDkbPackageArchive(uploadPath, extractedRoot);
    await copyDkbSourceOnly(extractedRoot, buildRoot);

    const dkb = await loadDkb(buildRoot);
    const packageId = input.request.package?.id ?? dkb.manifest.id;
    const version = input.request.package?.version ?? dkb.manifest.version;
    const publisherId = input.request.package?.publisherId ?? 'laravel-registry';

    await writeRegistryPackageManifest(buildRoot, dkb, packageId, version, publisherId);

    const compiled = await compileComposeProject(buildRoot, {
      force: true,
      compiler: 'llamaindex',
      artifactProfile: 'faiss-package',
      model: compilerModel,
    });
    const retrievalProfile = await readRetrievalProfileLock(buildRoot);

    await fs.rm(manifestPath(buildRoot, 'dkb-lock.json'), { force: true });
    await fs.rm(manifestPath(buildRoot, 'dkb-release.json'), { force: true });

    const packageTreeHash = await hashPackageTree(buildRoot);

    await createDkbPackageArchive(buildRoot, archivePath);

    const artifactManifestPath = resolveFrom(buildRoot, DKB_ARTIFACT_MANIFEST_PATH);
    const artifactManifest = await fs.readFile(artifactManifestPath);
    const archiveHash = `sha256:${await hashFile(archivePath)}`;
    const archiveFileName = packageArchiveFileName(packageId, version);
    const payload: Record<string, unknown> = {
      compiler: {
        id: 'dkb.registry.package',
        image: compilerImage,
        model: retrievalProfile.profile.embedding.model,
        profile: input.request.compiler?.profile ?? 'faiss-package',
        profileDigest: retrievalProfile.profileDigest,
      },
      lock: compiled.lock,
      packageTreeHash,
      archive: {
        fileName: archiveFileName,
        hash: archiveHash,
      },
      artifactManifest: {
        fileName: 'dkb-artifact.json',
        hash: `sha256:${createHash('sha256').update(artifactManifest).digest('hex')}`,
        contents: artifactManifest.toString('base64'),
      },
      logs: Buffer.from(JSON.stringify({
        event: 'dkb.registry.compile.completed',
        jobId: input.jobId,
        packageId,
        version,
        recordCount: compiled.recordCount,
      }, null, 2)).toString('base64'),
      recordCount: compiled.recordCount,
    };

    if (deliver) {
      await deliver({
        payload,
        archivePath,
        archiveSize: (await fs.stat(archivePath)).size,
      });

      return payload;
    }

    const archive = await fs.readFile(archivePath);

    return {
      ...payload,
      archive: {
        fileName: archiveFileName,
        hash: archiveHash,
        contents: archive.toString('base64'),
      },
    };
  } finally {
    if (previousFaissDockerImage === undefined) {
      delete process.env.DKB_FAISS_DOCKER_IMAGE;
    } else {
      process.env.DKB_FAISS_DOCKER_IMAGE = previousFaissDockerImage;
    }
    if (previousLlamaCompilerService === undefined) {
      delete process.env.DKB_LLAMA_COMPILER_SERVICE;
    } else {
      process.env.DKB_LLAMA_COMPILER_SERVICE = previousLlamaCompilerService;
    }

    await fs.rm(scratch, { recursive: true, force: true });
  }
}

async function sendCompiledArchive(response: ServerResponse, compiled: CompiledRegistryPackageDelivery): Promise<void> {
  const metadata = Buffer.from(JSON.stringify(compiled.payload), 'utf8').toString('base64');

  if (Buffer.byteLength(metadata, 'ascii') > 12 * 1024) {
    throw new DkbError('Compiler result metadata is too large for the streamed response header');
  }

  response.writeHead(200, {
    'content-type': DKB_COMPILER_RESULT_MEDIA_TYPE,
    'content-length': compiled.archiveSize,
    [DKB_COMPILER_RESULT_HEADER]: metadata,
  });
  await pipeline(createReadStream(compiled.archivePath), response);
}

async function hashFile(target: string): Promise<string> {
  const hash = createHash('sha256');

  for await (const chunk of createReadStream(target)) {
    hash.update(chunk);
  }

  return hash.digest('hex');
}

async function copyDkbSourceOnly(sourceRoot: string, targetRoot: string): Promise<void> {
  const stat = await fs.stat(sourceRoot);

  if (!stat.isDirectory()) {
    throw new DkbError(`Registry compile source must be a DKB directory: ${sourceRoot}`);
  }

  await fs.cp(sourceRoot, targetRoot, {
    recursive: true,
    filter: (candidate) => !isDkbSystemArtifactPath(sourceRoot, candidate),
  });
}

async function writeRegistryPackageManifest(root: string, dkb: Awaited<ReturnType<typeof loadDkb>>, packageId: string, version: string, publisherId: string): Promise<void> {
  const source = manifestPath(root, 'dkb.json');
  const manifest = await readJsonObject(source);

  delete manifest.dependencies;

  await fs.writeFile(source, `${JSON.stringify({
    manifestVersion: typeof manifest.manifestVersion === 'number' ? manifest.manifestVersion : 1,
    type: 'package',
    ...manifest,
    name: dkb.manifest.name,
    version,
    publisher: publisherId,
    package: dependencyNameFor(publisherId, packageId),
  }, null, 2)}\n`, 'utf8');
}

async function hashPackageTree(root: string): Promise<string> {
  const files = (await listFiles(root, root))
    .map((file) => path.relative(root, file).replace(/\\/g, '/'))
    .sort((left, right) => left.localeCompare(right));
  const entries = await Promise.all(files.map(async (relative) => ({
    path: relative,
    hash: await hashRequiredPath(path.join(root, relative)),
  })));

  return stableHash(entries);
}

async function hashRequiredPath(target: string): Promise<string> {
  return `sha256:${createHash('sha256').update(await fs.readFile(target)).digest('hex')}`;
}

async function listFiles(root: string, sourceRoot?: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name);

    if (sourceRoot && isDkbSystemArtifactPath(sourceRoot, target)) {
      return [];
    }

    if (entry.isDirectory()) {
      return listFiles(target, sourceRoot);
    }

    return entry.isFile() ? [target] : [];
  }));

  return nested.flat().sort((left, right) => left.localeCompare(right));
}

async function readJsonObject(source: string): Promise<Record<string, unknown>> {
  const value = JSON.parse((await fs.readFile(source, 'utf8')).replace(/^\uFEFF/, '')) as unknown;

  if (!isRecord(value)) {
    throw new DkbError(`Expected JSON object at ${source}`);
  }

  return value;
}

function packageArchiveFileName(packageId: string, version: string): string {
  return `${safeId(packageId)}-${safeId(version)}${DKB_PACKAGE_EXTENSION}`;
}

function dependencyNameFor(publisherId: string, packageId: string): string {
  return `@${safeId(publisherId)}/${safeId(packageId)}`;
}

function safeId(value: string): string {
  const id = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

  return id || 'package';
}

function isDkbSystemArtifactPath(sourceRoot: string, candidate: string): boolean {
  const relative = path.relative(sourceRoot, candidate);

  if (!relative) {
    return false;
  }

  const parts = relative.split(path.sep);
  const name = path.basename(candidate);

  return parts.includes('.dkb') || name === 'dkb-lock.json' || name === 'dkb-release.json' || name === DKB_PACKAGE_RECEIPT_PATH;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function setCommonHeaders(response: ServerResponse): void {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type,authorization');
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
