import { DkbError } from '../protocol/errors.js';
import type { LoadedDkb } from '../protocol/types.js';
import { DkbProviderHost } from './host.js';
import type {
  DkbChunkerProvider,
  DkbCompiledPipeline,
  DkbEmbeddingProvider,
  DkbIngestionProvider,
  DkbParserProvider,
  DkbPipelineRecord,
} from './types.js';

export async function compileDkbWithProviderHost(
  host: DkbProviderHost,
  dkb: LoadedDkb,
  options: { signal?: AbortSignal } = {},
): Promise<DkbCompiledPipeline> {
  const target = host.config.target;
  let result: DkbCompiledPipeline;

  if (target.ingestion) {
    const ingestion = host.provider<DkbIngestionProvider>('ingestion');
    const compiled = await ingestion.compile({
      dkb,
      options: host.optionsFor(target.ingestion),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    result = {
      documents: compiled.documents ?? [],
      chunks: compiled.chunks ?? [],
      records: compiled.records,
      receipts: [compiled.receipt],
      ...(compiled.nativeResult !== undefined ? { nativeResult: compiled.nativeResult } : {}),
    };
  } else {
    const parserId = target.parser;
    const chunkerId = target.chunker;

    if (!parserId || !chunkerId) {
      throw new DkbError(`Pipeline target ${target.name} requires parser and chunker providers`);
    }
    const parser = host.provider<DkbParserProvider>('parser');
    const chunker = host.provider<DkbChunkerProvider>('chunker');
    const embedding = host.provider<DkbEmbeddingProvider>('embedding');
    const documents = await parser.parse({ dkb, options: host.optionsFor(parserId), ...(options.signal ? { signal: options.signal } : {}) });
    const mutatedDocuments = await host.mutate('document', documents, options.signal);
    const chunks = await chunker.chunk({ documents: mutatedDocuments, options: host.optionsFor(chunkerId), ...(options.signal ? { signal: options.signal } : {}) });
    const mutatedChunks = await host.mutate('chunk', chunks, options.signal);
    const vectors = await embedding.embedDocuments({
      texts: mutatedChunks.map((chunk) => chunk.text),
      options: host.optionsFor(target.embedding),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (vectors.length !== mutatedChunks.length) {
      throw new DkbError(`Embedding provider ${target.embedding} returned ${vectors.length} vectors for ${mutatedChunks.length} chunks`);
    }
    const records: DkbPipelineRecord[] = mutatedChunks.map((chunk, index) => ({
      id: chunk.id,
      chunkId: chunk.id,
      text: chunk.text,
      embedding: vectors[index],
      metadata: { ...chunk.metadata, documentId: chunk.documentId },
    }));
    result = {
      documents: mutatedDocuments,
      chunks: mutatedChunks,
      records,
      receipts: [
        { providerId: parserId, providerVersion: host.describe().providers.find((provider) => provider.kind === 'parser')?.version ?? 'unknown', build: {} },
        { providerId: chunkerId, providerVersion: host.describe().providers.find((provider) => provider.kind === 'chunker')?.version ?? 'unknown', build: {} },
        {
          providerId: target.embedding,
          providerVersion: host.describe().providers.find((provider) => provider.kind === 'embedding')?.version ?? 'unknown',
          build: {},
          compatibility: await embedding.compatibility(host.optionsFor(target.embedding)),
        },
      ],
    };
  }

  if (target.ingestion) {
    result.documents = await host.mutate('document', result.documents, options.signal);
    result.chunks = await host.mutate('chunk', result.chunks, options.signal);
  }
  result.records = await host.mutate('record', result.records, options.signal);

  return result;
}
