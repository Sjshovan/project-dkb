import { canExecuteReadPlan } from '../adapters/adapter.js';
import { adapterForStore } from '../adapters/index.js';
import { stableHash } from '../contracts/hash.js';
import { queryKrIndex, readKrIndex, type IndexedKnowledgeRegion } from '../indexes/knowledgeIndex.js';
import type { QueryContext } from '../indexes/queryContext.js';
import {
  filterSourceUnitsForQueryEvidence,
  groupSourceUnitsByRegion,
  querySourceChunks,
  queryEvidenceForSourceUnits,
  readSourceIndex,
  sourceRegionKey,
  type IndexedSourceUnit,
  type SourceUnitMatch,
} from '../indexes/sourceIndex.js';
import { loadCompose } from '../protocol/manifest.js';
import { validateDkbReadRequest } from '../protocol/validation.js';
import type {
  DkbReadBlockReason,
  DkbEvidence,
  DkbEvidenceSufficiency,
  DkbReadQuery,
  DkbReadRequest,
  DkbReadResult,
  DkbReadStatus,
  LoadedDkb,
  QueryHit,
} from '../protocol/types.js';
import { blocked, validateDkbReadQuery } from '../adapters/sqlShared.js';
import { tokenize } from '../router/scoring.js';
import { SOURCE_DATA_POLICY_LINE } from '../security/sourceContent.js';

const DEFAULT_EVIDENCE_COMPLETION = {
  maxEvidencePasses: 2,
  minEvidenceConfidence: 0.75,
  maxAdditionalRegions: 3,
} as const;
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

interface RetrieveSourceGroup {
  record: IndexedKnowledgeRegion | QueryHit;
  dkbId: string;
  storeId: string;
  sourceType: IndexedSourceUnit['type'];
  units: IndexedSourceUnit[];
  matches: SourceUnitMatch[];
  query: DkbReadQuery;
}

export interface DkbRetrieveKnowledgeRequest {
  need: string;
  intent?: 'evidence' | 'records' | 'count' | 'summary' | 'compare';
  phrases?: string[];
  limit?: number;
  profile?: boolean;
  fallbackMode?: 'none' | 'source-rescue';
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
    regionsMatched: number;
    regionsRead: number;
    chunksMatched?: number;
    chunksRead?: number;
    sourceUnitsMatched: number;
    sourceUnitsRead: number;
    adapterGroups: Array<{
      dkbId: string;
      storeId: string;
      sourceType: string;
      regions: number;
      sourceUnits: number;
    }>;
    regionMatches: Array<{
      dkbId: string;
      regionId: string;
      title: string;
      retrievalPasses: string[];
      matchedTokens: string[];
      matchedPhrases: string[];
      matchedIdentifiers: string[];
    }>;
    sourceUnitMatches: Array<{
      dkbId: string;
      regionId: string;
      sourceId: string;
      assetId?: string;
      chunkOrdinal?: number;
      storeId: string;
      type: string;
      matchedTokens: string[];
      matchedPhrases: string[];
      matchedIdentifiers: string[];
      matchedKeywords: string[];
    }>;
    krProfile?: unknown;
    fallbackMode?: 'source-rescue';
  };
}

export interface DkbQueryTargetDescription {
  target: string;
  dkbId: string;
  regionId: string;
  recordId: string;
  title: string;
  summary: string;
  source: string;
  regionType: string | null;
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
  const response = await queryKrIndex(root, 'compose-index', query, limit, undefined, { queryContext });
  const targets = response.results
    .filter((record) => record.sourceRef && record.queryable)
    .map((record) => ({
      target: targetFor(record),
      dkbId: record.dkbId,
      regionId: record.id,
      recordId: record.id,
      title: record.title,
      summary: record.content,
      source: record.source,
      regionType: record.regionType ?? null,
      sourceType: record.sourceRef?.type ?? null,
      operations: record.queryable?.operations ?? [],
      fields: record.queryable?.fields ?? {},
      defaultLimit: record.queryable?.defaultLimit ?? 10,
      maxLimit: record.queryable?.maxLimit ?? 100,
      score: record.score,
    }));

  return {
    status: targets.length > 0 ? 'ready' : 'empty',
    query,
    targets,
    trace: response.trace,
  };
}

export async function retrieveKnowledge(
  root: string,
  request: DkbRetrieveKnowledgeRequest,
  queryContext?: QueryContext,
): Promise<DkbRetrieveKnowledgeResponse> {
  const query = retrievalQueryText(request);
  const limit = Math.max(1, Math.min(request.limit ?? 8, 100));
  const records = queryContext?.records ?? await maybeReadKrRecords(root);
  const sourceUnits = queryContext?.sourceUnits ?? await maybeReadSourceUnits(root);
  const sourceUnitsByRegion = groupSourceUnitsByRegion(sourceUnits);
  const sourceIndexQuery = sourceIndexRetrievalQuery(query, request);
  const queryEvidence = queryEvidenceForSourceUnits(sourceIndexQuery);
  const chunkMatches = querySourceChunks(sourceUnits, sourceIndexQuery, Math.max(limit * 4, 20));
  const chunkMatchesForRead = chunkMatches.slice(0, limit);
  const chunkMatchedRecords = recordsForMatchedSourceUnits(records, chunkMatches);

  if (records.length === 0 && sourceUnits.length === 0) {
    return blockedRetrievalResponse(request, query);
  }

  const krResponse = await queryKrIndex(root, 'compose-index', query, Math.max(records.length, 1), undefined, {
    queryContext,
    profile: request.profile,
    records,
  });
  const matchedRecords = chunkMatchedRecords.length > 0
    ? chunkMatchedRecords
    : krResponse.results.length > 0 || request.fallbackMode !== 'source-rescue'
      ? krResponse.results
    : recordsForMatchedSourceUnits(
        records,
        filterSourceUnitsForQueryEvidence(
          sourceUnits,
          queryEvidence,
          Math.max(limit * 5, 20),
        ),
      );

  if (matchedRecords.length === 0) {
    return blockedRetrievalResponse(request, query, krResponse.profile);
  }

  const registry = await loadCompose(root);
  const dkbs = uniqueDkbs([
    ...registry.collections.flatMap((collection) => collection.dkbs),
    ...registry.dkbs,
  ]);
  const chunkMatchesByRegion = groupSourceMatchesByRegion(chunkMatchesForRead);
  const sourceGroups = matchedRecords.flatMap((record, index) => sourceGroupsForRetrievedRegion(
    record,
    request,
    query,
    index,
    sourceUnitsByRegion,
    chunkMatches.length > 0
      ? chunkMatchesByRegion.get(sourceRegionKey(record)) ?? []
      : undefined,
  ));
  const fallbackQueries = sourceGroups.length === 0
    ? matchedRecords.flatMap((record, index) => fallbackReadQueryForRetrievedRegion(record, request, query, index))
    : [];
  const fallbackResult = fallbackQueries.length > 0
    ? await readDkb(root, { queries: fallbackQueries }, queryContext)
    : null;
  const queryResults = await Promise.all(sourceGroups.map((group) => executeRetrieveSourceGroup(group, dkbs)));
  const readResult: DkbReadResult = {
    status: fallbackResult?.status ?? summarizeStatus(queryResults.map((item) => item.status)),
    sourcePolicy: SOURCE_DATA_POLICY_LINE,
    queries: fallbackResult?.queries ?? queryResults,
  };
  const evidence = readResult.queries.flatMap((item) => item.evidence).map(redactEvidenceSource);
  const sufficiency = evaluateEvidenceSufficiency(readResult, query, false, 1);

  return {
    status: readResult.status,
    sourcePolicy: readResult.sourcePolicy,
    evidence,
    sufficiency,
    metadata: {
      requestId: retrievalRequestId(request),
      query,
      intent: request.intent ?? 'evidence',
      regionsMatched: matchedRecords.length,
      regionsRead: new Set(sourceGroups.map((group) => `${group.dkbId}/${group.record.id}`)).size,
      chunksMatched: sourceGroups.reduce((total, group) => total + group.matches.length, 0),
      chunksRead: sourceGroups.reduce((total, group) => total + group.units.length, 0),
      sourceUnitsMatched: sourceGroups.reduce((total, group) => total + group.matches.length, 0),
      sourceUnitsRead: sourceGroups.reduce((total, group) => total + group.units.length, 0),
      adapterGroups: adapterGroupsForSourceGroups(sourceGroups),
      regionMatches: regionMatchesFor(matchedRecords, queryEvidence),
      sourceUnitMatches: sourceUnitMatchesFor(sourceGroups),
      krProfile: krResponse.profile,
      ...(request.fallbackMode === 'source-rescue' && krResponse.results.length === 0 && matchedRecords.length > 0
        ? { fallbackMode: 'source-rescue' }
        : {}),
    },
  };
}

async function maybeReadKrRecords(root: string): Promise<IndexedKnowledgeRegion[]> {
  try {
    return await readKrIndex(root);
  } catch {
    return [];
  }
}

function blockedRetrievalResponse(
  request: DkbRetrieveKnowledgeRequest,
  query: string,
  krProfile?: unknown,
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
      regionsMatched: 0,
      regionsRead: 0,
      chunksMatched: 0,
      chunksRead: 0,
      sourceUnitsMatched: 0,
      sourceUnitsRead: 0,
      adapterGroups: [],
      regionMatches: [],
      sourceUnitMatches: [],
      krProfile,
    },
  };
}

function recordsForMatchedSourceUnits(
  records: IndexedKnowledgeRegion[],
  matches: SourceUnitMatch[],
): IndexedKnowledgeRegion[] {
  const recordsByRegion = new Map(records.map((record) => [sourceRegionKey(record), record]));
  const seen = new Set<string>();

  return matches.flatMap((match) => {
    const record = recordsByRegion.get(sourceRegionKey(match.unit));

    if (!record) {
      return [];
    }

    const key = `${record.dkbId}/${record.id}`;

    if (seen.has(key)) {
      return [];
    }

    seen.add(key);

    return [record];
  });
}

function groupSourceMatchesByRegion(matches: SourceUnitMatch[]): Map<string, SourceUnitMatch[]> {
  const groups = new Map<string, SourceUnitMatch[]>();

  for (const match of matches) {
    const key = sourceRegionKey(match.unit);
    const list = groups.get(key) ?? [];

    list.push(match);
    groups.set(key, list);
  }

  return groups;
}

export async function readDkb(root: string, request: DkbReadRequest, queryContext?: QueryContext): Promise<DkbReadResult> {
  const validatedRequest = validateDkbReadRequest(request, 'DKB read request');
  const registry = await loadCompose(root);
  const dkbs = uniqueDkbs([
    ...registry.collections.flatMap((collection) => collection.dkbs),
    ...registry.dkbs,
  ]);
  const records = queryContext?.records ?? await readKrIndex(root);
  const sourceUnits = queryContext?.sourceUnits ?? await maybeReadSourceUnits(root);
  const recordsByTarget = new Map<string, IndexedKnowledgeRegion>();
  const sourceUnitsByRegion = groupSourceUnitsByRegion(sourceUnits);

  for (const record of records) {
    recordsByTarget.set(targetFor(record), record);
    recordsByTarget.set(record.id, record);
    recordsByTarget.set(`${record.dkbId}.${record.id}`, record);
  }

  const queries = await Promise.all(validatedRequest.queries.map((query) => executeOne(query, dkbs, recordsByTarget, sourceUnitsByRegion)));
  const status = summarizeStatus(queries.map((query) => query.status));

  return sanitizeReadResult({
    status,
    sourcePolicy: SOURCE_DATA_POLICY_LINE,
    queries,
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
    },
  };
}

async function executeOne(
  query: DkbReadQuery,
  dkbs: LoadedDkb[],
  recordsByTarget: Map<string, IndexedKnowledgeRegion>,
  sourceUnitsByRegion: Map<string, IndexedSourceUnit[]>,
): Promise<DkbReadResult['queries'][number]> {
  const record = recordsByTarget.get(query.target);

  if (!record) {
    return blocked(query, 'unknown_target', `Unknown DKB read target: ${query.target}`, {});
  }

  const dkb = dkbs.find((candidate) => candidate.manifest.id === record.dkbId);

  if (!dkb) {
    return blocked(query, 'unknown_target', `Target DKB is unavailable: ${record.dkbId}`, { dkbId: record.dkbId });
  }

  const store = dkb.manifest.stores?.find((candidate) => candidate.id === record.sourceRef?.storeId);

  if (!store || !record.sourceRef) {
    return blocked(query, 'source_unavailable', `Target source is unavailable: ${record.dkbId}/${record.id}`, { dkbId: record.dkbId });
  }

  if (dkb.manifest.permissions?.read === false || store.permissions?.read === false) {
    return blocked(query, 'permission_denied', `Read denied for ${record.dkbId}/${store.id}`, { dkbId: record.dkbId, storeId: store.id });
  }

  try {
    const adapter = await adapterForStore(record.sourceRef.type);

    if (!canExecuteReadPlan(adapter)) {
      return blocked(query, 'source_unavailable', `Store type ${record.sourceRef.type} does not support DKB Read API execution`, { sourceType: record.sourceRef.type });
    }

    const sourceUnits = selectedSourceUnitsFor(record, query, sourceUnitsByRegion);
    const adapterQuery = sourceUnits.status === 'ready' ? queryForSelectedSources(query) : query;
    const queryable = record.queryable;
    const validation = validateQuery(adapterQuery, queryable);

    if (validation) {
      return blocked(query, validation.reason, validation.message, { target: targetFor(record) });
    }

    if (sourceUnits.status === 'empty') {
      return blocked(query, 'no_results', 'No source units matched the DKB read query inside the selected Knowledge Region.', {
        adapter: record.sourceRef.type,
        dkbId: dkb.manifest.id,
        storeId: store.id,
        regionId: record.id,
        sourceUnitsScanned: sourceUnits.scanned,
      });
    }

    return adapter.executeReadPlan({ dkb, store, record, query: adapterQuery, sourceUnits: sourceUnits.units });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return blocked(query, 'source_unavailable', message, { target: targetFor(record) });
  }
}

function queryForSelectedSources(query: DkbReadQuery): DkbReadQuery {
  return {
    ...query,
    filters: undefined,
  };
}

function sourceGroupsForRetrievedRegion(
  record: IndexedKnowledgeRegion | QueryHit,
  request: DkbRetrieveKnowledgeRequest,
  queryText: string,
  index: number,
  sourceUnitsByRegion: Map<string, IndexedSourceUnit[]>,
  selectedMatches?: SourceUnitMatch[],
): RetrieveSourceGroup[] {
  const operation = operationForRetrieve(record, request.intent ?? 'evidence');

  if (!operation) {
    return [];
  }

  const candidates = sourceUnitsByRegion.get(sourceRegionKey(record)) ?? [];
  const matches = selectedMatches
    ? selectedMatches.slice(0, Math.max(1, Math.min(request.limit ?? record.queryable?.defaultLimit ?? 20, record.queryable?.maxLimit ?? 100)))
    : operation === 'aggregate'
    ? []
    : filterSourceUnitsForQueryEvidence(
        candidates,
        queryEvidenceForSourceUnits(retrievalFilterQuery(record, queryText, request)),
        Math.max(1, Math.min(request.limit ?? record.queryable?.defaultLimit ?? 20, record.queryable?.maxLimit ?? 100)),
      );
  const selected = matches.map((match) => match.unit);

  if (operation !== 'aggregate' && candidates.length > 0 && selected.length === 0) {
    return [];
  }

  if (operation === 'aggregate') {
    return [{
      record,
      dkbId: record.dkbId,
      storeId: record.sourceRef?.storeId ?? '',
      sourceType: record.sourceRef?.type ?? 'filesystem',
      units: [],
      matches: [],
      query: {
        id: `retrieve-${index + 1}`,
        target: targetFor(record),
        operation,
        metric: 'count',
        limit: request.limit,
      },
    }];
  }

  return [...groupSourceUnitsForAdapter(selected.length > 0 ? selected : candidates).values()].map((units, groupIndex) => ({
    matches: matches.filter((match) => units.some((unit) => unit.id === match.unit.id)),
    record,
    dkbId: record.dkbId,
    storeId: units[0]!.storeId,
    sourceType: units[0]!.type,
    units,
    query: {
      id: `retrieve-${index + 1}-${groupIndex + 1}`,
      target: targetFor(record),
      operation: operationForSourceUnits(units, request.intent ?? 'evidence') ?? operation,
      filters: undefined,
      limit: request.limit,
    },
  }));
}

async function executeRetrieveSourceGroup(
  group: RetrieveSourceGroup,
  dkbs: LoadedDkb[],
): Promise<DkbReadResult['queries'][number]> {
  const dkb = dkbs.find((candidate) => candidate.manifest.id === group.dkbId);

  if (!dkb) {
    return blocked(group.query, 'unknown_target', `Target DKB is unavailable: ${group.dkbId}`, { dkbId: group.dkbId });
  }

  const store = dkb.manifest.stores?.find((candidate) => candidate.id === group.storeId);

  if (!store) {
    return blocked(group.query, 'source_unavailable', `Target store is unavailable: ${group.dkbId}/${group.storeId}`, {
      dkbId: group.dkbId,
      storeId: group.storeId,
    });
  }

  if (dkb.manifest.permissions?.read === false || store.permissions?.read === false) {
    return blocked(group.query, 'permission_denied', `Read denied for ${group.dkbId}/${group.storeId}`, {
      dkbId: group.dkbId,
      storeId: group.storeId,
    });
  }

  const adapter = await adapterForStore(group.sourceType);

  if (!canExecuteReadPlan(adapter)) {
    return blocked(group.query, 'source_unavailable', `Store type ${group.sourceType} does not support DKB retrieval execution`, {
      sourceType: group.sourceType,
    });
  }

  const record: IndexedKnowledgeRegion = {
    ...group.record,
    sourceRef: {
      storeId: group.storeId,
      type: group.sourceType,
      locator: group.units.length === 1
        ? group.units[0]!.locator
        : {
            ...(group.record.sourceRef?.locator ?? {}),
            sourceIds: group.units.map((unit) => unit.id),
          },
      hash: group.record.sourceRef?.hash,
    },
    queryable: group.units[0]?.queryable ?? group.record.queryable,
    storeIds: 'storeIds' in group.record ? group.record.storeIds : [group.storeId],
  };

  try {
    return adapter.executeReadPlan({ dkb, store, record, query: group.query, sourceUnits: group.units });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return blocked(group.query, 'source_unavailable', message, { target: targetFor(group.record) });
  }
}

function groupSourceUnitsForAdapter(units: IndexedSourceUnit[]): Map<string, IndexedSourceUnit[]> {
  const groups = new Map<string, IndexedSourceUnit[]>();

  for (const unit of units) {
    const key = `${unit.dkbId}/${unit.storeId}/${unit.type}`;
    const group = groups.get(key) ?? [];

    group.push(unit);
    groups.set(key, group);
  }

  return groups;
}

function operationForSourceUnits(units: IndexedSourceUnit[], intent: NonNullable<DkbRetrieveKnowledgeRequest['intent']>): DkbReadQuery['operation'] | null {
  const operations = new Set(units.flatMap((unit) => unit.capabilities.operations));

  if (intent === 'count') {
    return operations.has('aggregate') ? 'aggregate' : operations.has('search') ? 'search' : null;
  }

  if (intent === 'records') {
    return operations.has('lookup') ? 'lookup' : operations.has('search') ? 'search' : null;
  }

  return operations.has('search') ? 'search' : operations.has('fetch') ? 'fetch' : operations.has('lookup') ? 'lookup' : null;
}

function fallbackReadQueryForRetrievedRegion(
  record: IndexedKnowledgeRegion | QueryHit,
  request: DkbRetrieveKnowledgeRequest,
  queryText: string,
  index: number,
): DkbReadQuery[] {
  const operation = operationForRetrieve(record, request.intent ?? 'evidence');

  if (!operation) {
    return [];
  }

  return [{
    id: `retrieve-${index + 1}`,
    target: targetFor(record),
    operation,
    metric: operation === 'aggregate' ? 'count' : undefined,
    filters: operation === 'aggregate' ? undefined : readFiltersForRetrieve(request, queryText),
    limit: request.limit,
  }];
}

function operationForRetrieve(record: IndexedKnowledgeRegion | QueryHit, intent: NonNullable<DkbRetrieveKnowledgeRequest['intent']>): DkbReadQuery['operation'] | null {
  const operations = record.queryable?.operations ?? [];

  if (intent === 'count') {
    return operations.includes('aggregate') ? 'aggregate' : operations.includes('search') ? 'search' : operations[0] ?? null;
  }

  if (intent === 'records') {
    return operations.includes('lookup') ? 'lookup' : operations.includes('search') ? 'search' : operations[0] ?? null;
  }

  return operations.includes('search') ? 'search' : operations.includes('fetch') ? 'fetch' : operations.includes('lookup') ? 'lookup' : operations[0] ?? null;
}

function retrievalFilterQuery(record: IndexedKnowledgeRegion | QueryHit, queryText: string, request: DkbRetrieveKnowledgeRequest): DkbReadQuery {
  return {
    id: 'source-select',
    target: targetFor(record),
    operation: operationForRetrieve(record, request.intent ?? 'evidence') ?? 'search',
    filters: readFiltersForRetrieve(request, queryText),
    limit: request.limit,
  };
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

function adapterGroupsForSourceGroups(sourceGroups: RetrieveSourceGroup[]): DkbRetrieveKnowledgeResponse['metadata']['adapterGroups'] {
  const groups = new Map<string, DkbRetrieveKnowledgeResponse['metadata']['adapterGroups'][number]>();

  for (const sourceGroup of sourceGroups) {
    const key = `${sourceGroup.dkbId}/${sourceGroup.storeId}/${sourceGroup.sourceType}`;
    const group = groups.get(key) ?? {
      dkbId: sourceGroup.dkbId,
      storeId: sourceGroup.storeId,
      sourceType: sourceGroup.sourceType,
      regions: 0,
      sourceUnits: 0,
    };

    group.regions += 1;
    group.sourceUnits += sourceGroup.units.length;
    groups.set(key, group);
  }

  return [...groups.values()].sort((left, right) => left.dkbId.localeCompare(right.dkbId)
    || left.storeId.localeCompare(right.storeId)
    || left.sourceType.localeCompare(right.sourceType));
}

function regionMatchesFor(
  records: Array<IndexedKnowledgeRegion | QueryHit>,
  evidence: ReturnType<typeof queryEvidenceForSourceUnits>,
): DkbRetrieveKnowledgeResponse['metadata']['regionMatches'] {
  return records.map((record) => {
    const normalized = [
      record.title,
      record.content,
      record.topics.join(' '),
      (record.keywords ?? []).join(' '),
      record.entities.join(' '),
      (record.aliases ?? []).join(' '),
    ].join(' ').toLowerCase();
    const tokens = new Set(tokenize(normalized));
    const keywords = new Set((record.keywords ?? []).map((keyword) => keyword.toLowerCase()));

    return {
      dkbId: record.dkbId,
      regionId: record.id,
      title: record.title,
      retrievalPasses: 'retrievalPasses' in record ? record.retrievalPasses ?? [] : [],
      matchedTokens: evidence.tokens.filter((token) => tokens.has(token) || keywords.has(token)),
      matchedPhrases: evidence.phrases.filter((phrase) => normalized.includes(phrase)),
      matchedIdentifiers: evidence.identifiers.filter((identifier) => normalized.includes(identifier.toLowerCase())),
    };
  });
}

function sourceUnitMatchesFor(sourceGroups: RetrieveSourceGroup[]): DkbRetrieveKnowledgeResponse['metadata']['sourceUnitMatches'] {
  return sourceGroups.flatMap((group) => group.matches.map((match) => ({
    dkbId: match.unit.dkbId,
    regionId: match.unit.regionId,
    sourceId: match.unit.id,
    assetId: match.unit.assetId,
    chunkOrdinal: match.unit.chunkOrdinal,
    storeId: match.unit.storeId,
    type: match.unit.type,
    matchedTokens: match.evidence.tokens,
    matchedPhrases: match.evidence.phrases,
    matchedIdentifiers: match.evidence.identifiers,
    matchedKeywords: match.evidence.keywords,
  })));
}

function selectedSourceUnitsFor(
  record: IndexedKnowledgeRegion,
  query: DkbReadQuery,
  sourceUnitsByRegion: Map<string, IndexedSourceUnit[]>,
): { status: 'none' | 'ready'; units?: IndexedSourceUnit[] } | { status: 'empty'; scanned: number } {
  if (query.operation === 'aggregate') {
    return { status: 'none' };
  }

  const candidates = sourceUnitsByRegion.get(sourceRegionKey(record)) ?? [];

  if (candidates.length === 0) {
    return { status: 'none' };
  }

  const limit = Math.max(1, Math.min(query.limit ?? record.queryable?.defaultLimit ?? 20, record.queryable?.maxLimit ?? 100));
  const selected = filterSourceUnitsForQueryEvidence(candidates, queryEvidenceForSourceUnits(query), limit).map((match) => match.unit);

  if (selected.length === 0) {
    return {
      status: 'empty',
      scanned: candidates.length,
    };
  }

  return {
    status: 'ready',
    units: selected,
  };
}

async function maybeReadSourceUnits(root: string): Promise<IndexedSourceUnit[]> {
  try {
    return (await readSourceIndex(root)).units;
  } catch {
    return [];
  }
}

function validateQuery(query: DkbReadQuery, queryable: IndexedKnowledgeRegion['queryable']): { reason: DkbReadBlockReason; message: string } | null {
  return validateDkbReadQuery(query, queryable) as { reason: DkbReadBlockReason; message: string } | null;
}

function summarizeStatus(statuses: DkbReadStatus[]): DkbReadStatus {
  if (statuses.length === 0) {
    return 'blocked';
  }

  if (statuses.every((status) => status === 'complete')) {
    return 'complete';
  }

  if (statuses.some((status) => status === 'complete')) {
    return 'partial';
  }

  return 'blocked';
}

function targetFor(record: { dkbId: string; id: string }): string {
  return `${record.dkbId}/${record.id}`;
}

function evaluateEvidenceSufficiency(
  result: DkbReadResult,
  needText: string,
  expanded: boolean,
  passes: number,
): DkbEvidenceSufficiency {
  const evidence = result.queries.flatMap((query) => query.evidence);

  if (result.status === 'blocked') {
    return {
      status: 'blocked',
      confidence: 0,
      matchedNeed: false,
      expanded,
      reason: 'blocked',
      passes,
    };
  }

  if (evidence.length === 0) {
    return {
      status: result.status === 'complete' ? 'partial' : result.status,
      confidence: 0,
      matchedNeed: false,
      expanded,
      reason: 'no_evidence',
      passes,
    };
  }

  const tokens = tokenize(needText).filter((token) => token.length > 2 && !SUFFICIENCY_STOPWORDS.has(token));

  if (tokens.length === 0) {
    return {
      status: result.status,
      confidence: result.status === 'complete' ? 1 : 0.5,
      matchedNeed: true,
      expanded,
      reason: 'no_need',
      passes,
    };
  }

  const evidenceText = evidence.map(evidenceToText).join(' ');
  const exactIdentifierConfidence = exactIdentifierConfidenceFor(needText, evidenceText);

  if (exactIdentifierConfidence !== null) {
    return {
      status: result.status === 'complete' ? 'complete' : 'partial',
      confidence: exactIdentifierConfidence,
      matchedNeed: exactIdentifierConfidence >= DEFAULT_EVIDENCE_COMPLETION.minEvidenceConfidence,
      expanded,
      reason: 'matched_specific_identifier',
      passes,
    };
  }

  const evidenceTokens = new Set(tokenize(evidenceText));
  const matchedCount = tokens.filter((token) => evidenceTokens.has(token)).length;
  const confidence = roundConfidence(matchedCount / tokens.length);
  const matchedNeed = confidence >= DEFAULT_EVIDENCE_COMPLETION.minEvidenceConfidence;

  return {
    status: matchedNeed && result.status === 'complete' ? 'complete' : 'partial',
    confidence,
    matchedNeed,
    expanded,
    reason: matchedNeed ? 'matched_need' : 'weak_match',
    passes,
  };
}

function evidenceToText(evidence: DkbEvidence): string {
  if (typeof evidence.text === 'string') {
    return evidence.text;
  }

  if (evidence.rows) {
    return JSON.stringify(evidence.rows);
  }

  if (evidence.value !== undefined) {
    return String(evidence.value);
  }

  return evidence.label;
}

function roundConfidence(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 10000) / 10000;
}

function exactIdentifierConfidenceFor(needText: string, evidenceText: string): number | null {
  const identifiers = specificIdentifiers(needText);

  if (identifiers.length === 0) {
    return null;
  }

  const normalizedEvidence = normalizeIdentifierText(evidenceText);
  const matched = identifiers.filter((identifier) => normalizedEvidence.includes(identifier));

  if (matched.length === 0) {
    return null;
  }

  return roundConfidence(matched.length / identifiers.length);
}

function specificIdentifiers(value: string): string[] {
  return [...new Set((value.match(/\b[a-zA-Z][a-zA-Z0-9_-]*\d+[a-zA-Z0-9_-]*\b/g) ?? [])
    .map(normalizeIdentifierText)
    .filter((identifier) => identifier.length >= 4))];
}

function normalizeIdentifierText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function uniqueDkbs(dkbs: LoadedDkb[]): LoadedDkb[] {
  const seen = new Set<string>();

  return dkbs.filter((dkb) => {
    if (seen.has(dkb.manifest.id)) {
      return false;
    }

    seen.add(dkb.manifest.id);

    return true;
  });
}
