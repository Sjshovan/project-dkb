import fs from 'node:fs/promises';
import path from 'node:path';
import { stableHash } from '../contracts/hash.js';
import { resolveFrom } from '../protocol/paths.js';
import type {
  DkbReadOperation,
  KnowledgeCapabilityProfile,
  KnowledgeQueryable,
  KnowledgeRegion,
  KnowledgeRegionRelationship,
} from '../protocol/types.js';
import { tokenize } from '../router/scoring.js';
import type { IndexedKnowledgeRegion } from '../indexes/knowledgeIndex.js';
import {
  SOURCE_GRAPH_PATH,
  SOURCE_VECTOR_PATH,
  mergeCapabilityProfiles,
  sourceUnitsFromKnowledgeRegion,
  writeSourceIndex,
  type IndexedSourceEdge,
  type IndexedSourceUnit,
} from '../indexes/sourceIndex.js';

const MAX_KEYWORDS_PER_SOURCE = 24;
const MAX_KEYWORDS_PER_REGION = 32;
const MAX_EDGE_KEYWORDS = 8;
const MERGE_SCORE_THRESHOLD = 0.85;
const RELATION_SCORE_THRESHOLD = 0.45;

export type SourceUnit = IndexedSourceUnit;
export type SourceEdge = IndexedSourceEdge;

export interface SourceAnalysisResult {
  sourceUnits: SourceUnit[];
  sourceEdges: SourceEdge[];
  records: IndexedKnowledgeRegion[];
}

export function analyzeSourceUnits(rawUnits: SourceUnit[]): SourceAnalysisResult {
  const sourceUnits = normalizeSourceUnits(rawUnits);
  const sourceEdges = buildSourceEdges(sourceUnits);
  const records = recordsFromSourceClusters(sourceUnits, sourceEdges);
  const finalSourceUnits = records.flatMap(sourceUnitsForCompiledRecord);
  const finalSourceEdges = mergeSourceEdges(sourceEdges, buildSourceEdges(finalSourceUnits));

  return {
    sourceUnits: finalSourceUnits,
    sourceEdges: finalSourceEdges,
    records,
  };
}

export function analyzeAndClusterSources(records: IndexedKnowledgeRegion[]): SourceAnalysisResult {
  return analyzeSourceUnits(records.flatMap(sourceUnitsFromKnowledgeRegion));
}

export async function writeSourceAnalysisArtifacts(root: string, registryId: string, analysis: SourceAnalysisResult): Promise<void> {
  const sourceGraphPath = resolveFrom(root, SOURCE_GRAPH_PATH);
  const sourceVectorPath = resolveFrom(root, SOURCE_VECTOR_PATH);
  const createdAt = new Date().toISOString();

  await fs.mkdir(path.dirname(sourceGraphPath), { recursive: true });
  await writeSourceIndex(root, analysis.sourceUnits, analysis.sourceEdges);
  await Promise.all([
    fs.writeFile(sourceGraphPath, `${JSON.stringify({
      registryId,
      createdAt,
      nodes: analysis.sourceUnits.map((unit) => ({
        id: unit.id,
        dkbId: unit.dkbId,
        regionId: unit.regionId,
        storeId: unit.storeId,
        type: unit.type,
        keywords: unit.keywords,
        hash: unit.hash,
      })),
      edges: analysis.sourceEdges,
    }, null, 2)}\n`, 'utf8'),
    fs.writeFile(sourceVectorPath, `${JSON.stringify({
      registryId,
      createdAt,
      engine: 'deterministic-keyword-vector',
      dimensions: 64,
      vectors: analysis.sourceUnits.map((unit) => ({
        id: unit.id,
        vector: keywordVector(unit.keywords),
      })),
    }, null, 2)}\n`, 'utf8'),
  ]);
}

function normalizeSourceUnits(units: SourceUnit[]): SourceUnit[] {
  return units
    .map((unit) => {
      const text = compactText([
        unit.title,
        unit.text,
        unit.keywords.join(' '),
      ]);

      return {
        ...unit,
        text,
        keywords: rankedKeywords([...unit.keywords, ...extractKeywords(text)], MAX_KEYWORDS_PER_SOURCE),
        hash: unit.hash || stableHash({ sourceUnit: unit.id, text, locator: unit.locator }),
      };
    })
    .sort((left, right) => left.dkbId.localeCompare(right.dkbId)
      || left.storeId.localeCompare(right.storeId)
      || left.id.localeCompare(right.id));
}

function buildSourceEdges(units: SourceUnit[]): SourceEdge[] {
  const edges = new Map<string, SourceEdge>();

  for (const group of groupBy(units, (unit) => `${unit.dkbId}/${unit.regionId}`).values()) {
    const structuralUnits = group.filter((unit) => unit.type !== 'filesystem');

    for (let index = 1; index < structuralUnits.length; index += 1) {
      setEdge(
        edges,
        structuralUnits[index - 1]!,
        structuralUnits[index]!,
        'structural',
        1,
        sharedKeywords(structuralUnits[index - 1]!, structuralUnits[index]!),
        'database source units share an adapter-compiled structural region',
      );
    }
  }

  for (const group of groupBy(units, (unit) => unit.dkbId).values()) {
    const inverted = invertedKeywordIndex(group);
    const pairScores = new Map<string, { left: SourceUnit; right: SourceUnit; score: number; keywords: Set<string> }>();

    for (const [keyword, matches] of inverted) {
      if (matches.length < 2 || matches.length > Math.max(12, Math.ceil(group.length * 0.2))) {
        continue;
      }

      const weight = 1 / Math.sqrt(matches.length);

      for (let left = 0; left < matches.length; left += 1) {
        for (let right = left + 1; right < matches.length; right += 1) {
          const leftUnit = matches[left]!;
          const rightUnit = matches[right]!;
          const key = pairKey(leftUnit.id, rightUnit.id);
          const current = pairScores.get(key) ?? {
            left: leftUnit,
            right: rightUnit,
            score: 0,
            keywords: new Set<string>(),
          };

          current.score += weight;
          current.keywords.add(keyword);
          pairScores.set(key, current);
        }
      }
    }

    for (const pair of pairScores.values()) {
      const normalizedScore = pair.score / Math.max(Math.sqrt(pair.left.keywords.length + pair.right.keywords.length), 1);

      if (normalizedScore >= RELATION_SCORE_THRESHOLD) {
        setEdge(
          edges,
          pair.left,
          pair.right,
          normalizedScore >= MERGE_SCORE_THRESHOLD ? 'semantic_similarity' : 'lexical_overlap',
          normalizedScore,
          [...pair.keywords].sort((a, b) => a.localeCompare(b)).slice(0, MAX_EDGE_KEYWORDS),
          'source units share rare deterministic keywords inside one DKB',
        );
      }
    }
  }

  return [...edges.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId)
    || left.targetId.localeCompare(right.targetId)
    || left.type.localeCompare(right.type));
}

function recordsFromSourceClusters(units: SourceUnit[], edges: SourceEdge[]): IndexedKnowledgeRegion[] {
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const parent = new Map(units.map((unit) => [unit.id, unit.id]));

  for (const edge of edges) {
    const left = unitById.get(edge.sourceId);
    const right = unitById.get(edge.targetId);

    if (!left || !right || left.dkbId !== right.dkbId) {
      continue;
    }

    if ((edge.type === 'semantic_similarity' && edge.score >= MERGE_SCORE_THRESHOLD) || edge.type === 'structural') {
      union(parent, left.id, right.id);
    }
  }

  const clusters = groupBy(units, (unit) => find(parent, unit.id));
  const edgesBySource = groupEdgesBySource(edges);
  const records = [...clusters.values()].map((cluster) => recordFromCluster(cluster, edgesBySource));

  return records.sort((left, right) => left.dkbId.localeCompare(right.dkbId) || left.id.localeCompare(right.id));
}

function recordFromCluster(cluster: SourceUnit[], edgesBySource: Map<string, SourceEdge[]>): IndexedKnowledgeRegion {
  const ordered = [...cluster].sort((left, right) => left.id.localeCompare(right.id));
  const first = ordered[0]!;
  const sourceIds = ordered.map((unit) => unit.id);
  const keywords = rankedKeywords(ordered.flatMap((unit) => unit.keywords), MAX_KEYWORDS_PER_REGION);
  const relationships = semanticRelationshipsFor(ordered, edgesBySource);
  const id = regionIdForCluster(ordered);
  const title = titleForCluster(ordered, keywords);
  const content = compactText([
    `Semantic Knowledge Region over ${ordered.length} source unit${ordered.length === 1 ? '' : 's'}.`,
    keywords.length > 0 ? `Keywords: ${keywords.join(', ')}.` : null,
    `Sources: ${ordered.map((unit) => unit.title).slice(0, 8).join('; ')}.`,
    `Evidence preview: ${ordered.map((unit) => sourcePreview(unit.text)).join(' ')}`,
  ]).slice(0, 5200);
  const sourceRef = {
    storeId: first.storeId,
    type: first.type,
    locator: locatorForPrimarySource(first, ordered),
    hash: stableHash(ordered.map((unit) => unit.hash).sort()),
  };

  return {
    dkbId: first.dkbId,
    id,
    title,
    content,
    source: `${first.dkbId}#${id}`,
    topics: rankedKeywords([...keywords, ...ordered.flatMap((unit) => pathTokens(unit.title))], 64),
    keywords,
    entities: unique(ordered.map((unit) => unit.title).concat(sourceIds)).slice(0, 64),
    updatedAt: latestUpdatedAt(ordered),
    aliases: unique([id, ...keywords.slice(0, 12)]),
    regionType: regionTypeForCluster(ordered),
    relatedRegionIds: relationships.map((relationship) => relationship.regionId),
    relationships,
    grouping: {
      strategy: ordered.length > 1 ? 'semantic_cluster' : 'single_source',
      reason: ordered.length > 1
        ? 'Compiler grouped source units by deterministic semantic and lexical source graph signals.'
        : 'Compiler produced one Knowledge Region for one source unit.',
    },
    sourceRef,
    sourceUnits: ordered.map((unit) => ({
      id: unit.id,
      assetId: unit.assetId,
      storeId: unit.storeId,
      type: unit.type,
      locator: unit.locator,
      assetLocator: unit.assetLocator,
      title: unit.title,
      text: unit.text,
      keywords: unit.keywords,
      hash: unit.hash,
      updatedAt: unit.updatedAt,
      capabilities: unit.capabilities,
      queryable: unit.queryable,
      chunkOrdinal: unit.chunkOrdinal,
      chunkStart: unit.chunkStart,
      chunkEnd: unit.chunkEnd,
      heading: unit.heading,
    })),
    sourceIds,
    capabilities: mergeCapabilityProfiles(ordered.map((unit) => unit.capabilities)),
    queryable: mergeQueryables(ordered),
    storeIds: unique(ordered.map((unit) => unit.storeId)),
  };
}

function sourceUnitsForCompiledRecord(record: IndexedKnowledgeRegion): SourceUnit[] {
  return (record.sourceUnits ?? []).flatMap((unit) => {
    if (!unit.id || !unit.storeId || !unit.type || !unit.text || !unit.capabilities) {
      return [];
    }

    return [{
      id: unit.id,
      assetId: unit.assetId ?? stableHash({
        type: 'source-asset',
        dkbId: record.dkbId,
        storeId: unit.storeId,
        sourceType: unit.type,
        locator: unit.assetLocator ?? unit.locator,
        hash: unit.hash ?? null,
      }),
      dkbId: record.dkbId,
      regionId: record.id,
      storeId: unit.storeId,
      type: unit.type,
      locator: unit.locator,
      assetLocator: unit.assetLocator ?? unit.locator,
      title: unit.title ?? record.title,
      text: unit.text,
      keywords: unit.keywords ?? [],
      capabilities: unit.capabilities,
      queryable: unit.queryable,
      hash: unit.hash ?? stableHash({ sourceUnit: unit.id, locator: unit.locator, text: unit.text }),
      updatedAt: unit.updatedAt ?? record.updatedAt,
      chunkOrdinal: unit.chunkOrdinal ?? 0,
      chunkStart: unit.chunkStart ?? 0,
      chunkEnd: unit.chunkEnd ?? unit.text.length,
      heading: unit.heading,
    }];
  });
}

function regionIdForCluster(units: SourceUnit[]): string {
  if (units.length === 1) {
    const unit = units[0]!;
    const sourceId = unit.chunkOrdinal === 0
      ? unit.assetId
      : `${unit.assetId}:${unit.chunkOrdinal}:${unit.id}`;

    return `source:${stableHash({
      dkbId: unit.dkbId,
      sourceId,
    }).slice(7, 19)}`;
  }

  const structuralRegionIds = new Set(units.map((unit) => unit.regionId));
  const sourceTypes = new Set(units.map((unit) => unit.type));

  const allRows = units.every((unit) => unit.locator.type === 'row');

  if (!allRows && structuralRegionIds.size === 1 && sourceTypes.size === 1 && !sourceTypes.has('filesystem')) {
    return units[0]!.regionId;
  }

  return `semantic:${stableHash({
    dkbId: units[0]!.dkbId,
    sourceIds: units.map((unit) => unit.id).sort(),
  }).slice(7, 19)}`;
}

function titleForCluster(units: SourceUnit[], keywords: string[]): string {
  if (units.length === 1) {
    return units[0]!.title;
  }

  return keywords.length > 0
    ? keywords.slice(0, 4).join(' + ')
    : `${units.length} related sources`;
}

function regionTypeForCluster(units: SourceUnit[]): KnowledgeRegion['regionType'] {
  if (units.length > 1) {
    return 'dataset';
  }

  const unit = units[0]!;

  if (unit.type === 'filesystem') {
    return 'file';
  }

  return unit.locator.type === 'row' ? 'record' : 'table';
}

function locatorForPrimarySource(primary: SourceUnit, units: SourceUnit[]): Record<string, unknown> {
  if (units.length === 1) {
    return primary.locator;
  }

  return {
    sourceIds: units.map((unit) => unit.id).sort(),
  };
}

function semanticRelationshipsFor(units: SourceUnit[], edgesBySource: Map<string, SourceEdge[]>): KnowledgeRegionRelationship[] {
  const sourceIds = new Set(units.map((unit) => unit.id));
  const related = new Set<string>();

  for (const unit of units) {
    for (const edge of edgesBySource.get(unit.id) ?? []) {
      const otherSourceId = edge.sourceId === unit.id ? edge.targetId : edge.sourceId;

      if (!sourceIds.has(otherSourceId) && edge.type !== 'structural') {
        related.add(`source:${stableHash({ dkbId: unit.dkbId, sourceId: otherSourceId }).slice(7, 19)}`);
      }
    }
  }

  return [...related].sort((left, right) => left.localeCompare(right)).map((regionId) => ({
    type: 'semantic',
    regionId,
  }));
}

function mergeQueryables(units: SourceUnit[]): KnowledgeQueryable {
  const operations = unique(units.flatMap((unit) => unit.queryable?.operations ?? unit.capabilities.operations)) as DkbReadOperation[];
  const fields: NonNullable<KnowledgeQueryable['fields']> = {};

  for (const unit of units) {
    for (const [field, definition] of Object.entries(unit.queryable?.fields ?? {})) {
      fields[field] ??= definition;
    }
  }

  return {
    operations,
    fields,
    defaultLimit: Math.min(20, Math.max(1, units.length)),
    maxLimit: Math.max(20, units.length),
  };
}

function mergeSourceEdges(left: SourceEdge[], right: SourceEdge[]): SourceEdge[] {
  const merged = new Map<string, SourceEdge>();

  for (const edge of [...left, ...right]) {
    merged.set(`${edge.sourceId}|${edge.targetId}|${edge.type}`, edge);
  }

  return [...merged.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId)
    || a.targetId.localeCompare(b.targetId)
    || a.type.localeCompare(b.type));
}

function groupEdgesBySource(edges: SourceEdge[]): Map<string, SourceEdge[]> {
  const result = new Map<string, SourceEdge[]>();

  for (const edge of edges) {
    for (const sourceId of [edge.sourceId, edge.targetId]) {
      const list = result.get(sourceId) ?? [];

      list.push(edge);
      result.set(sourceId, list);
    }
  }

  return result;
}

function extractKeywords(text: string): string[] {
  const counts = new Map<string, number>();
  const tokens = tokenize(text)
    .map(normalizeKeyword)
    .filter((token) => token.length > 2 && !genericKeywords.has(token));

  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return [...counts]
    .sort((left, right) => keywordScore(right) - keywordScore(left) || left[0].localeCompare(right[0]))
    .map(([keyword]) => keyword)
    .slice(0, MAX_KEYWORDS_PER_SOURCE);
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

function invertedKeywordIndex(units: SourceUnit[]): Map<string, SourceUnit[]> {
  const index = new Map<string, SourceUnit[]>();

  for (const unit of units) {
    for (const keyword of unit.keywords) {
      const list = index.get(keyword) ?? [];

      list.push(unit);
      index.set(keyword, list);
    }
  }

  return index;
}

function sharedKeywords(left: SourceUnit, right: SourceUnit): string[] {
  const rightKeywords = new Set(right.keywords);

  return left.keywords.filter((keyword) => rightKeywords.has(keyword)).slice(0, MAX_EDGE_KEYWORDS);
}

function setEdge(
  edges: Map<string, SourceEdge>,
  left: SourceUnit,
  right: SourceUnit,
  type: SourceEdge['type'],
  score: number,
  keywords: string[],
  reason: string,
): void {
  const [source, target] = [left, right].sort((a, b) => a.id.localeCompare(b.id));
  const key = `${source.id}|${target.id}|${type}`;

  edges.set(key, {
    sourceId: source.id,
    targetId: target.id,
    dkbId: source.dkbId,
    storeId: source.storeId,
    type,
    score: roundScore(score),
    keywords,
    reason,
  });
}

function keywordVector(keywords: string[]): number[] {
  const vector = new Array<number>(64).fill(0);

  for (const keyword of keywords) {
    const hash = stableHash(keyword).slice(7);
    const index = Number.parseInt(hash.slice(0, 8), 16) % vector.length;
    const sign = Number.parseInt(hash.slice(8, 10), 16) % 2 === 0 ? 1 : -1;

    vector[index] += sign;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

  return norm > 0 ? vector.map((value) => roundScore(value / norm)) : vector;
}

function stableLocatorText(locator: Record<string, unknown>): string {
  return Object.entries(locator)
    .map(([key, value]) => `${key}:${String(value)}`)
    .join(' ');
}

function sourcePreview(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700);
}

function compactText(values: Array<string | null | undefined>): string {
  return values
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pathTokens(value: string): string[] {
  return value
    .split(/[\\/._\-\s]+/g)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 1);
}

function latestUpdatedAt(units: SourceUnit[]): string {
  return units
    .map((unit) => unit.updatedAt)
    .sort((left, right) => right.localeCompare(left))[0] ?? new Date(0).toISOString();
}

function pairKey(left: string, right: string): string {
  return [left, right].sort((a, b) => a.localeCompare(b)).join('|');
}

function find(parent: Map<string, string>, value: string): string {
  const current = parent.get(value) ?? value;

  if (current === value) {
    return current;
  }

  const root = find(parent, current);

  parent.set(value, root);

  return root;
}

function union(parent: Map<string, string>, left: string, right: string): void {
  const leftRoot = find(parent, left);
  const rightRoot = find(parent, right);

  if (leftRoot !== rightRoot) {
    parent.set(rightRoot, leftRoot);
  }
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

function unique<T extends string>(values: T[]): T[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function roundScore(value: number): number {
  return Math.round(value * 10000) / 10000;
}

const genericKeywords = new Set([
  'adapter',
  'boundary',
  'compiled',
  'data',
  'direct',
  'file',
  'files',
  'filesystem',
  'folder',
  'knowledge',
  'record',
  'records',
  'region',
  'regions',
  'source',
  'sources',
  'table',
  'tables',
  'view',
]);
