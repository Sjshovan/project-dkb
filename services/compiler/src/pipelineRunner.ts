import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import type { LoadedDkb } from '@sjshovan/dkb-protocol/types.js';
import { DkbProviderHost } from '@sjshovan/dkb-pipeline/host.js';
import { pipelineRecordMetadata, refreshMutatedRecordHashes } from '@sjshovan/dkb-providers-bundled/records.js';
import type {
  DkbChunkerProvider,
  DkbCompiledPipeline,
  DkbEmbeddingProvider,
  DkbEvidenceProvider,
  DkbParserProvider,
  DkbPipelineRecord,
} from '@sjshovan/dkb-pipeline/types.js';
import { embeddingCacheEnabled, openEmbeddingCache } from './embeddingCache.js';

export async function compileDkbWithProviderHost(
  host: DkbProviderHost,
  dkb: LoadedDkb,
  options: { signal?: AbortSignal } = {},
): Promise<DkbCompiledPipeline> {
  return embedDkbEvidenceWithProviderHost(host, await ingestDkbWithProviderHost(host, dkb, options), options);
}

export async function ingestDkbWithProviderHost(
  host: DkbProviderHost,
  dkb: LoadedDkb,
  options: { signal?: AbortSignal } = {},
): Promise<DkbCompiledPipeline> {
  const target = host.config.target;
  let result: DkbCompiledPipeline;

  if (target.evidence) {
    const evidenceProvider = host.provider<DkbEvidenceProvider>('evidence');
    const compiled = await evidenceProvider.compile({
      dkb,
      options: host.optionsFor(target.evidence),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    result = {
      documents: compiled.documents ?? [],
      chunks: compiled.chunks ?? [],
      records: compiled.records,
      receipts: [
        compiled.receipt,
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
    const documentsById = new Map(mutatedDocuments.map((document) => [document.id, document]));
    const ordinalByDocument = new Map<string, number>();
    const records: DkbPipelineRecord[] = mutatedChunks.map((chunk) => {
      const ordinal = ordinalByDocument.get(chunk.documentId) ?? 0;
      ordinalByDocument.set(chunk.documentId, ordinal + 1);

      return {
        id: chunk.id,
        chunkId: chunk.id,
        text: chunk.text,
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
      ],
    };
  }

  if (target.evidence) {
    result.documents = await host.mutate('document', result.documents, options.signal);
    result.chunks = await host.mutate('chunk', result.chunks, options.signal);
  }
  const beforeRecordMutation = result.records;
  result.records = refreshMutatedRecordHashes(
    beforeRecordMutation,
    await host.mutate('record', beforeRecordMutation, options.signal),
  );
  result.records = result.records.map((record) => ({ ...record, embedding: undefined }));
  result.receipts.push(...host.describe().processors.map((processor, order) => ({
    providerId: processor.id,
    providerVersion: processor.version,
    build: {
      kind: 'processor',
      stage: processor.stage,
      order,
      sourceDigest: processor.sourceDigest,
    },
  })));

  return result;
}

export async function embedDkbEvidenceWithProviderHost(
  host: DkbProviderHost,
  evidence: DkbCompiledPipeline,
  options: { signal?: AbortSignal } = {},
): Promise<DkbCompiledPipeline> {
  const target = host.config.target;
  const embedding = host.provider<DkbEmbeddingProvider>('embedding');
  const embeddingOptions = host.optionsFor(target.embedding);
  const embeddingRegistration = host.describe().providers.find((provider) => provider.kind === 'embedding');
  const embeddingCompatibility = await embedding.compatibility(embeddingOptions);
  const spaceDigest = stableHash({
    provider: target.embedding,
    version: embeddingRegistration?.version ?? 'unknown',
    implementation: embeddingRegistration?.sourceDigest ?? 'unknown',
    compatibility: embeddingCompatibility,
  });
  const expectedDimensions = positiveIntegerOrUndefined(embeddingCompatibility.dimensions);
  const totalStarted = performance.now();
  const cacheStarted = performance.now();
  const cache = embeddingCacheEnabled() ? await openEmbeddingCache(host.root, spaceDigest) : null;
  const vectorsByTextHash = new Map<string, number[]>();
  const uniqueTexts = new Map<string, string>();
  for (const record of evidence.records) {
    const textHash = stableHash({ text: record.text });
    const previous = uniqueTexts.get(textHash);
    if (previous !== undefined && previous !== record.text) throw new DkbError(`Embedding text hash collision for ${record.id}`);
    uniqueTexts.set(textHash, record.text);
  }
  let hits = 0;
  if (cache) {
    for (const textHash of uniqueTexts.keys()) {
      const vector = cache.get(textHash, expectedDimensions);
      if (vector) {
        vectorsByTextHash.set(textHash, vector);
        hits += 1;
      }
    }
  }
  const cacheLookupMs = performance.now() - cacheStarted;
  const missing = [...uniqueTexts.entries()].filter(([textHash]) => !vectorsByTextHash.has(textHash));
  const embedStarted = performance.now();
  const embedded = missing.length === 0
    ? []
    : await embedding.embedDocuments({
        texts: missing.map(([, text]) => text),
        options: embeddingOptions,
        ...(options.signal ? { signal: options.signal } : {}),
      });
  const embedMs = performance.now() - embedStarted;

  if (embedded.length !== missing.length) {
    cache?.close();
    throw new DkbError(`Embedding provider ${target.embedding} returned ${embedded.length} vectors for ${missing.length} uncached Evidence records`);
  }
  const cacheWriteStarted = performance.now();
  try {
    for (let index = 0; index < missing.length; index += 1) {
      const [textHash] = missing[index]!;
      const vector = validateVector(embedded[index], expectedDimensions, `${target.embedding} document vector ${index}`);
      vectorsByTextHash.set(textHash, vector);
      cache?.put(textHash, vector);
    }
  } finally {
    cache?.close();
  }
  const cacheWriteMs = performance.now() - cacheWriteStarted;
  const vectors = evidence.records.map((record) => {
    const textHash = stableHash({ text: record.text });
    const vector = vectorsByTextHash.get(textHash);
    if (!vector) throw new DkbError(`Embedding vector is missing for Evidence record ${record.id}`);
    return [...vector];
  });

  if (vectors.length !== evidence.records.length) {
    throw new DkbError(`Embedding provider ${target.embedding} returned ${vectors.length} vectors for ${evidence.records.length} Evidence records`);
  }
  const result: DkbCompiledPipeline = {
    ...evidence,
    records: evidence.records.map((record, index) => ({
    ...record,
    embedding: vectors[index],
    })),
    receipts: [
      ...evidence.receipts,
      {
        providerId: target.embedding,
        providerVersion: embeddingRegistration?.version ?? 'unknown',
        build: {
          cache: {
            enabled: Boolean(cache),
            spaceDigest,
            hits,
            misses: missing.length,
            uniqueTexts: uniqueTexts.size,
          },
          timingsMs: {
            cacheLookup: cacheLookupMs,
            embedding: embedMs,
            cacheWrite: cacheWriteMs,
            total: performance.now() - totalStarted,
          },
        },
        compatibility: embeddingCompatibility,
      },
    ],
  };

  return result;
}

function positiveIntegerOrUndefined(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function validateVector(value: unknown, expectedDimensions: number | undefined, label: string): number[] {
  if (!Array.isArray(value)
    || value.length === 0
    || (expectedDimensions !== undefined && value.length !== expectedDimensions)
    || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    throw new DkbError(
      `${label} is invalid${expectedDimensions !== undefined ? `; expected ${expectedDimensions} finite dimensions` : ''}`,
    );
  }
  return [...value];
}
