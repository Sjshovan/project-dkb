import fs from 'node:fs/promises';
import { resolveFrom } from '../protocol/paths.js';
import type { QueryHit } from '../protocol/types.js';
import { defaultMinimumScore, hasSufficientQueryCoverage, scoreRecord } from '../router/scoring.js';
import { KR_GRAPH_PATH, type IndexedKnowledgeRegion } from './knowledgeIndex.js';

export interface GraphNode {
  key: string;
  attributes?: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  attributes?: Record<string, unknown>;
}

export interface GraphArtifact {
  nodes?: GraphNode[];
  edges?: GraphEdge[];
}

interface GraphExpansionInput {
  root: string;
  records: IndexedKnowledgeRegion[];
  seeds: QueryHit[];
  limit: number;
  minScore?: number;
  queryTokens?: string[];
  artifact?: GraphArtifact | null;
}

interface NeighborCandidate {
  key: string;
  score: number;
  reason: string;
}

const MAX_GRAPH_DEPTH = 2;
const MAX_NEIGHBORS_PER_SEED = 24;

export async function expandKrGraph(input: GraphExpansionInput): Promise<QueryHit[]> {
  const artifact = input.artifact === undefined ? await readGraphArtifact(input.root) : input.artifact;

  if (!artifact || !Array.isArray(artifact.nodes) || !Array.isArray(artifact.edges) || input.seeds.length === 0) {
    return [];
  }

  const recordsByNode = new Map(input.records.map((record) => [krNodeKey(record.dkbId, record.id), record]));
  const adjacency = adjacencyFor(artifact.edges);
  const candidates = new Map<string, NeighborCandidate>();

  for (const seed of input.seeds) {
    const seedKey = krNodeKey(seed.dkbId, seed.id);

    if (!recordsByNode.has(seedKey)) {
      continue;
    }

    for (const candidate of graphCandidatesForSeed(seedKey, seed.score, adjacency)) {
      if (candidate.key === seedKey || !recordsByNode.has(candidate.key)) {
        continue;
      }

      const existing = candidates.get(candidate.key);

      if (!existing || candidate.score > existing.score) {
        candidates.set(candidate.key, candidate);
      }
    }
  }

  return [...candidates.values()]
    .filter((candidate) => candidate.score >= (input.minScore ?? defaultMinimumScore))
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    .slice(0, input.limit)
    .flatMap((candidate) => {
      const record = recordsByNode.get(candidate.key);

      if (!record) {
        throw new Error(`Graph candidate resolved to missing KR: ${candidate.key}`);
      }

      if (input.queryTokens && !shouldKeepGraphCandidate(record, candidate, input.queryTokens)) {
        return [];
      }

      return [{
        ...record,
        dkbId: record.dkbId,
        adapter: 'compose',
        score: candidate.score,
        retrievalPasses: ['graph'],
      }];
    });
}

export async function readGraphArtifact(root: string): Promise<GraphArtifact | null> {
  const graphPath = resolveFrom(root, KR_GRAPH_PATH);

  try {
    const parsed = JSON.parse(await fs.readFile(graphPath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as GraphArtifact : null;
  } catch {
    return null;
  }
}

function adjacencyFor(edges: GraphEdge[]): Map<string, Array<{ key: string; weight: number; type: string }>> {
  const adjacency = new Map<string, Array<{ key: string; weight: number; type: string }>>();

  for (const edge of edges) {
    if (typeof edge.source !== 'string' || typeof edge.target !== 'string') {
      continue;
    }

    const type = typeof edge.attributes?.type === 'string' ? edge.attributes.type : 'unknown';
    const similarity = typeof edge.attributes?.similarity === 'number' ? edge.attributes.similarity : undefined;
    const weight = graphWeight(type, similarity);

    if (weight <= 0) {
      continue;
    }

    appendNeighbor(adjacency, edge.source, edge.target, weight, type);
    appendNeighbor(adjacency, edge.target, edge.source, weight, reverseGraphType(type));
  }

  return adjacency;
}

function graphCandidatesForSeed(
  seedKey: string,
  seedScore: number,
  adjacency: Map<string, Array<{ key: string; weight: number; type: string }>>,
): NeighborCandidate[] {
  const queue: Array<{ key: string; depth: number; score: number; path: string[] }> = [{
    key: seedKey,
    depth: 0,
    score: seedScore,
    path: [],
  }];
  const bestVisited = new Map<string, number>([[seedKey, seedScore]]);
  const candidates = new Map<string, NeighborCandidate>();

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current || current.depth >= MAX_GRAPH_DEPTH) {
      continue;
    }

    for (const edge of (adjacency.get(current.key) ?? []).slice(0, MAX_NEIGHBORS_PER_SEED)) {
      if (edge.type === 'sibling' && seedScore >= 20) {
        continue;
      }

      if (current.path.at(-1) === 'parent' && edge.type === 'child') {
        continue;
      }

      const score = current.score * edge.weight;
      const existingScore = bestVisited.get(edge.key);

      if (existingScore !== undefined && existingScore >= score) {
        continue;
      }

      const path = [...current.path, edge.type];

      bestVisited.set(edge.key, score);
      queue.push({
        key: edge.key,
        depth: current.depth + 1,
        score,
        path,
      });

      if (edge.key.startsWith('kr:')) {
        const existing = candidates.get(edge.key);

        if (!existing || score > existing.score) {
          candidates.set(edge.key, {
            key: edge.key,
            score: Math.round(score),
            reason: path.join('>'),
          });
        }
      }
    }
  }

  return [...candidates.values()];
}

function appendNeighbor(
  adjacency: Map<string, Array<{ key: string; weight: number; type: string }>>,
  source: string,
  target: string,
  weight: number,
  type: string,
): void {
  const neighbors = adjacency.get(source) ?? [];

  neighbors.push({ key: target, weight, type });
  neighbors.sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
  adjacency.set(source, neighbors);
}

function graphWeight(type: string, similarity: number | undefined): number {
  if (type === 'semantic_neighbor') {
    return similarity && similarity >= 0.55 ? Math.min(0.95, similarity) : 0;
  }

  if (type === 'parent' || type === 'child') {
    return 0.85;
  }

  if (type === 'foreign_key' || type === 'reference' || type === 'related') {
    return 0.65;
  }

  if (type === 'sibling') {
    return 0.35;
  }

  if (type === 'path_ancestor') {
    return 0.2;
  }

  if (type === 'topic' || type === 'entity') {
    return 0;
  }

  return 0;
}

function reverseGraphType(type: string): string {
  if (type === 'child') {
    return 'parent';
  }

  if (type === 'parent') {
    return 'child';
  }

  return type;
}

function shouldKeepGraphCandidate(
  record: IndexedKnowledgeRegion,
  candidate: NeighborCandidate,
  queryTokens: string[],
): boolean {
  if (hasSufficientQueryCoverage(scoreRecord(record, queryTokens), queryTokens)) {
    return true;
  }

  return candidate.reason.split('>').some((type) => (
    type === 'foreign_key'
    || type === 'reference'
    || type === 'related'
    || type === 'semantic_neighbor'
  ));
}

function krNodeKey(dkbId: string, regionId: string): string {
  return `kr:${dkbId}/${regionId}`;
}
