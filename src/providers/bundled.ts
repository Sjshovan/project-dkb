import { DkbError } from '../protocol/errors.js';
import {
  LLAMAINDEX_COMPILER_ID,
  LLAMAINDEX_COMPILER_IMAGE,
  compileDkbWithLlamaIndex,
  compilerServiceStatus,
  doctorLlamaIndexCompilerService,
  inspectLlamaIndexCompiler,
  startLlamaIndexCompilerService,
  stopLlamaIndexCompilerService,
  type LlamaIndexCompilerResult,
} from '../compiler/llamaindex.js';
import type { DkbBundledPlugin } from './host.js';
import type { DkbEmbeddingProvider, DkbIngestionProvider } from './types.js';
import { writeFaissPackageArtifacts } from '../indexes/faissStore.js';

export const DKB_LLAMA_INDEX_PLUGIN_ID = '@dkb/llamaindex';
export const DKB_FASTEMBED_PLUGIN_ID = '@dkb/fastembed';
export const DKB_FAISS_PLUGIN_ID = '@dkb/faiss';
export const DKB_HYBRID_RETRIEVAL_PLUGIN_ID = '@dkb/hybrid';
export const DKB_BUNDLED_PROVIDER_VERSION = '1.0.0';
const DEFAULT_FASTEMBED_MODEL = 'BAAI/bge-small-en-v1.5';
const DEFAULT_FASTEMBED_DIMENSIONS = 384;
const DEFAULT_EMBED_TIMEOUT_MS = 30_000;

export const BUNDLED_PROVIDER_PLUGINS: readonly DkbBundledPlugin[] = [
  {
    id: DKB_LLAMA_INDEX_PLUGIN_ID,
    version: DKB_BUNDLED_PROVIDER_VERSION,
    setup(context) {
      const provider: DkbIngestionProvider = {
        kind: 'ingestion',
        lifecycle: {
          inspect: () => inspectLlamaIndexCompiler(),
          start: (options) => startLlamaIndexCompilerService({ forceRestart: Boolean(options?.restart) }),
          status: () => compilerServiceStatus(),
          stop: () => stopLlamaIndexCompilerService(),
          doctor: () => doctorLlamaIndexCompilerService(),
        },
        async compile({ dkb, options, signal }) {
          throwIfAborted(signal, DKB_LLAMA_INDEX_PLUGIN_ID);
          const model = optionalString(options.model);
          const image = optionalString(options.image);
          const timeout = positiveInteger(options.timeoutMs);
          const workers = positiveInteger(options.workers);
          const result = await compileDkbWithLlamaIndex(dkb, {
            ...(model ? { model } : {}),
            ...(image ? { image } : {}),
            ...(timeout ? { timeoutMs: timeout } : {}),
            ...(workers ? { workers } : {}),
          });
          throwIfAborted(signal, DKB_LLAMA_INDEX_PLUGIN_ID);

          return {
            records: result.records.map((record) => ({
              id: record.id,
              chunkId: record.id,
              text: record.text,
              embedding: Array.from(record.embedding),
              metadata: {
                assetId: record.assetId,
                storeId: record.storeId,
                type: record.type,
                locator: record.locator,
                assetLocator: record.assetLocator,
                title: record.title,
                hash: record.hash,
                updatedAt: record.updatedAt,
                chunkOrdinal: record.chunkOrdinal,
                chunkStart: record.chunkStart,
                chunkEnd: record.chunkEnd,
                sourceMetadata: record.metadata,
              },
            })),
            receipt: {
              providerId: DKB_LLAMA_INDEX_PLUGIN_ID,
              providerVersion: DKB_BUNDLED_PROVIDER_VERSION,
              build: {
                compilerId: result.compiler.id,
                compilerImage: result.compiler.image,
                model: result.compiler.model,
                extraction: {
                  richParser: 'docling',
                  richChunker: 'docling.hybrid',
                  fallbackParser: 'llamaindex',
                  fallbackChunker: 'llamaindex.sentence',
                },
              },
            },
            nativeResult: result,
          };
        },
        async health() {
          const status = await compilerServiceStatus();
          return {
            ok: status.docker && Boolean(status.image),
            detail: status.docker && Boolean(status.image)
              ? `${LLAMAINDEX_COMPILER_ID} via ${LLAMAINDEX_COMPILER_IMAGE}`
              : 'Docker or the bundled compiler image is unavailable',
          };
        },
      };

      context.registerProvider(provider);
    },
  },
  {
    id: DKB_FASTEMBED_PLUGIN_ID,
    version: DKB_BUNDLED_PROVIDER_VERSION,
    setup(context) {
      const provider: DkbEmbeddingProvider = {
        kind: 'embedding',
        async embedDocuments({ texts, options, signal }) {
          return requestFastEmbed(texts, 'document', options, signal);
        },
        async embedQuery({ text, options, signal }) {
          const vectors = await requestFastEmbed([text], 'query', options, signal);
          return vectors[0] ?? [];
        },
        compatibility(options) {
          return {
            embeddingSpace: optionalString(options.model) ?? DEFAULT_FASTEMBED_MODEL,
            dimensions: positiveInteger(options.dimensions) ?? DEFAULT_FASTEMBED_DIMENSIONS,
            metric: optionalString(options.metric) ?? 'cosine',
            normalized: options.normalized === undefined ? true : Boolean(options.normalized),
            queryMode: 'query',
            documentMode: 'passage',
            protocol: 'dkb.embedding.v1',
          };
        },
        async health() {
          const options = context.options;
          const url = embeddingUrl(options);

          if (!url) {
            return { ok: false, detail: `${embeddingUrlEnv(options)} is not set` };
          }
          try {
            const response = await fetch(healthUrl(url), { signal: AbortSignal.timeout(timeoutMs(options)) });
            return { ok: response.ok, detail: response.ok ? `FastEmbed ready at ${url}` : `FastEmbed returned ${response.status}` };
          } catch (error) {
            return { ok: false, detail: error instanceof Error ? error.message : String(error) };
          }
        },
      };

      context.registerProvider(provider);
    },
  },
  {
    id: DKB_FAISS_PLUGIN_ID,
    version: DKB_BUNDLED_PROVIDER_VERSION,
    setup(context) {
      context.registerProvider({
        kind: 'index',
        mode: 'packaged',
        async compilePackage({ root, dkb, compiled }) {
          const result = assertLlamaIndexNativeResult(compiled.nativeResult);
          const manifest = await writeFaissPackageArtifacts(root, dkb, result);
          return manifest ? {
            providerId: DKB_FAISS_PLUGIN_ID,
            providerVersion: DKB_BUNDLED_PROVIDER_VERSION,
            build: { format: manifest.format, chunkCount: manifest.chunkCount, files: manifest.files },
            compatibility: { ...manifest.embedding },
          } : null;
        },
        health: async () => ({ ok: true, detail: 'Packaged FAISS indexes' }),
      });
    },
  },
  {
    id: DKB_HYBRID_RETRIEVAL_PLUGIN_ID,
    version: DKB_BUNDLED_PROVIDER_VERSION,
    setup(context) {
      context.registerProvider({ kind: 'retrieval', health: async () => ({ ok: true, detail: 'DKB lexical/vector evidence fusion' }) });
    },
  },
] as const;

export function bundledProviderIds(): string[] {
  return BUNDLED_PROVIDER_PLUGINS.map((plugin) => plugin.id);
}

export function assertLlamaIndexNativeResult(value: unknown): LlamaIndexCompilerResult {
  if (!value || typeof value !== 'object' || !('compiler' in value) || !('records' in value) || !Array.isArray((value as { records?: unknown }).records)) {
    throw new DkbError(`${DKB_LLAMA_INDEX_PLUGIN_ID} returned an invalid native compiler result`);
  }

  return value as LlamaIndexCompilerResult;
}

async function requestFastEmbed(
  texts: readonly string[],
  mode: 'document' | 'query',
  options: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<number[][]> {
  const url = embeddingUrl(options);

  if (!url) {
    throw new DkbError(`${embeddingUrlEnv(options)} is required by ${DKB_FASTEMBED_PLUGIN_ID}`);
  }
  const expectedModel = optionalString(options.model) ?? DEFAULT_FASTEMBED_MODEL;
  const expectedDimensions = positiveInteger(options.dimensions) ?? DEFAULT_FASTEMBED_DIMENSIONS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs(options));
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ texts, mode }),
    signal: combinedSignal,
  });
  const body = await response.json() as { model?: unknown; vectors?: unknown };
  const vectors = Array.isArray(body.vectors) ? body.vectors : null;

  if (!response.ok || !vectors || vectors.length !== texts.length || vectors.some((vector) => !Array.isArray(vector) || vector.some((value) => typeof value !== 'number'))) {
    throw new DkbError(`FastEmbed ${mode} request failed (${response.status})`);
  }
  if (typeof body.model === 'string' && body.model !== expectedModel) {
    throw new DkbError(`FastEmbed model mismatch: expected ${expectedModel}, got ${body.model}`);
  }
  if (vectors.some((vector) => (vector as unknown[]).length !== expectedDimensions)) {
    throw new DkbError(`FastEmbed vector dimension mismatch: expected ${expectedDimensions}`);
  }

  return vectors as number[][];
}

function embeddingUrl(options: Readonly<Record<string, unknown>>): string | undefined {
  return optionalString(options.url) ?? optionalString(process.env[embeddingUrlEnv(options)]);
}

function embeddingUrlEnv(options: Readonly<Record<string, unknown>>): string {
  return optionalString(options.urlEnv) ?? 'DKB_QUERY_EMBEDDER_URL';
}

function healthUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = parsed.pathname.replace(/\/embed\/?$/, '/health');
  return parsed.href;
}

function timeoutMs(options: Readonly<Record<string, unknown>>): number {
  return positiveInteger(options.timeoutMs) ?? DEFAULT_EMBED_TIMEOUT_MS;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function throwIfAborted(signal: AbortSignal | undefined, providerId: string): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DkbError(`${providerId} was cancelled`);
  }
}
