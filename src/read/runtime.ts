import { performance } from 'node:perf_hooks';
import { stableHash } from '../contracts/hash.js';
import type { QueryContext } from '../indexes/queryContext.js';
import {
  queryEvidenceForSourceUnits,
  querySourceChunks,
  readSourceIndex,
  type IndexedSourceAsset,
  type IndexedSourceUnit,
  type SourceUnitMatch,
  type SourceUnitQueryEvidence,
} from '../indexes/sourceIndex.js';
import { querySearchDocuments, vectorDocumentsForSourceUnits } from '../indexes/vectorStore.js';
import { searchFaissSnapshot } from '../indexes/faissStore.js';
import { validateDkbReadRequest } from '../protocol/validation.js';
import type {
  DkbEvidence,
  DkbEvidenceSufficiency,
  DkbReadQuery,
  DkbReadRequest,
  DkbReadResult,
  DkbReadStatus,
} from '../protocol/types.js';
import { tokenize } from '../router/scoring.js';
import { renderUntrustedSourceBlock, SOURCE_DATA_POLICY_LINE } from '../security/sourceContent.js';
import { readNavigationChunks, semanticSearch } from './navigation.js';

export interface DkbRetrieveKnowledgeRequest {
  need: string;
  intent?: 'evidence' | 'records' | 'count' | 'summary' | 'compare';
  phrases?: string[];
  limit?: number;
  profile?: boolean;
}

export interface DkbRetrieveKnowledgeResponse {
  status: DkbReadStatus;
  sourcePolicy: string;
  evidence: DkbEvidence[];
  sufficiency: DkbEvidenceSufficiency;
  metadata: {
    requestId: string;
    query: string;
    intent: NonNullable<DkbRetrieveKnowledgeRequest['intent']>;
    chunksMatched?: number;
    chunksRead?: number;
    sourceUnitsMatched: number;
    sourceUnitsRead: number;
    adapterGroups: Array<{
      dkbId: string;
      storeId: string;
      sourceType: string;
      chunks: number;
      sourceUnits: number;
    }>;
    sourceUnitMatches: Array<{
      registryId?: string;
      sourceOrigin?: string;
      dkbId: string;
      packageVersion?: string;
      sourceId: string;
      assetId?: string;
      assetLocator?: Record<string, unknown>;
      sourceAssetHash?: string;
      chunkHash?: string;
      chunkOrdinal?: number;
      chunkStart?: number;
      chunkEnd?: number;
      storeId: string;
      type: string;
      matchedTokens: string[];
      matchedPhrases: string[];
      matchedIdentifiers: string[];
      matchedKeywords: string[];
    }>;
    retrievalProfile?: unknown;
  };
}

export interface DkbQueryTargetDescription {
  target: string;
  dkbId: string;
  sourceId: string;
  recordId: string;
  title: string;
  summary: string;
  source: string;
  sourceType: string | null;
  operations: string[];
  fields: Record<string, unknown>;
  defaultLimit: number;
  maxLimit: number;
  score: number;
}

export interface DkbQueryTargetResponse {
  status: 'ready' | 'empty';
  query: string;
  targets: DkbQueryTargetDescription[];
  trace: unknown[];
}

export async function describeQueryTargets(root: string, query: string, limit = 10, queryContext?: QueryContext): Promise<DkbQueryTargetResponse> {
  const sourceIndex = queryContext ? { units: queryContext.sourceUnits } : await maybeReadSourceIndexData(root);
  const result = await semanticSearch(root, query, limit, undefined, queryContext);
  const unitsById = new Map(sourceIndex.units.map((unit) => [unit.id, unit]));
  const targets = result.results
    .map((hit) => unitsById.get(hit.id))
    .filter((unit): unit is IndexedSourceUnit => Boolean(unit))
    .map((unit, index) => ({
      target: `${unit.dkbId}/${unit.id}`,
      dkbId: unit.dkbId,
      sourceId: unit.id,
      recordId: unit.id,
      title: unit.title,
      summary: unit.text,
      source: unit.id,
      sourceType: unit.type,
      operations: unit.queryable?.operations ?? [],
      fields: unit.queryable?.fields ?? {},
      defaultLimit: unit.queryable?.defaultLimit ?? 10,
      maxLimit: unit.queryable?.maxLimit ?? 100,
      score: result.results[index]?.score ?? 0,
    }));

  return {
    status: targets.length > 0 ? 'ready' : 'empty',
    query,
    targets,
    trace: [result.trace],
  };
}

export async function retrieveKnowledge(
  root: string,
  request: DkbRetrieveKnowledgeRequest,
  queryContext?: QueryContext,
): Promise<DkbRetrieveKnowledgeResponse> {
  const query = retrievalQueryText(request);
  const limit = Math.max(1, Math.min(request.limit ?? 8, 100));
  const sourceIndex = queryContext
    ? { assets: queryContext.sourceAssets, units: queryContext.sourceUnits }
    : await maybeReadSourceIndexData(root);
  const sourceUnits = sourceIndex.units;
  const sourceIndexQuery = sourceIndexRetrievalQuery(query, request);
  const queryEvidence = queryEvidenceForSourceUnits(sourceIndexQuery);

  if (sourceUnits.length === 0) {
    return blockedRetrievalResponse(request, query);
  }

  const candidateLimit = Math.max(limit * 3, 20);
  const sourceUnitsById = queryContext?.sourceUnitsById ?? new Map(sourceUnits.map((unit) => [unit.id, unit]));
  const lexicalStart = performance.now();
  const lexicalMatches = queryContext?.lexical
    ? queryContext.lexical.search(query, candidateLimit)
      .map((hit) => sourceUnitsById.get(hit.unitId))
      .filter((unit): unit is IndexedSourceUnit => Boolean(unit))
      .map((unit) => querySourceChunks([unit], sourceIndexQuery, 1)[0] ?? emptyMatch(unit))
    : querySourceChunks(sourceUnits, sourceIndexQuery, candidateLimit);
  const lexicalQueryMs = performance.now() - lexicalStart;
  const vectorStart = performance.now();
  const vectorResult = queryContext?.faiss
    ? await searchFaissSnapshot(queryContext.faiss, query, candidateLimit, queryContext.embedQuery)
    : await querySearchDocuments(
      queryContext?.searchRegistryId ?? 'compose-index',
      queryContext?.vectorDocuments ?? vectorDocumentsForSourceUnits(sourceUnits),
      query,
      candidateLimit,
      queryContext?.vectorArtifactRoot,
      request.phrases ?? [],
    );
  const vectorQueryMs = performance.now() - vectorStart;
  const vectorMatches = vectorResult.hits
    .map((hit) => sourceUnitsById.get(hit.id))
    .filter((unit): unit is IndexedSourceUnit => Boolean(unit))
    .map((unit) => querySourceChunks([unit], sourceIndexQuery, 1)[0] ?? emptyMatch(unit));
  const candidateChunkMatches = fuseChunkMatches(lexicalMatches, vectorMatches, candidateLimit);
  const exactMatchRequired = requiresExactCompiledMatch(request, queryEvidence);
  const chunkMatchesForRead = (exactMatchRequired
    ? candidateChunkMatches.filter((match) => satisfiesExactCompiledMatch(match, request, queryEvidence))
    : candidateChunkMatches).slice(0, limit);

  const directChunkMatches = chunkMatchesForRead.filter((match) => hasCompiledMatchEvidence(match.evidence));
  const profile = request.profile ? {
    timingsMs: {
      total: roundMs(lexicalQueryMs + vectorQueryMs),
      artifactContext: 0,
      dkbFilter: 0,
      tokenize: 0,
      lexicalScore: roundMs(lexicalQueryMs),
      vectorQuery: roundMs(vectorQueryMs),
      graphExpansion: 0,
      fusion: 0,
      traceAssembly: 0,
    },
    counts: {
      totalRecords: sourceUnits.length,
      filteredRecords: sourceUnits.length,
      lexicalHits: lexicalMatches.filter((match) => hasCompiledMatchEvidence(match.evidence)).length,
      vectorHits: vectorResult.hits.length,
      graphHits: 0,
      fusedHits: candidateChunkMatches.length,
      returnedHits: chunkMatchesForRead.length,
    },
    passes: ['lexical', 'vector'],
  } : undefined;

  if (chunkMatchesForRead.length === 0) {
    return blockedRetrievalResponse(request, query, profile);
  }

  const readResult: DkbReadResult = {
    status: 'complete',
    sourcePolicy: SOURCE_DATA_POLICY_LINE,
    queries: compiledChunkResultsForMatches(chunkMatchesForRead, query, request),
  };
  const evidence = readResult.queries.flatMap((item) => item.evidence).map(redactEvidenceSource);

  return {
    status: readResult.status,
    sourcePolicy: readResult.sourcePolicy,
    evidence,
    sufficiency: evaluateEvidenceSufficiency(readResult, query),
    metadata: {
      requestId: retrievalRequestId(request),
      query,
      intent: request.intent ?? 'evidence',
      chunksMatched: directChunkMatches.length,
      chunksRead: chunkMatchesForRead.length,
      sourceUnitsMatched: directChunkMatches.length,
      sourceUnitsRead: chunkMatchesForRead.length,
      adapterGroups: adapterGroupsForSourceMatches(chunkMatchesForRead),
      sourceUnitMatches: sourceUnitMatchesForMatches(chunkMatchesForRead, sourceIndex.assets, queryContext?.sourceAssetsByKey),
      retrievalProfile: profile,
    },
  };
}

export async function readDkb(root: string, request: DkbReadRequest, queryContext?: QueryContext): Promise<DkbReadResult> {
  const validatedRequest = validateDkbReadRequest(request, 'DKB read request');
  const fetchQueries = validatedRequest.queries.filter((query) => query.operation === 'fetch');
  const direct = await readNavigationChunks(root, fetchQueries.map((query) => query.target), queryContext);

  const queries = validatedRequest.queries.map((query) => {
    if (query.operation !== 'fetch') {
      return {
        id: query.id,
        target: query.target,
        status: 'blocked' as const,
        reason: 'unsupported_operation' as const,
        message: 'Use dkb.semantic_search or dkb.find to discover chunk references, then fetch them with operation fetch.',
        evidence: [],
        trace: { navigation: true },
      };
    }

    if (query.filters && query.filters.length > 0) {
      return {
        id: query.id,
        target: query.target,
        status: 'blocked' as const,
        reason: 'unsupported_field' as const,
        message: 'Direct chunk fetch does not apply filters; search first and fetch the returned reference.',
        evidence: [],
        trace: { navigation: true },
      };
    }

    const chunk = direct.chunks.find((candidate) => candidate.reference.id === query.target
      || `${candidate.reference.dkbId}/${candidate.reference.id}` === query.target);

    if (!chunk) {
      return {
        id: query.id,
        target: query.target,
        status: 'partial' as const,
        reason: 'no_results' as const,
        message: 'Compiled chunk reference was not found in the active runtime.',
        evidence: [],
        trace: { navigation: true, retrievalMode: 'compiled_chunk_direct' },
      };
    }

    return {
      id: query.id,
      target: query.target,
      status: 'complete' as const,
      reason: null,
      message: 'Compiled source chunk read directly from the active runtime catalog.',
        evidence: [{
        type: 'text' as const,
        label: `[${chunk.reference.dkbId}] ${chunk.reference.title}`,
        text: chunk.text,
        source: {
          storeId: chunk.reference.storeId,
          type: chunk.reference.sourceType as DkbEvidence['source']['type'],
          locator: chunk.reference.locator,
          hash: chunk.reference.sourceHash,
          evidenceId: chunk.reference.evidenceId,
          chunkId: chunk.reference.id,
          dkbId: chunk.reference.dkbId,
          packageVersion: chunk.reference.packageVersion,
        },
      }],
      trace: {
        navigation: true,
        retrievalMode: 'compiled_chunk_direct',
        dkbId: chunk.reference.dkbId,
        packageVersion: chunk.reference.packageVersion,
        sourceId: chunk.reference.sourceId,
        evidenceId: chunk.reference.evidenceId,
        assetId: chunk.reference.assetId,
        storeId: chunk.reference.storeId,
        sourceType: chunk.reference.sourceType,
        locator: chunk.reference.locator,
        assetLocator: chunk.reference.assetLocator,
        sourceHash: chunk.reference.sourceHash,
        chunkOrdinal: chunk.reference.chunkOrdinal,
        chunkStart: chunk.reference.chunkStart,
        chunkEnd: chunk.reference.chunkEnd,
      },
    };
  });

  return sanitizeReadResult({
    status: queries.every((query) => query.status === 'complete')
      ? 'complete'
      : queries.some((query) => query.status === 'complete')
        ? 'partial'
        : 'blocked',
    sourcePolicy: SOURCE_DATA_POLICY_LINE,
    queries,
  });
}

function compiledChunkResultsForMatches(
  matches: SourceUnitMatch[],
  query: string,
  request: DkbRetrieveKnowledgeRequest,
): DkbReadResult['queries'] {
  return matches.map((match, index) => ({
    id: `retrieve-${index + 1}`,
    target: `${match.unit.dkbId}/${match.unit.id}`,
    status: 'complete',
    reason: null,
    message: 'Compiled source chunk retrieved.',
    evidence: [compiledChunkEvidence(match)],
    trace: {
      retrievalMode: 'compiled_chunk_index',
      dkbId: match.unit.dkbId,
      storeId: match.unit.storeId,
      sourceType: match.unit.type,
      sourceId: match.unit.id,
      evidenceId: match.unit.evidenceId,
      assetId: match.unit.assetId,
      chunkOrdinal: match.unit.chunkOrdinal,
      chunkStart: match.unit.chunkStart,
      chunkEnd: match.unit.chunkEnd,
      matchedTokens: match.evidence.tokens,
      matchedPhrases: match.evidence.phrases,
      matchedIdentifiers: match.evidence.identifiers,
      matchedKeywords: match.evidence.keywords,
      requestedLimit: request.limit,
      query,
    },
  }));
}

function compiledChunkEvidence(match: SourceUnitMatch): DkbEvidence {
  return {
    type: 'text',
    label: compiledChunkLabel(match.unit),
    text: renderUntrustedSourceBlock(match.unit.text),
    source: {
      storeId: match.unit.storeId,
      type: match.unit.type,
      locator: match.unit.locator,
      hash: match.unit.hash,
      evidenceId: match.unit.evidenceId,
      chunkId: match.unit.id,
      dkbId: match.unit.dkbId,
      packageVersion: match.unit.packageVersion,
    },
  };
}

function compiledChunkLabel(unit: IndexedSourceUnit): string {
  const pathLabel = typeof unit.assetLocator.path === 'string'
    ? compactPathLabel(unit.assetLocator.path)
    : typeof unit.locator.path === 'string'
      ? compactPathLabel(unit.locator.path)
      : unit.title;

  return unit.chunkOrdinal > 0
    ? `${pathLabel} chunk ${unit.chunkOrdinal + 1}`
    : pathLabel;
}

function blockedRetrievalResponse(
  request: DkbRetrieveKnowledgeRequest,
  query: string,
  profile?: unknown,
): DkbRetrieveKnowledgeResponse {
  return {
    status: 'blocked',
    sourcePolicy: SOURCE_DATA_POLICY_LINE,
    evidence: [],
    sufficiency: {
      status: 'blocked',
      confidence: 0,
      matchedNeed: false,
      expanded: false,
      reason: 'no_evidence',
      passes: 1,
    },
    metadata: {
      requestId: retrievalRequestId(request),
      query,
      intent: request.intent ?? 'evidence',
      chunksMatched: 0,
      chunksRead: 0,
      sourceUnitsMatched: 0,
      sourceUnitsRead: 0,
      adapterGroups: [],
      sourceUnitMatches: [],
      retrievalProfile: profile,
    },
  };
}

function hasCompiledMatchEvidence(evidence: SourceUnitMatch['evidence']): boolean {
  return evidence.phrases.length > 0
    || evidence.identifiers.length > 0
    || evidence.keywords.length > 0
    || evidence.tokens.length > 0;
}

function satisfiesExactCompiledMatch(
  match: SourceUnitMatch,
  request: DkbRetrieveKnowledgeRequest,
  queryEvidence: SourceUnitQueryEvidence,
): boolean {
  const explicitPhrases = (request.phrases ?? [])
    .map((phrase) => phrase.toLowerCase().replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  if (explicitPhrases.length > 0) {
    return explicitPhrases.some((phrase) => match.evidence.phrases.includes(phrase));
  }

  if (queryEvidence.identifiers.length > 0) {
    return match.evidence.identifiers.length > 0;
  }

  return hasCompiledMatchEvidence(match.evidence);
}

function fuseChunkMatches(
  lexicalMatches: SourceUnitMatch[],
  vectorMatches: SourceUnitMatch[],
  limit: number,
): SourceUnitMatch[] {
  const fused = new Map<string, { match: SourceUnitMatch; score: number }>();
  const add = (matches: SourceUnitMatch[], weight: number): void => {
    matches.forEach((match, index) => {
      const current = fused.get(match.unit.id);

      fused.set(match.unit.id, {
        match: current && hasCompiledMatchEvidence(current.match.evidence) ? current.match : match,
        score: (current?.score ?? 0) + (weight / (index + 1)),
      });
    });
  };

  add(lexicalMatches, 0.65);
  add(vectorMatches, 0.35);

  return [...fused.values()]
    .sort((left, right) => right.score - left.score || left.match.unit.id.localeCompare(right.match.unit.id))
    .slice(0, limit)
    .map((entry) => entry.match);
}

function requiresExactCompiledMatch(
  request: DkbRetrieveKnowledgeRequest,
  evidence: SourceUnitQueryEvidence,
): boolean {
  return Boolean(request.phrases?.some((phrase) => phrase.trim().length > 0))
    || evidence.identifiers.length > 0;
}

function emptyMatch(unit: IndexedSourceUnit): SourceUnitMatch {
  return {
    unit,
    evidence: { phrases: [], identifiers: [], keywords: [], tokens: [] },
  };
}

function adapterGroupsForSourceMatches(matches: SourceUnitMatch[]): DkbRetrieveKnowledgeResponse['metadata']['adapterGroups'] {
  const groups = new Map<string, DkbRetrieveKnowledgeResponse['metadata']['adapterGroups'][number]>();

  for (const match of matches) {
    const key = `${match.unit.dkbId}/${match.unit.storeId}/${match.unit.type}`;
    const group = groups.get(key) ?? {
      dkbId: match.unit.dkbId,
      storeId: match.unit.storeId,
      sourceType: match.unit.type,
      chunks: 0,
      sourceUnits: 0,
    };

    group.chunks += 1;
    group.sourceUnits += 1;
    groups.set(key, group);
  }

  return [...groups.values()].sort((left, right) => left.dkbId.localeCompare(right.dkbId)
    || left.storeId.localeCompare(right.storeId)
    || left.sourceType.localeCompare(right.sourceType));
}

function sourceUnitMatchesForMatches(
  matches: SourceUnitMatch[],
  assets: IndexedSourceAsset[],
  existingAssetsByKey?: Map<string, IndexedSourceAsset>,
): DkbRetrieveKnowledgeResponse['metadata']['sourceUnitMatches'] {
  const assetsByKey = existingAssetsByKey ?? new Map(assets.map((asset) => [`${asset.dkbId}/${asset.id}`, asset]));

  return matches.map((match) => {
    const asset = assetsByKey.get(`${match.unit.dkbId}/${match.unit.assetId}`);

    return {
      registryId: registryIdForSourceUnit(match.unit),
      sourceOrigin: sourceOriginForSourceUnit(match.unit),
      dkbId: match.unit.dkbId,
      packageVersion: match.unit.packageVersion,
      sourceId: match.unit.id,
      evidenceId: match.unit.evidenceId,
      assetId: match.unit.assetId,
      assetLocator: match.unit.assetLocator,
      sourceAssetHash: asset?.hash,
      chunkHash: match.unit.hash,
      chunkOrdinal: match.unit.chunkOrdinal,
      chunkStart: match.unit.chunkStart,
      chunkEnd: match.unit.chunkEnd,
      storeId: match.unit.storeId,
      type: match.unit.type,
      matchedTokens: match.evidence.tokens,
      matchedPhrases: match.evidence.phrases,
      matchedIdentifiers: match.evidence.identifiers,
      matchedKeywords: match.evidence.keywords,
    };
  });
}

function sanitizeReadResult(result: DkbReadResult): DkbReadResult {
  return {
    ...result,
    queries: result.queries.map((query) => ({
      ...query,
      evidence: query.evidence.map(redactEvidenceSource),
    })),
  };
}

function redactEvidenceSource(evidence: DkbEvidence): DkbEvidence {
  return {
    ...evidence,
    source: {
      storeId: evidence.source.storeId,
      type: evidence.source.type,
      locator: {
        ref: stableHash({
          storeId: evidence.source.storeId,
          type: evidence.source.type,
          locator: evidence.source.locator,
          hash: evidence.source.hash ?? null,
        }).slice(7, 23),
      },
      hash: evidence.source.hash,
      evidenceId: evidence.source.evidenceId,
      chunkId: evidence.source.chunkId,
      dkbId: evidence.source.dkbId,
      packageVersion: evidence.source.packageVersion,
    },
  };
}

async function maybeReadSourceIndexData(root: string): Promise<{ assets: IndexedSourceAsset[]; units: IndexedSourceUnit[] }> {
  try {
    return await readSourceIndex(root);
  } catch {
    return {
      assets: [],
      units: [],
    };
  }
}

function sourceIndexRetrievalQuery(queryText: string, request: DkbRetrieveKnowledgeRequest): DkbReadQuery {
  return {
    id: 'source-index-select',
    target: 'source-index/global',
    operation: 'search',
    filters: readFiltersForRetrieve(request, queryText),
    limit: request.limit,
  };
}

function readFiltersForRetrieve(request: DkbRetrieveKnowledgeRequest, queryText: string): DkbReadQuery['filters'] {
  return [
    ...(request.phrases ?? []).filter(Boolean).map((phrase) => ({
      field: 'content',
      op: 'contains' as const,
      value: phrase,
    })),
    {
      field: 'content',
      op: 'contains' as const,
      value: queryText,
    },
  ];
}

function retrievalQueryText(request: DkbRetrieveKnowledgeRequest): string {
  return [
    request.need,
    ...(request.phrases ?? []),
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(' ')
    .trim();
}

function retrievalRequestId(request: DkbRetrieveKnowledgeRequest): string {
  return `retrieve:${normalizeIdentifierText(retrievalQueryText(request)).slice(0, 24) || 'knowledge'}`;
}

function evaluateEvidenceSufficiency(result: DkbReadResult, needText: string): DkbEvidenceSufficiency {
  const evidence = result.queries.flatMap((query) => query.evidence);

  if (evidence.length === 0) {
    return {
      status: 'blocked',
      confidence: 0,
      matchedNeed: false,
      expanded: false,
      reason: 'no_evidence',
      passes: 1,
    };
  }

  const tokens = tokenize(needText).filter((token) => token.length > 2 && !SUFFICIENCY_STOPWORDS.has(token));

  if (tokens.length === 0) {
    return {
      status: result.status,
      confidence: 1,
      matchedNeed: true,
      expanded: false,
      reason: 'no_need',
      passes: 1,
    };
  }

  const evidenceTokens = new Set(tokenize(evidence.map(evidenceToText).join(' ')));
  const matchedCount = tokens.filter((token) => evidenceTokens.has(token)).length;
  const confidence = roundConfidence(matchedCount / tokens.length);
  const matchedNeed = confidence >= 0.5;

  return {
    status: confidence >= 0.75 && result.status === 'complete' ? 'complete' : 'partial',
    confidence,
    matchedNeed,
    expanded: false,
    reason: matchedNeed ? 'matched_need' : 'weak_match',
    passes: 1,
  };
}

function evidenceToText(evidence: DkbEvidence): string {
  const label = evidence.label ? `${evidence.label} ` : '';

  if (typeof evidence.text === 'string') {
    return `${label}${evidence.text}`;
  }

  if (evidence.rows) {
    return `${label}${JSON.stringify(evidence.rows)}`;
  }

  if (evidence.value !== undefined) {
    return `${label}${String(evidence.value)}`;
  }

  return evidence.label;
}

function registryIdForSourceUnit(unit: IndexedSourceUnit): string | undefined {
  return unit.dkbId.endsWith('.local') || /\.local-[a-f0-9]{8}$/.test(unit.dkbId)
    ? unit.dkbId.replace(/\.local(?:-[a-f0-9]{8})?$/, '')
    : undefined;
}

function sourceOriginForSourceUnit(unit: IndexedSourceUnit): string | undefined {
  return registryIdForSourceUnit(unit) ? 'registry-local' : undefined;
}

function compactPathLabel(value: string): string {
  return value.split(/[\\/]+/g).filter(Boolean).at(-1) ?? value;
}

function normalizeIdentifierText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function roundConfidence(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 10000) / 10000;
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

const SUFFICIENCY_STOPWORDS = new Set([
  'what',
  'which',
  'where',
  'when',
  'who',
  'how',
  'does',
  'find',
  'show',
  'tell',
  'about',
  'record',
  'records',
  'mention',
  'mentions',
  'that',
  'this',
  'with',
  'from',
  'the',
]);
