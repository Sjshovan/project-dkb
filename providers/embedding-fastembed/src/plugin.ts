import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbBundledPlugin } from '@sjshovan/dkb-pipeline/host.js';
import { DKB_PLUGIN_API_VERSION, type DkbEmbeddingProvider } from '@sjshovan/dkb-pipeline/types.js';
import {
  DEFAULT_FASTEMBED_MODEL,
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

export const FASTEMBED_PLUGIN: DkbBundledPlugin = {
  apiVersion: DKB_PLUGIN_API_VERSION,
  id: DKB_FASTEMBED_PLUGIN_ID,
  version: DKB_FASTEMBED_PLUGIN_VERSION,
  setup(context) {
    const provider: DkbEmbeddingProvider = {
      kind: 'embedding',
      lifecycle: {
        start: (options) => ensureFastEmbedService({ model: stringOption(context.options.model) ?? DEFAULT_FASTEMBED_MODEL, image: stringOption(context.options.image), restart: Boolean(options?.restart) }),
        status: () => fastEmbedServiceStatus({ model: stringOption(context.options.model) ?? DEFAULT_FASTEMBED_MODEL, image: stringOption(context.options.image) }),
        stop: () => stopFastEmbedService({ model: stringOption(context.options.model) ?? DEFAULT_FASTEMBED_MODEL }),
        doctor: () => doctorFastEmbedService({ model: stringOption(context.options.model) ?? DEFAULT_FASTEMBED_MODEL, image: stringOption(context.options.image) }),
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
          return { ok: response.ok, detail: response.ok ? `FastEmbed ready at ${url}` : `FastEmbed returned ${response.status}` };
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
  const dimensions = integerOption(options.dimensions) ?? DEFAULT_DIMENSIONS;
  const batchSize = Math.min(integerOption(options.batchSize) ?? DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE);
  const output: number[][] = [];

  for (let offset = 0; offset < texts.length; offset += batchSize) {
    throwIfAborted(signal);
    const batch = texts.slice(offset, offset + batchSize);
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout(options))]) : AbortSignal.timeout(timeout(options));
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ texts: batch, mode }), signal: requestSignal });
    const body = await response.json() as { model?: unknown; vectors?: unknown };
    const vectors = Array.isArray(body.vectors) ? body.vectors : null;
    if (!response.ok || !vectors || vectors.length !== batch.length || vectors.some((vector) => !Array.isArray(vector) || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value)))) {
      throw new DkbError(`FastEmbed ${mode} request failed (${response.status})`);
    }
    if (typeof body.model === 'string' && body.model !== expectedModel) throw new DkbError(`FastEmbed model mismatch: expected ${expectedModel}, got ${body.model}`);
    if (vectors.some((vector) => (vector as unknown[]).length !== dimensions)) throw new DkbError(`FastEmbed vector dimension mismatch: expected ${dimensions}`);
    output.push(...vectors as number[][]);
  }
  return output;
}

async function resolvedUrl(options: Readonly<Record<string, unknown>>, start: boolean): Promise<string | undefined> {
  const configured = stringOption(options.url) ?? stringOption(process.env[urlEnvironment(options)]);
  if (configured) return configured;
  const serviceOptions = { model: stringOption(options.model) ?? DEFAULT_FASTEMBED_MODEL, image: stringOption(options.image) };
  const status = start ? await ensureFastEmbedService(serviceOptions) : await fastEmbedServiceStatus(serviceOptions);
  return status.ready ? fastEmbedEndpoint(status) : undefined;
}

function urlEnvironment(options: Readonly<Record<string, unknown>>): string { return stringOption(options.urlEnv) ?? 'DKB_QUERY_EMBEDDER_URL'; }
function healthUrl(url: string): string { const parsed = new URL(url); parsed.pathname = parsed.pathname.replace(/\/embed\/?$/, '/health'); return parsed.href; }
function timeout(options: Readonly<Record<string, unknown>>): number { return integerOption(options.timeoutMs) ?? DEFAULT_TIMEOUT_MS; }
function stringOption(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function integerOption(value: unknown): number | undefined { return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined; }
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason ?? new DkbError(`${DKB_FASTEMBED_PLUGIN_ID} was cancelled`); }
