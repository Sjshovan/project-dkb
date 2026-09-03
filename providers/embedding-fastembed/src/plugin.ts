import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbBundledPluginModule } from '@sjshovan/dkb-pipeline/host.js';
import { defineOptionsSchema } from '@sjshovan/dkb-pipeline/sdk.js';
import { isSha256Digest } from '@sjshovan/dkb-pipeline/validation.js';
import { DKB_PLUGIN_API_VERSION, type DkbEmbeddingProvider } from '@sjshovan/dkb-pipeline/types.js';
import { fastEmbedModelPin } from './model.js';
import {
  DEFAULT_FASTEMBED_MODEL,
  FASTEMBED_PROVIDER_IMAGE,
  doctorFastEmbedService,
  ensureFastEmbedService,
  fastEmbedEndpoint,
  fastEmbedServiceStatus,
  stopFastEmbedService,
} from './service.js';

export const DKB_FASTEMBED_PLUGIN_ID = '@dkb/embedding-fastembed';
export const DKB_FASTEMBED_PLUGIN_VERSION = '0.1.0';
const DEFAULT_DIMENSIONS = 384;
const DEFAULT_BATCH_SIZE = 32;
const MAX_BATCH_SIZE = 128;
const DEFAULT_TIMEOUT_MS = 120_000;
const optionsSchema = defineOptionsSchema((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [{ message: 'Options must be an object' }];
  const options = value as Record<string, unknown>;
  const allowed = ['url', 'urlEnv', 'image', 'imageDigest', 'model', 'modelRepository', 'modelRevision', 'dimensions', 'metric', 'normalized', 'batchSize', 'timeoutMs'];
  const issues = Object.keys(options).filter((key) => !allowed.includes(key)).map((key) => ({ message: `Unknown option ${key}`, path: [key] }));
  if (options.imageDigest !== undefined && !isSha256Digest(options.imageDigest)) issues.push({ message: 'imageDigest must be an exact sha256 digest', path: ['imageDigest'] });
  if (issues.length > 0) return issues;
  const model = stringOption(options.model) ?? DEFAULT_FASTEMBED_MODEL;
  const pin = fastEmbedModelPin(model, options);
  return {
    ...(stringOption(options.url) ? { url: stringOption(options.url)! } : {}),
    urlEnv: stringOption(options.urlEnv) ?? 'DKB_QUERY_EMBEDDER_URL',
    image: stringOption(options.image) ?? FASTEMBED_PROVIDER_IMAGE,
    ...(isSha256Digest(options.imageDigest) ? { imageDigest: options.imageDigest } : {}),
    model,
    modelRepository: pin.repository,
    modelRevision: pin.revision,
    dimensions: integerOption(options.dimensions) ?? DEFAULT_DIMENSIONS,
    metric: stringOption(options.metric) ?? 'cosine',
    normalized: options.normalized === undefined ? true : Boolean(options.normalized),
    batchSize: Math.min(integerOption(options.batchSize) ?? DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE),
    timeoutMs: integerOption(options.timeoutMs) ?? DEFAULT_TIMEOUT_MS,
  };
}, DKB_FASTEMBED_PLUGIN_ID);

export const FASTEMBED_PLUGIN: DkbBundledPluginModule = {
  apiVersion: DKB_PLUGIN_API_VERSION,
  id: DKB_FASTEMBED_PLUGIN_ID,
  version: DKB_FASTEMBED_PLUGIN_VERSION,
  sourceUrl: import.meta.url,
  optionsSchema,
  identity: ({ options }) => {
    const model = stringOption(options.model) ?? DEFAULT_FASTEMBED_MODEL;
    const pin = fastEmbedModelPin(model, options);
    const imageDigest = isSha256Digest(options.imageDigest) ? options.imageDigest : undefined;
    return {
      profileOptions: {
        model,
        modelRepository: pin.repository,
        modelRevision: pin.revision,
        dimensions: integerOption(options.dimensions) ?? DEFAULT_DIMENSIONS,
        metric: stringOption(options.metric) ?? 'cosine',
        normalized: options.normalized === undefined ? true : Boolean(options.normalized),
      },
      external: [
        ...(imageDigest ? [{ kind: 'image' as const, name: 'embedding-worker', digest: imageDigest }] : []),
        { kind: 'model', name: 'embedding-model', digest: stableHash({ repository: pin.repository, revision: pin.revision }) },
      ],
    };
  },
  integrity: {
    apiVersion: DKB_PLUGIN_API_VERSION,
    id: DKB_FASTEMBED_PLUGIN_ID,
    version: DKB_FASTEMBED_PLUGIN_VERSION,
    protocols: ['dkb.embedding.v1'],
    artifactFormats: [],
  },
  setup(context) {
    const provider: DkbEmbeddingProvider = {
      kind: 'embedding',
      lifecycle: {
        start: (options) => ensureFastEmbedService({ ...serviceOptions(context.options), restart: Boolean(options?.restart) }),
        status: () => fastEmbedServiceStatus(serviceOptions(context.options)),
        stop: () => stopFastEmbedService(serviceOptions(context.options)),
        doctor: () => doctorFastEmbedService(serviceOptions(context.options)),
      },
      embedDocuments: ({ texts, options, signal }) => embedWithFastEmbed(texts, 'document', options, signal),
      async embedQuery({ text, options, signal }) {
        return (await embedWithFastEmbed([text], 'query', options, signal))[0] ?? [];
      },
      compatibility(options) {
        const queryMode = 'query';
        const documentMode = 'passage';
        return {
          embeddingSpace: stringOption(options.model) ?? DEFAULT_FASTEMBED_MODEL,
          modelRevision: fastEmbedModelPin(stringOption(options.model) ?? DEFAULT_FASTEMBED_MODEL, options).revision,
          dimensions: integerOption(options.dimensions) ?? DEFAULT_DIMENSIONS,
          metric: stringOption(options.metric) ?? 'cosine',
          normalized: options.normalized === undefined ? true : Boolean(options.normalized),
          queryMode,
          documentMode,
          queryTransformDigest: stableHash({ mode: queryMode }),
          documentTransformDigest: stableHash({ mode: documentMode }),
          protocol: 'dkb.embedding.v1',
        };
      },
      async health() {
        const url = await resolvedUrl(context.options, false);
        if (!url) return { ok: false, detail: `${urlEnvironment(context.options)} is not set and the local provider service is not running` };
        try {
          const response = await fetch(healthUrl(url), { signal: AbortSignal.timeout(timeout(context.options)) });
          const body = await response.json() as Record<string, unknown>;
          const pin = fastEmbedModelPin(stringOption(context.options.model) ?? DEFAULT_FASTEMBED_MODEL, context.options);
          const ready = response.ok && body.model === context.options.model && body.modelRepository === pin.repository && body.modelRevision === pin.revision;
          return { ok: ready, detail: ready ? `FastEmbed pinned model ready at ${url}` : `FastEmbed model identity or health mismatch at ${url}; restart the configured provider service` };
        } catch (error) {
          return { ok: false, detail: error instanceof Error ? error.message : String(error) };
        }
      },
    };
    context.registerProvider(provider);
  },
};

export async function embedWithFastEmbed(texts: readonly string[], mode: 'document' | 'query', options: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<number[][]> {
  if (texts.length === 0) return [];
  const url = await resolvedUrl(options, true);
  if (!url) throw new DkbError(`${urlEnvironment(options)} is required by ${DKB_FASTEMBED_PLUGIN_ID}`);
  const expectedModel = stringOption(options.model) ?? DEFAULT_FASTEMBED_MODEL;
  const pin = fastEmbedModelPin(expectedModel, options);
  const dimensions = integerOption(options.dimensions) ?? DEFAULT_DIMENSIONS;
  const batchSize = Math.min(integerOption(options.batchSize) ?? DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE);
  const output: number[][] = [];

  for (let offset = 0; offset < texts.length; offset += batchSize) {
    throwIfAborted(signal);
    const batch = texts.slice(offset, offset + batchSize);
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout(options))]) : AbortSignal.timeout(timeout(options));
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ texts: batch, mode }), signal: requestSignal });
    const body = await response.json() as { model?: unknown; modelRepository?: unknown; modelRevision?: unknown; vectors?: unknown };
    const vectors = Array.isArray(body.vectors) ? body.vectors : null;
    if (!response.ok || !vectors || vectors.length !== batch.length || vectors.some((vector) => !Array.isArray(vector) || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value)))) {
      throw new DkbError(`FastEmbed ${mode} request failed (${response.status})`);
    }
    if (body.model !== expectedModel || body.modelRepository !== pin.repository || body.modelRevision !== pin.revision) throw new DkbError(`FastEmbed model identity mismatch: expected ${expectedModel} from ${pin.repository}@${pin.revision}. Restart the configured provider service.`);
    if (vectors.some((vector) => (vector as unknown[]).length !== dimensions)) throw new DkbError(`FastEmbed vector dimension mismatch: expected ${dimensions}`);
    output.push(...vectors as number[][]);
  }
  return output;
}

async function resolvedUrl(options: Readonly<Record<string, unknown>>, start: boolean): Promise<string | undefined> {
  const configured = stringOption(options.url) ?? stringOption(process.env[urlEnvironment(options)]);
  if (configured) return configured;
  const selected = serviceOptions(options);
  const status = start ? await ensureFastEmbedService(selected) : await fastEmbedServiceStatus(selected);
  return status.ready ? fastEmbedEndpoint(status) : undefined;
}

function serviceOptions(options: Readonly<Record<string, unknown>>) { return { model: stringOption(options.model) ?? DEFAULT_FASTEMBED_MODEL, modelRepository: stringOption(options.modelRepository), modelRevision: stringOption(options.modelRevision), image: stringOption(options.image), imageDigest: stringOption(options.imageDigest) }; }

function urlEnvironment(options: Readonly<Record<string, unknown>>): string { return stringOption(options.urlEnv) ?? 'DKB_QUERY_EMBEDDER_URL'; }
function healthUrl(url: string): string { const parsed = new URL(url); parsed.pathname = parsed.pathname.replace(/\/embed\/?$/, '/health'); return parsed.href; }
function timeout(options: Readonly<Record<string, unknown>>): number { return integerOption(options.timeoutMs) ?? DEFAULT_TIMEOUT_MS; }
function stringOption(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function integerOption(value: unknown): number | undefined { return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined; }
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason ?? new DkbError(`${DKB_FASTEMBED_PLUGIN_ID} was cancelled`); }
