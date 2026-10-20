import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { resolveDockerImageIdentity } from '@sjshovan/dkb-pipeline/serviceIdentity.js';
import { isSha256Digest } from '@sjshovan/dkb-pipeline/validation.js';
import type { DkbExecutionContext } from '@sjshovan/dkb-pipeline/execution.js';
import type { DkbJsonValue } from '@sjshovan/dkb-pipeline/types.js';
import { compilerServiceJobsRoot, trustedCompilerServiceUrl, type CompilerServiceOptions } from './compilerService.js';
import { resolveEvidenceOptions, type EvidenceOptions } from './evidenceOptions.js';
import {
  LLAMAINDEX_COMPILER_IMAGE,
  LLAMAINDEX_DOCUMENT_BATCH_SIZE,
} from './compilerConstants.js';
import type {
  LlamaIndexCompilerOutput,
  LlamaIndexCompilerRecord,
  LlamaIndexCompilerRequest,
} from './compiler.js';

const execFile = promisify(execFileCallback);
const JOB_FORMAT = 'dkb.evidence.worker-job.v1';
const CONTROL_FORMAT = 'dkb.evidence.worker-control.v1';
const CONTROL_FILE = '.dkb-worker-control.json';
const CANCEL_TIMEOUT_MS = 15_000;

interface WorkerState extends Record<string, DkbJsonValue> {
  format: typeof CONTROL_FORMAT;
  mode: 'service' | 'docker';
  jobId: string;
  jobToken: string;
  jobRoot: string;
  serviceUrl: string;
  imageId: string;
  inputRoot: string;
  deadline: string;
}

interface WorkerOptions {
  imageDigest?: string;
  model?: string;
  modelRevision?: string;
  evidenceOptions?: EvidenceOptions;
  timeoutMs?: number;
  workers?: number;
  signal?: AbortSignal;
  execution?: DkbExecutionContext;
}

export async function readCompilerOutput(outputDir: string): Promise<LlamaIndexCompilerOutput> {
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

export function compareRecords(left: LlamaIndexCompilerRecord, right: LlamaIndexCompilerRecord): number {
  return left.id.localeCompare(right.id);
}

export function elapsedMs(start: number): number {
  return Math.round((performance.now() - start) * 1000) / 1000;
}

export async function ensureImage(image: string): Promise<void> {
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

export async function runCompiler(
  image: string,
  inputRoot: string,
  requestDir: string,
  outputDir: string,
  options: WorkerOptions,
): Promise<() => Promise<void>> {
  options.signal?.throwIfAborted();
  const imageId = await resolveDockerImageIdentity(image, options.imageDigest);
  const state = workerState('docker', path.dirname(path.resolve(requestDir)), {
    imageId, inputRoot: path.resolve(inputRoot), timeoutMs: options.timeoutMs,
  });
  const pending = await registerWorker(state, options.execution);
  const args = [
    'create', '--name', containerName(state),
    '--label', `org.dkb.evidence.job-id=${state.jobId}`,
    '--label', `org.dkb.evidence.job-token-hash=${tokenHash(state.jobToken)}`,
    ...(environmentFlag(process.env.DKB_LLAMA_GPU) ? ['--gpus', 'all'] : []),
    '--mount', `type=bind,src=${path.resolve(inputRoot)},dst=/input,readonly`,
    '--mount', `type=bind,src=${path.resolve(requestDir)},dst=/request,readonly`,
    '--mount', `type=bind,src=${path.resolve(outputDir)},dst=/output`,
    '--entrypoint', 'python',
    imageId,
    '/compiler/compile.py',
  ];
  const env = [
    'DKB_COMPILER_REQUEST=/request/request.json',
    'DKB_COMPILER_INPUT=/input',
    'DKB_COMPILER_OUTPUT=/output/llamaindex-compiled.json',
    options.model ? `DKB_COMPILER_MODEL=${options.model}` : null,
    options.modelRevision ? `DKB_COMPILER_MODEL_REVISION=${options.modelRevision}` : null,
    `DKB_EVIDENCE_OPTIONS=${JSON.stringify(options.evidenceOptions ?? resolveEvidenceOptions())}`,
    `DKB_LLAMA_ASYNC_WORKERS=${boundedWorkerCount(options.workers ?? Number(process.env.DKB_LLAMA_ASYNC_WORKERS ?? 1))}`,
    `DKB_LLAMA_DOCUMENT_BATCH_SIZE=${process.env.DKB_LLAMA_DOCUMENT_BATCH_SIZE ?? String(LLAMAINDEX_DOCUMENT_BATCH_SIZE)}`,
  ].filter((value): value is string => Boolean(value));

  for (const item of env.reverse()) {
    args.splice(1, 0, '-e', item);
  }

  let failure: unknown;
  try {
    options.signal?.throwIfAborted();
    // A created container cannot write source/output. Never abort create halfway
    // and mistake an interrupted Docker client for an acknowledged worker stop.
    await execFile('docker', args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    options.signal?.throwIfAborted();
    const container = await inspectOwnedContainer(state);
    if (!container) throw new DkbError('The owned Evidence container was not created.');
    await execFile('docker', ['start', '--attach', container.Id], {
      timeout: boundedCompilerTimeout(options.timeoutMs), signal: options.signal,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    failure = error;
  }
  if (!await terminateOwnedContainer(state)) throw terminationUnconfirmed(state);
  if (failure || options.signal?.aborted) {
    await cleanupAndSettleWorker(state, pending, options.execution);
    if (options.signal?.aborted) throw options.signal.reason ?? new DkbError('Evidence compilation cancelled.', 'compile_cancelled');
    throw new DkbError('LlamaIndex compiler container failed after its worker stopped.');
  }
  // The caller still needs the stopped worker's output before removing scratch.
  return () => cleanupAndSettleWorker(state, pending, options.execution);
}

export async function runCompilerService(
  serviceUrl: string,
  request: LlamaIndexCompilerRequest,
  options: WorkerOptions & { jobId: string; jobRoot: string },
): Promise<LlamaIndexCompilerOutput> {
  const endpoint = compilerServiceEndpoint(serviceUrl);
  const timeoutMs = boundedCompilerTimeout(options.timeoutMs);
  options.signal?.throwIfAborted();
  const state = workerState('service', options.jobRoot, { serviceUrl: compilerServiceBase(serviceUrl), jobId: options.jobId, timeoutMs });
  const pending = await registerWorker(state, options.execution);
  let settled = false;

  try {
    options.signal?.throwIfAborted();
    const response = await postCompilerRequest(endpoint, JSON.stringify({
        jobId: options.jobId,
        jobToken: state.jobToken,
        deadline: state.deadline,
        request,
        model: options.model,
        modelRevision: options.modelRevision,
        evidenceOptions: options.evidenceOptions ?? resolveEvidenceOptions(),
        workers: boundedWorkerCount(options.workers ?? Number(process.env.DKB_LLAMA_ASYNC_WORKERS ?? 1)),
      }), timeoutMs, options.signal);
    const body = JSON.parse(response.text) as { job?: unknown };
    const job = terminalAcknowledgement(body?.job, state);
    if (!job) throw new DkbError('Evidence worker did not acknowledge a matching terminal job.');
    await cleanupAndSettleWorker(state, pending, options.execution);
    settled = true;
    if (options.signal?.aborted) throw options.signal.reason ?? new DkbError('Evidence compilation cancelled.', 'compile_cancelled');
    if (!response.ok || job.status !== 'completed') throw new DkbError('Evidence worker did not complete compilation.', job.status === 'cancelled' ? 'compile_cancelled' : 'DKB_ERROR');
    return parseOutput(body, endpoint);
  } catch (error) {
    if (settled) throw error;
    // Use a new bounded control request: the compile signal is already aborted.
    if (!await confirmServiceTermination(state)) throw terminationUnconfirmed(state);
    await cleanupAndSettleWorker(state, pending, options.execution);
    if (options.signal?.aborted) throw options.signal.reason ?? new DkbError('Evidence compilation cancelled.', 'compile_cancelled');
    throw new DkbError(`Evidence compiler service request failed (${safeServiceFailure(error)}). Its worker acknowledged termination or safe completion, and scratch was cleaned up. Check the selected Evidence service health before retrying.`, 'compiler_service_request_failed');
  }
}

// Never include service bodies, URLs or arbitrary exception messages: they may
// contain source text or worker credentials. Retain only known failure classes.
function safeServiceFailure(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  switch (code) {
    case 'ECONNRESET': return 'connection reset';
    case 'ECONNREFUSED': return 'connection refused';
    case 'ETIMEDOUT': return 'connection timed out';
    case 'ENOTFOUND': return 'service host not found';
    case 'EAI_AGAIN': return 'service host lookup temporarily unavailable';
  }
  if (error instanceof SyntaxError) return 'invalid JSON response';
  if (error instanceof DkbError) return 'worker validation or cleanup failure';
  return 'transport or response failure';
}

/** Only the concrete provider interprets opaque recovery state or worker handles. */
export async function cancelLlamaIndexPending(input: {
  state: Record<string, DkbJsonValue>; options: CompilerServiceOptions; signal?: AbortSignal;
}): Promise<{ safeToCleanup: boolean }> {
  try {
    input.signal?.throwIfAborted();
    const state = await validatedWorkerState(input.state);
    if (state.mode === 'service') {
      const trustedUrl = await trustedCompilerServiceUrl(input.options);
      if (!trustedUrl || compilerServiceBase(trustedUrl) !== state.serviceUrl) return { safeToCleanup: false };
      if (!await confirmServiceTermination(state, input.signal)) return { safeToCleanup: false };
    } else {
      const image = input.options.image ?? process.env.DKB_LLAMA_COMPILER_IMAGE ?? LLAMAINDEX_COMPILER_IMAGE;
      if (await resolveDockerImageIdentity(image, input.options.imageDigest) !== state.imageId) return { safeToCleanup: false };
      if (!await terminateOwnedContainer(state)) return { safeToCleanup: false };
    }
    await fs.rm(state.jobRoot, { recursive: true, force: true });
    return { safeToCleanup: true };
  } catch { return { safeToCleanup: false }; }
}

/** Explicit recovery for direct local callers without a host execution journal. */
export async function recoverLlamaIndexCompiler(controlPath: string, options: CompilerServiceOptions = {}): Promise<{ safeToCleanup: boolean }> {
  const resolved = path.resolve(controlPath);
  if (path.basename(resolved) !== CONTROL_FILE) throw new DkbError('Choose the exact retained Evidence worker control file.');
  const stat = await fs.lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new DkbError('Invalid Evidence worker recovery control.');
  const state = JSON.parse(await fs.readFile(resolved, 'utf8')) as Record<string, DkbJsonValue>;
  if (state.jobRoot !== path.dirname(resolved)) throw new DkbError('Evidence worker recovery path does not match its control file.');
  const result = await cancelLlamaIndexPending({ state, options });
  if (!result.safeToCleanup) throw terminationUnconfirmed(state as WorkerState);
  return result;
}

function workerState(mode: WorkerState['mode'], jobRoot: string, options: {
  serviceUrl?: string; jobId?: string; imageId?: string; inputRoot?: string; timeoutMs?: number;
}): WorkerState {
  return { format: CONTROL_FORMAT, mode, jobId: options.jobId ?? `job-${randomUUID()}`,
    jobToken: randomBytes(32).toString('base64url'), jobRoot: path.resolve(jobRoot),
    serviceUrl: options.serviceUrl ?? '', imageId: options.imageId ?? '', inputRoot: options.inputRoot ?? '',
    deadline: new Date(Date.now() + boundedCompilerTimeout(options.timeoutMs)).toISOString() };
}

async function registerWorker(state: WorkerState, execution?: DkbExecutionContext): Promise<string | undefined> {
  await validateWorkerRoot(state);
  const handle = await fs.open(path.join(state.jobRoot, CONTROL_FILE), 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  // Dispatch has not started. Preserve a registration/cancellation failure;
  // the host journal remains authoritative if persistence already succeeded.
  return execution?.registerPending(state);
}

async function settleWorker(state: WorkerState, pending: string | undefined, execution?: DkbExecutionContext): Promise<void> {
  if (!pending || !execution) return;
  try { await execution.settlePending(pending); }
  catch { throw terminationUnconfirmed(state); }
}

async function cleanupAndSettleWorker(state: WorkerState, pending: string | undefined, execution?: DkbExecutionContext): Promise<void> {
  try {
    await validatedWorkerState(state);
    await fs.rm(state.jobRoot, { recursive: true, force: true });
  } catch { throw terminationUnconfirmed(state); }
  await settleWorker(state, pending, execution);
}

function terminationUnconfirmed(state: WorkerState): DkbError {
  return new DkbError(`Evidence worker termination is unconfirmed. Keep its source and scratch intact. Recover with recoverLlamaIndexCompiler(controlPath, trustedOptions) from @sjshovan/dkb-evidence-docling-llamaindex/compiler.js before retrying. Private recovery control: ${path.join(state.jobRoot, CONTROL_FILE)}`, 'compile_termination_unconfirmed');
}

async function validateWorkerRoot(state: WorkerState): Promise<void> {
  const expectedParent = state.mode === 'service' ? path.resolve(compilerServiceJobsRoot()) : path.resolve(os.tmpdir());
  if (path.dirname(state.jobRoot) !== expectedParent
    || (state.mode === 'service' ? path.basename(state.jobRoot) !== state.jobId : !/^dkb-llamaindex-[A-Za-z0-9]+$/u.test(path.basename(state.jobRoot)))) {
    throw new DkbError('Invalid Evidence worker scratch ownership.');
  }
  try {
    const stat = await fs.lstat(state.jobRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DkbError('Invalid Evidence worker scratch directory.');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

async function validatedWorkerState(value: Record<string, DkbJsonValue>): Promise<WorkerState> {
  const state = value as WorkerState;
  if (state.format !== CONTROL_FORMAT || !['service', 'docker'].includes(state.mode)
    || !/^job-[a-f0-9-]{36}$/u.test(state.jobId) || !/^[A-Za-z0-9_-]{43}$/u.test(state.jobToken)
    || typeof state.jobRoot !== 'string' || !path.isAbsolute(state.jobRoot) || path.resolve(state.jobRoot) !== state.jobRoot
    || typeof state.serviceUrl !== 'string' || typeof state.imageId !== 'string' || typeof state.inputRoot !== 'string'
    || typeof state.deadline !== 'string' || !Number.isFinite(Date.parse(state.deadline))) throw new DkbError('Invalid Evidence worker recovery state.');
  await validateWorkerRoot(state);
  try {
    const controlPath = path.join(state.jobRoot, CONTROL_FILE);
    const stat = await fs.lstat(controlPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new DkbError('Invalid Evidence worker recovery control.');
    const saved = JSON.parse(await fs.readFile(controlPath, 'utf8')) as unknown;
    if (!saved || typeof saved !== 'object'
      || JSON.stringify(Object.entries(saved).sort()) !== JSON.stringify(Object.entries(state).sort())) throw new DkbError('Evidence worker recovery control does not match its journal.');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return state;
}

function tokenHash(token: string): string { return `sha256:${createHash('sha256').update(token).digest('hex')}`; }

function terminalAcknowledgement(value: unknown, state: WorkerState): { status: string } | null {
  if (!value || typeof value !== 'object') return null;
  const job = value as Record<string, unknown>;
  if (job.format !== JOB_FORMAT || job.jobId !== state.jobId || job.jobTokenHash !== tokenHash(state.jobToken)
    || !['completed', 'failed', 'cancelled'].includes(String(job.status)) || job.safeToCleanup !== true
    || typeof job.terminated !== 'boolean' || (job.status === 'cancelled' && job.terminated !== true)) return null;
  return { status: String(job.status) };
}

async function confirmServiceTermination(state: WorkerState, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + CANCEL_TIMEOUT_MS;
  let route = '/jobs/cancel';
  try {
    while (Date.now() < deadline) {
      const response = await postCompilerRequest(`${state.serviceUrl}${route}`,
        JSON.stringify({ jobId: state.jobId, jobToken: state.jobToken }), Math.min(5_000, deadline - Date.now()), signal, 65_536);
      if (!response.ok) return false;
      const job = JSON.parse(response.text) as Record<string, unknown>;
      if (terminalAcknowledgement(job, state)) return true;
      if (!job || job.format !== JOB_FORMAT || job.jobId !== state.jobId || job.jobTokenHash !== tokenHash(state.jobToken)
        || !['queued', 'running', 'cancelling'].includes(String(job.status)) || job.safeToCleanup !== false) return false;
      route = '/jobs/status';
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch { /* A lost or mismatched acknowledgement is not evidence of termination. */ }
  return false;
}

interface OwnedContainer {
  Id: string; Image: string; Config: { Labels?: Record<string, string> };
  State: { Running?: boolean; Restarting?: boolean; Status?: string };
  Mounts?: Array<{ Source?: string; Destination?: string; RW?: boolean }>;
}

function containerName(state: WorkerState): string { return `dkb-evidence-${state.jobId}`; }

async function inspectOwnedContainer(state: WorkerState): Promise<OwnedContainer | null> {
  let stdout: string;
  try { ({ stdout } = await execFile('docker', ['inspect', containerName(state)], { timeout: 5_000, maxBuffer: 1024 * 1024 })); }
  catch (error) {
    if (/no such (container|object)/iu.test(commandDetail(error))) return null;
    throw error;
  }
  const container = (JSON.parse(stdout) as OwnedContainer[])[0];
  const labels = container?.Config?.Labels;
  const mount = (destination: string, source: string, writable: boolean) => container?.Mounts?.some(item =>
    item.Destination === destination && item.Source && path.resolve(item.Source) === source && item.RW === writable);
  if (!container || !/^[a-f0-9]{64}$/u.test(container.Id) || container.Image !== state.imageId
    || labels?.['org.dkb.evidence.job-id'] !== state.jobId || labels?.['org.dkb.evidence.job-token-hash'] !== tokenHash(state.jobToken)
    || !mount('/input', state.inputRoot, false) || !mount('/request', path.join(state.jobRoot, 'request'), false)
    || !mount('/output', path.join(state.jobRoot, 'output'), true)) throw new DkbError('Evidence container ownership does not match the pending job.');
  return container;
}

async function terminateOwnedContainer(state: WorkerState): Promise<boolean> {
  try {
    let container = await inspectOwnedContainer(state);
    if (!container) return true;
    const id = container.Id;
    if (container.State.Running || container.State.Restarting) {
      try { await execFile('docker', ['stop', '--time', '3', id], { timeout: 5_000 }); }
      catch { /* The client may fail after the daemon stopped the worker. */ }
      container = await inspectOwnedContainer(state);
      if (!container) return true;
      if (container.Id !== id) return false;
      if (container.State.Running || container.State.Restarting) {
        try { await execFile('docker', ['kill', id], { timeout: 5_000 }); }
        catch { /* Only a fresh owned-container inspection can confirm termination. */ }
        container = await inspectOwnedContainer(state);
        if (!container) return true;
        if (container.Id !== id || container.State.Running || container.State.Restarting) return false;
      }
    }
    if (container.State.Status !== 'created') await execFile('docker', ['wait', id], { timeout: 5_000 });
    await execFile('docker', ['rm', id], { timeout: 5_000 });
    return await inspectOwnedContainer(state) === null;
  } catch { return false; }
}

async function postCompilerRequest(
  endpoint: string,
  body: string,
  timeoutMs: number,
  signal?: AbortSignal,
  maxBytes = 128 * 1024 * 1024,
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
    signal?.throwIfAborted();
    const request = send(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;

      response.on('data', (chunk: Buffer | string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) { request.destroy(new Error('Compiler service response exceeds its size limit')); return; }
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.once('aborted', () => {
        finished();
        reject(new Error('Compiler service response was aborted'));
      });
      response.once('error', (error) => {
        finished();
        reject(error);
      });
      response.once('end', () => {
        finished();
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
    const aborted = () => request.destroy(new Error('Compiler service request cancelled'));
    const finished = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); };
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    request.once('error', (error) => {
      finished();
      reject(error);
    });
    request.end(body);
  });
}

function compilerServiceEndpoint(serviceUrl: string): string {
  return `${compilerServiceBase(serviceUrl)}/compile`;
}

function compilerServiceBase(serviceUrl: string): string {
  const parsed = new URL(serviceUrl.trim());
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new DkbError('Invalid Evidence worker service URL.');
  parsed.pathname = parsed.pathname.replace(/\/+$/u, '').replace(/\/compile$/u, '');
  return parsed.toString().replace(/\/+$/u, '');
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
    if (!record || typeof record.id !== 'string' || typeof record.assetId !== 'string' || 'embedding' in record) {
      throw new DkbError(`Invalid LlamaIndex compiler record at ${source}`);
    }
    if (!isSha256Digest(record.sourceHash)) {
      throw new DkbError('Evidence worker record requires the original source SHA-256 hash. Rebuild and restart the selected Evidence worker; chunk text hashes cannot replace source provenance.');
    }
  }
  return output as LlamaIndexCompilerOutput;
}

function commandDetail(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error) {
    return `${String((error as { stdout?: unknown }).stdout ?? '')}${String((error as { stderr?: unknown }).stderr ?? '')}`.trim();
  }
  return error instanceof Error ? error.message : String(error);
}
