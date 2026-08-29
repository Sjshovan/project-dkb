import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

const execFile = promisify(execFileCallback);

export const DKB_TEI_PLUGIN_ID = '@dkb/embedding-tei';
export const TEI_VERSION = '1.9.3';
export const TEI_CPU_IMAGE = 'ghcr.io/huggingface/text-embeddings-inference:cpu-1.9.3@sha256:ad950d30878eceb72aaf32024d26fa2b1d04a75304fa0b4776b49aa1941fea07';
export const TEI_DEFAULT_MODEL = 'BAAI/bge-small-en-v1.5';
export const TEI_DEFAULT_MODEL_REVISION = '5c38ec7c405ec4b44b94cc5a9bb96e735b38267a';
export const TEI_DEFAULT_DIMENSIONS = 384;
const TEI_PORT = 80;
const starts = new Map<string, Promise<TeiServiceStatus>>();

export interface TeiOptions {
  url?: string;
  urlEnv?: string;
  image?: string;
  model?: string;
  modelRevision?: string;
  dimensions?: number;
  normalized?: boolean;
  metric?: string;
  batchSize?: number;
  timeoutMs?: number;
  truncate?: boolean;
  queryPrefix?: string;
  documentPrefix?: string;
  queryPromptName?: string;
  documentPromptName?: string;
}

export interface TeiServiceStatus {
  docker: boolean;
  image: string;
  model: string;
  modelRevision: string;
  container: string;
  running: boolean;
  ready: boolean;
  url?: string;
  drift: string[];
  info?: Record<string, unknown>;
}

export function teiCompatibility(options: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const parsed = parseOptions(options);
  return {
    embeddingSpace: parsed.model,
    modelRevision: parsed.modelRevision,
    dimensions: parsed.dimensions,
    metric: parsed.metric,
    normalized: parsed.normalized,
    queryMode: 'query',
    documentMode: 'passage',
    queryTransformDigest: stableHash({ prefix: parsed.queryPrefix, promptName: parsed.queryPromptName }),
    documentTransformDigest: stableHash({ prefix: parsed.documentPrefix, promptName: parsed.documentPromptName }),
    protocol: 'tei.embed.v1',
  };
}

export async function embedWithTei(
  texts: readonly string[],
  mode: 'document' | 'query',
  options: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const parsed = parseOptions(options);
  const url = await resolvedTeiUrl(parsed, true);
  if (!url) throw new DkbError(`${parsed.urlEnv} is required by ${DKB_TEI_PLUGIN_ID}`);
  const vectors: number[][] = [];

  for (let offset = 0; offset < texts.length; offset += parsed.batchSize) {
    if (signal?.aborted) throw signal.reason ?? new DkbError('TEI embedding was cancelled');
    const batch = texts.slice(offset, offset + parsed.batchSize);
    const prefix = mode === 'query' ? parsed.queryPrefix : parsed.documentPrefix;
    const promptName = mode === 'query' ? parsed.queryPromptName : parsed.documentPromptName;
    const timeout = AbortSignal.timeout(parsed.timeoutMs);
    const response = await fetch(`${url}/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        inputs: batch.map((text) => `${prefix}${text}`),
        normalize: parsed.normalized,
        truncate: parsed.truncate,
        dimensions: parsed.dimensions,
        ...(promptName ? { prompt_name: promptName } : {}),
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const body = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      throw new DkbError(`TEI ${mode} request failed (${response.status}): ${errorBody(body)}`);
    }
    if (!Array.isArray(body) || body.length !== batch.length) {
      throw new DkbError(`TEI returned ${Array.isArray(body) ? body.length : 'an invalid response'} for ${batch.length} inputs`);
    }
    for (const vector of body) {
      if (!Array.isArray(vector) || vector.length !== parsed.dimensions || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
        throw new DkbError(`TEI vector dimension or numeric validation failed; expected ${parsed.dimensions} finite values`);
      }
      vectors.push(vector as number[]);
    }
  }

  return vectors;
}

export async function ensureTeiService(options: Readonly<Record<string, unknown>> = {}, restart = false): Promise<TeiServiceStatus> {
  const parsed = parseOptions(options);
  const key = `${parsed.image}\0${parsed.model}\0${parsed.modelRevision}`;
  const existing = starts.get(key);
  if (existing && !restart) return existing;
  const start = startTeiService(parsed, restart);
  starts.set(key, start);
  try {
    return await start;
  } finally {
    if (starts.get(key) === start) starts.delete(key);
  }
}

export async function teiServiceStatus(options: Readonly<Record<string, unknown>> = {}): Promise<TeiServiceStatus> {
  const parsed = parseOptions(options);
  const container = teiContainerName(parsed);
  try {
    await execFile('docker', ['--version'], { timeout: 30_000 });
  } catch {
    return { docker: false, image: parsed.image, model: parsed.model, modelRevision: parsed.modelRevision, container, running: false, ready: false, drift: ['docker_unavailable'] };
  }
  const inspected = await inspectContainer(container).catch(() => null);
  const running = inspected?.State?.Running === true;
  const drift: string[] = [];
  if (inspected?.Config?.Image !== parsed.image) drift.push('image_mismatch');
  if (inspected?.Config?.Labels?.['org.dkb.tei.model'] !== parsed.model) drift.push('model_mismatch');
  if (inspected?.Config?.Labels?.['org.dkb.tei.revision'] !== parsed.modelRevision) drift.push('model_revision_mismatch');
  const port = running ? await hostPort(container).catch(() => undefined) : undefined;
  const url = port ? `http://127.0.0.1:${port}` : undefined;
  const info = url ? await readTeiInfo(url).catch(() => undefined) : undefined;
  const ready = Boolean(info) && modelMatches(info!, parsed);
  if (running && !ready) drift.push('service_unhealthy');
  return {
    docker: true,
    image: parsed.image,
    model: parsed.model,
    modelRevision: parsed.modelRevision,
    container,
    running,
    ready,
    ...(url ? { url } : {}),
    drift: [...new Set(drift)],
    ...(info ? { info } : {}),
  };
}

export async function stopTeiService(options: Readonly<Record<string, unknown>> = {}): Promise<TeiServiceStatus> {
  const parsed = parseOptions(options);
  const container = teiContainerName(parsed);
  try {
    await execFile('docker', ['rm', '-f', container], { timeout: 30_000 });
  } catch (error) {
    if (!/No such container/i.test(errorMessage(error))) throw error;
  }
  return teiServiceStatus(options);
}

export async function doctorTeiService(options: Readonly<Record<string, unknown>> = {}): Promise<{ ok: boolean; status: TeiServiceStatus; recovery?: string }> {
  const configured = configuredTeiUrl(parseOptions(options));
  if (configured) {
    const info = await readTeiInfo(configured).catch(() => undefined);
    const status = await teiStatusForConfigured(configured, parseOptions(options), info);
    return status.ready ? { ok: true, status } : { ok: false, status, recovery: `Verify ${configured}/health and ${configured}/info.` };
  }
  const status = await teiServiceStatus(options);
  return status.ready
    ? { ok: true, status }
    : { ok: false, status, recovery: status.docker ? 'Run dkb compiler start for the selected TEI target.' : 'Start Docker Desktop, then retry.' };
}

async function resolvedTeiUrl(options: Required<TeiOptions>, start: boolean): Promise<string | undefined> {
  const configured = configuredTeiUrl(options);
  if (configured) return configured.replace(/\/+$/, '');
  const status = start ? await ensureTeiService(options) : await teiServiceStatus(options);
  return status.ready ? status.url : undefined;
}

async function startTeiService(options: Required<TeiOptions>, restart: boolean): Promise<TeiServiceStatus> {
  const current = await teiServiceStatus(options);
  if (current.ready && current.drift.length === 0 && !restart) return current;
  // Docker retains stopped containers and their names. Always remove a
  // non-ready instance before creating its deterministic replacement.
  await stopTeiService(options);
  const container = teiContainerName(options);
  try {
    await execFile('docker', [
      'run', '-d',
      '--name', container,
      '--label', `org.dkb.tei.model=${options.model}`,
      '--label', `org.dkb.tei.revision=${options.modelRevision}`,
      '--label', `org.dkb.tei.version=${TEI_VERSION}`,
      '--label', 'org.dkb.component=tei-provider-service',
      '-p', `127.0.0.1::${TEI_PORT}`,
      '--mount', 'type=volume,src=dkb-tei-model-cache,dst=/data',
      options.image,
      '--model-id', options.model,
      '--revision', options.modelRevision,
      '--dtype', 'float32',
      '--max-client-batch-size', String(options.batchSize),
      '--auto-truncate',
    ], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    throw new DkbError(`Unable to start TEI ${options.model}@${options.modelRevision}: ${errorMessage(error)}`);
  }

  const deadline = Date.now() + 10 * 60_000;
  let status = await teiServiceStatus(options);
  while (!status.ready && Date.now() < deadline) {
    await delay(1_000);
    status = await teiServiceStatus(options);
  }
  if (!status.ready || status.drift.length > 0) {
    throw new DkbError(`TEI service ${container} did not become ready: ${status.drift.join(', ') || 'health check failed'}`);
  }
  return status;
}

async function readTeiInfo(url: string): Promise<Record<string, unknown>> {
  const health = await fetch(`${url.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(5_000) });
  if (!health.ok) throw new DkbError(`TEI health returned ${health.status}`);
  const response = await fetch(`${url.replace(/\/+$/, '')}/info`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new DkbError(`TEI info returned ${response.status}`);
  const body = await response.json() as unknown;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DkbError('TEI info returned an invalid response');
  return body as Record<string, unknown>;
}

function modelMatches(info: Record<string, unknown>, options: Required<TeiOptions>): boolean {
  return info.model_id === options.model && info.model_sha === options.modelRevision && info.version === TEI_VERSION;
}

async function teiStatusForConfigured(url: string, options: Required<TeiOptions>, info?: Record<string, unknown>): Promise<TeiServiceStatus> {
  return {
    docker: false,
    image: options.image,
    model: options.model,
    modelRevision: options.modelRevision,
    container: 'configured-endpoint',
    running: Boolean(info),
    ready: Boolean(info) && modelMatches(info!, options),
    url,
    drift: info && modelMatches(info, options) ? [] : ['configured_endpoint_mismatch'],
    ...(info ? { info } : {}),
  };
}

function parseOptions(options: Readonly<Record<string, unknown>>): Required<TeiOptions> {
  return {
    url: optionalString(options.url) ?? '',
    urlEnv: optionalString(options.urlEnv) ?? 'DKB_TEI_URL',
    image: optionalString(options.image) ?? TEI_CPU_IMAGE,
    model: optionalString(options.model) ?? TEI_DEFAULT_MODEL,
    modelRevision: optionalString(options.modelRevision) ?? TEI_DEFAULT_MODEL_REVISION,
    dimensions: positiveInteger(options.dimensions) ?? TEI_DEFAULT_DIMENSIONS,
    normalized: options.normalized === undefined ? true : Boolean(options.normalized),
    metric: optionalString(options.metric) ?? 'cosine',
    batchSize: Math.min(positiveInteger(options.batchSize) ?? 32, 128),
    timeoutMs: positiveInteger(options.timeoutMs) ?? 120_000,
    truncate: options.truncate === undefined ? true : Boolean(options.truncate),
    queryPrefix: rawString(options.queryPrefix),
    documentPrefix: rawString(options.documentPrefix),
    queryPromptName: optionalString(options.queryPromptName) ?? '',
    documentPromptName: optionalString(options.documentPromptName) ?? '',
  };
}

function configuredTeiUrl(options: Required<TeiOptions>): string | undefined {
  return options.url || optionalString(process.env[options.urlEnv]);
}

function teiContainerName(options: Pick<Required<TeiOptions>, 'model' | 'modelRevision'>): string {
  const key = createHash('sha256').update(`${options.model}\0${options.modelRevision}`).digest('hex').slice(0, 12);
  return `dkb-tei-${key}`;
}

async function inspectContainer(container: string): Promise<{ State?: { Running?: boolean }; Config?: { Image?: string; Labels?: Record<string, string> } }> {
  const { stdout } = await execFile('docker', ['inspect', container], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed) || !parsed[0] || typeof parsed[0] !== 'object') throw new DkbError(`Invalid Docker inspection for ${container}`);
  return parsed[0] as { State?: { Running?: boolean }; Config?: { Image?: string; Labels?: Record<string, string> } };
}

async function hostPort(container: string): Promise<number | undefined> {
  const { stdout } = await execFile('docker', ['port', container, String(TEI_PORT)], { timeout: 30_000 });
  const match = /127\.0\.0\.1:(\d+)/.exec(stdout) ?? /0\.0\.0\.0:(\d+)/.exec(stdout);
  return match ? Number.parseInt(match[1]!, 10) : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function rawString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function errorBody(value: unknown): string {
  return value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { error?: unknown }).error === 'string'
    ? String((value as { error: string }).error)
    : JSON.stringify(value);
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error) {
    return `${String((error as { stdout?: unknown }).stdout ?? '')}${String((error as { stderr?: unknown }).stderr ?? '')}`.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
