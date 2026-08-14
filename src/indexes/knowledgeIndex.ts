import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { UndirectedGraph } from 'graphology';
import { stableHash } from '../contracts/hash.js';
import { DkbError } from '../protocol/errors.js';
import { DKB_ARTIFACTS_DIR, resolveFrom } from '../protocol/paths.js';
import type { DkbStore, KnowledgeCapabilityProfile, KnowledgeRegion, LoadedDkb, QueryHit, QueryTrace, RetrievalPass } from '../protocol/types.js';
import { applyScoreProbabilityCutoff, defaultResultProbabilityCutoff, defaultMinimumScore, hasSufficientQueryCoverage, scoreRecord, tokenize } from '../router/scoring.js';
import { expandKrGraph } from './graphRetrieval.js';
import type { QueryContext } from './queryContext.js';
import {
  querySearchArtifact,
  querySearchDocumentsArtifact,
  writeSearchArtifacts,
  type SemanticNeighbor,
  type VectorArtifactBuild,
  type VectorDocument,
} from './vectorStore.js';

export const KR_INDEX_PATH = `${DKB_ARTIFACTS_DIR}/kr.index`;
export const KR_GRAPH_PATH = `${DKB_ARTIFACTS_DIR}/kr.index.graph`;
export const KR_VECTOR_PATH = `${DKB_ARTIFACTS_DIR}/kr.index.vector.json`;
export const KR_VECTOR_LANCE_PATH = `${DKB_ARTIFACTS_DIR}/kr.index.vector.lance`;

export interface IndexedKnowledgeRegion extends KnowledgeRegion {
  dkbId: string;
  storeIds: string[];
}

export interface IndexQueryResponse {
  results: QueryHit[];
  trace: QueryTrace[];
  profile?: QueryProfile;
  cache?: QueryCacheTrace;
}

export type KrRetrievalPass = 'lexical' | 'vector' | 'graph';

export interface QueryKrIndexOptions {
  passes?: KrRetrievalPass[];
  includedDkbs?: string[];
  resultProbabilityCutoff?: number;
  profile?: boolean;
  queryContext?: QueryContext;
  records?: IndexedKnowledgeRegion[];
}

export interface QueryProfile {
  timingsMs: {
    total: number;
    artifactContext: number;
    dkbFilter: number;
    tokenize: number;
    lexicalScore: number;
    vectorQuery: number;
    graphExpansion: number;
    fusion: number;
    traceAssembly: number;
  };
  counts: {
    totalRecords: number;
    filteredRecords: number;
    lexicalHits: number;
    vectorHits: number;
    graphHits: number;
    fusedHits: number;
    returnedHits: number;
  };
  passes: KrRetrievalPass[];
}

export interface QueryCacheTrace {
  hit: boolean;
  key: string | null;
  artifactHash: string | null;
}

interface ArtifactGraph {
  export(): unknown;
  hasNode(node: string): boolean;
  addNode(node: string, attributes: Record<string, unknown>): void;
  hasEdge(edge: string): boolean;
  hasEdge(source: string, target: string): boolean;
  addUndirectedEdgeWithKey(edge: string, source: string, target: string, attributes: Record<string, unknown>): void;
}

export async function krIndexExists(root: string): Promise<boolean> {
  return exists(resolveFrom(root, KR_INDEX_PATH));
}

export async function readKrIndex(root: string): Promise<IndexedKnowledgeRegion[]> {
  const indexPath = resolveFrom(root, KR_INDEX_PATH);
  const database = new DatabaseSync(indexPath, { readOnly: true });

  try {
    const hasKeywords = hasColumn(database, 'regions', 'keywords_json');
    const hasCapabilities = hasColumn(database, 'regions', 'capabilities_json');
    const regions = database
      .prepare(`
        select dkb_id, region_id, type, title, summary, updated_at,
          queryable_json, ${hasKeywords ? 'keywords_json' : "'[]' as keywords_json"},
          ${hasCapabilities ? 'capabilities_json' : "'null' as capabilities_json"},
          grouping_type, grouping_reason, region_hash
        from regions
        order by dkb_id, region_id
      `)
      .all() as Array<Record<string, unknown>>;
    const sources = database
      .prepare(`
        select s.dkb_id, rs.region_id, s.source_id, s.store_id, s.type,
          s.locator_json, s.source_hash, s.updated_at, rs.role, rs.position
        from region_sources rs
        join sources s on s.dkb_id = rs.dkb_id and s.source_id = rs.source_id
        order by rs.dkb_id, rs.region_id, rs.position, rs.source_id
      `)
      .all() as Array<Record<string, unknown>>;
    const edges = database
      .prepare(`
        select dkb_id, source_region_id, target_region_id, type, weight, reason
        from region_edges
        order by dkb_id, source_region_id, target_region_id, type
      `)
      .all() as Array<Record<string, unknown>>;
    const sourcesByRegion = groupBy(sources, (row) => `${row.dkb_id}/${row.region_id}`);
    const outgoingEdgesByRegion = groupBy(edges, (row) => `${row.dkb_id}/${row.source_region_id}`);

    return regions.map((region) => reconstructRegion(
      region,
      sourcesByRegion.get(`${region.dkb_id}/${region.region_id}`) ?? [],
      outgoingEdgesByRegion.get(`${region.dkb_id}/${region.region_id}`) ?? [],
    ));
  } finally {
    database.close();
  }
}

export async function queryKrIndex(
  root: string,
  collectionId: string,
  query: string,
  limit = 10,
  minScore = defaultMinimumScore,
  options: QueryKrIndexOptions = {},
): Promise<IndexQueryResponse> {
  const totalStart = performance.now();
  let artifactContextMs = 0;
  let dkbFilterMs = 0;
  let tokenizeMs = 0;
  let lexicalScoreMs = 0;
  let vectorQueryMs = 0;
  let graphExpansionMs = 0;
  let fusionMs = 0;
  let traceAssemblyMs = 0;
  const passes = normalizeRetrievalPasses(options.passes);
  const contextStart = performance.now();
  const allRecords = options.queryContext?.records ?? options.records ?? await readKrIndex(root);
  const vectorDocuments = options.queryContext?.vectorDocuments;
  const graphArtifact = options.queryContext?.graphArtifact;
  const vectorArtifactRoot = options.queryContext?.vectorArtifactRoot ?? path.dirname(resolveFrom(root, KR_VECTOR_PATH));
  const searchRegistryId = options.queryContext?.searchRegistryId ?? await searchRegistryIdFor(root, collectionId);

  artifactContextMs = elapsedMs(contextStart);

  const tokenizeStart = performance.now();
  const queryTokens = tokenize(query);
  tokenizeMs = elapsedMs(tokenizeStart);

  const filterStart = performance.now();
  const records = filterRecordsByManifestIntent(filterRecordsByDkb(allRecords, options.includedDkbs), queryTokens);
  const filteredVectorDocuments = vectorDocuments ? filterVectorDocumentsByRecords(vectorDocuments, records) : undefined;
  dkbFilterMs = elapsedMs(filterStart);
  const traceByDkb = traceForRecords(records);
  const lexicalStart = performance.now();
  const lexicalResults = passes.includes('lexical')
    ? records
      .map((record) => ({
        ...scoreRecord(record, queryTokens),
        dkbId: record.dkbId,
        adapter: 'compose' as const,
        retrievalPasses: ['lexical' as const],
      }))
      .filter((hit) => hit.score >= minScore && hasSufficientQueryCoverage(hit, queryTokens))
      .sort((a, b) => b.score - a.score || a.dkbId.localeCompare(b.dkbId) || a.id.localeCompare(b.id))
    : [];
  lexicalScoreMs = elapsedMs(lexicalStart);

  const vectorStart = performance.now();
  const vectorResults = passes.includes('vector')
    ? await queryVectorArtifact(searchRegistryId, records, filteredVectorDocuments, query, allRecords.length, vectorArtifactRoot)
    : [];
  vectorQueryMs = elapsedMs(vectorStart);

  const graphOnlySeedResults = passes.length === 1 && passes[0] === 'graph'
    ? graphOnlySeeds(records, queryTokens, minScore)
    : [];
  const seedResults = mergeHits([...lexicalResults, ...vectorResults], Math.max(limit * 3, 20));
  const graphStart = performance.now();
  const graphResults = passes.includes('graph')
    ? await expandKrGraph({
      root,
      records,
      seeds: graphSeedsFor(seedResults.length > 0 ? seedResults : graphOnlySeedResults),
      limit: Math.max(limit * 3, 20),
      minScore,
      queryTokens,
      artifact: graphArtifact,
    })
    : [];
  graphExpansionMs = elapsedMs(graphStart);

  const fusionStart = performance.now();
  const mergedResults = mergeHits([...lexicalResults, ...vectorResults, ...graphOnlySeedResults, ...graphResults], Math.max(limit * 2, limit));
  const results = applyScoreProbabilityCutoff(mergedResults, options.resultProbabilityCutoff ?? defaultResultProbabilityCutoff).slice(0, limit);
  fusionMs = elapsedMs(fusionStart);

  const traceStart = performance.now();
  const resultIds = new Set(results.map((hit) => `${hit.dkbId}:${hit.id}`));

  for (const record of records) {
    const trace = traceByDkb.get(record.dkbId);

    if (trace && resultIds.has(`${record.dkbId}:${record.id}`)) {
      trace.hits += 1;
    }
  }
  const trace = [...traceByDkb.values()];
  traceAssemblyMs = elapsedMs(traceStart);

  const response: IndexQueryResponse = {
    results,
    trace,
  };

  if (options.profile) {
    response.profile = {
      timingsMs: {
        total: elapsedMs(totalStart),
        artifactContext: roundMs(artifactContextMs),
        dkbFilter: roundMs(dkbFilterMs),
        tokenize: roundMs(tokenizeMs),
        lexicalScore: roundMs(lexicalScoreMs),
        vectorQuery: roundMs(vectorQueryMs),
        graphExpansion: roundMs(graphExpansionMs),
        fusion: roundMs(fusionMs),
        traceAssembly: roundMs(traceAssemblyMs),
      },
      counts: {
        totalRecords: allRecords.length,
        filteredRecords: records.length,
        lexicalHits: lexicalResults.length,
        vectorHits: vectorResults.length,
        graphHits: graphResults.length + graphOnlySeedResults.length,
        fusedHits: mergedResults.length,
        returnedHits: results.length,
      },
      passes,
    };
    response.cache = {
      hit: Boolean(options.queryContext),
      key: options.queryContext?.cacheKey ?? null,
      artifactHash: options.queryContext?.artifactHash ?? null,
    };
  }

  return response;
}

function filterRecordsByDkb(records: IndexedKnowledgeRegion[], includedDkbs: string[] | undefined): IndexedKnowledgeRegion[] {
  if (!includedDkbs || includedDkbs.length === 0) {
    return records;
  }

  const allowed = new Set(includedDkbs);

  return records.filter((record) => allowed.has(record.dkbId));
}

function normalizeRetrievalPasses(passes: KrRetrievalPass[] | undefined): KrRetrievalPass[] {
  if (!passes || passes.length === 0) {
    return process.env.DKB_VECTOR_DEFAULT === '1' || process.env.DKB_VECTOR_DEFAULT === 'true'
      ? ['lexical', 'vector', 'graph']
      : ['lexical', 'graph'];
  }

  return [...new Set(passes)].filter((pass): pass is KrRetrievalPass => pass === 'lexical' || pass === 'vector' || pass === 'graph');
}

function filterRecordsByManifestIntent(records: IndexedKnowledgeRegion[], queryTokens: string[]): IndexedKnowledgeRegion[] {
  if (isManifestQuery(queryTokens)) {
    return records;
  }

  return records.filter((record) => !isManifestOnlyRegion(record));
}

function isManifestOnlyRegion(record: IndexedKnowledgeRegion): boolean {
  const locator = record.sourceRef?.locator;

  if (!locator || typeof locator !== 'object') {
    return false;
  }

  const paths = (locator as { paths?: unknown; path?: unknown }).paths;

  if (Array.isArray(paths) && paths.length > 0) {
    return paths.every((item) => item === 'dkb.json');
  }

  return (locator as { path?: unknown }).path === 'dkb.json';
}

function isManifestQuery(queryTokens: string[]): boolean {
  const manifestTerms = new Set(['manifest', 'package', 'version', 'license', 'author', 'collection', 'description']);

  return queryTokens.some((token) => manifestTerms.has(token));
}

function traceForRecords(records: IndexedKnowledgeRegion[]): Map<string, QueryTrace> {
  const traceByDkb = new Map<string, QueryTrace>();

  for (const record of records) {
    const trace = traceByDkb.get(record.dkbId) ?? {
      dkbId: record.dkbId,
      adapter: 'compose' as const,
      recordsScanned: 0,
      hits: 0,
    };

    trace.recordsScanned += 1;
    traceByDkb.set(record.dkbId, trace);
  }

  return traceByDkb;
}

export async function writeKrIndex(root: string, records: IndexedKnowledgeRegion[]): Promise<string> {
  const indexPath = resolveFrom(root, KR_INDEX_PATH);

  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await removeArtifact(indexPath);

  const database = new DatabaseSync(indexPath);

  try {
    database.exec(`
      create table regions (
        dkb_id text not null,
        region_id text not null,
        type text not null,
        title text not null,
        summary text not null,
        updated_at text not null,
        queryable_json text not null,
        keywords_json text not null,
        capabilities_json text not null,
        grouping_type text,
        grouping_reason text,
        region_hash text not null,
        primary key (dkb_id, region_id)
      );

      create table sources (
        dkb_id text not null,
        source_id text not null,
        store_id text not null,
        type text not null,
        locator_json text not null,
        source_hash text,
        updated_at text not null,
        primary key (dkb_id, source_id)
      );

      create table region_sources (
        dkb_id text not null,
        region_id text not null,
        source_id text not null,
        role text not null,
        position integer not null,
        primary key (dkb_id, region_id, source_id),
        foreign key (dkb_id, region_id) references regions (dkb_id, region_id),
        foreign key (dkb_id, source_id) references sources (dkb_id, source_id)
      );

      create table region_edges (
        dkb_id text not null,
        source_region_id text not null,
        target_region_id text not null,
        type text not null,
        weight real not null,
        reason text,
        primary key (dkb_id, source_region_id, target_region_id, type),
        foreign key (dkb_id, source_region_id) references regions (dkb_id, region_id)
      );
    `);

    const insertRegion = database.prepare(`
      insert into regions (
        dkb_id, region_id, type, title, summary, updated_at, queryable_json,
        keywords_json, capabilities_json, grouping_type, grouping_reason, region_hash
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSource = database.prepare(`
      insert or ignore into sources (
        dkb_id, source_id, store_id, type, locator_json, source_hash, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertRegionSource = database.prepare(`
      insert into region_sources (
        dkb_id, region_id, source_id, role, position
      ) values (?, ?, ?, ?, ?)
    `);
    const insertRegionEdge = database.prepare(`
      insert into region_edges (
        dkb_id, source_region_id, target_region_id, type, weight, reason
      ) values (?, ?, ?, ?, ?, ?)
    `);

    for (const record of records) {
      const sourceRef = record.sourceRef;

      if (!sourceRef) {
        throw new DkbError(`Indexed record ${record.dkbId}/${record.id} is missing sourceRef`);
      }

      insertRegion.run(
        record.dkbId,
        record.id,
        record.regionType ?? 'record',
        record.title,
        record.content,
        record.updatedAt,
        JSON.stringify(record.queryable ?? defaultQueryableFor(record)),
        JSON.stringify(record.keywords ?? []),
        JSON.stringify(record.capabilities ?? capabilitiesForQueryable(record.queryable ?? defaultQueryableFor(record))),
        record.grouping?.strategy ?? null,
        record.grouping?.reason ?? null,
        stableHash(recordForHash(record)),
      );

      for (const [position, source] of sourcesForRecord(record).entries()) {
        insertSource.run(
          record.dkbId,
          source.sourceId,
          source.storeId,
          source.type,
          JSON.stringify(source.locator),
          source.hash ?? null,
          source.updatedAt,
        );
        insertRegionSource.run(
          record.dkbId,
          record.id,
          source.sourceId,
          source.role,
          position,
        );
      }

      for (const edge of edgesForRecord(record)) {
        insertRegionEdge.run(
          record.dkbId,
          record.id,
          edge.targetRegionId,
          edge.type,
          edge.weight,
          edge.reason ?? null,
        );
      }
    }
  } finally {
    database.close();
  }

  return indexPath;
}

export async function writeGraphArtifacts(
  root: string,
  dkbs: LoadedDkb[],
  records: IndexedKnowledgeRegion[],
  semanticNeighbors: SemanticNeighbor[] = [],
): Promise<{ krGraphPath: string }> {
  const krGraphPath = resolveFrom(root, KR_GRAPH_PATH);
  const krGraph = graphForRecords(dkbs, records, 'kr', semanticNeighbors);

  await fs.mkdir(path.dirname(krGraphPath), { recursive: true });
  await fs.writeFile(krGraphPath, `${JSON.stringify(krGraph.export(), null, 2)}\n`, 'utf8');

  return {
    krGraphPath,
  };
}

export async function writeVectorArtifacts(root: string, registryId: string, records: IndexedKnowledgeRegion[]): Promise<VectorArtifactBuild> {
  const krVectorPath = resolveFrom(root, KR_VECTOR_PATH);

  return writeSearchArtifacts(registryId, krVectorPath, records);
}

function defaultQueryableFor(record: KnowledgeRegion): NonNullable<KnowledgeRegion['queryable']> {
  return {
    operations: record.regionType === 'table' || record.regionType === 'view'
      ? ['search', 'lookup', 'aggregate']
      : ['fetch', 'search'],
    defaultLimit: 10,
    maxLimit: 100,
  };
}

interface IndexedSourceRow {
  sourceId: string;
  storeId: string;
  type: DkbStore['type'];
  locator: Record<string, unknown>;
  hash?: string;
  updatedAt: string;
  role: 'primary' | 'member' | 'supporting';
}

interface IndexedEdgeRow {
  targetRegionId: string;
  type: NonNullable<KnowledgeRegion['relationships']>[number]['type'];
  weight: number;
  reason?: string;
}

function reconstructRegion(region: Record<string, unknown>, sourceRows: Record<string, unknown>[], edgeRows: Record<string, unknown>[]): IndexedKnowledgeRegion {
  const dkbId = String(region.dkb_id);
  const regionId = String(region.region_id);
  const type = String(region.type) as KnowledgeRegion['regionType'];
  const sources = sourceRows.map(sourceRowFor);
  const edges = edgeRows.map(edgeRowFor);
  const primarySource = sources.find((source) => source.role === 'primary') ?? sources[0];
  const sourceRef = primarySource ? {
    storeId: primarySource.storeId,
    type: primarySource.type,
    locator: locatorForRegion(regionId, type, sources),
    hash: combinedSourceHash(sources),
  } : undefined;
  const source = sourceLabelFor(regionId, sourceRef?.locator);
  const groupingType = optionalString(region.grouping_type);
  const groupingReason = optionalString(region.grouping_reason);
  const topics = unique([
    ...pathTokens(regionId),
    ...pathTokens(String(region.title)),
    ...pathTokens(String(region.summary)),
  ]).slice(0, 32);
  const keywords = parseJsonStringArray(region.keywords_json).slice(0, 64);
  const entities = unique([
    String(region.title),
    ...sources.map((sourceRow) => sourceRow.sourceId),
  ]).slice(0, 32);
  const aliases = unique([
    regionId,
    source,
    ...sources.map((sourceRow) => sourceLabelFor(sourceRow.sourceId, sourceRow.locator)),
  ]);

  return {
    dkbId,
    id: regionId,
    title: String(region.title),
    content: String(region.summary),
    source,
    topics,
    keywords,
    entities,
    updatedAt: String(region.updated_at),
    aliases,
    regionType: type,
    sourceRef,
    queryable: parseJsonObject(region.queryable_json) as unknown as KnowledgeRegion['queryable'],
    capabilities: parseCapabilityProfile(region.capabilities_json, parseJsonObject(region.queryable_json) as unknown as KnowledgeRegion['queryable']),
    parentRegionId: edges.find((edge) => edge.type === 'parent')?.targetRegionId,
    childRegionIds: edges.filter((edge) => edge.type === 'child').map((edge) => edge.targetRegionId),
    relatedRegionIds: edges.filter((edge) => edge.type !== 'parent' && edge.type !== 'child').map((edge) => edge.targetRegionId),
    ancestry: ancestryForRegion(regionId),
    relationships: edges.map((edge) => ({
      type: edge.type,
      regionId: edge.targetRegionId,
    })),
    grouping: groupingType && groupingReason ? {
      strategy: groupingType as NonNullable<KnowledgeRegion['grouping']>['strategy'],
      reason: groupingReason,
    } : undefined,
    sourceIds: sources.map((sourceRow) => sourceRow.sourceId),
    sourceUnits: sources.map((sourceRow) => ({
      id: sourceRow.sourceId,
      storeId: sourceRow.storeId,
      type: sourceRow.type,
      locator: sourceRow.locator,
      hash: sourceRow.hash,
      updatedAt: sourceRow.updatedAt,
    })),
    storeIds: unique(sources.map((sourceRow) => sourceRow.storeId)),
  };
}

function parseCapabilityProfile(value: unknown, queryable: KnowledgeRegion['queryable']): KnowledgeCapabilityProfile {
  const fallback = capabilitiesForQueryable(queryable);

  if (typeof value !== 'string') {
    return fallback;
  }

  try {
    const parsed = JSON.parse(value) as Partial<KnowledgeCapabilityProfile> | null;

    if (!parsed) {
      return fallback;
    }

    return {
      ...fallback,
      ...parsed,
      operations: Array.isArray(parsed.operations)
        ? parsed.operations.filter((item): item is KnowledgeCapabilityProfile['operations'][number] => typeof item === 'string' && ['fetch', 'search', 'lookup', 'aggregate'].includes(item))
        : fallback.operations,
    };
  } catch {
    return fallback;
  }
}

function capabilitiesForQueryable(queryable: KnowledgeRegion['queryable']): KnowledgeCapabilityProfile {
  const operations = queryable?.operations ?? [];

  return {
    evidence: operations.some((operation) => operation === 'fetch' || operation === 'search' || operation === 'lookup') ? 'full' : 'none',
    records: operations.some((operation) => operation === 'lookup') ? 'full' : 'none',
    exactCount: operations.some((operation) => operation === 'aggregate') ? 'full' : 'none',
    approximateCount: operations.some((operation) => operation === 'fetch' || operation === 'search') ? 'partial' : 'none',
    structuredFilter: Object.keys(queryable?.fields ?? {}).length > 0 && operations.some((operation) => operation === 'lookup' || operation === 'aggregate') ? 'full' : 'none',
    operations,
  };
}

function sourceRowFor(row: Record<string, unknown>): IndexedSourceRow {
  return {
    sourceId: String(row.source_id),
    storeId: String(row.store_id),
    type: String(row.type) as DkbStore['type'],
    locator: parseJsonObject(row.locator_json),
    hash: optionalString(row.source_hash),
    updatedAt: String(row.updated_at),
    role: String(row.role) as IndexedSourceRow['role'],
  };
}

function edgeRowFor(row: Record<string, unknown>): IndexedEdgeRow {
  return {
    targetRegionId: String(row.target_region_id),
    type: String(row.type) as IndexedEdgeRow['type'],
    weight: typeof row.weight === 'number' ? row.weight : Number(row.weight ?? 1),
    reason: optionalString(row.reason),
  };
}

function sourcesForRecord(record: IndexedKnowledgeRegion): IndexedSourceRow[] {
  if (record.sourceUnits?.length) {
    return record.sourceUnits.flatMap((unit, index) => {
      const storeId = unit.storeId ?? record.sourceRef?.storeId;
      const type = unit.type ?? record.sourceRef?.type;

      if (!storeId || !type) {
        return [];
      }

      return [{
        sourceId: unit.id ?? sourceIdFor(type, unit.locator),
        storeId,
        type,
        locator: unit.locator,
        hash: unit.hash,
        updatedAt: unit.updatedAt ?? record.updatedAt,
        role: index === 0 ? 'primary' as const : 'member' as const,
      }];
    });
  }

  const sourceRef = record.sourceRef;

  if (!sourceRef) {
    return [];
  }

  const sourceLocators = sourceLocatorsFor(record);

  return sourceLocators.map((locator, index) => ({
    sourceId: sourceIdFor(sourceRef.type, locator),
    storeId: sourceRef.storeId,
    type: sourceRef.type,
    locator,
    hash: index === 0 ? sourceRef.hash : undefined,
    updatedAt: record.updatedAt,
    role: index === 0 ? 'primary' : 'member',
  }));
}

function sourceLocatorsFor(record: IndexedKnowledgeRegion): Record<string, unknown>[] {
  const locator = record.sourceRef?.locator ?? {};
  const paths = Array.isArray(locator.paths)
    ? locator.paths.filter((item): item is string => typeof item === 'string')
    : [];

  if (paths.length > 0) {
    return paths.map((sourcePath) => ({
      path: sourcePath,
    }));
  }

  const tables = Array.isArray(locator.tables)
    ? locator.tables.filter((item): item is string => typeof item === 'string')
    : [];

  if (tables.length > 0) {
    return tables.map((table) => {
      const [schema, tableName] = table.includes('.') ? table.split('.', 2) : [locator.schema, table];

      return typeof schema === 'string'
        ? { schema, table: tableName, type: 'table' }
        : { table: tableName, type: 'table' };
    });
  }

  return [locator];
}

function edgesForRecord(record: IndexedKnowledgeRegion): IndexedEdgeRow[] {
  return (record.relationships ?? []).map((relationship) => ({
    targetRegionId: relationship.regionId,
    type: relationship.type,
    weight: 1,
    reason: record.grouping?.reason,
  }));
}

function locatorForRegion(regionId: string, type: KnowledgeRegion['regionType'], sources: IndexedSourceRow[]): Record<string, unknown> {
  const primary = sources.find((source) => source.role === 'primary') ?? sources[0];

  if (!primary) {
    return {};
  }

  if (primary.type === 'filesystem' && type === 'folder') {
    const paths = sources
      .map((source) => source.locator.path)
      .filter((item): item is string => typeof item === 'string');

    return {
      path: stripRegionPrefix(regionId, 'folder:'),
      paths,
    };
  }

  if ((primary.type === 'sqlite' || primary.type === 'postgres') && type === 'table_group') {
    const tables = sources
      .map((source) => {
        const schema = typeof source.locator.schema === 'string' ? source.locator.schema : null;
        const table = typeof source.locator.table === 'string' ? source.locator.table : null;

        return table ? schema ? `${schema}.${table}` : table : null;
      })
      .filter((item): item is string => item !== null);

    return {
      ...primary.locator,
      primaryTable: primary.locator.table,
      tables,
      type,
    };
  }

  return primary.locator;
}

function sourceIdFor(type: DkbStore['type'], locator: Record<string, unknown>): string {
  if (type === 'filesystem' && typeof locator.path === 'string') {
    return `file:${locator.path}`;
  }

  if ((type === 'sqlite' || type === 'postgres') && typeof locator.table === 'string') {
    return typeof locator.schema === 'string'
      ? `table:${locator.schema}.${locator.table}`
      : `table:${locator.table}`;
  }

  return `${type}:${stableHash(locator).slice(7, 19)}`;
}

function combinedSourceHash(sources: IndexedSourceRow[]): string | undefined {
  const hashes = sources
    .map((source) => source.hash)
    .filter((hash): hash is string => Boolean(hash));

  if (hashes.length === 0) {
    return undefined;
  }

  return hashes.length === 1 ? hashes[0] : stableHash(hashes);
}

function sourceLabelFor(regionId: string, locator: Record<string, unknown> | undefined): string {
  if (typeof locator?.path === 'string') {
    return locator.path;
  }

  if (typeof locator?.table === 'string') {
    return typeof locator.schema === 'string' ? `${locator.schema}.${locator.table}` : locator.table;
  }

  return regionId;
}

function ancestryForRegion(regionId: string): string[] {
  const stripped = stripRegionPrefix(regionId, 'folder:');

  if (stripped === regionId) {
    return [];
  }

  const parts = stripped.split('/').filter(Boolean);

  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}

function stripRegionPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

async function queryVectorArtifact(
  registryId: string,
  records: IndexedKnowledgeRegion[],
  documents: VectorDocument[] | undefined,
  query: string,
  searchLimit: number,
  artifactRoot: string,
): Promise<QueryHit[]> {
  const limit = Math.max(records.length, searchLimit);

  return documents
    ? querySearchDocumentsArtifact(registryId, records, documents, query, limit, artifactRoot)
    : querySearchArtifact(registryId, records, query, limit, artifactRoot);
}

async function searchRegistryIdFor(root: string, fallback: string): Promise<string> {
  try {
    const manifest = parseJsonObject(await fs.readFile(resolveFrom(root, KR_VECTOR_PATH), 'utf8'));
    const registryId = manifest.registryId;

    return typeof registryId === 'string' && registryId.length > 0 ? registryId : fallback;
  } catch {
    return fallback;
  }
}

function mergeHits(hits: QueryHit[], limit: number): QueryHit[] {
  const merged = new Map<string, QueryHit>();

  for (const hit of hits) {
    const key = `${hit.dkbId}/${hit.id}`;
    const existing = merged.get(key);

    if (!existing) {
      merged.set(key, {
        ...hit,
        retrievalPasses: uniqueRetrievalPasses(hit.retrievalPasses ?? ['lexical']),
      });

      continue;
    }

    const retrievalPasses = uniqueRetrievalPasses([...(existing.retrievalPasses ?? ['lexical']), ...(hit.retrievalPasses ?? ['lexical'])]);

    if (hit.score > existing.score) {
      merged.set(key, {
        ...hit,
        retrievalPasses,
      });
    } else {
      merged.set(key, {
        ...existing,
        retrievalPasses,
      });
    }
  }

  return [...merged.values()]
    .sort(compareHits)
    .slice(0, limit);
}

function compareHits(left: QueryHit, right: QueryHit): number {
  const scoreDelta = right.score - left.score;

  if (Math.abs(scoreDelta) > 2) {
    return scoreDelta;
  }

  const hierarchyDelta = hierarchySpecificityDelta(left, right);

  return hierarchyDelta || scoreDelta || left.dkbId.localeCompare(right.dkbId) || left.id.localeCompare(right.id);
}

function hierarchySpecificityDelta(left: QueryHit, right: QueryHit): number {
  if (isParentRegion(left, right)) {
    return 1;
  }

  if (isParentRegion(right, left)) {
    return -1;
  }

  return 0;
}

function isParentRegion(parent: QueryHit, child: QueryHit): boolean {
  if (parent.dkbId !== child.dkbId) {
    return false;
  }

  if (child.parentRegionId === parent.id || parent.childRegionIds?.includes(child.id)) {
    return true;
  }

  const parentPath = stripRegionPrefix(parent.id, 'folder:');

  return parentPath !== parent.id && (child.ancestry ?? []).includes(parentPath);
}

function graphSeedsFor(seedResults: QueryHit[]): QueryHit[] {
  const topScore = seedResults[0]?.score ?? 0;

  if (topScore < 20) {
    return seedResults;
  }

  const cutoff = Math.ceil(topScore * 0.35);

  return seedResults.filter((seed) => seed.score >= cutoff);
}

function graphOnlySeeds(records: IndexedKnowledgeRegion[], queryTokens: string[], minScore: number): QueryHit[] {
  return records
    .map((record) => ({
      ...scoreRecord(record, queryTokens),
      dkbId: record.dkbId,
      adapter: 'compose' as const,
      retrievalPasses: ['graph' as const],
    }))
    .filter((hit) => hit.score >= minScore && hasSufficientQueryCoverage(hit, queryTokens))
    .sort((a, b) => b.score - a.score || a.dkbId.localeCompare(b.dkbId) || a.id.localeCompare(b.id));
}

function uniqueRetrievalPasses(passes: RetrievalPass[]): RetrievalPass[] {
  return [...new Set(passes)];
}

function filterVectorDocumentsByRecords(documents: VectorDocument[], records: IndexedKnowledgeRegion[]): VectorDocument[] {
  const allowed = new Set(records.map((record) => `${record.dkbId}/${record.id}`));

  return documents.filter((document) => allowed.has(document.id));
}

function elapsedMs(start: number): number {
  return performance.now() - start;
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function graphForRecords(
  dkbs: LoadedDkb[],
  records: IndexedKnowledgeRegion[],
  prefix: 'kr' | 'ks',
  semanticNeighbors: SemanticNeighbor[],
): ArtifactGraph {
  const graph = new UndirectedGraph({ multi: false, allowSelfLoops: false }) as ArtifactGraph;

  for (const dkb of dkbs) {
    addNode(graph, `dkb:${dkb.manifest.id}`, {
      type: 'dkb',
      id: dkb.manifest.id,
      name: dkb.manifest.name,
    });
  }

  for (const record of records) {
    const recordNode = `${prefix}:${record.dkbId}/${record.id}`;

    addNode(graph, recordNode, {
      type: prefix,
      dkbId: record.dkbId,
      regionId: record.id,
      recordId: record.id,
      title: record.title,
      regionType: record.regionType ?? null,
    });
    addEdge(graph, recordNode, `dkb:${record.dkbId}`, 'belongs_to');

    for (const ancestor of record.ancestry ?? []) {
      const ancestorNode = `path:${record.dkbId}/${ancestor}`;

      addNode(graph, ancestorNode, { type: 'path', dkbId: record.dkbId, value: ancestor });
      addEdge(graph, recordNode, ancestorNode, 'path_ancestor');
    }

    for (const relationship of record.relationships ?? []) {
      const relatedNode = `${prefix}:${record.dkbId}/${relationship.regionId}`;

      addNode(graph, relatedNode, {
        type: prefix,
        dkbId: record.dkbId,
        regionId: relationship.regionId,
        unresolved: true,
      });
      addEdge(graph, recordNode, relatedNode, relationship.type);
    }

    for (const topic of record.topics) {
      const topicNode = `topic:${topic.toLowerCase()}`;

      addNode(graph, topicNode, { type: 'topic', value: topic });
      addEdge(graph, recordNode, topicNode, 'topic');
    }

    for (const keyword of record.keywords ?? []) {
      const keywordNode = `keyword:${keyword.toLowerCase()}`;

      addNode(graph, keywordNode, { type: 'keyword', value: keyword });
      addEdge(graph, recordNode, keywordNode, 'keyword');
    }

    for (const entity of record.entities) {
      const entityNode = `entity:${entity.toLowerCase()}`;

      addNode(graph, entityNode, { type: 'entity', value: entity });
      addEdge(graph, recordNode, entityNode, 'entity');
    }
  }

  for (const neighbor of semanticNeighbors) {
    const sourceNode = `${prefix}:${neighbor.sourceId}`;
    const targetNode = `${prefix}:${neighbor.targetId}`;

    if (!graph.hasNode(sourceNode) || !graph.hasNode(targetNode)) {
      continue;
    }

    addEdge(graph, sourceNode, targetNode, 'semantic_neighbor', {
      similarity: neighbor.score,
      source: 'kr.index.vector',
    });
  }

  return graph;
}

function addNode(graph: ArtifactGraph, node: string, attributes: Record<string, unknown>): void {
  if (!graph.hasNode(node)) {
    graph.addNode(node, attributes);
  }
}

function addEdge(graph: ArtifactGraph, source: string, target: string, type: string, attributes: Record<string, unknown> = {}): void {
  const [left, right] = [source, target].sort((a, b) => a.localeCompare(b));
  const edge = `${type}:${left}->${right}`;

  if (!graph.hasEdge(edge) && !graph.hasEdge(source, target)) {
    graph.addUndirectedEdgeWithKey(edge, source, target, { type, ...attributes });
  }
}

export function recordForHash(record: KnowledgeRegion & { dkbId?: string }): Record<string, unknown> {
  return {
    dkbId: record.dkbId ?? null,
    id: record.id,
    title: record.title,
    summary: record.content,
    source: record.source,
    topics: [...record.topics].sort((a, b) => a.localeCompare(b)),
    keywords: [...(record.keywords ?? [])].sort((a, b) => a.localeCompare(b)),
    entities: [...record.entities].sort((a, b) => a.localeCompare(b)),
    aliases: [...(record.aliases ?? [])].sort((a, b) => a.localeCompare(b)),
    updatedAt: record.updatedAt,
    regionType: record.regionType ?? null,
    sourceRef: record.sourceRef ?? null,
    queryable: record.queryable ?? null,
    parentRegionId: record.parentRegionId ?? null,
    childRegionIds: [...(record.childRegionIds ?? [])].sort((a, b) => a.localeCompare(b)),
    relatedRegionIds: [...(record.relatedRegionIds ?? [])].sort((a, b) => a.localeCompare(b)),
    ancestry: [...(record.ancestry ?? [])],
    relationships: record.relationships ?? [],
    grouping: record.grouping ?? null,
    sourceIds: [...(record.sourceIds ?? [])].sort((a, b) => a.localeCompare(b)),
    capabilities: record.capabilities ?? null,
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);

    return true;
  } catch {
    return false;
  }
}

async function removeArtifact(target: string): Promise<void> {
  const attempts = 6;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });

      return;
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : '';

      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(code) || attempt === attempts) {
        throw error;
      }

      await delay(attempt * 150);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) {
    return {};
  }

  const parsed = JSON.parse(value) as unknown;

  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function parseJsonStringArray(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) {
    return [];
  }

  const parsed = JSON.parse(value) as unknown;

  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
}

function hasColumn(database: DatabaseSync, table: string, column: string): boolean {
  const rows = database.prepare(`pragma table_info(${table})`).all() as Array<{ name?: unknown }>;

  return rows.some((row) => row.name === column);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function groupBy<T>(values: T[], keyFor: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();

  for (const value of values) {
    const key = keyFor(value);
    const group = groups.get(key) ?? [];

    group.push(value);
    groups.set(key, group);
  }

  return groups;
}

function pathTokens(value: string): string[] {
  return value
    .split(/[\\/._:\-\s+]+/g)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 1);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
