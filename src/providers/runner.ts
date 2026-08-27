import { DkbError } from '@dkb/protocol/errors.js';
import type { LoadedDkb } from '@dkb/protocol/types.js';
import { DkbProviderHost } from '@dkb/pipeline/host.js';
import { pipelineRecordMetadata, refreshMutatedRecordHashes } from './records.js';
import type {
  DkbChunkerProvider,
  DkbCompiledPipeline,
  DkbEmbeddingProvider,
  DkbIngestionProvider,
  DkbParserProvider,
  DkbPipelineRecord,
} from '@dkb/pipeline/types.js';

export async function compileDkbWithProviderHost(
  host: DkbProviderHost,
  dkb: LoadedDkb,
  options: { signal?: AbortSignal } = {},
): Promise<DkbCompiledPipeline> {
  const target = host.config.target;
  const embedding = host.provider<DkbEmbeddingProvider>('embedding');
  const embeddingOptions = host.optionsFor(target.embedding);
  const embeddingRegistration = host.describe().providers.find((provider) => provider.kind === 'embedding');
  const embeddingCompatibility = await embedding.compatibility(embeddingOptions);
  let result: DkbCompiledPipeline;

  if (target.ingestion) {
    const ingestion = host.provider<DkbIngestionProvider>('ingestion');
    const compiled = await ingestion.compile({
      dkb,
      options: host.optionsFor(target.ingestion),
      embedding: {
        id: target.embedding,
        version: embeddingRegistration?.version ?? 'unknown',
        options: embeddingOptions,
        compatibility: embeddingCompatibility,
        embedDocuments: (texts, signal) => embedding.embedDocuments({ texts, options: embeddingOptions, ...(signal ? { signal } : {}) }),
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    result = {
      documents: compiled.documents ?? [],
      chunks: compiled.chunks ?? [],
      records: compiled.records,
      receipts: [
        compiled.receipt,
        {
          providerId: target.embedding,
          providerVersion: embeddingRegistration?.version ?? 'unknown',
          build: {},
          compatibility: embeddingCompatibility,
        },
      ],
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
    const documents = await parser.parse({ dkb, options: host.optionsFor(parserId), ...(options.signal ? { signal: options.signal } : {}) });
    const mutatedDocuments = await host.mutate('document', documents, options.signal);
    const chunks = await chunker.chunk({ documents: mutatedDocuments, options: host.optionsFor(chunkerId), ...(options.signal ? { signal: options.signal } : {}) });
    const mutatedChunks = await host.mutate('chunk', chunks, options.signal);
    const vectors = await embedding.embedDocuments({
      texts: mutatedChunks.map((chunk) => chunk.text),
      options: embeddingOptions,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (vectors.length !== mutatedChunks.length) {
      throw new DkbError(`Embedding provider ${target.embedding} returned ${vectors.length} vectors for ${mutatedChunks.length} chunks`);
    }
    const documentsById = new Map(mutatedDocuments.map((document) => [document.id, document]));
    const ordinalByDocument = new Map<string, number>();
    const records: DkbPipelineRecord[] = mutatedChunks.map((chunk, index) => {
      const ordinal = ordinalByDocument.get(chunk.documentId) ?? 0;
      ordinalByDocument.set(chunk.documentId, ordinal + 1);

      return {
        id: chunk.id,
        chunkId: chunk.id,
        text: chunk.text,
        embedding: vectors[index],
        metadata: {
          ...pipelineRecordMetadata(dkb, documentsById.get(chunk.documentId), chunk, ordinal),
          documentId: chunk.documentId,
        },
      };
    });
    result = {
      documents: mutatedDocuments,
      chunks: mutatedChunks,
      records,
      receipts: [
        { providerId: parserId, providerVersion: host.describe().providers.find((provider) => provider.kind === 'parser')?.version ?? 'unknown', build: {} },
        { providerId: chunkerId, providerVersion: host.describe().providers.find((provider) => provider.kind === 'chunker')?.version ?? 'unknown', build: {} },
        {
          providerId: target.embedding,
          providerVersion: embeddingRegistration?.version ?? 'unknown',
          build: {},
          compatibility: embeddingCompatibility,
        },
      ],
    };
  }

  if (target.ingestion) {
    result.documents = await host.mutate('document', result.documents, options.signal);
    result.chunks = await host.mutate('chunk', result.chunks, options.signal);
  }
  const beforeRecordMutation = result.records;
  result.records = refreshMutatedRecordHashes(
    beforeRecordMutation,
    await host.mutate('record', beforeRecordMutation, options.signal),
  );
  const processorReceipts = host.describe().processors.map((processor, order) => ({
    providerId: processor.id,
    providerVersion: processor.version,
    build: {
      kind: 'processor',
      stage: processor.stage,
      order,
      sourceDigest: processor.sourceDigest,
    },
  }));
  result.receipts.push(...processorReceipts);

  return result;
}
