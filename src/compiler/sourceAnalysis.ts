import fs from 'node:fs/promises';
import path from 'node:path';
import { stableHash } from '../contracts/hash.js';
import { resolveFrom } from '../protocol/paths.js';
import { tokenize } from '../router/scoring.js';
import {
  SOURCE_GRAPH_PATH,
  SOURCE_VECTOR_PATH,
  writeSourceIndex,
  type IndexedSourceEdge,
  type IndexedSourceUnit,
} from '../indexes/sourceIndex.js';

const MAX_KEYWORDS_PER_SOURCE = 24;
const MAX_EDGE_KEYWORDS = 8;
const RELATION_SCORE_THRESHOLD = 0.45;

export type SourceUnit = IndexedSourceUnit;
export type SourceEdge = IndexedSourceEdge;

export interface SourceAnalysisResult {
  sourceUnits: SourceUnit[];
  sourceEdges: SourceEdge[];
}

export function analyzeSourceUnits(rawUnits: SourceUnit[]): SourceAnalysisResult {
  const sourceUnits = normalizeSourceUnits(rawUnits);
  const sourceEdges = buildSourceEdges(sourceUnits);

  return {
    sourceUnits,
    sourceEdges,
  };
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

  for (const group of groupBy(units, (unit) => `${unit.dkbId}/${unit.assetId}`).values()) {
    const ordered = [...group].sort((left, right) => left.chunkOrdinal - right.chunkOrdinal || left.id.localeCompare(right.id));

    for (let index = 1; index < ordered.length; index += 1) {
      setEdge(
        edges,
        ordered[index - 1]!,
        ordered[index]!,
        'next',
        1,
        sharedKeywords(ordered[index - 1]!, ordered[index]!),
        'adjacent compiled chunks from one source asset',
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
          'lexical_overlap',
          normalizedScore,
          [...pair.keywords].sort((a, b) => a.localeCompare(b)).slice(0, MAX_EDGE_KEYWORDS),
          'compiled chunks share rare deterministic keywords inside one DKB',
        );
      }
    }
  }

  return [...edges.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId)
    || left.targetId.localeCompare(right.targetId)
    || left.type.localeCompare(right.type));
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
  const key = `${source.dkbId}/${source.id}/${target.id}/${type}`;
  const current = edges.get(key);
  const next = {
    dkbId: source.dkbId,
    storeId: source.storeId,
    sourceId: source.id,
    targetId: target.id,
    type,
    score: roundScore(score),
    keywords,
    reason,
  };

  if (!current || next.score > current.score) {
    edges.set(key, next);
  }
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

function keywordVector(keywords: string[]): number[] {
  const vector = new Array<number>(64).fill(0);

  for (const keyword of keywords) {
    const hash = stableHash(keyword).replace(/^sha256:/, '');
    const index = Number.parseInt(hash.slice(0, 8), 16) % vector.length;
    const sign = Number.parseInt(hash.slice(8, 10), 16) % 2 === 0 ? 1 : -1;

    vector[index] += sign;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

  return norm > 0 ? vector.map((value) => roundScore(value / norm)) : vector;
}

function extractKeywords(text: string): string[] {
  const counts = new Map<string, number>();

  for (const token of tokenize(text).map((value) => value.toLowerCase())) {
    if (token.length > 2 && !genericKeywords.has(token)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  return [...counts]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([keyword]) => keyword)
    .slice(0, MAX_KEYWORDS_PER_SOURCE);
}

function rankedKeywords(values: string[], limit: number): string[] {
  const counts = new Map<string, number>();

  for (const value of values) {
    const normalized = value.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');

    if (normalized.length > 2 && !genericKeywords.has(normalized)) {
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
  }

  return [...counts]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([keyword]) => keyword)
    .slice(0, limit);
}

function compactText(values: Array<string | null | undefined>): string {
  return values.filter((value): value is string => Boolean(value?.trim()))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pairKey(left: string, right: string): string {
  return [left, right].sort((a, b) => a.localeCompare(b)).join('\0');
}

function groupBy<T>(values: T[], keyFor: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();

  for (const value of values) {
    const key = keyFor(value);
    const list = groups.get(key) ?? [];

    list.push(value);
    groups.set(key, list);
  }

  return groups;
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
  'folder',
  'from',
  'knowledge',
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
  'with',
]);
