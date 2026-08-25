import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { stableHash } from '../contracts/hash.js';
import { DKB_ARTIFACTS_DIR, resolveFrom } from '../protocol/paths.js';
import type { DkbReadOperation, DkbReadQuery, DkbStoreType, KnowledgeCapabilityProfile, KnowledgeQueryable } from '../protocol/types.js';
import { tokenize } from '../router/scoring.js';

export const SOURCE_INDEX_PATH = `${DKB_ARTIFACTS_DIR}/source.index`;
export const SOURCE_GRAPH_PATH = `${DKB_ARTIFACTS_DIR}/source.index.graph`;
export const SOURCE_VECTOR_PATH = `${DKB_ARTIFACTS_DIR}/source.index.vector.json`;

export interface IndexedSourceAsset {
  id: string;
  dkbId: string;
  storeId: string;
  type: DkbStoreType;
  locator: Record<string, unknown>;
  title: string;
  hash: string;
  updatedAt: string;
}

export interface IndexedSourceUnit {
  id: string;
  assetId: string;
  dkbId: string;
  packageVersion?: string;
  storeId: string;
  type: DkbStoreType;
  locator: Record<string, unknown>;
  assetLocator: Record<string, unknown>;
  title: string;
  text: string;
  keywords: string[];
  capabilities: KnowledgeCapabilityProfile;
  queryable?: KnowledgeQueryable;
  hash: string;
  updatedAt: string;
  chunkOrdinal: number;
  chunkStart: number;
  chunkEnd: number;
  heading?: string;
}

export interface IndexedSourceEdge {
  sourceId: string;
  targetId: string;
  dkbId: string;
  storeId: string;
  type: 'structural' | 'lexical_overlap' | 'semantic_similarity' | 'foreign_key' | 'previous' | 'next' | 'parent_asset' | 'same_heading';
  score: number;
  keywords: string[];
  reason: string;
}

export interface SourceIndexReadResult {
  assets: IndexedSourceAsset[];
  units: IndexedSourceUnit[];
  edges: IndexedSourceEdge[];
}

export interface SourceUnitQueryEvidence {
  text: string;
  tokens: string[];
  phrases: string[];
  identifiers: string[];
}

export interface SourceUnitMatch {
  unit: IndexedSourceUnit;
  evidence: {
    phrases: string[];
    identifiers: string[];
    keywords: string[];
    tokens: string[];
  };
}

export async function writeSourceIndex(root: string, units: IndexedSourceUnit[], edges: IndexedSourceEdge[]): Promise<string> {
  const indexPath = resolveFrom(root, SOURCE_INDEX_PATH);
  const tempIndexPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
  const assets = sourceAssetsFromChunks(units);

  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await removeArtifact(tempIndexPath);

  const database = new DatabaseSync(tempIndexPath);

  try {
    database.exec(`
      create table source_assets (
        dkb_id text not null,
        asset_id text not null,
        store_id text not null,
        type text not null,
        locator_json text not null,
        title text not null,
        source_hash text not null,
        updated_at text not null,
        primary key (dkb_id, asset_id)
      );

      create table source_units (
        dkb_id text not null,
        source_id text not null,
        asset_id text not null,
        store_id text not null,
        type text not null,
        locator_json text not null,
        asset_locator_json text not null,
        title text not null,
        search_text text not null,
        keywords_json text not null,
        capabilities_json text not null,
        queryable_json text,
        source_hash text not null,
        updated_at text not null,
        chunk_ordinal integer not null,
        chunk_start integer not null,
        chunk_end integer not null,
        heading text,
        primary key (dkb_id, source_id)
      );

      create index source_units_asset_idx
        on source_units (dkb_id, asset_id);

      create table source_edges (
        dkb_id text not null,
        store_id text not null,
        source_id text not null,
        target_source_id text not null,
        type text not null,
        score real not null,
        keywords_json text not null,
        reason text not null,
        primary key (dkb_id, source_id, target_source_id, type)
      );
    `);

    const insertAsset = database.prepare(`
      insert into source_assets (
        dkb_id, asset_id, store_id, type, locator_json, title, source_hash, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertUnit = database.prepare(`
      insert into source_units (
        dkb_id, source_id, asset_id, store_id, type, locator_json, asset_locator_json,
        title, search_text, keywords_json, capabilities_json, queryable_json, source_hash, updated_at,
        chunk_ordinal, chunk_start, chunk_end, heading
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEdge = database.prepare(`
      insert into source_edges (
        dkb_id, store_id, source_id, target_source_id, type, score, keywords_json, reason
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    database.exec('begin');
    try {
      for (const asset of assets) {
        insertAsset.run(
          asset.dkbId,
          asset.id,
          asset.storeId,
          asset.type,
          JSON.stringify(asset.locator),
          asset.title,
          asset.hash,
          asset.updatedAt,
        );
      }

      for (const unit of units) {
        insertUnit.run(
          unit.dkbId,
          unit.id,
          unit.assetId,
          unit.storeId,
          unit.type,
          JSON.stringify(unit.locator),
          JSON.stringify(unit.assetLocator),
          unit.title,
          unit.text,
          JSON.stringify(unit.keywords),
          JSON.stringify(unit.capabilities),
          unit.queryable ? JSON.stringify(unit.queryable) : null,
          unit.hash,
          unit.updatedAt,
          unit.chunkOrdinal,
          unit.chunkStart,
          unit.chunkEnd,
          unit.heading ?? null,
        );
      }

      for (const edge of edges) {
        insertEdge.run(
          edge.dkbId,
          edge.storeId,
          edge.sourceId,
          edge.targetId,
          edge.type,
          edge.score,
          JSON.stringify(edge.keywords),
          edge.reason,
        );
      }
      database.exec('commit');
    } catch (error) {
      database.exec('rollback');
      throw error;
    }
  } finally {
    database.close();
  }

  await removeArtifact(indexPath);
  await fs.rename(tempIndexPath, indexPath);

  return indexPath;
}

export async function readSourceIndex(root: string): Promise<SourceIndexReadResult> {
  const indexPath = resolveFrom(root, SOURCE_INDEX_PATH);
  const database = new DatabaseSync(indexPath, { readOnly: true });

  try {
    const hasAssets = hasTable(database, 'source_assets');
    const hasAssetColumns = hasColumn(database, 'source_units', 'asset_id');
    const assetRows = hasAssets
      ? database.prepare(`
        select dkb_id, asset_id, store_id, type, locator_json, title, source_hash, updated_at
        from source_assets
        order by dkb_id, asset_id
      `).all() as Array<Record<string, unknown>>
      : [];
    const unitRows = database.prepare(`
      select dkb_id, source_id,
             ${hasAssetColumns ? 'asset_id' : 'source_id as asset_id'},
             store_id, type, locator_json,
             ${hasAssetColumns ? 'asset_locator_json' : 'locator_json as asset_locator_json'},
             title, search_text, keywords_json, capabilities_json, queryable_json, source_hash, updated_at,
             ${hasAssetColumns ? 'chunk_ordinal' : '0 as chunk_ordinal'},
             ${hasAssetColumns ? 'chunk_start' : '0 as chunk_start'},
             ${hasAssetColumns ? 'chunk_end' : 'length(search_text) as chunk_end'},
             ${hasAssetColumns ? 'heading' : 'null as heading'}
      from source_units
      order by dkb_id, source_id
    `).all() as Array<Record<string, unknown>>;
    const edgeRows = database.prepare(`
      select dkb_id, store_id, source_id, target_source_id, type, score, keywords_json, reason
      from source_edges
      order by dkb_id, source_id, target_source_id, type
    `).all() as Array<Record<string, unknown>>;

    return {
      assets: hasAssets ? assetRows.map(sourceAssetFromRow) : sourceAssetsFromChunks(unitRows.map(sourceUnitFromRow)),
      units: unitRows.map(sourceUnitFromRow),
      edges: edgeRows.map(sourceEdgeFromRow),
    };
  } finally {
    database.close();
  }
}

export function queryEvidenceForSourceUnits(query: DkbReadQuery | string): SourceUnitQueryEvidence {
  const text = typeof query === 'string' ? query : queryTextFor(query);
  const tokens = tokenize(text).filter((token) => token.length > 2 && !genericKeywords.has(normalizeKeyword(token)));
  const identifiers = identifiersFor(text);
  const explicitPhrases = typeof query === 'string' ? [] : explicitPhrasesFor(query);

  return {
    text,
    tokens,
    phrases: [...new Set([
      ...explicitPhrases,
      ...phrasesFor(text),
    ])],
    identifiers,
  };
}

export function filterSourceUnitsForQueryEvidence(
  units: IndexedSourceUnit[],
  evidence: SourceUnitQueryEvidence,
  limit: number,
): SourceUnitMatch[] {
  if (units.length === 0) {
    return [];
  }

  if (evidence.tokens.length === 0 && evidence.phrases.length === 0 && evidence.identifiers.length === 0) {
    return units.slice(0, limit).map((unit) => ({
      unit,
      evidence: {
        phrases: [],
        identifiers: [],
        keywords: [],
        tokens: [],
      },
    }));
  }

  return units
    .map((unit, index) => ({
      unit,
      index,
      evidence: sourceUnitMatchEvidence(unit, evidence),
    }))
    .filter((item) => hasSourceUnitMatch(item.evidence, evidence))
    .sort(compareSourceUnitMatches)
    .slice(0, limit)
    .map((item) => ({
      unit: item.unit,
      evidence: item.evidence,
    }));
}

export function querySourceChunks(
  units: IndexedSourceUnit[],
  query: DkbReadQuery | string,
  limit: number,
): SourceUnitMatch[] {
  const evidence = queryEvidenceForSourceUnits(query);
  const matches = filterSourceUnitsForQueryEvidence(units, evidence, Math.max(limit * 4, limit));

  return expandSourceChunkMatches(units, matches, limit);
}

export function expandSourceChunkMatches(
  units: IndexedSourceUnit[],
  matches: SourceUnitMatch[],
  limit: number,
): SourceUnitMatch[] {
  const byAsset = new Map<string, IndexedSourceUnit[]>();

  for (const unit of units) {
    const key = `${unit.dkbId}/${unit.assetId}`;
    const list = byAsset.get(key) ?? [];

    list.push(unit);
    byAsset.set(key, list);
  }

  for (const list of byAsset.values()) {
    list.sort((left, right) => left.chunkOrdinal - right.chunkOrdinal || left.id.localeCompare(right.id));
  }

  const expanded = new Map<string, SourceUnitMatch>();

  for (const match of matches) {
    expanded.set(sourceChunkMatchKey(match.unit), match);
    const siblings = byAsset.get(`${match.unit.dkbId}/${match.unit.assetId}`) ?? [];
    const index = siblings.findIndex((unit) => unit.id === match.unit.id);

    for (const neighbor of [siblings[index - 1], siblings[index + 1]]) {
      if (!neighbor || expanded.has(sourceChunkMatchKey(neighbor))) {
        continue;
      }

      expanded.set(sourceChunkMatchKey(neighbor), {
        unit: neighbor,
        evidence: {
          phrases: [],
          identifiers: [],
          keywords: [],
          tokens: [],
        },
      });
    }
  }

  return [...expanded.values()]
    .sort(compareExpandedMatches)
    .slice(0, limit);
}

export function sourceUnitId(input: {
  dkbId: string;
  storeId: string;
  type: DkbStoreType;
  locator: Record<string, unknown>;
  ordinal?: number;
}): string {
  return stableHash({
    type: 'source-chunk',
    dkbId: input.dkbId,
    storeId: input.storeId,
    sourceType: input.type,
    locator: input.locator,
    ordinal: input.ordinal ?? 0,
  });
}

export function sourceAssetsFromChunks(units: IndexedSourceUnit[]): IndexedSourceAsset[] {
  const assets = new Map<string, IndexedSourceAsset>();

  for (const unit of units) {
    const key = `${unit.dkbId}/${unit.assetId}`;
    const current = assets.get(key);

    if (!current || unit.chunkOrdinal < (units.find((candidate) => candidate.assetId === current.id)?.chunkOrdinal ?? Number.MAX_SAFE_INTEGER)) {
      assets.set(key, {
        id: unit.assetId,
        dkbId: unit.dkbId,
        storeId: unit.storeId,
        type: unit.type,
        locator: unit.assetLocator,
        title: unit.heading ? unit.title.replace(` - ${unit.heading}`, '') : unit.title,
        hash: stableHash({
          assetId: unit.assetId,
          chunks: units
            .filter((candidate) => candidate.dkbId === unit.dkbId && candidate.assetId === unit.assetId)
            .map((candidate) => candidate.hash)
            .sort(),
        }),
        updatedAt: unit.updatedAt,
      });
    }
  }

  return [...assets.values()].sort((left, right) => left.dkbId.localeCompare(right.dkbId) || left.id.localeCompare(right.id));
}

export function capabilitiesForSourceType(type: DkbStoreType): KnowledgeCapabilityProfile {
  if (type === 'sqlite' || type === 'postgres' || type === 'database') {
    return {
      evidence: 'full',
      records: 'full',
      exactCount: 'full',
      approximateCount: 'none',
      structuredFilter: 'full',
      operations: ['lookup', 'search', 'aggregate'],
    };
  }

  return {
    evidence: 'full',
    records: 'none',
    exactCount: 'none',
    approximateCount: 'partial',
    structuredFilter: 'none',
    operations: ['fetch', 'search'],
  };
}

export function mergeCapabilityProfiles(profiles: KnowledgeCapabilityProfile[]): KnowledgeCapabilityProfile {
  const operations = unique(profiles.flatMap((profile) => profile.operations));

  return {
    evidence: mergeSupport(profiles.map((profile) => profile.evidence)),
    records: mergeSupport(profiles.map((profile) => profile.records)),
    exactCount: mergeSupport(profiles.map((profile) => profile.exactCount)),
    approximateCount: mergeSupport(profiles.map((profile) => profile.approximateCount)),
    structuredFilter: mergeSupport(profiles.map((profile) => profile.structuredFilter)),
    operations,
  };
}

function sourceUnitMatchEvidence(unit: IndexedSourceUnit, evidence: SourceUnitQueryEvidence): SourceUnitMatch['evidence'] {
  const normalized = `${unit.title}\n${unit.text}\n${unit.keywords.join(' ')}`.toLowerCase();
  const phrases = evidence.phrases.filter((phrase) => phrase.length > 0 && normalized.includes(phrase));
  const identifiers = evidence.identifiers.filter((identifier) => normalized.includes(identifier.toLowerCase()));

  if (evidence.identifiers.length > 0) {
    return {
      phrases,
      identifiers,
      keywords: [],
      tokens: [],
    };
  }

  const unitTokens = new Set(tokenize(normalized));
  const keywordSet = new Set(unit.keywords.map((keyword) => keyword.toLowerCase()));
  return {
    phrases,
    identifiers,
    keywords: evidence.tokens.filter((token) => keywordSet.has(token)),
    tokens: evidence.tokens.filter((token) => unitTokens.has(token)),
  };
}

function hasSourceUnitMatch(match: SourceUnitMatch['evidence'], query: SourceUnitQueryEvidence): boolean {
  if (query.identifiers.length > 0) {
    return match.identifiers.length > 0;
  }

  return match.phrases.length > 0
    || match.identifiers.length > 0
    || match.keywords.length > 0
    || match.tokens.length > 0;
}

function compareSourceUnitMatches(
  left: { unit: IndexedSourceUnit; index: number; evidence: SourceUnitMatch['evidence'] },
  right: { unit: IndexedSourceUnit; index: number; evidence: SourceUnitMatch['evidence'] },
): number {
  return right.evidence.identifiers.length - left.evidence.identifiers.length
    || right.evidence.phrases.length - left.evidence.phrases.length
    || right.evidence.keywords.length - left.evidence.keywords.length
    || right.evidence.tokens.length - left.evidence.tokens.length
    || right.unit.updatedAt.localeCompare(left.unit.updatedAt)
    || left.unit.id.localeCompare(right.unit.id)
    || left.index - right.index;
}

function compareExpandedMatches(left: SourceUnitMatch, right: SourceUnitMatch): number {
  const leftMatched = sourceUnitMatchWeight(left.evidence);
  const rightMatched = sourceUnitMatchWeight(right.evidence);

  return rightMatched - leftMatched
    || right.unit.updatedAt.localeCompare(left.unit.updatedAt)
    || left.unit.dkbId.localeCompare(right.unit.dkbId)
    || left.unit.assetId.localeCompare(right.unit.assetId)
    || left.unit.chunkOrdinal - right.unit.chunkOrdinal
    || left.unit.id.localeCompare(right.unit.id);
}

function sourceUnitMatchWeight(evidence: SourceUnitMatch['evidence']): number {
  return evidence.identifiers.length * 100
    + evidence.phrases.length * 50
    + evidence.keywords.length * 10
    + evidence.tokens.length;
}

function sourceChunkMatchKey(unit: IndexedSourceUnit): string {
  return `${unit.dkbId}/${unit.id}`;
}

function queryTextFor(query: DkbReadQuery): string {
  return (query.filters ?? []).map((filter) => String(filter.value)).join(' ');
}

function explicitPhrasesFor(query: DkbReadQuery): string[] {
  return (query.filters ?? [])
    .filter((filter) => filter.op === 'contains' && typeof filter.value === 'string')
    .map((filter) => String(filter.value).toLowerCase().replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function extractKeywords(text: string): string[] {
  const counts = new Map<string, number>();

  for (const token of tokenize(text).map(normalizeKeyword)) {
    if (token.length > 2 && !genericKeywords.has(token)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  return [...counts]
    .sort((left, right) => keywordScore(right) - keywordScore(left) || left[0].localeCompare(right[0]))
    .map(([keyword]) => keyword)
    .slice(0, 24);
}

function rankedKeywords(values: string[], limit: number): string[] {
  const counts = new Map<string, number>();

  for (const value of values.flatMap((item) => tokenize(item, { keepStopwords: true })).map(normalizeKeyword)) {
    if (value.length > 2 && !genericKeywords.has(value)) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }

  return [...counts]
    .sort((left, right) => keywordScore(right) - keywordScore(left) || left[0].localeCompare(right[0]))
    .map(([keyword]) => keyword)
    .slice(0, limit);
}

function keywordScore([keyword, count]: [string, number]): number {
  return count * 2 + Math.min(keyword.length, 16) / 8;
}

function normalizeKeyword(value: string): string {
  return value.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
}

function stableLocatorText(locator: Record<string, unknown>): string {
  return Object.entries(locator)
    .map(([key, value]) => `${key}:${String(value)}`)
    .join(' ');
}

function phrasesFor(text: string): string[] {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const tokens = tokenize(normalized).filter((token) => token.length > 2);
  const phrases: string[] = [];

  if (normalized.length > 0) {
    phrases.push(normalized);
  }

  for (let size = Math.min(4, tokens.length); size >= 2; size -= 1) {
    for (let index = 0; index <= tokens.length - size; index += 1) {
      phrases.push(tokens.slice(index, index + size).join(' '));
    }
  }

  return [...new Set(phrases)];
}

function identifiersFor(text: string): string[] {
  return [...new Set((text.match(/\b[A-Za-z0-9][A-Za-z0-9_-]*\d[A-Za-z0-9_-]*\b/g) ?? [])
    .map((identifier) => identifier.trim())
    .filter(Boolean))];
}

function sourceUnitFromRow(row: Record<string, unknown>): IndexedSourceUnit {
  return {
    id: String(row.source_id),
    assetId: String(row.asset_id),
    dkbId: String(row.dkb_id),
    storeId: String(row.store_id),
    type: String(row.type) as DkbStoreType,
    locator: parseJsonObject(row.locator_json),
    assetLocator: parseJsonObject(row.asset_locator_json),
    title: String(row.title),
    text: String(row.search_text),
    keywords: parseJsonStringArray(row.keywords_json),
    capabilities: parseCapabilities(row.capabilities_json, String(row.type) as DkbStoreType),
    queryable: parseQueryable(row.queryable_json),
    hash: String(row.source_hash),
    updatedAt: String(row.updated_at),
    chunkOrdinal: Number(row.chunk_ordinal ?? 0),
    chunkStart: Number(row.chunk_start ?? 0),
    chunkEnd: Number(row.chunk_end ?? String(row.search_text).length),
    heading: optionalString(row.heading),
  };
}

function sourceAssetFromRow(row: Record<string, unknown>): IndexedSourceAsset {
  return {
    id: String(row.asset_id),
    dkbId: String(row.dkb_id),
    storeId: String(row.store_id),
    type: String(row.type) as DkbStoreType,
    locator: parseJsonObject(row.locator_json),
    title: String(row.title),
    hash: String(row.source_hash),
    updatedAt: String(row.updated_at),
  };
}

function parseQueryable(value: unknown): KnowledgeQueryable | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }

    return parsed as KnowledgeQueryable;
  } catch {
    return undefined;
  }
}

function parseCapabilities(value: unknown, type: DkbStoreType): KnowledgeCapabilityProfile {
  if (typeof value !== 'string') {
    return capabilitiesForSourceType(type);
  }

  try {
    const parsed = JSON.parse(value) as Partial<KnowledgeCapabilityProfile>;

    return {
      ...capabilitiesForSourceType(type),
      ...parsed,
      operations: validOperations(parsed.operations),
    };
  } catch {
    return capabilitiesForSourceType(type);
  }
}

function validOperations(value: unknown): DkbReadOperation[] {
  const allowed = new Set<DkbReadOperation>(['fetch', 'search', 'lookup', 'aggregate']);

  return Array.isArray(value)
    ? unique(value.filter((item): item is DkbReadOperation => typeof item === 'string' && allowed.has(item as DkbReadOperation)))
    : [];
}

function mergeSupport(values: KnowledgeCapabilityProfile[keyof Pick<KnowledgeCapabilityProfile, 'evidence' | 'records' | 'exactCount' | 'approximateCount' | 'structuredFilter'>][]): 'none' | 'partial' | 'full' {
  const concrete = values.filter((value) => value !== 'none');

  if (concrete.length === 0) {
    return 'none';
  }

  return concrete.length === values.length && concrete.every((value) => value === 'full') ? 'full' : 'partial';
}

function unique<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

const genericKeywords = new Set([
  'adapter',
  'boundary',
  'compiled',
  'data',
  'direct',
  'does',
  'file',
  'files',
  'find',
  'filesystem',
  'folder',
  'from',
  'knowledge',
  'mention',
  'mentions',
  'record',
  'records',
  'row',
  'rows',
  'source',
  'sources',
  'table',
  'tables',
  'that',
  'this',
  'view',
]);

function sourceEdgeFromRow(row: Record<string, unknown>): IndexedSourceEdge {
  return {
    sourceId: String(row.source_id),
    targetId: String(row.target_source_id),
    dkbId: String(row.dkb_id),
    storeId: String(row.store_id),
    type: String(row.type) as IndexedSourceEdge['type'],
    score: Number(row.score),
    keywords: parseJsonStringArray(row.keywords_json),
    reason: String(row.reason),
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseJsonStringArray(value: unknown): string[] {
  if (typeof value !== 'string') {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;

    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function hasTable(database: DatabaseSync, table: string): boolean {
  const row = database
    .prepare("select name from sqlite_master where type = 'table' and name = ?")
    .get(table) as { name?: string } | undefined;

  return row?.name === table;
}

function hasColumn(database: DatabaseSync, table: string, column: string): boolean {
  const rows = database.prepare(`pragma table_info(${table})`).all() as Array<{ name?: unknown }>;

  return rows.some((row) => row.name === column);
}

async function removeArtifact(target: string): Promise<void> {
  await fs.rm(target, { force: true, recursive: true });
}
