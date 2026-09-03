import { execFile as execFileCallback } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { resolveDockerImageIdentity } from '@sjshovan/dkb-pipeline/serviceIdentity.js';
import { isSha256Digest } from '@sjshovan/dkb-pipeline/validation.js';
import { resolveEvidenceOptions, type EvidenceOptions } from './evidenceOptions.js';
import {
  LLAMAINDEX_DOCUMENT_BATCH_SIZE,
} from './compilerConstants.js';
import type {
  LlamaIndexCompilerOutput,
  LlamaIndexCompilerRecord,
  LlamaIndexCompilerRequest,
} from './compiler.js';

const execFile = promisify(execFileCallback);

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
  options: { imageDigest?: string; model?: string; modelRevision?: string; evidenceOptions?: EvidenceOptions; timeoutMs?: number; workers?: number },
): Promise<void> {
  const imageId = await resolveDockerImageIdentity(image, options.imageDigest);
  const args = [
    'run', '--rm',
    ...(environmentFlag(process.env.DKB_LLAMA_GPU) ? ['--gpus', 'all'] : []),
    '--mount', `type=bind,src=${path.resolve(inputRoot)},dst=/input,readonly`,
    '--mount', `type=bind,src=${path.resolve(requestDir)},dst=/request,readonly`,
    '--mount', `type=bind,src=${path.resolve(outputDir)},dst=/output`,
    imageId,
  ];
  const env = [
    options.model ? `DKB_COMPILER_MODEL=${options.model}` : null,
    options.modelRevision ? `DKB_COMPILER_MODEL_REVISION=${options.modelRevision}` : null,
    `DKB_EVIDENCE_OPTIONS=${JSON.stringify(options.evidenceOptions ?? resolveEvidenceOptions())}`,
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

export async function runCompilerService(
  serviceUrl: string,
  request: LlamaIndexCompilerRequest,
  options: { jobId: string; model?: string; modelRevision?: string; evidenceOptions?: EvidenceOptions; timeoutMs?: number; workers?: number },
): Promise<LlamaIndexCompilerOutput> {
  const endpoint = compilerServiceEndpoint(serviceUrl);
  const timeoutMs = boundedCompilerTimeout(options.timeoutMs);
  let response: { ok: boolean; status: number; text: string };

  try {
    response = await postCompilerRequest(endpoint, JSON.stringify({
        jobId: options.jobId,
        request,
        model: options.model,
        modelRevision: options.modelRevision,
        evidenceOptions: options.evidenceOptions ?? resolveEvidenceOptions(),
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
