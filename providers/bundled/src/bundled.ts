import { DkbError } from '@dkb/protocol/errors.js';
import { stableHash } from '@dkb/protocol/contracts/hash.js';
import {
  LLAMAINDEX_COMPILER_ID,
  LLAMAINDEX_COMPILER_IMAGE,
  compileDkbWithLlamaIndex,
  compilerServiceStatus,
  doctorLlamaIndexCompilerService,
  inspectLlamaIndexCompiler,
  startLlamaIndexCompilerService,
  stopLlamaIndexCompilerService,
} from './llamaindex.js';
import type { DkbBundledPlugin } from '@dkb/pipeline/host.js';
import type { DkbEmbeddingProvider, DkbIndexRuntime, DkbIngestionProvider } from '@dkb/pipeline/types.js';
import {
  buildFaissRuntimeSnapshot,
  closeFaissSnapshot,
  loadFaissPackageArtifact,
  searchFaissSnapshot,
  validateFaissPackageQueryability,
  validateFaissRuntimeReady,
  writeFaissPackageArtifacts,
} from './faissStore.js';
import {
  MEILISEARCH_INDEX_FORMAT,
  MEILISEARCH_PROVIDER_ID,
  installMeilisearchPackage,
  meilisearchProviderHealth,
  openMeilisearchRuntime,
  uninstallMeilisearchPackage,
  validateMeilisearchPackageArtifact,
  verifyMeilisearchRuntime,
  writeMeilisearchPackageArtifacts,
} from './meilisearchProvider.js';
import { buildLexicalRuntimeSnapshot } from './lexicalStore.js';
import {
  DEFAULT_FASTEMBED_MODEL,
  doctorFastEmbedService,
  ensureFastEmbedService,
  fastEmbedEndpoint,
  fastEmbedServiceStatus,
  stopFastEmbedService,
} from './fastembed.js';
import {
  DKB_TEI_PLUGIN_ID,
  doctorTeiService,
  embedWithTei,
  ensureTeiService,
  stopTeiService,
  teiCompatibility,
  teiServiceStatus,
} from './tei.js';

export const DKB_LLAMA_INDEX_PLUGIN_ID = '@dkb/llamaindex';
export const DKB_FASTEMBED_PLUGIN_ID = '@dkb/fastembed';
export { DKB_TEI_PLUGIN_ID };
export const DKB_FAISS_PLUGIN_ID = '@dkb/faiss';
export const DKB_MEILISEARCH_PLUGIN_ID = MEILISEARCH_PROVIDER_ID;
export const DKB_HYBRID_RETRIEVAL_PLUGIN_ID = '@dkb/hybrid';
export const DKB_BUNDLED_PROVIDER_VERSION = '0.1.0';
const DEFAULT_FASTEMBED_DIMENSIONS = 384;
const DEFAULT_FASTEMBED_BATCH_SIZE = 32;
const MAX_FASTEMBED_BATCH_SIZE = 128;
const DEFAULT_EMBED_TIMEOUT_MS = 120_000;

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
          const model = optionalString(options.tokenizerModel) ?? DEFAULT_FASTEMBED_MODEL;
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
        lifecycle: {
          start: (options) => ensureFastEmbedService({
            model: optionalString(context.options.model) ?? DEFAULT_FASTEMBED_MODEL,
            image: optionalString(context.options.image),
            restart: Boolean(options?.restart),
          }),
          status: () => fastEmbedServiceStatus({
            model: optionalString(context.options.model) ?? DEFAULT_FASTEMBED_MODEL,
            image: optionalString(context.options.image),
          }),
          stop: () => stopFastEmbedService({ model: optionalString(context.options.model) ?? DEFAULT_FASTEMBED_MODEL }),
          doctor: () => doctorFastEmbedService({
            model: optionalString(context.options.model) ?? DEFAULT_FASTEMBED_MODEL,
            image: optionalString(context.options.image),
          }),
        },
        async embedDocuments({ texts, options, signal }) {
          return embedWithFastEmbed(texts, 'document', options, signal);
        },
        async embedQuery({ text, options, signal }) {
          const vectors = await embedWithFastEmbed([text], 'query', options, signal);
          return vectors[0] ?? [];
        },
        compatibility(options) {
          const queryMode = 'query';
          const documentMode = 'passage';
          return {
            embeddingSpace: optionalString(options.model) ?? DEFAULT_FASTEMBED_MODEL,
            dimensions: positiveInteger(options.dimensions) ?? DEFAULT_FASTEMBED_DIMENSIONS,
            metric: optionalString(options.metric) ?? 'cosine',
            normalized: options.normalized === undefined ? true : Boolean(options.normalized),
            queryMode,
            documentMode,
            queryTransformDigest: stableHash({ mode: queryMode }),
            documentTransformDigest: stableHash({ mode: documentMode }),
            protocol: 'dkb.embedding.v1',
          };
        },
        async health() {
          const options = context.options;
          const url = await resolvedEmbeddingUrl(options, false);

          if (!url) return { ok: false, detail: `${embeddingUrlEnv(options)} is not set and the local provider service is not running` };
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
    id: DKB_TEI_PLUGIN_ID,
    version: DKB_BUNDLED_PROVIDER_VERSION,
    setup(context) {
      const provider: DkbEmbeddingProvider = {
        kind: 'embedding',
        lifecycle: {
          start: (options) => ensureTeiService(context.options, Boolean(options?.restart)),
          status: () => teiServiceStatus(context.options),
          stop: () => stopTeiService(context.options),
          doctor: () => doctorTeiService(context.options),
        },
        embedDocuments: ({ texts, options, signal }) => embedWithTei(texts, 'document', options, signal),
        async embedQuery({ text, options, signal }) {
          return (await embedWithTei([text], 'query', options, signal))[0] ?? [];
        },
        compatibility: teiCompatibility,
        async health() {
          const result = await doctorTeiService(context.options);
          return {
            ok: result.ok,
            detail: result.ok
              ? `TEI ${result.status.model}@${result.status.modelRevision} ready at ${result.status.url}`
              : result.recovery,
          };
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
        format: 'IndexIDMap2(IndexFlatIP)',
        async compilePackage({ root, dkb, compiled, compatibility }) {
          const manifest = await writeFaissPackageArtifacts(root, dkb, compiled, compatibility);
          return manifest ? {
            providerId: DKB_FAISS_PLUGIN_ID,
            providerVersion: DKB_BUNDLED_PROVIDER_VERSION,
            build: { format: manifest.format, chunkCount: manifest.chunkCount, files: manifest.files },
            compatibility: { ...manifest.embedding },
          } : null;
        },
        async validatePackage({ dkb }) {
          await validateFaissPackageQueryability(dkb);
          return { documentCount: (await loadFaissPackageArtifact(dkb)).units.length };
        },
        async verifyRuntime({ libraryRoot, libraryId, packageId, packageVersion }) {
          const result = await validateFaissRuntimeReady({ root: libraryRoot, registryId: libraryId, packageId, packageVersion });
          return {
            indexId: result.backend.index,
            documentCount: result.documentCount,
            status: 'ready',
          };
        },
        async openRuntime({ libraryRoot, libraryId, compatibility, embedQuery }) {
          const snapshot = await buildFaissRuntimeSnapshot(libraryRoot, libraryId);

          if (!snapshot) {
            return null;
          }
          if (compatibility.embeddingSpace !== snapshot.embedding.model || compatibility.dimensions !== snapshot.embedding.dimensions) {
            await closeFaissSnapshot(snapshot);
            throw new DkbError(`Selected embedding provider is incompatible with installed FAISS packages: expected ${snapshot.embedding.model}/${snapshot.embedding.dimensions}, got ${String(compatibility.embeddingSpace)}/${String(compatibility.dimensions)}`);
          }
          const lexical = buildLexicalRuntimeSnapshot({
            packages: snapshot.packages,
            numericIdToUnitId: snapshot.numericIdToUnitId,
            unitsById: snapshot.unitsById,
          }) ?? undefined;
          let closed = false;
          const runtime: DkbIndexRuntime = {
            providerId: DKB_FAISS_PLUGIN_ID,
            mode: 'packaged',
            format: 'IndexIDMap2(IndexFlatIP)',
            packages: snapshot.packages.map((item) => ({ id: item.id, version: item.version, indexId: item.segmentPath, documentCount: item.chunkCount })),
            assets: snapshot.assets,
            units: snapshot.units,
            ...(lexical ? { lexicalSearch: (query, limit, scope) => lexical.search(query, limit, scope) } : {}),
            search: (query, limit) => searchFaissSnapshot(snapshot, query, limit, embedQuery),
            async close() {
              if (closed) return;
              closed = true;
              lexical?.close();
              await closeFaissSnapshot(snapshot);
            },
          };

          return runtime;
        },
        health: async () => ({ ok: true, detail: 'Packaged FAISS indexes' }),
      });
    },
  },
  {
    id: DKB_MEILISEARCH_PLUGIN_ID,
    version: DKB_BUNDLED_PROVIDER_VERSION,
    setup(context) {
      context.registerProvider({
        kind: 'index',
        mode: 'managed',
        format: MEILISEARCH_INDEX_FORMAT,
        compilePackage: (input) => writeMeilisearchPackageArtifacts({ ...input, providerVersion: DKB_BUNDLED_PROVIDER_VERSION }),
        async validatePackage({ dkb, compatibility }) {
          const artifact = await validateMeilisearchPackageArtifact(dkb, compatibility);
          return { documentCount: artifact.records.length };
        },
        installPackage: installMeilisearchPackage,
        uninstallPackage: uninstallMeilisearchPackage,
        verifyRuntime: verifyMeilisearchRuntime,
        openRuntime: openMeilisearchRuntime,
        health: () => meilisearchProviderHealth(context.options),
      });
    },
  },
  {
    id: DKB_HYBRID_RETRIEVAL_PLUGIN_ID,
    version: DKB_BUNDLED_PROVIDER_VERSION,
    setup(context) {
      context.registerProvider({ kind: 'retrieval', protocol: 'dkb.evidence.v1', health: async () => ({ ok: true, detail: 'DKB lexical/vector evidence fusion' }) });
    },
  },
] as const;

export function bundledProviderIds(): string[] {
  return BUNDLED_PROVIDER_PLUGINS.map((plugin) => plugin.id);
}

export async function embedWithFastEmbed(
  texts: readonly string[],
  mode: 'document' | 'query',
  options: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const url = await resolvedEmbeddingUrl(options, true);
  if (!url) throw new DkbError(`${embeddingUrlEnv(options)} is required by ${DKB_FASTEMBED_PLUGIN_ID}`);
  const expectedModel = optionalString(options.model) ?? DEFAULT_FASTEMBED_MODEL;
  const expectedDimensions = positiveInteger(options.dimensions) ?? DEFAULT_FASTEMBED_DIMENSIONS;
  const batchSize = Math.min(positiveInteger(options.batchSize) ?? DEFAULT_FASTEMBED_BATCH_SIZE, MAX_FASTEMBED_BATCH_SIZE);
  const output: number[][] = [];

  for (let offset = 0; offset < texts.length; offset += batchSize) {
    throwIfAborted(signal, DKB_FASTEMBED_PLUGIN_ID);
    const batch = texts.slice(offset, offset + batchSize);
    const timeoutSignal = AbortSignal.timeout(timeoutMs(options));
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ texts: batch, mode }),
      signal: combinedSignal,
    });
    const body = await response.json() as { model?: unknown; vectors?: unknown };
    const vectors = Array.isArray(body.vectors) ? body.vectors : null;

    if (!response.ok || !vectors || vectors.length !== batch.length || vectors.some((vector) => !Array.isArray(vector) || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value)))) {
      throw new DkbError(`FastEmbed ${mode} request failed (${response.status})`);
    }
    if (typeof body.model === 'string' && body.model !== expectedModel) {
      throw new DkbError(`FastEmbed model mismatch: expected ${expectedModel}, got ${body.model}`);
    }
    if (vectors.some((vector) => (vector as unknown[]).length !== expectedDimensions)) {
      throw new DkbError(`FastEmbed vector dimension mismatch: expected ${expectedDimensions}`);
    }
    output.push(...vectors as number[][]);
  }

  return output;
}

function embeddingUrl(options: Readonly<Record<string, unknown>>): string | undefined {
  return optionalString(options.url) ?? optionalString(process.env[embeddingUrlEnv(options)]);
}

async function resolvedEmbeddingUrl(options: Readonly<Record<string, unknown>>, start: boolean): Promise<string | undefined> {
  const configured = embeddingUrl(options);
  if (configured) return configured;

  const serviceOptions = {
    model: optionalString(options.model) ?? DEFAULT_FASTEMBED_MODEL,
    image: optionalString(options.image),
  };
  const status = start
    ? await ensureFastEmbedService(serviceOptions)
    : await fastEmbedServiceStatus(serviceOptions);
  return status.ready ? fastEmbedEndpoint(status) : undefined;
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
