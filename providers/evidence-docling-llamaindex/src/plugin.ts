import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import type { DkbBundledPluginModule } from '@sjshovan/dkb-pipeline/host.js';
import { defineOptionsSchema } from '@sjshovan/dkb-pipeline/sdk.js';
import { isSha256Digest } from '@sjshovan/dkb-pipeline/validation.js';
import { DKB_PLUGIN_API_VERSION, type DkbEvidenceProvider, type DkbJsonValue } from '@sjshovan/dkb-pipeline/types.js';
import { tokenizerRevision } from './model.js';
import { EVIDENCE_OPTION_KEYS, evidenceModelAssetsDigest, resolveEvidenceOptions } from './evidenceOptions.js';
import {
  LLAMAINDEX_COMPILER_ID,
  LLAMAINDEX_COMPILER_IMAGE,
  compileDkbWithLlamaIndex,
  cancelLlamaIndexPending,
  compilerProviderHealth,
  compilerServiceStatus,
  doctorLlamaIndexCompilerService,
  inspectLlamaIndexCompiler,
  startLlamaIndexCompilerService,
  stopLlamaIndexCompilerService,
} from './compiler.js';

export const DKB_EVIDENCE_DOCLING_LLAMAINDEX_PLUGIN_ID = '@dkb/evidence-docling-llamaindex';
export const DKB_EVIDENCE_DOCLING_LLAMAINDEX_PLUGIN_VERSION = '0.1.0';
const DEFAULT_TOKENIZER_MODEL = 'BAAI/bge-small-en-v1.5';
const optionsSchema = defineOptionsSchema((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [{ message: 'Options must be an object' }];
  const options = value as Record<string, unknown>;
  const issues = Object.keys(options).filter((key) => !['tokenizerModel', 'tokenizerRevision', 'image', 'imageDigest', 'timeoutMs', 'workers', ...EVIDENCE_OPTION_KEYS].includes(key))
    .map((key) => ({ message: `Unknown option ${key}`, path: [key] }));
  if (options.imageDigest !== undefined && !isSha256Digest(options.imageDigest)) {
    issues.push({ message: 'imageDigest must be an exact sha256 digest', path: ['imageDigest'] });
  }
  if (issues.length > 0) return issues;
  const tokenizerModel = stringOption(options.tokenizerModel) ?? DEFAULT_TOKENIZER_MODEL;
  return {
    tokenizerModel,
    tokenizerRevision: tokenizerRevision(tokenizerModel, options.tokenizerRevision),
    ...resolveEvidenceOptions(options),
    ...(stringOption(options.image) ? { image: stringOption(options.image)! } : {}),
    ...(isSha256Digest(options.imageDigest) ? { imageDigest: options.imageDigest } : {}),
    timeoutMs: integerOption(options.timeoutMs) ?? 1_200_000,
    workers: integerOption(options.workers) ?? 1,
  };
}, DKB_EVIDENCE_DOCLING_LLAMAINDEX_PLUGIN_ID);

export const EVIDENCE_DOCLING_LLAMAINDEX_PLUGIN: DkbBundledPluginModule = {
  apiVersion: DKB_PLUGIN_API_VERSION,
  id: DKB_EVIDENCE_DOCLING_LLAMAINDEX_PLUGIN_ID,
  version: DKB_EVIDENCE_DOCLING_LLAMAINDEX_PLUGIN_VERSION,
  sourceUrl: import.meta.url,
  optionsSchema,
  identity: ({ options }) => {
    const tokenizerModel = stringOption(options.tokenizerModel) ?? DEFAULT_TOKENIZER_MODEL;
    const revision = tokenizerRevision(tokenizerModel, options.tokenizerRevision);
    const evidenceOptions = resolveEvidenceOptions(options);
    const imageDigest = isSha256Digest(options.imageDigest) ? options.imageDigest : undefined;
    return {
      profileOptions: { tokenizerModel, tokenizerRevision: revision, ...evidenceOptions },
      external: [
        ...(imageDigest ? [{ kind: 'image' as const, name: 'evidence-worker', digest: imageDigest }] : []),
        { kind: 'model', name: 'tokenizer', digest: stableHash({ model: tokenizerModel, revision }) },
        { kind: 'model', name: 'docling-assets', digest: evidenceModelAssetsDigest(evidenceOptions) },
      ],
    };
  },
  integrity: {
    apiVersion: DKB_PLUGIN_API_VERSION,
    id: DKB_EVIDENCE_DOCLING_LLAMAINDEX_PLUGIN_ID,
    version: DKB_EVIDENCE_DOCLING_LLAMAINDEX_PLUGIN_VERSION,
    protocols: ['dkb.evidence.v4'],
    artifactFormats: [],
  },
  setup(context) {
    const serviceOptions = {
      image: stringOption(context.options.image),
      imageDigest: stringOption(context.options.imageDigest),
      model: stringOption(context.options.tokenizerModel) ?? DEFAULT_TOKENIZER_MODEL,
      modelRevision: stringOption(context.options.tokenizerRevision),
    };
    const provider: DkbEvidenceProvider = {
      kind: 'evidence',
      lifecycle: {
        inspect: () => inspectLlamaIndexCompiler(serviceOptions),
        start: (options) => startLlamaIndexCompilerService({ ...serviceOptions, forceRestart: Boolean(options?.restart) }),
        status: () => compilerServiceStatus(serviceOptions),
        stop: () => stopLlamaIndexCompilerService(serviceOptions),
        doctor: () => doctorLlamaIndexCompilerService(serviceOptions),
      },
      async compile({ dkb, options, signal, execution }) {
        throwIfAborted(signal);
        const model = stringOption(options.tokenizerModel) ?? DEFAULT_TOKENIZER_MODEL;
        const image = stringOption(options.image);
        const timeoutMs = integerOption(options.timeoutMs);
        const workers = integerOption(options.workers);
        const result = await compileDkbWithLlamaIndex(dkb, {
          signal,
          execution,
          model,
          modelRevision: tokenizerRevision(model, options.tokenizerRevision),
          evidenceOptions: resolveEvidenceOptions(options),
          ...(isSha256Digest(options.imageDigest) ? { imageDigest: options.imageDigest } : {}),
          ...(image ? { image } : {}),
          ...(timeoutMs ? { timeoutMs } : {}),
          ...(workers ? { workers } : {}),
        });
        throwIfAborted(signal);
        return {
          records: result.records.map((record) => ({
            id: record.id,
            chunkId: record.id,
            text: record.text,
            provenance: {
              assetId: record.assetId,
              storeId: record.storeId,
              sourceType: record.type,
              locator: record.locator as Record<string, DkbJsonValue>,
              assetLocator: record.assetLocator as Record<string, DkbJsonValue>,
              title: record.title,
              sourceHash: record.sourceHash,
              updatedAt: record.updatedAt,
              chunkOrdinal: record.chunkOrdinal,
              chunkStart: record.chunkStart,
              chunkEnd: record.chunkEnd,
            },
            metadata: record.metadata as Record<string, DkbJsonValue>,
          })),
          receipt: {
            build: {
              compilerId: result.compiler.id,
              tokenizerModel: result.compiler.model,
              tokenizerRevision: result.compiler.modelRevision,
              modelAssetsDigest: result.compiler.modelAssetsDigest,
              evidenceOptions: { ...result.compiler.evidenceOptions },
              extraction: { richParser: 'docling', richChunker: 'docling.hybrid', fallbackParser: 'llamaindex', fallbackChunker: 'llamaindex.sentence' },
            },
            diagnostics: {
              compilerImage: result.compiler.image,
              ...(result.execution ? { execution: result.execution as DkbJsonValue } : {}),
              ...(result.cache ? { cache: result.cache as unknown as DkbJsonValue } : {}),
            },
          },
        };
      },
      cancelPending: ({ state, options, signal }) => cancelLlamaIndexPending({
        state, signal,
        options: {
          image: stringOption(options.image),
          imageDigest: stringOption(options.imageDigest),
          model: stringOption(options.tokenizerModel) ?? DEFAULT_TOKENIZER_MODEL,
          modelRevision: stringOption(options.tokenizerRevision),
        },
      }),
      health: () => compilerProviderHealth(serviceOptions),
    };
    context.registerProvider(provider);
  },
};

function stringOption(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function integerOption(value: unknown): number | undefined { return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined; }
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason ?? new DkbError(`${DKB_EVIDENCE_DOCLING_LLAMAINDEX_PLUGIN_ID} was cancelled`); }
