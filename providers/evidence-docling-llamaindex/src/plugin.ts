import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbBundledPlugin } from '@sjshovan/dkb-pipeline/host.js';
import { DKB_PLUGIN_API_VERSION, type DkbEvidenceProvider } from '@sjshovan/dkb-pipeline/types.js';
import {
  LLAMAINDEX_COMPILER_ID,
  LLAMAINDEX_COMPILER_IMAGE,
  compileDkbWithLlamaIndex,
  compilerServiceStatus,
  doctorLlamaIndexCompilerService,
  inspectLlamaIndexCompiler,
  startLlamaIndexCompilerService,
  stopLlamaIndexCompilerService,
} from './compiler.js';

export const DKB_EVIDENCE_DOCLING_LLAMAINDEX_PLUGIN_ID = '@dkb/evidence-docling-llamaindex';
export const DKB_EVIDENCE_DOCLING_LLAMAINDEX_PLUGIN_VERSION = '0.1.0';
const DEFAULT_TOKENIZER_MODEL = 'BAAI/bge-small-en-v1.5';

export const EVIDENCE_DOCLING_LLAMAINDEX_PLUGIN: DkbBundledPlugin = {
  apiVersion: DKB_PLUGIN_API_VERSION,
  id: DKB_EVIDENCE_DOCLING_LLAMAINDEX_PLUGIN_ID,
  version: DKB_EVIDENCE_DOCLING_LLAMAINDEX_PLUGIN_VERSION,
  setup(context) {
    const provider: DkbEvidenceProvider = {
      kind: 'evidence',
      lifecycle: {
        inspect: () => inspectLlamaIndexCompiler(),
        start: (options) => startLlamaIndexCompilerService({ forceRestart: Boolean(options?.restart) }),
        status: () => compilerServiceStatus(),
        stop: () => stopLlamaIndexCompilerService(),
        doctor: () => doctorLlamaIndexCompilerService(),
      },
      async compile({ dkb, options, signal }) {
        throwIfAborted(signal);
        const model = stringOption(options.tokenizerModel) ?? DEFAULT_TOKENIZER_MODEL;
        const image = stringOption(options.image);
        const timeoutMs = integerOption(options.timeoutMs);
        const workers = integerOption(options.workers);
        const result = await compileDkbWithLlamaIndex(dkb, {
          model,
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
            providerId: DKB_EVIDENCE_DOCLING_LLAMAINDEX_PLUGIN_ID,
            providerVersion: DKB_EVIDENCE_DOCLING_LLAMAINDEX_PLUGIN_VERSION,
            build: {
              compilerId: result.compiler.id,
              compilerImage: result.compiler.image,
              tokenizerModel: result.compiler.model,
              extraction: { richParser: 'docling', richChunker: 'docling.hybrid', fallbackParser: 'llamaindex', fallbackChunker: 'llamaindex.sentence' },
              ...(result.execution ? { execution: result.execution } : {}),
              ...(result.cache ? { cache: result.cache } : {}),
            },
          },
        };
      },
      async health() {
        const status = await compilerServiceStatus();
        return { ok: status.docker && Boolean(status.image), detail: status.docker && Boolean(status.image) ? `${LLAMAINDEX_COMPILER_ID} via ${LLAMAINDEX_COMPILER_IMAGE}` : 'Docker or the Evidence worker image is unavailable' };
      },
    };
    context.registerProvider(provider);
  },
};

function stringOption(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function integerOption(value: unknown): number | undefined { return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined; }
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason ?? new DkbError(`${DKB_EVIDENCE_DOCLING_LLAMAINDEX_PLUGIN_ID} was cancelled`); }
