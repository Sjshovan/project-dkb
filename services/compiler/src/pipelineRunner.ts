import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import type { LoadedDkb } from '@sjshovan/dkb-protocol/types.js';
import { DkbProviderHost } from '@sjshovan/dkb-pipeline/host.js';
import {
  validatePipelineChunks,
  validatePipelineDocuments,
  validatePipelineRecords,
  validateParsedDocuments,
  validateLocatedChunks,
  validateVectors,
} from '@sjshovan/dkb-pipeline/validation.js';
import { normalizeDkbOwnedRecordMetadata, pipelineRecordFields } from './records.js';
import type {
  DkbChunkerProvider,
  DkbEmbeddingProvider,
  DkbEvidencePipeline,
  DkbEvidenceProvider,
  DkbParserProvider,
  DkbPipelineRecord,
  DkbRetrievalPipeline,
} from '@sjshovan/dkb-pipeline/types.js';
import { embeddingCacheEnabled, openEmbeddingCache } from './embeddingCache.js';
import { providerReceipt } from './providerReceipts.js';
import type { ProviderExecutionFactory } from './providerExecution.js';

export async function compileDkbWithProviderHost(
  host: DkbProviderHost,
  dkb: LoadedDkb,
  options: { signal?: AbortSignal; execution?: ProviderExecutionFactory } = {},
): Promise<DkbRetrievalPipeline> {
  return embedDkbEvidenceWithProviderHost(host, await ingestDkbWithProviderHost(host, dkb, options), options);
}

export async function ingestDkbWithProviderHost(
  host: DkbProviderHost,
  dkb: LoadedDkb,
  options: { signal?: AbortSignal; execution?: ProviderExecutionFactory } = {},
): Promise<DkbEvidencePipeline> {
  const target = host.config.target;
  let result: DkbEvidencePipeline;

  if (target.evidence) {
    const evidenceProvider = host.provider<DkbEvidenceProvider>('evidence');
    const compiled = await evidenceProvider.compile({
      dkb,
      options: host.optionsFor(target.evidence),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.execution ? { execution: options.execution(host, 'evidence') } : {}),
    });
    const receipt = providerReceipt(host, 'evidence', compiled?.receipt);
    const documents = validatePipelineDocuments(compiled.documents ?? [], target.evidence);
    const chunks = validatePipelineChunks(compiled.chunks ?? [], target.evidence, documents);
    const chunkIds = compiled.chunks === undefined ? undefined : new Set(chunks.map((chunk) => chunk.id));
    result = {
      documents,
      chunks,
      records: validatePipelineRecords(compiled.records, target.evidence, chunkIds),
      receipts: [
        receipt,
      ],
    };
  } else {
    const parserId = target.parser;
    const chunkerId = target.chunker;

    if (!parserId || !chunkerId) {
      throw new DkbError(`Pipeline target ${target.name} requires parser and chunker providers`);
    }
    const parser = host.provider<DkbParserProvider>('parser');
    const chunker = host.provider<DkbChunkerProvider>('chunker');
    const documents = validateParsedDocuments(await parser.parse({ dkb, options: host.optionsFor(parserId), ...(options.signal ? { signal: options.signal } : {}) }), parserId);
    const mutatedDocuments = validateParsedDocuments(await host.mutate('document', documents, options.signal), 'document processors');
    const chunks = validateLocatedChunks(await chunker.chunk({ documents: mutatedDocuments, options: host.optionsFor(chunkerId), ...(options.signal ? { signal: options.signal } : {}) }), chunkerId, mutatedDocuments);
    const mutatedChunks = validateLocatedChunks(await host.mutate('chunk', chunks, options.signal), 'chunk processors', mutatedDocuments);
    const documentsById = new Map(mutatedDocuments.map((document) => [document.id, document]));
    const records: DkbPipelineRecord[] = mutatedChunks.map((chunk) => {
      const document = documentsById.get(chunk.documentId);
      if (!document) throw new DkbError(`Chunk ${chunk.id} references unknown parsed document ${chunk.documentId}`);
      const fields = pipelineRecordFields(dkb, document, chunk);

      return {
        id: chunk.id,
        chunkId: chunk.id,
        text: chunk.text,
        ...fields,
        metadata: { ...fields.metadata, documentId: chunk.documentId },
      };
    });
    result = {
      documents: mutatedDocuments,
      chunks: mutatedChunks,
      records,
      receipts: [
        providerReceipt(host, 'parser', { build: {} }),
        providerReceipt(host, 'chunker', { build: {} }),
      ],
    };
  }

  result.records = normalizeDkbOwnedRecordMetadata(
    dkb,
    validatePipelineRecords(await host.mutate('record', result.records, options.signal), 'record processors'),
  );
  result.receipts.push(...host.describe().processors.map((processor, order) => ({
    kind: 'processor' as const,
    stage: processor.stage,
    providerId: processor.id,
    providerVersion: processor.version,
    providerIntegrityDigest: processor.integrityDigest,
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
  evidence: DkbEvidencePipeline,
  options: { signal?: AbortSignal } = {},
): Promise<DkbRetrievalPipeline> {
  const target = host.config.target;
  const embeddingId = target.embedding;
  if (!embeddingId) {
    return { ...evidence, vectors: [] };
  }
  const embedding = host.provider<DkbEmbeddingProvider>('embedding');
  const embeddingOptions = host.optionsFor(embeddingId);
  const embeddingRegistration = host.describe().providers.find((provider) => provider.kind === 'embedding');
  if (!embeddingRegistration) throw new DkbError(`Selected embedding provider ${embeddingId} has no validated registration`);
  const embeddingCompatibility = providerReceipt(host, 'embedding', {
    build: {},
    compatibility: await embedding.compatibility(embeddingOptions),
  }).compatibility!;
  const spaceDigest = stableHash({
    provider: embeddingId,
    version: embeddingRegistration.version,
    integrity: embeddingRegistration.integrityDigest,
    options: host.profileOptionsFor(embeddingId),
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
  let embedMs = 0;
  let cacheWriteMs = 0;
  try {
    options.signal?.throwIfAborted();
    const embedded = missing.length === 0
      ? []
      : await embedding.embedDocuments({
          texts: missing.map(([, text]) => text),
          options: embeddingOptions,
          ...(options.signal ? { signal: options.signal } : {}),
        });
    options.signal?.throwIfAborted();
    embedMs = performance.now() - embedStarted;
    const cacheWriteStarted = performance.now();
    const validated = validateVectors(embedded, missing.length, expectedDimensions, `${embeddingId} document embedding`);
    for (let index = 0; index < missing.length; index += 1) {
      const [textHash] = missing[index]!;
      const vector = validated[index]!;
      vectorsByTextHash.set(textHash, vector);
      cache?.put(textHash, vector);
    }
    cacheWriteMs = performance.now() - cacheWriteStarted;
  } finally {
    cache?.close();
  }
  const vectors = evidence.records.map((record) => {
    const textHash = stableHash({ text: record.text });
    const vector = vectorsByTextHash.get(textHash);
    if (!vector) throw new DkbError(`Embedding vector is missing for Evidence record ${record.id}`);
    return [...vector];
  });

  if (vectors.length !== evidence.records.length) {
    throw new DkbError(`Embedding provider ${embeddingId} returned ${vectors.length} vectors for ${evidence.records.length} Evidence records`);
  }
  const result: DkbRetrievalPipeline = {
    ...evidence,
    vectors: evidence.records.map((record, index) => ({
      evidenceId: record.id,
      values: vectors[index]!,
    })),
    receipts: [
      ...evidence.receipts,
      providerReceipt(host, 'embedding', {
        build: {},
        diagnostics: {
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
      }),
    ],
  };

  return result;
}

function positiveIntegerOrUndefined(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}
