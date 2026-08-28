import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { compileComposeProject, compileRetrievalFromEvidence } from './compile.js';
import { stableHash } from '@dkb/protocol/contracts/hash.js';
import { DkbError } from '@dkb/protocol/errors.js';
import { parseDkbIdentity } from '@dkb/protocol/identity.js';
import { loadDkb } from '@dkb/protocol/manifest.js';
import { DKB_ARTIFACTS_DIR, manifestPath, resolveFrom } from '@dkb/protocol/paths.js';
import { DKB_ARTIFACT_MANIFEST_PATH } from '@dkb/library/artifacts.js';
import { DKB_PACKAGE_RECEIPT_PATH } from '@dkb/library/signing.js';
import { createDkbPackageArchive, DKB_PACKAGE_EXTENSION, extractDkbPackageArchive } from '@dkb/registry-client/archive.js';
import { DKB_RETRIEVAL_PROFILE_LOCK_PATH, readRetrievalProfileLock } from '@dkb/pipeline/profile.js';
import { resolveProviderRetrievalProfile } from '@dkb/pipeline/profile.js';
import { BUNDLED_PROVIDER_PLUGINS } from '@dkb/providers-bundled/bundled.js';
import { LLAMAINDEX_COMPILER_IMAGE } from '@dkb/providers-bundled/llamaindex.js';
import { resolveContextConfig } from '@dkb/pipeline/config.js';
import { DkbProviderHost } from '@dkb/pipeline/host.js';
import { DKB_COMPILER_VERSION } from './version.js';
import { validateEvidenceIr } from '@dkb/protocol/evidence/ir.js';
import { validateEvidenceBuildLock } from '@dkb/protocol/builds.js';
import { summarizeCompilerDeliveryStatistics } from './buildStatistics.js';

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
    target?: string;
    stage?: 'pipeline' | 'retrieval';
  };
  sourceArchive: {
    fileName?: string;
    hash?: string;
    contents: string;
  };
  evidenceArchive?: {
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
  const evidenceUploadPath = path.join(scratch, input.evidenceArchive?.fileName ?? 'evidence.dkbevidence');
  const evidenceExtractedRoot = path.join(scratch, 'evidence');
  const extractedRoot = path.join(scratch, 'source');
  const requestedPackageId = input.request.package?.id;
  const buildRoot = path.join(scratch, safeId(requestedPackageId ?? 'build'));
  const archivePath = path.join(scratch, 'compiled.dkbpkg');
  const contextRoot = registryCompilerContextRoot();
  const contextConfig = await resolveContextConfig(contextRoot);
  const target = input.request.target ?? contextConfig.activeTarget;

  if (target !== contextConfig.activeTarget) {
    throw new DkbError(`Registry compiler accepts only its active target "${contextConfig.activeTarget}", not "${target}"`);
  }
  const compilerImage = process.env.DKB_LLAMA_COMPILER_IMAGE ?? LLAMAINDEX_COMPILER_IMAGE;

  try {
    await fs.writeFile(uploadPath, sourceArchive);
    await extractDkbPackageArchive(uploadPath, extractedRoot);
    await copyDkbSourceOnly(extractedRoot, buildRoot);

    const dkb = await loadDkb(buildRoot);
    const packageId = input.request.package?.id ?? dkb.manifest.id;
    const version = input.request.package?.version ?? dkb.manifest.version;
    const publisherId = input.request.package?.publisherId ?? parseDkbIdentity(dkb.manifest.id).namespace;

    assertRegistryPackageManifest(dkb, packageId, version, publisherId);
    const sourceTreeHash = await hashPackageTree(buildRoot);

    const stage = input.request.stage ?? 'pipeline';
    const compiled = stage === 'retrieval'
      ? await compileRetrievalStage(input, buildRoot, evidenceUploadPath, evidenceExtractedRoot, target, contextRoot, packageId, version)
      : await compileComposeProject(buildRoot, {
          force: true,
          mode: 'package',
          target,
          contextRoot,
        });
    const retrievalProfile = await readRetrievalProfileLock(buildRoot);

    await fs.rm(manifestPath(buildRoot, 'dkb-release.json'), { force: true });

    const packageTreeHash = await hashPackageTree(buildRoot);

    await createDkbPackageArchive(buildRoot, archivePath);

    const artifactManifestPath = resolveFrom(buildRoot, DKB_ARTIFACT_MANIFEST_PATH);
    const artifactManifest = await fs.readFile(artifactManifestPath);
    const archiveHash = `sha256:${await hashFile(archivePath)}`;
    const archiveSize = (await fs.stat(archivePath)).size;
    const archiveFileName = packageArchiveFileName(packageId, version);
    const payload: Record<string, unknown> = {
      compiler: {
        id: 'dkb.registry.package',
        image: compilerImage,
        model: retrievalProfile.profile.embedding.model,
        target,
        profile: target,
        buildDigest: retrievalProfile.buildDigest,
        compatibilityDigest: retrievalProfile.compatibilityDigest,
        profileDigest: retrievalProfile.profileDigest,
        providers: retrievalProfile.profile.providers,
      },
      lock: compiled.lock,
      sourceTreeHash,
      packageTreeHash,
      archive: {
        fileName: archiveFileName,
        hash: archiveHash,
        bytes: archiveSize,
      },
      artifactManifest: {
        fileName: 'dkb-artifact.json',
        hash: `sha256:${createHash('sha256').update(artifactManifest).digest('hex')}`,
        contents: artifactManifest.toString('base64'),
      },
      logs: Buffer.from(JSON.stringify({
        event: 'dkb.registry.compile.completed',
        stage,
        jobId: input.jobId,
        packageId,
        version,
        recordCount: compiled.recordCount,
      }, null, 2)).toString('base64'),
      recordCount: compiled.recordCount,
      buildStatistics: compiled.profile?.statistics
        ? summarizeCompilerDeliveryStatistics({
            corpus: compiled.profile.statistics.corpus,
            storage: compiled.profile.statistics.storage,
            timingsMs: compiled.profile.timingsMs,
          })
        : undefined,
    };

    if (deliver) {
      await deliver({
        payload,
        archivePath,
        archiveSize,
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
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

async function compileRetrievalStage(
  input: CompileRequest,
  buildRoot: string,
  evidenceUploadPath: string,
  evidenceExtractedRoot: string,
  target: string,
  contextRoot: string,
  packageId: string,
  version: string,
): Promise<Awaited<ReturnType<typeof compileComposeProject>>> {
  if (!input.evidenceArchive) {
    throw new DkbError('Retrieval-only compilation requires evidenceArchive');
  }
  const bytes = Buffer.from(input.evidenceArchive.contents, 'base64');
  const actualHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (input.evidenceArchive.hash && input.evidenceArchive.hash !== actualHash) {
    throw new DkbError(`Evidence archive hash mismatch: expected ${input.evidenceArchive.hash}, got ${actualHash}`);
  }
  await fs.writeFile(evidenceUploadPath, bytes);
  await extractDkbPackageArchive(evidenceUploadPath, evidenceExtractedRoot);
  const evidencePath = path.join(evidenceExtractedRoot, 'evidence.ir.json');
  const lockPath = path.join(evidenceExtractedRoot, 'evidence.lock.json');
  const evidence = validateEvidenceIr(JSON.parse(await fs.readFile(evidencePath, 'utf8')), evidencePath);
  const lock = validateEvidenceBuildLock(JSON.parse(await fs.readFile(lockPath, 'utf8')), lockPath);
  if (lock.package.id !== packageId
    || lock.package.version !== version
    || lock.evidenceProfileDigest !== evidence.evidenceProfileDigest
    || lock.evidenceDigest !== evidence.evidenceDigest
    || lock.recordCount !== evidence.evidence.length
    || lock.chunkCount !== evidence.chunks.length) {
    throw new DkbError(`Evidence archive does not match ${packageId}@${version}`);
  }

  return compileRetrievalFromEvidence(buildRoot, evidence, { target, contextRoot });
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
  const host = await DkbProviderHost.create({ root: contextRoot, bundled: BUNDLED_PROVIDER_PLUGINS });

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

function assertRegistryPackageManifest(dkb: Awaited<ReturnType<typeof loadDkb>>, packageId: string, version: string, publisherId: string): void {
  const identity = parseDkbIdentity(dkb.manifest.id);

  if (packageId !== dkb.manifest.id) {
    throw new DkbError(`Registry compile identity mismatch: requested ${packageId}, source declares ${dkb.manifest.id}`);
  }
  if (publisherId !== identity.namespace) {
    throw new DkbError(`Publisher ${publisherId} does not own ${dkb.manifest.id}`);
  }
  if (version !== dkb.manifest.version) {
    throw new DkbError(`Registry compile version mismatch: requested ${version}, source declares ${dkb.manifest.version}`);
  }
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

  return parts.includes('.dkb')
    || name === 'dkb-lock.json'
    || name === DKB_RETRIEVAL_PROFILE_LOCK_PATH
    || name === 'dkb-release.json'
    || name === DKB_PACKAGE_RECEIPT_PATH;
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
