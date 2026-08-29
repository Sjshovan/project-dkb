import { execFile as execFileCallback } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { DKB_CACHE_DIR, resolveFrom } from '@sjshovan/dkb-protocol/paths.js';
import type { LoadedDkb } from '@sjshovan/dkb-protocol/types.js';

const execFile = promisify(execFileCallback);

export const LLAMAINDEX_COMPILER_IMAGE = 'dkb-compiler-llamaindex:0.4.0';
export const LLAMAINDEX_COMPILER_ID = 'llamaindex.docling.evidence';
export const LLAMAINDEX_COMPILER_SERVICE_VERSION = '3';
export const LLAMAINDEX_DOCUMENT_BATCH_SIZE = 32;
const LLAMAINDEX_COMPILER_SERVICE_CONTAINER = 'dkb-llamaindex-compiler-service';
const LLAMAINDEX_COMPILER_SERVICE_PORT = 8091;

export interface LlamaIndexCompilerRecord {
  id: string;
  assetId: string;
  storeId: string;
  type: 'filesystem' | 'sqlite' | 'database';
  locator: Record<string, unknown>;
  assetLocator: Record<string, unknown>;
  title: string;
  text: string;
  hash: string;
  updatedAt: string;
  chunkOrdinal: number;
  chunkStart: number;
  chunkEnd: number;
  metadata: Record<string, unknown>;
  embedding?: number[] | Float32Array;
}

export interface LlamaIndexCompilerResult {
  compiler: {
    id: string;
    model: string;
    image: string;
  };
  execution?: {
    mode?: string;
    workers?: number;
    batching?: {
      documentBatchSize?: number;
      embeddingBatchSize?: number;
      inferenceBatchSize?: number;
      provider?: string;
      recordCount?: number;
    };
    timingsMs?: Record<string, number>;
    wrapperTimingsMs?: Record<string, number>;
  };
  records: LlamaIndexCompilerRecord[];
  cache?: LlamaIndexCompilerCacheStats;
}

export interface LlamaIndexCompilerCacheStats {
  cachePath: string;
  checkpointPath: string;
  cacheHit: boolean;
  resumed: boolean;
  cacheableSources: number;
  changedSources: number;
  reusedSources: number;
  changedSourceKeys: string[];
  reusedSourceKeys: string[];
  compiledRecords: number;
  reusedRecords: number;
}

interface LlamaIndexCompilerOutput {
  format: 'dkb.llamaindex.compile.v2';
  compiler: { id: string; model: string };
  execution?: LlamaIndexCompilerResult['execution'];
  records: LlamaIndexCompilerRecord[];
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

interface LlamaIndexDatabaseSourceRequest {
  id: string;
  kind: 'database';
  connection: string;
  query?: string;
  includeTables?: string[];
}

interface SourceCandidate {
  key: string;
  type: 'filesystem' | 'sqlite';
  storeId: string;
  path: string;
  hash: string;
}

interface LlamaIndexRecordCache {
  version: 1;
  compilerId: typeof LLAMAINDEX_COMPILER_ID;
  model: string;
  dkbId: string;
  dkbVersion: string;
  entries: Record<string, {
    sourceHash: string;
    records: LlamaIndexCompilerRecord[];
  }>;
  updatedAt: string;
}

interface LlamaIndexCompileCheckpoint {
  version: 1;
  compilerId: typeof LLAMAINDEX_COMPILER_ID;
  model: string;
  dkbId: string;
  dkbVersion: string;
  status: 'running' | 'completed';
  startedAt: string;
  updatedAt: string;
  changedSources: Array<Pick<SourceCandidate, 'key' | 'type' | 'storeId' | 'path' | 'hash'>>;
  reusedSources: string[];
}

export async function compileDkbWithLlamaIndex(dkb: LoadedDkb, options: {
  image?: string;
  model?: string;
  timeoutMs?: number;
  workers?: number;
} = {}): Promise<LlamaIndexCompilerResult> {
  const image = options.image ?? process.env.DKB_LLAMA_COMPILER_IMAGE ?? LLAMAINDEX_COMPILER_IMAGE;
  const model = options.model ?? process.env.DKB_COMPILER_MODEL ?? 'BAAI/bge-small-en-v1.5';
  const request = requestFor(dkb);
  const cachePath = llamaIndexCachePath(dkb.root);
  const checkpointPath = llamaIndexCheckpointPath(dkb.root);
  const cacheEnabled = process.env.DKB_LLAMA_RECORD_CACHE === undefined
    || environmentFlag(process.env.DKB_LLAMA_RECORD_CACHE);
  const previousCheckpoint = cacheEnabled ? await readCheckpoint(checkpointPath) : null;
  const cache = cacheEnabled ? await readRecordCache(cachePath, dkb, model) : null;
  const plan = !cacheEnabled || request.externalSources.length > 0
    ? null
    : await cachePlanFor(dkb, request, cache);
  const resumed = previousCheckpoint?.status === 'running';

  if (plan && plan.changed.length === 0 && plan.reusedRecords.length > 0) {
    await writeCheckpoint(checkpointPath, checkpointFor(dkb, model, [], plan.reused.map((item) => item.key), 'completed'));

    return {
      compiler: {
        id: LLAMAINDEX_COMPILER_ID,
        model,
        image,
      },
      execution: {
        mode: 'cached',
        workers: 0,
        timingsMs: {
          total: 0,
        },
      },
      records: plan.reusedRecords.sort(compareRecords),
      cache: {
        cachePath,
        checkpointPath,
        cacheHit: true,
        resumed,
        cacheableSources: plan.candidates.length,
        changedSources: 0,
        reusedSources: plan.reused.length,
        changedSourceKeys: [],
        reusedSourceKeys: plan.reused.map((item) => item.key),
        compiledRecords: 0,
        reusedRecords: plan.reusedRecords.length,
      },
    };
  }

  const requestToCompile = plan ? requestForChangedSources(request, plan.changed) : request;

  await writeCheckpoint(checkpointPath, checkpointFor(dkb, model, plan?.changed ?? [], plan?.reused.map((item) => item.key) ?? [], 'running'));

  if (process.env.DKB_TEST_ABORT_LLAMA_AFTER_CHECKPOINT === '1') {
    throw new DkbError(`Aborted LlamaIndex compile after checkpoint at ${checkpointPath}`);
  }

  const serviceJob = await maybePrepareCompilerServiceJob(dkb.root, requestToCompile, {
    image,
    model,
    timeoutMs: options.timeoutMs,
    workers: options.workers,
  });
  if (serviceJob) {
    const serviceStart = performance.now();
    let parsed: LlamaIndexCompilerOutput;
    try {
      parsed = await runCompilerService(serviceJob.serviceUrl, requestToCompile, {
        jobId: serviceJob.jobId,
        model,
        timeoutMs: options.timeoutMs,
        workers: options.workers,
      });
    } finally {
      await fs.rm(serviceJob.jobRoot, { recursive: true, force: true });
    }
    const records = plan
      ? [...plan.reusedRecords, ...parsed.records].sort(compareRecords)
      : parsed.records.sort(compareRecords);

    if (plan) {
      await writeRecordCache(cachePath, dkb, model, plan.candidates, records);
    }
    await writeCheckpoint(checkpointPath, checkpointFor(dkb, model, plan?.changed ?? [], plan?.reused.map((item) => item.key) ?? [], 'completed'));

    return {
      compiler: {
        id: LLAMAINDEX_COMPILER_ID,
        model: parsed.compiler.model,
        image,
      },
      execution: {
        ...parsed.execution,
        wrapperTimingsMs: {
          serviceRequest: elapsedMs(serviceStart),
          total: elapsedMs(serviceStart),
        },
      },
      records,
      cache: {
        cachePath,
        checkpointPath,
        cacheHit: false,
        resumed,
        cacheableSources: plan?.candidates.length ?? 0,
        changedSources: plan?.changed.length ?? 0,
        reusedSources: plan?.reused.length ?? 0,
        changedSourceKeys: plan?.changed.map((item) => item.key) ?? [],
        reusedSourceKeys: plan?.reused.map((item) => item.key) ?? [],
        compiledRecords: parsed.records.length,
        reusedRecords: plan?.reusedRecords.length ?? 0,
      },
    };
  }

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-llamaindex-'));
  const requestDir = path.join(scratch, 'request');
  const outputDir = path.join(scratch, 'output');
  const wrapperStart = performance.now();
  let requestWriteMs = 0;
  let imageMs = 0;
  let containerMs = 0;
  let outputReadMs = 0;

  try {
    const requestStart = performance.now();
    await fs.mkdir(requestDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(requestDir, 'request.json'), `${JSON.stringify(requestToCompile, null, 2)}\n`, 'utf8');
    requestWriteMs = elapsedMs(requestStart);
    const imageStart = performance.now();
    await ensureImage(image);
    imageMs = elapsedMs(imageStart);
    const containerStart = performance.now();
    await runCompiler(image, dkb.root, requestDir, outputDir, {
      model,
      timeoutMs: options.timeoutMs,
      workers: options.workers,
    });
    containerMs = elapsedMs(containerStart);
    const outputReadStart = performance.now();
    const parsed = await readCompilerOutput(outputDir);
    outputReadMs = elapsedMs(outputReadStart);
    const records = plan
      ? [...plan.reusedRecords, ...parsed.records].sort(compareRecords)
      : parsed.records.sort(compareRecords);

    if (plan) {
      await writeRecordCache(cachePath, dkb, model, plan.candidates, records);
    }
    await writeCheckpoint(checkpointPath, checkpointFor(dkb, model, plan?.changed ?? [], plan?.reused.map((item) => item.key) ?? [], 'completed'));

    return {
      compiler: {
        id: LLAMAINDEX_COMPILER_ID,
        model: parsed.compiler.model,
        image,
      },
      execution: {
        ...parsed.execution,
        wrapperTimingsMs: {
          requestWrite: requestWriteMs,
          image: imageMs,
          container: containerMs,
          outputRead: outputReadMs,
          total: elapsedMs(wrapperStart),
        },
      },
      records,
      cache: {
        cachePath,
        checkpointPath,
        cacheHit: false,
        resumed,
        cacheableSources: plan?.candidates.length ?? 0,
        changedSources: plan?.changed.length ?? 0,
        reusedSources: plan?.reused.length ?? 0,
        changedSourceKeys: plan?.changed.map((item) => item.key) ?? [],
        reusedSourceKeys: plan?.reused.map((item) => item.key) ?? [],
        compiledRecords: parsed.records.length,
        reusedRecords: plan?.reusedRecords.length ?? 0,
      },
    };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

export async function inspectLlamaIndexCompiler(): Promise<LlamaIndexCompilerInspection> {
  const image = process.env.DKB_LLAMA_COMPILER_IMAGE ?? LLAMAINDEX_COMPILER_IMAGE;
  let status: LlamaIndexCompilerServiceStatus | null = null;

  try {
    await execFile('docker', ['--version'], { timeout: 30_000 });
  } catch {
    return { docker: false, image, available: false, serviceReady: false };
  }

  const available = await dockerImageExists(image);
  status = await compilerServiceStatus({ image }).catch(() => null);

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

export async function compilerServiceStatus(options: { image?: string } = {}): Promise<LlamaIndexCompilerServiceStatus> {
  const image = options.image ?? process.env.DKB_LLAMA_COMPILER_IMAGE ?? LLAMAINDEX_COMPILER_IMAGE;
  try {
    await execFile('docker', ['--version'], { timeout: 30_000 });
  } catch {
    return {
      docker: false,
      image,
      container: LLAMAINDEX_COMPILER_SERVICE_CONTAINER,
      running: false,
      ready: false,
      drift: ['docker_unavailable'],
    };
  }

  const expectedImageId = await dockerImageId(image).catch(() => undefined);
  const container = await inspectServiceContainer().catch(() => null);
  const running = container?.state.Running === true;
  const port = running ? await serviceHostPort(LLAMAINDEX_COMPILER_SERVICE_CONTAINER).catch(() => undefined) : undefined;
  const url = port ? `http://127.0.0.1:${port}` : undefined;
  const drift: string[] = [];

  if (!expectedImageId) {
    drift.push('image_missing');
  }
  if (container) {
    if (container.config.Image && container.config.Image !== image) {
      drift.push('image_tag_mismatch');
    }
    if (expectedImageId && container.imageId && container.imageId !== expectedImageId) {
      drift.push('image_id_mismatch');
    }
    if (container.labels['org.dkb.compiler.service.version'] !== LLAMAINDEX_COMPILER_SERVICE_VERSION) {
      drift.push('service_version_mismatch');
    }
    if (container.labels['org.dkb.compiler.jobs-root'] !== path.resolve(compilerServiceJobsRoot())) {
      drift.push('jobs_root_mismatch');
    }
  }

  let health: unknown;
  let ready = false;
  let serviceVersion: string | undefined;
  if (url) {
    health = await serviceHealth(url).catch((error) => ({ ok: false, error: commandDetail(error) }));
    ready = isHealthyService(health);
    serviceVersion = serviceVersionFromHealth(health);
    if (!ready) {
      drift.push('service_unhealthy');
    }
    if (serviceVersion && serviceVersion !== LLAMAINDEX_COMPILER_SERVICE_VERSION) {
      drift.push('health_version_mismatch');
    }
  }

  return {
    docker: true,
    image,
    container: LLAMAINDEX_COMPILER_SERVICE_CONTAINER,
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

export async function startLlamaIndexCompilerService(options: {
  image?: string;
  model?: string;
  forceRestart?: boolean;
} = {}): Promise<LlamaIndexCompilerServiceStatus> {
  const image = options.image ?? process.env.DKB_LLAMA_COMPILER_IMAGE ?? LLAMAINDEX_COMPILER_IMAGE;
  await ensureServiceImage(image);
  const current = await compilerServiceStatus({ image });

  if (current.ready && current.drift.length === 0 && !options.forceRestart) {
    return current;
  }

  // A stopped container still owns its name. Once the ready fast-path above
  // fails, remove any prior instance before creating the replacement.
  await stopLlamaIndexCompilerService();

  const jobsRoot = compilerServiceJobsRoot();
  await fs.mkdir(jobsRoot, { recursive: true });

  try {
    await execFile('docker', [
      'run',
      '-d',
      ...(environmentFlag(process.env.DKB_LLAMA_GPU) ? ['--gpus', 'all'] : []),
      '--name',
      LLAMAINDEX_COMPILER_SERVICE_CONTAINER,
      '--label',
      `org.dkb.compiler.service.version=${LLAMAINDEX_COMPILER_SERVICE_VERSION}`,
      '--label',
      `org.dkb.compiler.jobs-root=${path.resolve(jobsRoot)}`,
      '--label',
      'org.dkb.component=llamaindex-compiler-service',
      '-p',
      `127.0.0.1::${LLAMAINDEX_COMPILER_SERVICE_PORT}`,
      '--mount',
      `type=bind,src=${path.resolve(jobsRoot)},dst=/jobs`,
      '-e',
      `DKB_COMPILER_MODEL=${options.model ?? process.env.DKB_COMPILER_MODEL ?? 'BAAI/bge-small-en-v1.5'}`,
      '-e',
      `DKB_LLAMA_DOCUMENT_BATCH_SIZE=${process.env.DKB_LLAMA_DOCUMENT_BATCH_SIZE ?? String(LLAMAINDEX_DOCUMENT_BATCH_SIZE)}`,
      '-e',
      'DKB_COMPILER_JOBS_ROOT=/jobs',
      '--entrypoint',
      'python',
      image,
      '-m',
      'uvicorn',
      'service:app',
      '--host',
      '0.0.0.0',
      '--port',
      String(LLAMAINDEX_COMPILER_SERVICE_PORT),
    ], {
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    throw new DkbError(`Unable to start LlamaIndex compiler service. Ensure Docker is running and image ${image} can run locally: ${commandDetail(error)}`);
  }

  const deadline = performance.now() + 60_000;
  let lastStatus = await compilerServiceStatus({ image });
  while (performance.now() < deadline) {
    lastStatus = await compilerServiceStatus({ image });
    if (lastStatus.ready && lastStatus.drift.length === 0) {
      return lastStatus;
    }
    await sleep(250);
  }

  throw new DkbError(`LlamaIndex compiler service did not become ready. Last status: ${JSON.stringify(lastStatus)}`);
}

export async function stopLlamaIndexCompilerService(): Promise<LlamaIndexCompilerServiceStatus> {
  const image = process.env.DKB_LLAMA_COMPILER_IMAGE ?? LLAMAINDEX_COMPILER_IMAGE;

  try {
    await execFile('docker', ['rm', '-f', LLAMAINDEX_COMPILER_SERVICE_CONTAINER], {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    const detail = commandDetail(error);

    if (!/no such (container|object)/iu.test(detail)) {
      throw new DkbError(`Unable to stop LlamaIndex compiler service: ${detail}`);
    }
  }

  return compilerServiceStatus({ image });
}

export async function doctorLlamaIndexCompilerService(): Promise<{
  ok: boolean;
  status: LlamaIndexCompilerServiceStatus;
  actions: string[];
}> {
  const image = process.env.DKB_LLAMA_COMPILER_IMAGE ?? LLAMAINDEX_COMPILER_IMAGE;
  const status = await compilerServiceStatus({ image });
  const actions: string[] = [];

  if (!status.docker) {
    actions.push('Start Docker Desktop, then run `dkb compiler start`.');
  }
  if (status.drift.includes('image_missing')) {
    actions.push(`Build or allow DKB to build the compiler image: ${image}.`);
  }
  if (status.drift.some((item) => item.endsWith('_mismatch'))) {
    actions.push('Run `dkb compiler start --restart` to replace the stale compiler service.');
  }
  if (status.docker && !status.ready) {
    actions.push('Run `dkb compiler start` and retry the compile.');
  }

  return {
    ok: status.ready && status.drift.length === 0,
    status,
    actions,
  };
}

async function maybePrepareCompilerServiceJob(
  sourceRoot: string,
  request: ReturnType<typeof requestFor>,
  options: { image: string; model: string; timeoutMs?: number; workers?: number },
): Promise<{ serviceUrl: string; jobId: string; jobRoot: string } | null> {
  if (process.env.DKB_LLAMA_COMPILER_SERVICE === '0' || process.env.DKB_LLAMA_COMPILER_SERVICE === 'false') {
    return null;
  }

  const serviceUrl = process.env.DKB_LLAMA_COMPILER_SERVICE_URL
    ? process.env.DKB_LLAMA_COMPILER_SERVICE_URL.trim().replace(/\/+$/, '')
    : (await startLlamaIndexCompilerService({
        image: options.image,
        model: options.model,
      })).url;

  if (!serviceUrl) {
    throw new DkbError('LlamaIndex compiler service did not provide a local URL');
  }

  const jobId = `job-${process.pid}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const jobRoot = path.join(compilerServiceJobsRoot(), jobId);
  const inputRoot = path.join(jobRoot, 'input');

  await fs.rm(jobRoot, { recursive: true, force: true });
  await fs.mkdir(inputRoot, { recursive: true });

  try {
    await stageCompilerServiceInput(sourceRoot, inputRoot, request);
  } catch (error) {
    await fs.rm(jobRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    serviceUrl,
    jobId,
    jobRoot,
  };
}

async function stageCompilerServiceInput(sourceRoot: string, inputRoot: string, request: ReturnType<typeof requestFor>): Promise<void> {
  const root = path.resolve(sourceRoot);

  for (const store of request.stores) {
    if (store.type === 'sqlite') {
      await copyContainedFile(root, inputRoot, store.path);
      continue;
    }

    if (store.includePaths?.length) {
      for (const item of store.includePaths) {
        await copyContainedFile(root, inputRoot, item);
      }
      continue;
    }

    const storeRoot = containedSourcePath(root, store.path);
    await copySourceTree(storeRoot, path.join(inputRoot, store.path), root, inputRoot, new Set(store.excludePaths ?? []));
  }
}

async function copyContainedFile(sourceRoot: string, inputRoot: string, relativePath: string): Promise<void> {
  const source = containedSourcePath(sourceRoot, relativePath);
  const stat = await fs.stat(source);

  if (!stat.isFile()) {
    throw new DkbError(`Compiler service expected source file: ${relativePath}`);
  }

  const target = path.join(inputRoot, relativePath.replace(/\\/g, '/'));

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}

async function copySourceTree(source: string, target: string, sourceRoot: string, inputRoot: string, excluded: Set<string>): Promise<void> {
  const entries = await fs.readdir(source, { withFileTypes: true });

  await fs.mkdir(target, { recursive: true });
  for (const entry of entries) {
    if (isExcludedSourceEntry(entry.name)) {
      continue;
    }
    const from = path.join(source, entry.name);
    const relative = path.relative(sourceRoot, from).replace(/\\/g, '/');
    if (excluded.has(relative)) {
      continue;
    }
    const to = path.join(inputRoot, relative);

    if (entry.isDirectory()) {
      await copySourceTree(from, to, sourceRoot, inputRoot, excluded);
    } else if (entry.isFile()) {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to);
    }
  }
}

function containedSourcePath(sourceRoot: string, relativePath: string): string {
  const target = path.resolve(sourceRoot, relativePath);
  const relative = path.relative(sourceRoot, target);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new DkbError(`Compiler service source path escapes DKB root: ${relativePath}`);
  }

  return target;
}

function compilerServiceRoot(): string {
  return path.resolve(process.env.DKB_LLAMA_COMPILER_SERVICE_ROOT ?? path.join(os.homedir(), '.dkb', 'compiler-service'));
}

function compilerServiceJobsRoot(): string {
  return path.join(compilerServiceRoot(), 'jobs');
}

async function ensureServiceImage(image: string): Promise<void> {
  const hasImage = await dockerImageExists(image);
  const version = hasImage ? await dockerImageLabel(image, 'org.dkb.compiler.service.version').catch(() => undefined) : undefined;

  if (hasImage && version === LLAMAINDEX_COMPILER_SERVICE_VERSION) {
    return;
  }

  await ensureImage(image);

  const rebuiltVersion = await dockerImageLabel(image, 'org.dkb.compiler.service.version').catch(() => undefined);
  if (rebuiltVersion !== LLAMAINDEX_COMPILER_SERVICE_VERSION) {
    const context = compilerContextPath();
    try {
      await execFile('docker', ['build', '--pull', '--tag', image, context], {
        timeout: 15 * 60_000,
        maxBuffer: 20 * 1024 * 1024,
      });
    } catch (error) {
      throw new DkbError(`Unable to build LlamaIndex compiler service image: ${commandDetail(error)}`);
    }
  }

  const finalVersion = await dockerImageLabel(image, 'org.dkb.compiler.service.version').catch(() => undefined);
  if (finalVersion !== LLAMAINDEX_COMPILER_SERVICE_VERSION) {
    throw new DkbError(`LlamaIndex compiler image ${image} is missing service version label ${LLAMAINDEX_COMPILER_SERVICE_VERSION}`);
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

async function dockerImageId(image: string): Promise<string> {
  const { stdout } = await execFile('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { timeout: 30_000 });

  return stdout.trim();
}

async function dockerImageLabel(image: string, label: string): Promise<string | undefined> {
  const { stdout } = await execFile('docker', ['image', 'inspect', image, '--format', `{{ index .Config.Labels "${label}" }}`], { timeout: 30_000 });
  const value = stdout.trim();

  return value && value !== '<no value>' ? value : undefined;
}

async function inspectServiceContainer(): Promise<{
  state: { Running?: boolean };
  config: { Image?: string };
  labels: Record<string, string>;
  imageId: string;
}> {
  const { stdout } = await execFile('docker', ['inspect', LLAMAINDEX_COMPILER_SERVICE_CONTAINER], {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as Array<{
    State?: { Running?: boolean };
    Config?: { Image?: string; Labels?: Record<string, string> };
    Image?: string;
  }>;
  const first = parsed[0];

  if (!first) {
    throw new DkbError(`Compiler service container ${LLAMAINDEX_COMPILER_SERVICE_CONTAINER} does not exist`);
  }

  return {
    state: first.State ?? {},
    config: first.Config ?? {},
    labels: first.Config?.Labels ?? {},
    imageId: first.Image ?? '',
  };
}

async function serviceHostPort(container: string): Promise<number | undefined> {
  const { stdout } = await execFile('docker', ['port', container, String(LLAMAINDEX_COMPILER_SERVICE_PORT)], { timeout: 30_000 });
  const match = /127\.0\.0\.1:(\d+)/.exec(stdout) ?? /0\.0\.0\.0:(\d+)/.exec(stdout);

  return match ? Number.parseInt(match[1]!, 10) : undefined;
}

async function serviceHealth(serviceUrl: string): Promise<unknown> {
  const response = await fetch(`${serviceUrl.replace(/\/+$/, '')}/health`, {
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.json() as unknown;

  if (!response.ok) {
    throw new DkbError(`Compiler service health failed (${response.status}): ${JSON.stringify(body)}`);
  }

  return body;
}

function isHealthyService(value: unknown): boolean {
  return Boolean(value)
    && typeof value === 'object'
    && (value as { ok?: unknown }).ok === true
    && (value as { serviceVersion?: unknown }).serviceVersion === LLAMAINDEX_COMPILER_SERVICE_VERSION;
}

function serviceVersionFromHealth(value: unknown): string | undefined {
  return value && typeof value === 'object' && typeof (value as { serviceVersion?: unknown }).serviceVersion === 'string'
    ? (value as { serviceVersion: string }).serviceVersion
    : undefined;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function requestFor(dkb: LoadedDkb): {
  dkbId: string;
  version: string;
  stores: Array<{
    id: string;
    type: 'filesystem' | 'sqlite';
    path: string;
    includePaths?: string[];
    excludePaths?: string[];
  }>;
  externalSources: LlamaIndexDatabaseSourceRequest[];
} {
  const stores = (dkb.manifest.stores ?? []).flatMap((store) => {
    if ((store.type !== 'filesystem' && store.type !== 'sqlite') || !store.path || store.permissions?.read === false) {
      return [];
    }

    const includePaths = Array.isArray(store.meta?.includePaths)
      ? store.meta.includePaths.filter((item): item is string => typeof item === 'string')
      : undefined;
    const excludePaths = Array.isArray(store.meta?.claimedByAdapters)
      ? store.meta.claimedByAdapters.filter((item): item is string => typeof item === 'string')
      : undefined;

    return [{
      id: store.id,
      type: store.type,
      path: store.path.replace(/^\.\//, '').replace(/\\/g, '/'),
      ...(includePaths && includePaths.length > 0 ? { includePaths } : {}),
      ...(excludePaths && excludePaths.length > 0 ? { excludePaths } : {}),
    }];
  });

  const externalSources = externalDatabaseSourcesFor(dkb);

  if (stores.length === 0 && externalSources.length === 0) {
    throw new DkbError(`DKB ${dkb.manifest.id} has no readable local sources or configured LlamaIndex database sources`);
  }

  return {
    dkbId: dkb.manifest.id,
    version: dkb.manifest.version,
    stores,
    externalSources,
  };
}

async function cachePlanFor(
  dkb: LoadedDkb,
  request: ReturnType<typeof requestFor>,
  cache: LlamaIndexRecordCache | null,
): Promise<{
  candidates: SourceCandidate[];
  changed: SourceCandidate[];
  reused: SourceCandidate[];
  reusedRecords: LlamaIndexCompilerRecord[];
}> {
  const candidates = (await Promise.all(request.stores.map((store) => sourceCandidatesForStore(dkb, store)))).flat()
    .sort((left, right) => left.key.localeCompare(right.key));
  const changed: SourceCandidate[] = [];
  const reused: SourceCandidate[] = [];
  const reusedRecords: LlamaIndexCompilerRecord[] = [];

  for (const candidate of candidates) {
    const entry = cache?.entries[candidate.key];

    if (entry && entry.sourceHash === candidate.hash) {
      reused.push(candidate);
      reusedRecords.push(...entry.records);
    } else {
      changed.push(candidate);
    }
  }

  return {
    candidates,
    changed,
    reused,
    reusedRecords,
  };
}

async function sourceCandidatesForStore(
  dkb: LoadedDkb,
  store: ReturnType<typeof requestFor>['stores'][number],
): Promise<SourceCandidate[]> {
  const absolute = path.resolve(dkb.root, store.path);

  if (store.type === 'sqlite') {
    return [{
      key: sourceCacheKey(dkb, store.id, store.type, store.path),
      type: store.type,
      storeId: store.id,
      path: store.path,
      hash: await hashFile(absolute),
    }];
  }

  const included = store.includePaths?.length
    ? store.includePaths.map((item) => path.resolve(dkb.root, item))
    : await listSourceFiles(absolute);
  const excluded = new Set(
    (store.excludePaths ?? []).map((item) => path.resolve(dkb.root, item)),
  );

  return Promise.all(included.filter((file) => !excluded.has(path.resolve(file))).map(async (file) => {
    const relative = path.relative(dkb.root, file).replace(/\\/g, '/');

    return {
      key: sourceCacheKey(dkb, store.id, store.type, relative),
      type: store.type,
      storeId: store.id,
      path: relative,
      hash: await hashFile(file),
    };
  }));
}

function requestForChangedSources(
  request: ReturnType<typeof requestFor>,
  changed: SourceCandidate[],
): ReturnType<typeof requestFor> {
  const changedByStore = new Map<string, SourceCandidate[]>();

  for (const candidate of changed) {
    const existing = changedByStore.get(candidate.storeId) ?? [];
    existing.push(candidate);
    changedByStore.set(candidate.storeId, existing);
  }

  const stores = request.stores.flatMap((store) => {
    const changedForStore = changedByStore.get(store.id) ?? [];

    if (changedForStore.length === 0) {
      return [];
    }

    if (store.type === 'filesystem') {
      return [{
        ...store,
        includePaths: changedForStore.map((item) => item.path).sort((left, right) => left.localeCompare(right)),
      }];
    }

    return [store];
  });

  if (stores.length === 0 && request.externalSources.length === 0) {
    throw new DkbError('LlamaIndex compiler cache plan selected no changed sources to compile');
  }

  return {
    ...request,
    stores,
  };
}

async function listSourceFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.flatMap(async (entry) => {
    if (isExcludedSourceEntry(entry.name)) {
      return [];
    }
    const target = path.join(root, entry.name);

    if (entry.isDirectory()) {
      return listSourceFiles(target);
    }

    return entry.isFile() ? [target] : [];
  }));

  return nested.flat().sort((left, right) => left.localeCompare(right));
}

function isExcludedSourceEntry(name: string): boolean {
  return name.startsWith('.')
    || name === 'dkb.json'
    || name === 'dkb-lock.json'
    || name === 'dkb-profile.lock.json'
    || name === 'dkb-release.json'
    || name === '.dkb-package.json';
}

function sourceCacheKey(dkb: LoadedDkb, storeId: string, type: SourceCandidate['type'], sourcePath: string): string {
  return `${dkb.manifest.id}:${dkb.manifest.version}:${storeId}:${type}:${sourcePath.replace(/\\/g, '/')}`;
}

async function readRecordCache(cachePath: string, dkb: LoadedDkb, model: string): Promise<LlamaIndexRecordCache | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath, 'utf8')) as unknown;

    if (!isRecordCache(parsed) || parsed.dkbId !== dkb.manifest.id || parsed.dkbVersion !== dkb.manifest.version || parsed.model !== model) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

async function writeRecordCache(
  cachePath: string,
  dkb: LoadedDkb,
  model: string,
  candidates: SourceCandidate[],
  records: LlamaIndexCompilerRecord[],
): Promise<void> {
  const entries: LlamaIndexRecordCache['entries'] = {};
  const candidatesByPath = new Map(candidates.map((candidate) => [`${candidate.storeId}:${candidate.type}:${candidate.path}`, candidate]));

  for (const record of records) {
    const sourcePath = typeof record.metadata.dkb_path === 'string' ? record.metadata.dkb_path : undefined;
    const candidate = sourcePath ? candidatesByPath.get(`${record.storeId}:${record.type}:${sourcePath}`) : undefined;

    if (!candidate) {
      continue;
    }

    const entry = entries[candidate.key] ?? {
      sourceHash: candidate.hash,
      records: [],
    };
    entry.records.push(record);
    entries[candidate.key] = entry;
  }

  const cache: LlamaIndexRecordCache = {
    version: 1,
    compilerId: LLAMAINDEX_COMPILER_ID,
    model,
    dkbId: dkb.manifest.id,
    dkbVersion: dkb.manifest.version,
    entries,
    updatedAt: new Date().toISOString(),
  };

  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await writeJsonAtomic(cachePath, cache);
}

function isRecordCache(value: unknown): value is LlamaIndexRecordCache {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<LlamaIndexRecordCache>;

  return candidate.version === 1
    && candidate.compilerId === LLAMAINDEX_COMPILER_ID
    && typeof candidate.model === 'string'
    && typeof candidate.dkbId === 'string'
    && typeof candidate.dkbVersion === 'string'
    && Boolean(candidate.entries)
    && typeof candidate.entries === 'object'
    && !Array.isArray(candidate.entries);
}

async function readCheckpoint(checkpointPath: string): Promise<LlamaIndexCompileCheckpoint | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(checkpointPath, 'utf8')) as unknown;

    return isCheckpoint(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function checkpointFor(
  dkb: LoadedDkb,
  model: string,
  changedSources: SourceCandidate[],
  reusedSources: string[],
  status: LlamaIndexCompileCheckpoint['status'],
): LlamaIndexCompileCheckpoint {
  const now = new Date().toISOString();

  return {
    version: 1,
    compilerId: LLAMAINDEX_COMPILER_ID,
    model,
    dkbId: dkb.manifest.id,
    dkbVersion: dkb.manifest.version,
    status,
    startedAt: now,
    updatedAt: now,
    changedSources: changedSources.map(({ key, type, storeId, path, hash }) => ({ key, type, storeId, path, hash })),
    reusedSources,
  };
}

async function writeCheckpoint(checkpointPath: string, checkpoint: LlamaIndexCompileCheckpoint): Promise<void> {
  await fs.mkdir(path.dirname(checkpointPath), { recursive: true });
  await writeJsonAtomic(checkpointPath, checkpoint);
}

function isCheckpoint(value: unknown): value is LlamaIndexCompileCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<LlamaIndexCompileCheckpoint>;

  return candidate.version === 1
    && candidate.compilerId === LLAMAINDEX_COMPILER_ID
    && (candidate.status === 'running' || candidate.status === 'completed')
    && Array.isArray(candidate.changedSources)
    && Array.isArray(candidate.reusedSources);
}

function llamaIndexCachePath(root: string): string {
  return resolveFrom(root, `${DKB_CACHE_DIR}/llamaindex-record-cache.json`);
}

function llamaIndexCheckpointPath(root: string): string {
  return resolveFrom(root, `${DKB_CACHE_DIR}/llamaindex-job.json`);
}

async function readCompilerOutput(outputDir: string): Promise<LlamaIndexCompilerOutput> {
  const metadataPath = path.join(outputDir, 'llamaindex-compiled.meta.json');
  if (existsSync(metadataPath)) {
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as Record<string, unknown>;
    const recordsFile = typeof metadata.recordsFile === 'string' ? metadata.recordsFile : '';
    const resolvedOutputDir = path.resolve(outputDir);
    const recordsPath = path.resolve(resolvedOutputDir, recordsFile);

    if (!recordsFile || path.dirname(recordsPath) !== resolvedOutputDir) {
      throw new DkbError(`Invalid streamed LlamaIndex records path in ${metadataPath}`);
    }

    const records: LlamaIndexCompilerRecord[] = [];
    const lines = createInterface({
      input: createReadStream(recordsPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }
      const record = JSON.parse(line) as LlamaIndexCompilerRecord;
      if (Array.isArray(record.embedding)) {
        record.embedding = Float32Array.from(record.embedding);
      }
      records.push(record);
    }

    if (typeof metadata.recordCount === 'number' && metadata.recordCount !== records.length) {
      throw new DkbError(`Streamed LlamaIndex record count mismatch: expected ${metadata.recordCount}, got ${records.length}`);
    }

    return parseOutput({ ...metadata, records }, metadataPath);
  }

  const outputPath = path.join(outputDir, 'llamaindex-compiled.json');
  return parseOutput(JSON.parse(await fs.readFile(outputPath, 'utf8')) as unknown, outputPath);
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const tempPath = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;

  await fs.writeFile(tempPath, `${JSON.stringify(value, float32JsonReplacer, 2)}\n`, 'utf8');
  await fs.rm(target, { force: true });
  await fs.rename(tempPath, target);
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');

  hash.update(await fs.readFile(file));

  return `sha256:${hash.digest('hex')}`;
}

function compareRecords(left: LlamaIndexCompilerRecord, right: LlamaIndexCompilerRecord): number {
  return left.id.localeCompare(right.id);
}

function elapsedMs(start: number): number {
  return Math.round((performance.now() - start) * 1000) / 1000;
}

function externalDatabaseSourcesFor(dkb: LoadedDkb): LlamaIndexDatabaseSourceRequest[] {
  const config = dkb.manifest.meta?.llamaIndex;
  const sources = config && typeof config === 'object' && Array.isArray((config as { sources?: unknown }).sources)
    ? (config as { sources: unknown[] }).sources
    : [];

  return sources.map((value, index) => {
    if (!value || typeof value !== 'object') {
      throw new DkbError(`meta.llamaIndex.sources[${index}] must be an object`);
    }
    const source = value as Record<string, unknown>;
    if (source.kind !== 'database' || typeof source.id !== 'string' || source.id.length === 0) {
      throw new DkbError(`meta.llamaIndex.sources[${index}] must declare id and kind: "database"`);
    }
    const envName = typeof source.connectionEnv === 'string' ? source.connectionEnv : undefined;
    const direct = typeof source.connection === 'string' ? source.connection : undefined;
    const connection = envName ? process.env[envName] : direct;
    if (!connection) {
      throw new DkbError(`Database source ${source.id} requires ${envName ? `environment variable ${envName}` : 'connectionEnv'}`);
    }
    if (direct && !envName && source.developmentOnly !== true) {
      throw new DkbError(`Database source ${source.id} has an inline connection. Use connectionEnv, or set developmentOnly: true for local-only testing.`);
    }
    const includeTables = Array.isArray(source.includeTables)
      ? source.includeTables.filter((item): item is string => typeof item === 'string')
      : undefined;

    return {
      id: source.id,
      kind: 'database' as const,
      connection: connectionForCompiler(dkb.root, connection),
      ...(typeof source.query === 'string' ? { query: source.query } : {}),
      ...(includeTables?.length ? { includeTables } : {}),
    };
  });
}

function connectionForCompiler(root: string, connection: string): string {
  const localSqlite = /^sqlite:\/\/\/(.+)$/i.exec(connection);
  if (!localSqlite) {
    return connection;
  }
  const sourcePath = path.resolve(localSqlite[1]!.replace(/^\//, ''));
  const relative = path.relative(root, sourcePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return connection;
  }

  return `sqlite:////input/${relative.replace(/\\/g, '/')}`;
}

async function ensureImage(image: string): Promise<void> {
  try {
    await execFile('docker', ['image', 'inspect', image], { timeout: 30_000 });
    return;
  } catch {
    // Build from the compiler source included with the CLI package.
  }

  const context = compilerContextPath();
  try {
    await fs.access(path.join(context, 'Dockerfile'));
  } catch {
    throw new DkbError(`LlamaIndex compiler image ${image} is not present and compiler build context is missing at ${context}`);
  }

  try {
    await execFile('docker', ['build', '--pull', '--tag', image, context], {
      timeout: 15 * 60_000,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    throw new DkbError(`Unable to build LlamaIndex compiler image: ${commandDetail(error)}`);
  }
}

async function runCompiler(
  image: string,
  inputRoot: string,
  requestDir: string,
  outputDir: string,
  options: { model?: string; timeoutMs?: number; workers?: number },
): Promise<void> {
  const args = [
    'run', '--rm',
    ...(environmentFlag(process.env.DKB_LLAMA_GPU) ? ['--gpus', 'all'] : []),
    '--mount', `type=bind,src=${path.resolve(inputRoot)},dst=/input,readonly`,
    '--mount', `type=bind,src=${path.resolve(requestDir)},dst=/request,readonly`,
    '--mount', `type=bind,src=${path.resolve(outputDir)},dst=/output`,
    image,
  ];
  const env = [
    options.model ? `DKB_COMPILER_MODEL=${options.model}` : null,
    `DKB_LLAMA_ASYNC_WORKERS=${boundedWorkerCount(options.workers ?? Number(process.env.DKB_LLAMA_ASYNC_WORKERS ?? 1))}`,
    `DKB_LLAMA_DOCUMENT_BATCH_SIZE=${process.env.DKB_LLAMA_DOCUMENT_BATCH_SIZE ?? String(LLAMAINDEX_DOCUMENT_BATCH_SIZE)}`,
  ].filter((value): value is string => Boolean(value));

  for (const item of env.reverse()) {
    args.splice(2, 0, '-e', item);
  }

  try {
    await execFile('docker', args, {
      timeout: boundedCompilerTimeout(options.timeoutMs),
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    throw new DkbError(`LlamaIndex compiler container failed: ${commandDetail(error)}`);
  }
}

async function runCompilerService(
  serviceUrl: string,
  request: ReturnType<typeof requestFor>,
  options: { jobId: string; model?: string; timeoutMs?: number; workers?: number },
): Promise<LlamaIndexCompilerOutput> {
  const endpoint = compilerServiceEndpoint(serviceUrl);
  const timeoutMs = boundedCompilerTimeout(options.timeoutMs);
  let response: { ok: boolean; status: number; text: string };

  try {
    response = await postCompilerRequest(endpoint, JSON.stringify({
        jobId: options.jobId,
        request,
        model: options.model,
        workers: boundedWorkerCount(options.workers ?? Number(process.env.DKB_LLAMA_ASYNC_WORKERS ?? 1)),
      }), timeoutMs);
  } catch (error) {
    const cause = error instanceof Error && error.cause
      ? ` (${commandDetail(error.cause)})`
      : '';
    throw new DkbError(`LlamaIndex compiler service request failed after at most ${timeoutMs}ms: ${commandDetail(error)}${cause}`);
  }

  const text = response.text;

  if (!response.ok) {
    throw new DkbError(`LlamaIndex compiler service failed (${response.status}): ${text}`);
  }

  try {
    return parseOutput(JSON.parse(text) as unknown, endpoint);
  } catch (error) {
    throw error instanceof DkbError
      ? error
      : new DkbError(`Invalid LlamaIndex compiler service response at ${endpoint}: ${commandDetail(error)}`);
  }
}

async function postCompilerRequest(
  endpoint: string,
  body: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; text: string }> {
  const target = new URL(endpoint);
  const send = target.protocol === 'http:'
    ? httpRequest
    : target.protocol === 'https:'
      ? httpsRequest
      : null;

  if (!send) {
    throw new DkbError(`Unsupported LlamaIndex compiler service protocol: ${target.protocol}`);
  }

  return new Promise((resolve, reject) => {
    const request = send(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      },
    }, (response) => {
      const chunks: Buffer[] = [];

      response.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.once('aborted', () => {
        clearTimeout(timer);
        reject(new Error('Compiler service response was aborted'));
      });
      response.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      response.once('end', () => {
        clearTimeout(timer);
        const status = response.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    const timer = setTimeout(() => {
      request.destroy(new Error(`Compiler service request exceeded ${timeoutMs}ms`));
    }, timeoutMs);

    timer.unref();
    request.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end(body);
  });
}

function compilerServiceEndpoint(serviceUrl: string): string {
  const trimmed = serviceUrl.trim().replace(/\/+$/, '');

  return trimmed.endsWith('/compile') ? trimmed : `${trimmed}/compile`;
}

function boundedCompilerTimeout(value: number | undefined): number {
  const parsed = value ?? Number(process.env.DKB_LLAMA_COMPILER_TIMEOUT_MS ?? 30 * 60_000);

  return Number.isFinite(parsed) ? Math.max(60_000, Math.min(parsed, 60 * 60_000)) : 30 * 60_000;
}

function boundedWorkerCount(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(4, Math.trunc(value))) : 1;
}

function environmentFlag(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}

function compilerContextPath(): string {
  const candidates = [
    path.resolve(process.cwd(), 'providers/evidence-docling-llamaindex/python'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../python'),
  ];

  return candidates.find((candidate) => fileExistsSync(path.join(candidate, 'Dockerfile'))) ?? candidates[0]!;
}

function fileExistsSync(target: string): boolean {
  return existsSync(target);
}

function parseOutput(value: unknown, source: string): LlamaIndexCompilerOutput {
  if (!value || typeof value !== 'object') {
    throw new DkbError(`Invalid LlamaIndex compiler output at ${source}`);
  }
  const output = value as Partial<LlamaIndexCompilerOutput>;
  if (output.format !== 'dkb.llamaindex.compile.v2' || !output.compiler || !Array.isArray(output.records)) {
    throw new DkbError(`Invalid LlamaIndex compiler output contract at ${source}`);
  }
  for (const record of output.records) {
    if (!record || typeof record.id !== 'string' || typeof record.assetId !== 'string' || record.embedding !== undefined) {
      throw new DkbError(`Invalid LlamaIndex compiler record at ${source}`);
    }
  }
  return output as LlamaIndexCompilerOutput;
}

function float32JsonReplacer(_key: string, value: unknown): unknown {
  return value instanceof Float32Array ? Array.from(value) : value;
}

function commandDetail(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error) {
    return `${String((error as { stdout?: unknown }).stdout ?? '')}${String((error as { stderr?: unknown }).stderr ?? '')}`.trim();
  }
  return error instanceof Error ? error.message : String(error);
}
