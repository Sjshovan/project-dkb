import { performance } from 'node:perf_hooks';
import { getQueryContext, type QueryContext } from '../indexes/queryContext.js';
import type {
  DkbEvidence,
  DkbEvidenceSufficiency,
  DkbReadQuery,
  DkbReadResult,
  DkbReadStatus,
} from '@sjshovan/dkb-protocol/types.js';
import { renderUntrustedSourceBlock, SOURCE_DATA_POLICY_LINE } from '@sjshovan/dkb-protocol/security/sourceContent.js';
import { semanticSearch } from './navigation.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbRuntimeContext } from '../runtime/context.js';
import {
  compactPathLabel,
  matchForUnit,
  normalizeIdentifierText,
  queryEvidenceForRequest,
  registryIdForSourceUnit,
  runtimeEvidenceAsset,
  runtimeEvidenceUnit,
  sourceOriginForSourceUnit,
  type RuntimeEvidenceAsset,
  type RuntimeEvidenceUnit,
  type SourceUnitMatch,
  type SourceUnitQueryEvidence,
} from './evidenceModel.js';
import { evaluateEvidenceSufficiency } from './evidenceSufficiency.js';
import { redactEvidenceSource } from './read.js';

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

export async function describeQueryTargets(root: string, query: string, limit = 10, queryContext?: QueryContext, runtime?: DkbRuntimeContext): Promise<DkbQueryTargetResponse> {
  const context = queryContext ?? await contextFor(root, requiredRuntime(runtime));
  const result = await semanticSearch(root, query, limit, undefined, context);
  const unitsById = new Map(context.evidenceRecords.map(runtimeEvidenceUnit).map((unit) => [unit.id, unit]));
  const targets = result.results
    .map((hit) => unitsById.get(hit.id))
    .filter((unit): unit is RuntimeEvidenceUnit => Boolean(unit))
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
  runtime?: DkbRuntimeContext,
): Promise<DkbRetrieveKnowledgeResponse> {
  const context = queryContext ?? await contextFor(root, requiredRuntime(runtime));
  const query = retrievalQueryText(request);
  const limit = Math.max(1, Math.min(request.limit ?? 8, 100));
  const evidenceCatalog = {
    assets: context.evidenceAssets.map(runtimeEvidenceAsset),
    units: context.evidenceRecords.map(runtimeEvidenceUnit),
  };
  const sourceUnits = evidenceCatalog.units;
  const evidenceQuery = evidenceRetrievalQuery(query, request);
  const queryEvidence = queryEvidenceForRequest(evidenceQuery);

  if (sourceUnits.length === 0) {
    return blockedRetrievalResponse(request, query);
  }

  const candidateLimit = Math.max(limit * 3, 20);
  const sourceUnitsById = new Map(sourceUnits.map((unit) => [unit.id, unit]));
  const vectorStart = performance.now();
  const vectorResult = await context.retrieval.search({ query, limit: candidateLimit });
  const vectorQueryMs = performance.now() - vectorStart;
  const vectorMatches = vectorResult.hits
    .flatMap((hit) => {
      const unit = sourceUnitsById.get(hit.evidenceId);
      return unit ? [matchForUnit(unit, queryEvidence, hit.matchedTokens ?? [])] : [];
    });
  const candidateChunkMatches = vectorMatches.slice(0, candidateLimit);
  const exactMatchRequired = requiresExactCompiledMatch(request, queryEvidence);
  const chunkMatchesForRead = (exactMatchRequired
    ? candidateChunkMatches.filter((match) => satisfiesExactCompiledMatch(match, request, queryEvidence))
    : candidateChunkMatches).slice(0, limit);

  const directChunkMatches = chunkMatchesForRead.filter((match) => hasCompiledMatchEvidence(match.evidence));
  const profile = request.profile ? {
    timingsMs: {
      total: roundMs(vectorQueryMs),
      artifactContext: 0,
      dkbFilter: 0,
      tokenize: 0,
      lexicalScore: 0,
      vectorQuery: roundMs(vectorQueryMs),
      graphExpansion: 0,
      fusion: 0,
      traceAssembly: 0,
    },
    counts: {
      totalRecords: sourceUnits.length,
      filteredRecords: sourceUnits.length,
      lexicalHits: vectorResult.hits.filter((hit) => hit.channels.includes('lexical')).length,
      vectorHits: vectorResult.hits.length,
      graphHits: 0,
      fusedHits: candidateChunkMatches.length,
      returnedHits: chunkMatchesForRead.length,
    },
    passes: ['retrieval-provider'],
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
      sourceUnitMatches: sourceUnitMatchesForMatches(chunkMatchesForRead, evidenceCatalog.assets),
      retrievalProfile: profile,
    },
  };
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

function compiledChunkLabel(unit: RuntimeEvidenceUnit): string {
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

function requiresExactCompiledMatch(
  request: DkbRetrieveKnowledgeRequest,
  evidence: SourceUnitQueryEvidence,
): boolean {
  return Boolean(request.phrases?.some((phrase) => phrase.trim().length > 0))
    || evidence.identifiers.length > 0;
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
  assets: RuntimeEvidenceAsset[],
): DkbRetrieveKnowledgeResponse['metadata']['sourceUnitMatches'] {
  const assetsByKey = new Map(assets.map((asset) => [`${asset.dkbId}/${asset.id}`, asset]));

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

function evidenceRetrievalQuery(queryText: string, request: DkbRetrieveKnowledgeRequest): DkbReadQuery {
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

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

async function contextFor(root: string, runtime: DkbRuntimeContext): Promise<QueryContext> {
  const { loadLibrary } = await import('@sjshovan/dkb-protocol/manifest.js');
  const library = await loadLibrary(root);
  return getQueryContext(library.root, library.manifest.id, runtime);
}

function requiredRuntime(runtime: DkbRuntimeContext | undefined): DkbRuntimeContext {
  if (!runtime) throw new DkbError('A DKB Runtime context is required when no query context is supplied.');
  return runtime;
}
