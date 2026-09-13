import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { resolveDockerImageIdentity } from '@sjshovan/dkb-pipeline/serviceIdentity.js';
import { tokenizerRevision } from './model.js';
import {
  LLAMAINDEX_COMPILER_ID,
  LLAMAINDEX_COMPILER_IMAGE,
  LLAMAINDEX_COMPILER_SERVICE_VERSION,
  LLAMAINDEX_DOCUMENT_BATCH_SIZE,
} from './compilerConstants.js';

const execFile = promisify(execFileCallback);
const SERVICE_CONTAINER = 'dkb-llamaindex-compiler-service';
const SERVICE_PORT = 8091;
const starts = new Map<string, Promise<LlamaIndexCompilerServiceStatus>>();

export interface CompilerServiceOptions { image?: string; imageDigest?: string; model?: string; modelRevision?: string }

export interface CompilerServiceRequest {
  stores: Array<{
    type: 'filesystem' | 'sqlite';
    path: string;
    includePaths?: string[];
    excludePaths?: string[];
  }>;
}

export interface LlamaIndexCompilerInspection {
  docker: boolean;
  image: string;
  available: boolean;
  serviceReady: boolean;
  serviceUrl?: string;
  serviceContainer?: string;
  serviceVersion?: string;
  drift?: string[];
}

export interface LlamaIndexCompilerServiceStatus {
  docker: boolean;
  image: string;
  container: string;
  running: boolean;
  ready: boolean;
  url?: string;
  imageId?: string;
  expectedImageId?: string;
  serviceVersion?: string;
  drift: string[];
  health?: unknown;
}

export async function inspectLlamaIndexCompiler(options: CompilerServiceOptions = {}): Promise<LlamaIndexCompilerInspection> {
  const { image } = resolvedServiceOptions(options);
  try {
    await execFile('docker', ['--version'], { timeout: 30_000 });
  } catch {
    return { docker: false, image, available: false, serviceReady: false };
  }

  const available = await dockerImageExists(image);
  const status = await compilerServiceStatus({ ...options, image }).catch(() => null);
  return {
    docker: true,
    image,
    available,
    serviceReady: Boolean(status?.ready),
    serviceUrl: status?.url,
    serviceContainer: status?.container,
    serviceVersion: status?.serviceVersion,
    drift: status?.drift,
  };
}

export async function compilerServiceStatus(options: CompilerServiceOptions = {}): Promise<LlamaIndexCompilerServiceStatus> {
  const selected = resolvedServiceOptions(options);
  const { image } = selected;
  const containerName = serviceContainerName(selected);
  try {
    await execFile('docker', ['--version'], { timeout: 30_000 });
  } catch {
    return { docker: false, image, container: containerName, running: false, ready: false, drift: ['docker_unavailable'] };
  }

  const expectedImageId = await resolveDockerImageIdentity(image, selected.imageDigest).catch(() => undefined);
  const container = await inspectServiceContainer(containerName).catch(() => null);
  const running = container?.state.Running === true;
  const port = running ? await serviceHostPort(containerName).catch(() => undefined) : undefined;
  const url = port ? `http://127.0.0.1:${port}` : undefined;
  const drift: string[] = [];
  if (!expectedImageId) drift.push('image_identity_unverified');
  if (container) {
    if (!expectedImageId || container.imageId !== expectedImageId) drift.push('image_id_mismatch');
    if (container.labels['org.dkb.compiler.service.version'] !== LLAMAINDEX_COMPILER_SERVICE_VERSION) drift.push('service_version_mismatch');
    if (container.labels['org.dkb.compiler.jobs-root'] !== path.resolve(compilerServiceJobsRoot())) drift.push('jobs_root_mismatch');
  }

  let health: unknown;
  let ready = false;
  let serviceVersion: string | undefined;
  if (url) {
    health = await serviceHealth(url).catch((error) => ({ ok: false, error: commandDetail(error) }));
    ready = isHealthyService(health);
    serviceVersion = serviceVersionFromHealth(health);
    if (!ready) drift.push('service_unhealthy');
    if (serviceVersion && serviceVersion !== LLAMAINDEX_COMPILER_SERVICE_VERSION) drift.push('health_version_mismatch');
  }

  return {
    docker: true,
    image,
    container: containerName,
    running,
    ready,
    url,
    imageId: container?.imageId,
    expectedImageId,
    serviceVersion,
    drift,
    health,
  };
}

export async function compilerProviderHealth(options: CompilerServiceOptions = {}): Promise<{ ok: boolean; detail: string }> {
  const serviceUrl = process.env.DKB_LLAMA_COMPILER_SERVICE_URL?.trim().replace(/\/+$/u, '');
  if (serviceUrl) {
    try {
      const health = await serviceHealth(serviceUrl);
      const ready = isHealthyService(health);
      const version = serviceVersionFromHealth(health);
      return {
        ok: ready,
        detail: ready
          ? `${LLAMAINDEX_COMPILER_ID} service v${version ?? 'unknown'} at ${serviceUrl}`
          : `${LLAMAINDEX_COMPILER_ID} service at ${serviceUrl} returned incompatible health`,
      };
    } catch (error) {
      return { ok: false, detail: `${LLAMAINDEX_COMPILER_ID} service at ${serviceUrl} is unavailable: ${commandDetail(error)}` };
    }
  }

  const status = await compilerServiceStatus(options);
  const available = status.docker && Boolean(status.expectedImageId);
  return {
    ok: available,
    detail: available
      ? `${LLAMAINDEX_COMPILER_ID} via ${status.image}`
      : 'Docker or the Evidence worker image is unavailable',
  };
}

export async function startLlamaIndexCompilerService(options: CompilerServiceOptions & {
  forceRestart?: boolean;
} = {}): Promise<LlamaIndexCompilerServiceStatus> {
  const selected = { ...resolvedServiceOptions(options), forceRestart: options.forceRestart };
  const key = serviceContainerName(selected);
  const existing = starts.get(key);
  if (existing && !options.forceRestart) return existing;
  const starting = startCompilerService(selected);
  starts.set(key, starting);
  try { return await starting; }
  finally { if (starts.get(key) === starting) starts.delete(key); }
}

async function startCompilerService(options: ReturnType<typeof resolvedServiceOptions> & { forceRestart?: boolean }): Promise<LlamaIndexCompilerServiceStatus> {
  const { image } = options;
  const containerName = serviceContainerName(options);
  if (options.imageDigest) {
    const selectedId = await resolveDockerImageIdentity(image, options.imageDigest);
    if (await dockerImageLabel(selectedId, 'org.dkb.compiler.service.version') !== LLAMAINDEX_COMPILER_SERVICE_VERSION) {
      throw new DkbError(`Pinned compiler image ${image} does not implement service version ${LLAMAINDEX_COMPILER_SERVICE_VERSION}. Restore a compatible pinned image; DKB will not rebuild over the selected identity.`);
    }
  } else await ensureServiceImage(image);
  const imageId = await resolveDockerImageIdentity(image, options.imageDigest);
  const current = await compilerServiceStatus(options);
  if (current.ready && current.drift.length === 0 && !options.forceRestart) return current;
  await stopLlamaIndexCompilerService(options);

  const jobsRoot = compilerServiceJobsRoot();
  await fs.mkdir(jobsRoot, { recursive: true });
  try {
    await execFile('docker', [
      'run', '-d',
      ...(environmentFlag(process.env.DKB_LLAMA_GPU) ? ['--gpus', 'all'] : []),
      '--name', containerName,
      '--label', `org.dkb.compiler.service.version=${LLAMAINDEX_COMPILER_SERVICE_VERSION}`,
      '--label', `org.dkb.compiler.jobs-root=${path.resolve(jobsRoot)}`,
      '--label', 'org.dkb.component=llamaindex-compiler-service',
      '-p', `127.0.0.1::${SERVICE_PORT}`,
      '--mount', `type=bind,src=${path.resolve(jobsRoot)},dst=/jobs`,
      '-e', `DKB_COMPILER_MODEL=${options.model}`,
      '-e', `DKB_COMPILER_MODEL_REVISION=${options.modelRevision}`,
      '-e', `DKB_LLAMA_DOCUMENT_BATCH_SIZE=${process.env.DKB_LLAMA_DOCUMENT_BATCH_SIZE ?? String(LLAMAINDEX_DOCUMENT_BATCH_SIZE)}`,
      '-e', 'DKB_COMPILER_JOBS_ROOT=/jobs',
      '--entrypoint', 'python', imageId,
      '-m', 'uvicorn', 'service:app', '--host', '0.0.0.0', '--port', String(SERVICE_PORT),
    ], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    throw new DkbError(`Unable to start LlamaIndex compiler service. Ensure Docker is running and image ${image} can run locally: ${commandDetail(error)}`);
  }

  const deadline = performance.now() + 60_000;
  let lastStatus = await compilerServiceStatus(options);
  while (performance.now() < deadline) {
    lastStatus = await compilerServiceStatus(options);
    if (lastStatus.ready && lastStatus.drift.length === 0) return lastStatus;
    await sleep(250);
  }
  throw new DkbError(`LlamaIndex compiler service did not become ready. Last status: ${JSON.stringify(lastStatus)}`);
}

export async function stopLlamaIndexCompilerService(options: CompilerServiceOptions = {}): Promise<LlamaIndexCompilerServiceStatus> {
  const selected = resolvedServiceOptions(options);
  const containerName = serviceContainerName(selected);
  try {
    await execFile('docker', ['rm', '-f', containerName], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    const detail = commandDetail(error);
    if (!/no such (container|object)/iu.test(detail)) throw new DkbError(`Unable to stop LlamaIndex compiler service: ${detail}`);
  }
  return compilerServiceStatus(selected);
}

export async function doctorLlamaIndexCompilerService(options: CompilerServiceOptions = {}): Promise<{
  ok: boolean;
  status: LlamaIndexCompilerServiceStatus;
  actions: string[];
}> {
  const { image } = resolvedServiceOptions(options);
  const status = await compilerServiceStatus(options);
  const actions: string[] = [];
  if (!status.docker) actions.push('Start Docker Desktop, then run `dkb compiler start`.');
  if (status.drift.includes('image_identity_unverified')) actions.push(`Restore the pinned compiler image: ${image}.`);
  if (status.drift.some((item) => item.endsWith('_mismatch'))) actions.push('Run `dkb compiler start --restart` to replace the stale compiler service.');
  if (status.docker && !status.ready) actions.push('Run `dkb compiler start` and retry the compile.');
  return { ok: status.ready && status.drift.length === 0, status, actions };
}

export async function maybePrepareCompilerServiceJob(
  sourceRoot: string,
  request: CompilerServiceRequest,
  options: { image: string; imageDigest?: string; model: string; modelRevision?: string; timeoutMs?: number; workers?: number; signal?: AbortSignal },
): Promise<{ serviceUrl: string; jobId: string; jobRoot: string } | null> {
  options.signal?.throwIfAborted();
  if (process.env.DKB_LLAMA_COMPILER_SERVICE === '0' || process.env.DKB_LLAMA_COMPILER_SERVICE === 'false') return null;
  const serviceUrl = process.env.DKB_LLAMA_COMPILER_SERVICE_URL
    ? process.env.DKB_LLAMA_COMPILER_SERVICE_URL.trim().replace(/\/+$/u, '')
    : (await startLlamaIndexCompilerService(options)).url;
  if (!serviceUrl) throw new DkbError('LlamaIndex compiler service did not provide a local URL');
  options.signal?.throwIfAborted();

  const jobId = `job-${randomUUID()}`;
  const jobRoot = path.join(compilerServiceJobsRoot(), jobId);
  const inputRoot = path.join(jobRoot, 'input');
  await fs.mkdir(compilerServiceJobsRoot(), { recursive: true });
  await fs.mkdir(jobRoot);
  try {
    await fs.mkdir(inputRoot);
    await stageCompilerServiceInput(sourceRoot, inputRoot, request);
    options.signal?.throwIfAborted();
  } catch (error) {
    await fs.rm(jobRoot, { recursive: true, force: true });
    throw error;
  }
  return { serviceUrl, jobId, jobRoot };
}

function compilerServiceRoot(): string {
  return path.resolve(process.env.DKB_LLAMA_COMPILER_SERVICE_ROOT ?? path.join(os.homedir(), '.dkb', 'compiler-service'));
}

export function compilerServiceJobsRoot(): string {
  return path.join(compilerServiceRoot(), 'jobs');
}

/** Recovery never starts or replaces a shared service to recover an old job. */
export async function trustedCompilerServiceUrl(options: CompilerServiceOptions): Promise<string | undefined> {
  const configured = process.env.DKB_LLAMA_COMPILER_SERVICE_URL?.trim().replace(/\/+$/u, '');
  return configured ?? (await compilerServiceStatus(options)).url;
}

async function stageCompilerServiceInput(sourceRoot: string, inputRoot: string, request: CompilerServiceRequest): Promise<void> {
  const root = path.resolve(sourceRoot);
  for (const store of request.stores) {
    if (store.type === 'sqlite') {
      await copyContainedFile(root, inputRoot, store.path);
    } else if (store.includePaths?.length) {
      for (const item of store.includePaths) await copyContainedFile(root, inputRoot, item);
    } else {
      const storeRoot = containedSourcePath(root, store.path);
      await copySourceTree(storeRoot, path.join(inputRoot, store.path), root, inputRoot, new Set(store.excludePaths ?? []));
    }
  }
}

async function copyContainedFile(sourceRoot: string, inputRoot: string, relativePath: string): Promise<void> {
  const source = containedSourcePath(sourceRoot, relativePath);
  if (!(await fs.stat(source)).isFile()) throw new DkbError(`Compiler service expected source file: ${relativePath}`);
  const target = path.join(inputRoot, relativePath.replace(/\\/gu, '/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}

async function copySourceTree(source: string, target: string, sourceRoot: string, inputRoot: string, excluded: Set<string>): Promise<void> {
  const entries = await fs.readdir(source, { withFileTypes: true });
  await fs.mkdir(target, { recursive: true });
  for (const entry of entries) {
    if (isExcludedSourceEntry(entry.name)) continue;
    const from = path.join(source, entry.name);
    const relative = path.relative(sourceRoot, from).replace(/\\/gu, '/');
    if (excluded.has(relative)) continue;
    const to = path.join(inputRoot, relative);
    if (entry.isDirectory()) await copySourceTree(from, to, sourceRoot, inputRoot, excluded);
    else if (entry.isFile()) {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to);
    }
  }
}

function containedSourcePath(sourceRoot: string, relativePath: string): string {
  const target = path.resolve(sourceRoot, relativePath);
  const relative = path.relative(sourceRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new DkbError(`Compiler service source path escapes DKB root: ${relativePath}`);
  return target;
}

async function ensureServiceImage(image: string): Promise<void> {
  const hasImage = await dockerImageExists(image);
  const version = hasImage ? await dockerImageLabel(image, 'org.dkb.compiler.service.version').catch(() => undefined) : undefined;
  if (hasImage && version === LLAMAINDEX_COMPILER_SERVICE_VERSION) return;
  await ensureImage(image);
  if (await dockerImageLabel(image, 'org.dkb.compiler.service.version').catch(() => undefined) !== LLAMAINDEX_COMPILER_SERVICE_VERSION) {
    const context = compilerContextPath();
    try {
      await execFile('docker', ['build', '--pull', '--tag', image, context], { timeout: 15 * 60_000, maxBuffer: 20 * 1024 * 1024 });
    } catch (error) {
      throw new DkbError(`Unable to build LlamaIndex compiler service image: ${commandDetail(error)}`);
    }
  }
  if (await dockerImageLabel(image, 'org.dkb.compiler.service.version').catch(() => undefined) !== LLAMAINDEX_COMPILER_SERVICE_VERSION) {
    throw new DkbError(`LlamaIndex compiler image ${image} is missing service version label ${LLAMAINDEX_COMPILER_SERVICE_VERSION}`);
  }
}

async function ensureImage(image: string): Promise<void> {
  if (await dockerImageExists(image)) return;
  const context = compilerContextPath();
  try {
    await fs.access(path.join(context, 'Dockerfile'));
    await execFile('docker', ['build', '--pull', '--tag', image, context], { timeout: 15 * 60_000, maxBuffer: 20 * 1024 * 1024 });
  } catch (error) {
    throw new DkbError(`Unable to prepare LlamaIndex compiler image ${image} from ${context}: ${commandDetail(error)}`);
  }
}

async function dockerImageExists(image: string): Promise<boolean> {
  try {
    await execFile('docker', ['image', 'inspect', image], { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

async function dockerImageLabel(image: string, label: string): Promise<string | undefined> {
  const value = (await execFile('docker', ['image', 'inspect', image, '--format', `{{ index .Config.Labels "${label}" }}`], { timeout: 30_000 })).stdout.trim();
  return value && value !== '<no value>' ? value : undefined;
}

async function inspectServiceContainer(containerName: string): Promise<{
  state: { Running?: boolean };
  config: { Image?: string };
  labels: Record<string, string>;
  imageId: string;
}> {
  const { stdout } = await execFile('docker', ['inspect', containerName], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  const first = (JSON.parse(stdout) as Array<{ State?: { Running?: boolean }; Config?: { Image?: string; Labels?: Record<string, string> }; Image?: string }>)[0];
  if (!first) throw new DkbError(`Compiler service container ${containerName} does not exist`);
  return { state: first.State ?? {}, config: first.Config ?? {}, labels: first.Config?.Labels ?? {}, imageId: first.Image ?? '' };
}

async function serviceHostPort(container: string): Promise<number | undefined> {
  const { stdout } = await execFile('docker', ['port', container, String(SERVICE_PORT)], { timeout: 30_000 });
  const match = /127\.0\.0\.1:(\d+)/u.exec(stdout) ?? /0\.0\.0\.0:(\d+)/u.exec(stdout);
  return match ? Number.parseInt(match[1]!, 10) : undefined;
}

async function serviceHealth(serviceUrl: string): Promise<unknown> {
  const response = await fetch(`${serviceUrl.replace(/\/+$/u, '')}/health`, { signal: AbortSignal.timeout(5_000) });
  const body = await response.json() as unknown;
  if (!response.ok) throw new DkbError(`Compiler service health failed (${response.status}): ${JSON.stringify(body)}`);
  return body;
}

function isHealthyService(value: unknown): boolean {
  return Boolean(value) && typeof value === 'object'
    && (value as { ok?: unknown }).ok === true
    && (value as { serviceVersion?: unknown }).serviceVersion === LLAMAINDEX_COMPILER_SERVICE_VERSION;
}

function serviceVersionFromHealth(value: unknown): string | undefined {
  return value && typeof value === 'object' && typeof (value as { serviceVersion?: unknown }).serviceVersion === 'string'
    ? (value as { serviceVersion: string }).serviceVersion
    : undefined;
}

function compilerContextPath(): string {
  const candidates = [
    path.resolve(process.cwd(), 'providers/evidence-docling-llamaindex/python'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../python'),
  ];
  return candidates.find((candidate) => existsSync(path.join(candidate, 'Dockerfile'))) ?? candidates[0]!;
}

function resolvedServiceOptions(options: CompilerServiceOptions) {
  const image = options.image ?? process.env.DKB_LLAMA_COMPILER_IMAGE ?? LLAMAINDEX_COMPILER_IMAGE;
  const model = options.model ?? process.env.DKB_COMPILER_MODEL ?? 'BAAI/bge-small-en-v1.5';
  return { image, imageDigest: options.imageDigest, model, modelRevision: tokenizerRevision(model, options.modelRevision ?? process.env.DKB_COMPILER_MODEL_REVISION) };
}

function serviceContainerName(options: ReturnType<typeof resolvedServiceOptions>): string {
  const key = createHash('sha256').update(`${options.imageDigest ?? options.image}\0${options.model}\0${options.modelRevision}\0${path.resolve(compilerServiceJobsRoot())}`).digest('hex').slice(0, 12);
  return `${SERVICE_CONTAINER}-${key}`;
}

function isExcludedSourceEntry(name: string): boolean {
  return name === '.dkb' || name === '.git' || name === 'node_modules' || name === 'vendor';
}

function environmentFlag(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function commandDetail(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error) {
    return `${String((error as { stdout?: unknown }).stdout ?? '')}${String((error as { stderr?: unknown }).stderr ?? '')}`.trim();
  }
  return error instanceof Error ? error.message : String(error);
}
