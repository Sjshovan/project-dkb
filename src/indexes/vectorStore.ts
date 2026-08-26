import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { stableHash } from '../contracts/hash.js';
import { DKB_ARTIFACTS_DIR } from '../protocol/paths.js';
import { tokenize } from '../router/scoring.js';
import type { IndexedSourceUnit } from './sourceIndex.js';
import {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_VECTOR_DIMENSIONS,
  cosine,
  embedderBackendForEnvironment,
} from './embeddingBackend.js';

const LOCAL_ENGINE = 'dkb-local-hash';
const LANCEDB_ENGINE = 'lancedb';
const SEMANTIC_EDGE_THRESHOLD = 0.18;
const QUERY_SCORE_THRESHOLD = 0.12;

export interface VectorDocument {
  id: string;
  packageId?: string;
  packageVersion?: string;
  dkbId: string;
  recordId: string;
  title: string;
  summary: string;
  text: string;
  domains: string[];
  topics: string[];
  keywords: string[];
  entities: string[];
  aliases: string[];
  sourceType: string;
  updatedAt: string;
  sourceHash: string | null;
  /** Compiler-produced vector. The runtime must never create a replacement. */
  embedding?: number[];
}

export interface SemanticNeighbor {
  sourceId: string;
  targetId: string;
  score: number;
}

export interface VectorArtifactBuild {
  vectorPath: string;
  semanticNeighbors: SemanticNeighbor[];
  backend: SearchBackendDescription;
}

export interface SearchBackendDescription {
  engine: 'lancedb' | 'dkb-local-hash';
  status: 'ready' | 'fallback' | 'unavailable';
  reason?: string;
  url?: string;
  path?: string;
  indexUid?: string;
  embedder?: string;
  semanticRatio?: number;
  rankingScoreThreshold?: number;
}

export interface SearchBackendHealth {
  engine: SearchBackendDescription['engine'];
  status: 'ready' | 'fallback' | 'unavailable';
  url?: string;
  reason?: string;
}

export interface SearchQueryResult {
  hits: Array<{
    id: string;
    score: number;
    source: string;
  }>;
  trace: SearchBackendDescription;
}

export interface SearchIndexBackend {
  describe(): SearchBackendDescription;
  health(artifactRoot?: string): Promise<SearchBackendHealth>;
  syncDocuments(input: {
    registryId: string;
    artifactRoot: string;
    documents: VectorDocument[];
  }): Promise<SearchBackendDescription>;
  query(input: {
    registryId: string;
    artifactRoot: string;
    documents: VectorDocument[];
    query: string;
    limit: number;
    lexicalQueries?: string[];
  }): Promise<SearchQueryResult>;
  semanticNeighbors(input: {
    registryId: string;
    artifactRoot: string;
    documents: VectorDocument[];
  }): Promise<SemanticNeighbor[]>;
  deleteIndex(input: {
    registryId: string;
    artifactRoot?: string;
  }): Promise<SearchBackendDescription>;
}

/**
 * The runtime's canonical search document. A source chunk is the unit that
 * was compiled, embedded, installed and cited.
 */
export function vectorDocumentsForSourceUnits(units: IndexedSourceUnit[]): VectorDocument[] {
  return units.map((unit) => ({
    id: unit.id,
    dkbId: unit.dkbId,
    recordId: unit.id,
    title: unit.title,
    summary: unit.text,
    text: [unit.title, unit.text, unit.keywords.join(' ')].join(' '),
    domains: [],
    topics: [],
    keywords: [...unit.keywords],
    entities: [],
    aliases: [],
    sourceType: unit.type,
    updatedAt: unit.updatedAt,
    sourceHash: unit.hash,
  }));
}

export async function querySearchDocuments(
  registryId: string,
  documents: VectorDocument[],
  query: string,
  limit: number,
  artifactRoot = path.resolve(DKB_ARTIFACTS_DIR),
  lexicalQueries: string[] = [],
): Promise<SearchQueryResult> {
  return searchBackendForEnvironment().query({
    registryId,
    artifactRoot,
    documents,
    query,
    limit: Math.max(limit, 1),
    lexicalQueries,
  });
}

export async function writeSearchArtifacts(
  registryId: string,
  vectorPath: string,
  documents: VectorDocument[],
): Promise<VectorArtifactBuild> {
  const backend = searchBackendForEnvironment();
  const artifactRoot = path.dirname(vectorPath);
  await removeLegacyLanceRoot(artifactRoot);
  const sync = await backend.syncDocuments({ registryId, artifactRoot, documents });
  const backendDescription = sync.engine === LANCEDB_ENGINE
    ? sync
    : backend.describe();
  const semanticNeighbors = canBuildSemanticGraphEdges(backendDescription)
    ? await backend.semanticNeighbors({ registryId, artifactRoot, documents })
    : [];

  await writeVectorManifest(vectorPath, registryId, documents, sync);

  return {
    vectorPath,
    semanticNeighbors,
    backend: backendDescription,
  };
}

function canBuildSemanticGraphEdges(backend: SearchBackendDescription): boolean {
  return backend.status === 'ready' && backend.embedder !== DEFAULT_EMBEDDING_MODEL;
}

export async function describeSearchBackend(artifactRoot?: string): Promise<SearchBackendHealth> {
  return searchBackendForEnvironment().health(artifactRoot);
}

export async function resetSearchBackend(registryId: string, artifactRoot?: string): Promise<{ chunks: SearchBackendDescription }> {
  const backend = searchBackendForEnvironment();
  const chunks = await backend.deleteIndex({ registryId, artifactRoot });

  return { chunks };
}

export async function searchBackendQuery(input: {
  registryId: string;
  artifactRoot?: string;
  documents: VectorDocument[];
  query: string;
  limit?: number;
  lexicalQueries?: string[];
}): Promise<SearchQueryResult> {
  return searchBackendForEnvironment().query({
    registryId: input.registryId,
    artifactRoot: input.artifactRoot ?? path.resolve(DKB_ARTIFACTS_DIR),
    documents: input.documents,
    query: input.query,
    limit: input.limit ?? 10,
    lexicalQueries: input.lexicalQueries ?? [],
  });
}

export function searchBackendForEnvironment(): SearchIndexBackend {
  return new LanceDbBackend();
}

function indexUidFor(registryId: string): string {
  return `dkb_chunks_${safeIndexPart(registryId)}`;
}

function safeIndexPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'local';
}

class LocalHashSearchBackend implements SearchIndexBackend {
  constructor(private readonly fallbackReason = 'LanceDB is unavailable; using deterministic local hash search.') {}

  describe(): SearchBackendDescription {
    return {
      engine: LOCAL_ENGINE,
      status: 'fallback',
      embedder: DEFAULT_EMBEDDING_MODEL,
      reason: this.fallbackReason,
    };
  }

  async health(): Promise<SearchBackendHealth> {
    return this.describe();
  }

  async syncDocuments(): Promise<SearchBackendDescription> {
    return this.describe();
  }

  async query(input: { documents: VectorDocument[]; query: string; limit: number }): Promise<SearchQueryResult> {
    const tokens = tokenize(input.query);
    const embedder = embedderBackendForEnvironment();
    const queryVector = await embedder.embedText(input.query);
    const documentVectors = await embedder.embedBatch(input.documents.map((document) => document.text));
    const hits = input.documents
      .map((document, index) => {
        const lexical = scoreVectorDocument(document, tokens);
        const semantic = cosine(queryVector, documentVectors[index] ?? []);
        const score = Math.max(lexical / 12, semantic);

        return {
          id: document.id,
          score,
          source: LOCAL_ENGINE,
        };
      })
      .filter((hit) => hit.score >= QUERY_SCORE_THRESHOLD)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, input.limit);

    return {
      hits,
      trace: this.describe(),
    };
  }

  async semanticNeighbors(input: { documents: VectorDocument[] }): Promise<SemanticNeighbor[]> {
    return localSemanticNeighbors(input.documents);
  }

  async deleteIndex(): Promise<SearchBackendDescription> {
    return this.describe();
  }
}

class LanceDbBackend implements SearchIndexBackend {
  describe(): SearchBackendDescription {
    return {
      engine: LANCEDB_ENGINE,
      status: 'ready',
      embedder: DEFAULT_EMBEDDING_MODEL,
      path: undefined,
      reason: 'Embedded LanceDB vector storage is active with deterministic local hash embeddings. ONNX embedding support is intentionally isolated until an audit-clean package path is available.',
    };
  }

  async health(artifactRoot?: string): Promise<SearchBackendHealth> {
    try {
      const lancedb = await import('@lancedb/lancedb');
      const root = lanceRootFor(artifactRoot ?? path.resolve(DKB_ARTIFACTS_DIR));

      await fs.mkdir(root, { recursive: true });
      await lancedb.connect(root);

      return {
        engine: LANCEDB_ENGINE,
        status: 'ready',
        url: root,
      };
    } catch (error) {
      return {
        engine: LANCEDB_ENGINE,
        status: 'unavailable',
        reason: errorMessage(error),
      };
    }
  }

  async syncDocuments(input: { registryId: string; artifactRoot: string; documents: VectorDocument[] }): Promise<SearchBackendDescription> {
    try {
      const lancedb = await import('@lancedb/lancedb');
      const root = lanceRootFor(input.artifactRoot);
      const tableName = lanceTableNameFor(input.registryId);
      const embedder = embedderBackendForEnvironment();
      const vectors = await embedder.embedBatch(input.documents.map((document) => document.text));
      const rows = input.documents.map((document, index) => ({
        ...lanceDocumentFor(document),
        vector: vectors[index] ?? new Array<number>(DEFAULT_VECTOR_DIMENSIONS).fill(0),
      }));

      await fs.mkdir(root, { recursive: true });

      const database = await lancedb.connect(root);

      if (rows.length === 0) {
        await database.createTable(tableName, [{
          id: '__empty__',
          vector: new Array<number>(DEFAULT_VECTOR_DIMENSIONS).fill(0),
          dkbId: '',
          recordId: '',
          title: '',
          summary: '',
          text: '',
          domains: '',
          topics: '',
          keywords: '',
          entities: '',
          aliases: '',
          sourceType: '',
          updatedAt: '',
          sourceHash: '',
        }], { mode: 'overwrite' });
      } else {
        await database.createTable(tableName, rows, { mode: 'overwrite' });
      }

      return {
        ...this.describe(),
        path: root,
        indexUid: tableName,
      };
    } catch (error) {
      return {
        engine: LANCEDB_ENGINE,
        status: 'unavailable',
        path: lanceRootFor(input.artifactRoot),
        reason: errorMessage(error),
      };
    }
  }

  async query(input: { registryId: string; artifactRoot: string; documents: VectorDocument[]; query: string; limit: number }): Promise<SearchQueryResult> {
    try {
      const lancedb = await import('@lancedb/lancedb');
      const root = lanceRootFor(input.artifactRoot);
      const tableName = lanceTableNameFor(input.registryId);
      const embedder = embedderBackendForEnvironment();
      const database = await lancedb.connect(root);
      const table = await database.openTable(tableName);
      const rows = await (table
        .search(await embedder.embedText(input.query)) as unknown as {
          distanceType(type: 'cosine'): {
            limit(limit: number): {
              toArray(): Promise<LanceSearchRow[]>;
            };
          };
        })
        .distanceType('cosine')
        .limit(input.limit)
        .toArray();

      const hits = rows
        .filter((row) => row.id !== '__empty__')
        .map((row) => ({
          id: String(row.id),
          score: distanceToSimilarity(Number(row._distance ?? 1)),
          source: LANCEDB_ENGINE,
        }))
        .filter((hit) => hit.score >= QUERY_SCORE_THRESHOLD)
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

      return {
        hits,
        trace: {
          ...this.describe(),
          path: root,
          indexUid: tableName,
        },
      };
    } catch (error) {
      return new LocalHashSearchBackend(`LanceDB query failed: ${errorMessage(error)}`).query(input);
    }
  }

  async semanticNeighbors(input: { artifactRoot: string; documents: VectorDocument[] }): Promise<SemanticNeighbor[]> {
    return localSemanticNeighbors(input.documents);
  }

  async deleteIndex(input: { registryId: string; artifactRoot?: string }): Promise<SearchBackendDescription> {
    const root = lanceRootFor(input.artifactRoot ?? path.resolve(DKB_ARTIFACTS_DIR));

    try {
      const lancedb = await import('@lancedb/lancedb');
      const database = await lancedb.connect(root);

      try {
        await database.dropTable(lanceTableNameFor(input.registryId));
      } catch {
        // Dropping is best-effort because older LanceDB versions do not expose
        // ignoreMissing in the JavaScript API.
      }

      return {
        ...this.describe(),
        path: root,
        indexUid: lanceTableNameFor(input.registryId),
      };
    } catch (error) {
      return {
        engine: LANCEDB_ENGINE,
        status: 'unavailable',
        path: root,
        reason: errorMessage(error),
      };
    }
  }
}

interface LanceSearchRow {
  id?: unknown;
  _distance?: unknown;
}

interface LanceSearchDocument {
  id: string;
  dkbId: string;
  recordId: string;
  title: string;
  summary: string;
  text: string;
  domains: string[];
  topics: string[];
  keywords: string[];
  entities: string[];
  aliases: string[];
  sourceType: string;
  updatedAt: string;
  sourceHash: string | null;
}

function lanceRootFor(artifactRoot: string): string {
  return process.env.DKB_VECTOR_PATH
    ? path.resolve(process.env.DKB_VECTOR_PATH)
    : path.join(artifactRoot, 'chunk.index.vector.lance');
}

async function removeLegacyLanceRoot(artifactRoot: string): Promise<void> {
  if (process.env.DKB_VECTOR_PATH) {
    return;
  }

  await fs.rm(path.join(artifactRoot, 'vector.lance'), { recursive: true, force: true });
}

function lanceTableNameFor(registryId: string): string {
  return `chunks_${safeIndexPart(registryId)}`;
}

function lanceDocumentFor(document: VectorDocument): Omit<LanceSearchDocument, 'domains' | 'topics' | 'keywords' | 'entities' | 'aliases' | 'sourceHash'> & {
  domains: string;
  topics: string;
  keywords: string;
  entities: string;
  aliases: string;
  sourceHash: string;
} {
  return {
    id: document.id,
    dkbId: document.dkbId,
    recordId: document.recordId,
    title: document.title,
    summary: document.summary,
    text: document.text,
    domains: document.domains.join(' '),
    topics: document.topics.join(' '),
    keywords: document.keywords.join(' '),
    entities: document.entities.join(' '),
    aliases: document.aliases.join(' '),
    sourceType: document.sourceType,
    updatedAt: document.updatedAt,
    sourceHash: document.sourceHash ?? '',
  };
}

async function writeVectorManifest(
  target: string,
  registryId: string,
  documents: VectorDocument[],
  backend: SearchBackendDescription,
): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
  await fs.writeFile(target, `${JSON.stringify({
    engine: backend.engine,
    status: backend.status,
    reason: backend.reason,
    artifactType: 'chunks',
    registryId,
    indexUid: backend.indexUid ?? indexUidFor(registryId),
    artifactPath: backend.path,
    embedder: backend.embedder,
    semanticRatio: backend.semanticRatio,
    rankingScoreThreshold: backend.rankingScoreThreshold,
    dimensions: backend.engine === LOCAL_ENGINE || backend.engine === LANCEDB_ENGINE ? DEFAULT_VECTOR_DIMENSIONS : undefined,
    documentCount: documents.length,
    sourceHash: stableHash(documents.map((document) => ({
      id: document.id,
      sourceHash: document.sourceHash,
      textHash: stableTextHash(document.text),
    }))),
    documents: documents.map((document) => ({
      id: document.id,
      dkbId: document.dkbId,
      recordId: document.recordId,
      title: document.title,
      sourceType: document.sourceType,
      textHash: stableTextHash(document.text),
    })),
  }, null, 2)}\n`, 'utf8');
}

function scoreVectorDocument(document: VectorDocument, queryTokens: string[]): number {
  const text = [
    document.title,
    document.summary,
    document.text,
    document.keywords.join(' '),
    document.topics.join(' '),
  ].join(' ').toLowerCase();
  const tokens = new Set(tokenize(text));

  return queryTokens.filter((token) => tokens.has(token)).length;
}

async function localSemanticNeighbors(documents: VectorDocument[]): Promise<SemanticNeighbor[]> {
  const edges = new Map<string, SemanticNeighbor>();
  const embedder = embedderBackendForEnvironment();
  const embedded = await embedder.embedBatch(documents.map((document) => document.text));
  const vectors = new Map(documents.map((document, index) => [document.id, embedded[index] ?? []]));

  for (const document of documents) {
    const vector = vectors.get(document.id) ?? [];

    for (const target of documents) {
      if (target.id === document.id) {
        continue;
      }

      const score = cosine(vector, vectors.get(target.id) ?? []);

      if (score < SEMANTIC_EDGE_THRESHOLD) {
        continue;
      }

      const [left, right] = [document.id, target.id].sort((a, b) => a.localeCompare(b));
      const key = `${left}->${right}`;
      const existing = edges.get(key);

      if (!existing || score > existing.score) {
        edges.set(key, {
          sourceId: left,
          targetId: right,
          score: roundScore(score),
        });
      }
    }
  }

  return [...edges.values()].sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId) || a.targetId.localeCompare(b.targetId));
}

function distanceToSimilarity(distance: number): number {
  if (!Number.isFinite(distance)) {
    return 0;
  }

  return Math.max(0, Math.min(1, 1 - distance / 2));
}


function stableTextHash(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function roundScore(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
