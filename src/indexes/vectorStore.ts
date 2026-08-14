import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { stableHash } from '../contracts/hash.js';
import { DKB_ARTIFACTS_DIR } from '../protocol/paths.js';
import type { QueryHit } from '../protocol/types.js';
import { defaultMinimumScore, hasSufficientQueryCoverage, scoreRecord, tokenize } from '../router/scoring.js';
import type { IndexedKnowledgeRegion } from './knowledgeIndex.js';
import {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_VECTOR_DIMENSIONS,
  cosine,
  embedderBackendForEnvironment,
} from './embeddingBackend.js';

const LOCAL_ENGINE = 'dkb-local-hash';
const LANCEDB_ENGINE = 'lancedb';
const MEILI_ENGINE = 'meilisearch';
const SEMANTIC_EDGE_THRESHOLD = 0.18;
const QUERY_SCORE_THRESHOLD = 0.12;
const DEFAULT_MEILI_URL = 'http://127.0.0.1:7700';
const DEFAULT_SEMANTIC_RATIO = 0.5;
const DEFAULT_RANKING_SCORE_THRESHOLD = 0.15;

export interface VectorDocument {
  id: string;
  dkbId: string;
  regionId: string;
  recordId: string;
  title: string;
  summary: string;
  text: string;
  domains: string[];
  topics: string[];
  keywords: string[];
  entities: string[];
  aliases: string[];
  regionType: string;
  sourceType: string;
  updatedAt: string;
  sourceHash: string | null;
}

export interface SemanticNeighbor {
  sourceId: string;
  targetId: string;
  score: number;
}

export interface VectorArtifactBuild {
  krVectorPath: string;
  semanticNeighbors: SemanticNeighbor[];
  backend: SearchBackendDescription;
}

export interface SearchBackendDescription {
  engine: 'meilisearch' | 'lancedb' | 'dkb-local-hash';
  status: 'ready' | 'fallback' | 'unavailable';
  reason?: string;
  url?: string;
  path?: string;
  krIndexUid?: string;
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

export function vectorDocumentsFor(records: IndexedKnowledgeRegion[]): VectorDocument[] {
  return records.map((record) => ({
    id: `${record.dkbId}/${record.id}`,
    dkbId: record.dkbId,
    regionId: record.id,
    recordId: record.id,
    title: record.title,
    summary: record.content,
    text: [
      record.title,
      record.content,
      (record.keywords ?? []).join(' '),
      record.topics.join(' '),
      record.entities.join(' '),
      (record.aliases ?? []).join(' '),
      (record.ancestry ?? []).join(' '),
      record.grouping?.reason ?? '',
    ].join(' '),
    domains: [],
    topics: [...record.topics],
    keywords: [...(record.keywords ?? [])],
    entities: [...record.entities],
    aliases: [...(record.aliases ?? [])],
    regionType: record.regionType ?? 'unknown',
    sourceType: record.sourceRef?.type ?? 'unknown',
    updatedAt: record.updatedAt,
    sourceHash: record.sourceRef?.hash ?? null,
  }));
}

export async function writeSearchArtifacts(
  registryId: string,
  krVectorPath: string,
  records: IndexedKnowledgeRegion[],
): Promise<VectorArtifactBuild> {
  const documents = vectorDocumentsFor(records);
  const backend = searchBackendForEnvironment();
  const artifactRoot = path.dirname(krVectorPath);
  await removeLegacyLanceRoot(artifactRoot);
  const krSync = await backend.syncDocuments({ registryId, artifactRoot, documents });
  const backendDescription = krSync.engine === MEILI_ENGINE || krSync.engine === LANCEDB_ENGINE
    ? krSync
    : backend.describe();
  const semanticNeighbors = canBuildSemanticGraphEdges(backendDescription)
    ? await backend.semanticNeighbors({ registryId, artifactRoot, documents })
    : [];

  await writeVectorManifest(krVectorPath, registryId, documents, krSync);

  return {
    krVectorPath,
    semanticNeighbors,
    backend: backendDescription,
  };
}

function canBuildSemanticGraphEdges(backend: SearchBackendDescription): boolean {
  return backend.status === 'ready' && backend.embedder !== DEFAULT_EMBEDDING_MODEL;
}

export async function querySearchArtifact(
  registryId: string,
  records: IndexedKnowledgeRegion[],
  query: string,
  limit = records.length,
  artifactRoot = path.resolve(DKB_ARTIFACTS_DIR),
): Promise<QueryHit[]> {
  const documents = vectorDocumentsFor(records);

  return querySearchDocumentsArtifact(registryId, records, documents, query, limit, artifactRoot);
}

export async function querySearchDocumentsArtifact(
  registryId: string,
  records: IndexedKnowledgeRegion[],
  documents: VectorDocument[],
  query: string,
  limit = records.length,
  artifactRoot = path.resolve(DKB_ARTIFACTS_DIR),
): Promise<QueryHit[]> {
  const backend = searchBackendForEnvironment();
  const result = await backend.query({
    registryId,
    artifactRoot,
    documents,
    query,
    limit: Math.max(limit, records.length, 1),
  });
  const byTarget = new Map(records.map((record) => [`${record.dkbId}/${record.id}`, record]));
  const queryTokens = tokenize(query);
  const lexicalBoundedVector = result.trace.embedder === DEFAULT_EMBEDDING_MODEL;

  return result.hits
    .map((hit): QueryHit | null => {
      const record = byTarget.get(hit.id);

      if (!record) {
        return null;
      }

      const vectorScore = Math.round(hit.score * 12);
      const lexicalHit = scoreRecord(record, queryTokens);
      const lexicalScore = lexicalHit.score;
      const trustedVectorScore = lexicalBoundedVector ? Math.min(vectorScore, lexicalScore + 1) : vectorScore;
      const fusedScore = Math.max(trustedVectorScore, lexicalScore);

      if (fusedScore < defaultMinimumScore || (lexicalBoundedVector && !hasSufficientQueryCoverage(lexicalHit, queryTokens))) {
        return null;
      }

      return {
        ...record,
        dkbId: record.dkbId,
        adapter: 'compose',
        score: fusedScore,
        retrievalPasses: ['vector'],
      };
    })
    .filter((hit): hit is QueryHit => hit !== null);
}

export async function describeSearchBackend(artifactRoot?: string): Promise<SearchBackendHealth> {
  return searchBackendForEnvironment().health(artifactRoot);
}

export async function resetSearchBackend(registryId: string, artifactRoot?: string): Promise<{ kr: SearchBackendDescription }> {
  const backend = searchBackendForEnvironment();
  const kr = await backend.deleteIndex({ registryId, artifactRoot });

  return { kr };
}

export async function searchBackendQuery(input: {
  registryId: string;
  artifactRoot?: string;
  records: IndexedKnowledgeRegion[];
  query: string;
  limit?: number;
}): Promise<SearchQueryResult> {
  const documents = vectorDocumentsFor(input.records);

  return searchBackendForEnvironment().query({
    registryId: input.registryId,
    artifactRoot: input.artifactRoot ?? path.resolve(DKB_ARTIFACTS_DIR),
    documents,
    query: input.query,
    limit: input.limit ?? 10,
  });
}

export function searchBackendForEnvironment(): SearchIndexBackend {
  if (shouldUseLanceDb()) {
    return new LanceDbBackend();
  }

  if (shouldUseMeilisearch()) {
    return new MeilisearchBackend();
  }

  return new LocalHashSearchBackend();
}

function shouldUseLanceDb(): boolean {
  const engine = (process.env.DKB_SEARCH_ENGINE ?? 'lancedb').toLowerCase();

  return engine === 'embedded' || engine === 'lancedb';
}

function shouldUseMeilisearch(): boolean {
  const engine = (process.env.DKB_SEARCH_ENGINE ?? 'auto').toLowerCase();

  return engine === 'meilisearch' || (engine === 'auto' && Boolean(process.env.MEILI_URL));
}

function meiliUrl(): string {
  return process.env.MEILI_URL ?? DEFAULT_MEILI_URL;
}

function meiliApiKey(): string | undefined {
  return process.env.MEILI_MASTER_KEY || process.env.MEILI_API_KEY || undefined;
}

function indexUidFor(registryId: string): string {
  return `dkb_kr_${safeIndexPart(registryId)}`;
}

function safeIndexPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'local';
}

class LocalHashSearchBackend implements SearchIndexBackend {
  constructor(private readonly fallbackReason = 'Meilisearch is not configured; using deterministic local hash search.') {}

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
          regionId: '',
          recordId: '',
          title: '',
          summary: '',
          text: '',
          domains: '',
          topics: '',
          keywords: '',
          entities: '',
          aliases: '',
          regionType: '',
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
        krIndexUid: tableName,
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
          krIndexUid: tableName,
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
        krIndexUid: lanceTableNameFor(input.registryId),
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

class MeilisearchBackend implements SearchIndexBackend {
  describe(): SearchBackendDescription {
    return {
      engine: MEILI_ENGINE,
      status: 'ready',
      url: meiliUrl(),
      embedder: hasMeiliEmbedder() ? embedderName() : undefined,
      semanticRatio: hasMeiliEmbedder() ? semanticRatio() : 0,
      rankingScoreThreshold: rankingScoreThreshold(),
    };
  }

  async health(): Promise<SearchBackendHealth> {
    try {
      const client = await createMeiliClient();

      await client.health();

      return {
        engine: MEILI_ENGINE,
        status: 'ready',
        url: meiliUrl(),
      };
    } catch (error) {
      return {
        engine: MEILI_ENGINE,
        status: 'unavailable',
        url: meiliUrl(),
        reason: errorMessage(error),
      };
    }
  }

  async syncDocuments(input: { registryId: string; documents: VectorDocument[] }): Promise<SearchBackendDescription> {
    const uid = indexUidFor(input.registryId);

    try {
      const client = await createMeiliClient();

      await this.ensureIndex(client, uid);
      const index = client.index<SearchDocument>(uid);
      const settingsTask = await index.updateSettings(meiliSettings());

      await client.tasks.waitForTask(settingsTask, { timeout: 30000, interval: 100 });

      const deleteTask = await index.deleteAllDocuments();

      await client.tasks.waitForTask(deleteTask, { timeout: 30000, interval: 100 });

      if (input.documents.length > 0) {
        const addTask = await index.addDocuments(input.documents.map(searchDocumentFor), { primaryKey: 'id' });

        await client.tasks.waitForTask(addTask, { timeout: 60000, interval: 100 });
      }

      return {
        ...this.describe(),
        krIndexUid: uid,
      };
    } catch (error) {
      return {
        engine: MEILI_ENGINE,
        status: 'unavailable',
        url: meiliUrl(),
        reason: errorMessage(error),
      };
    }
  }

  async query(input: { registryId: string; documents: VectorDocument[]; query: string; limit: number }): Promise<SearchQueryResult> {
    const uid = indexUidFor(input.registryId);

    try {
      const client = await createMeiliClient();
      const index = client.index<SearchDocument>(uid);
      const response = await index.search<SearchDocument>(input.query, {
        limit: input.limit,
        showRankingScore: true,
        rankingScoreThreshold: rankingScoreThreshold(),
        hybrid: hasMeiliEmbedder() ? {
          embedder: embedderName(),
          semanticRatio: semanticRatio(),
        } : undefined,
      } as never);

      return {
        hits: response.hits.map((hit) => ({
          id: hit.id,
          score: typeof hit._rankingScore === 'number' ? hit._rankingScore : 0,
          source: MEILI_ENGINE,
        })),
        trace: {
          ...this.describe(),
          krIndexUid: uid,
        },
      };
    } catch (error) {
      return new LocalHashSearchBackend(`Meilisearch query failed: ${errorMessage(error)}`).query(input);
    }
  }

  async semanticNeighbors(input: { registryId: string; documents: VectorDocument[] }): Promise<SemanticNeighbor[]> {
    if (!hasMeiliEmbedder()) {
      return localSemanticNeighbors(input.documents);
    }

    const uid = indexUidFor(input.registryId);

    try {
      const client = await createMeiliClient();
      const index = client.index<SearchDocument>(uid);
      const edges = new Map<string, SemanticNeighbor>();

      for (const document of input.documents) {
        const response = await index.search<SearchDocument>(document.text, {
          limit: Math.min(input.documents.length, 8),
          showRankingScore: true,
          rankingScoreThreshold: SEMANTIC_EDGE_THRESHOLD,
          hybrid: {
            embedder: embedderName(),
            semanticRatio: 1,
          },
        } as never);

        for (const hit of response.hits) {
          if (hit.id === document.id) {
            continue;
          }

          const score = typeof hit._rankingScore === 'number' ? hit._rankingScore : 0;

          if (score < SEMANTIC_EDGE_THRESHOLD) {
            continue;
          }

          const [left, right] = [document.id, hit.id].sort((a, b) => a.localeCompare(b));
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
    } catch {
      return localSemanticNeighbors(input.documents);
    }
  }

  async deleteIndex(input: { registryId: string }): Promise<SearchBackendDescription> {
    const uid = indexUidFor(input.registryId);

    try {
      const client = await createMeiliClient();

      await client.deleteIndexIfExists(uid);

      return {
        ...this.describe(),
        krIndexUid: uid,
      };
    } catch (error) {
      return {
        engine: MEILI_ENGINE,
        status: 'unavailable',
        url: meiliUrl(),
        reason: errorMessage(error),
      };
    }
  }

  private async ensureIndex(client: MeiliClient, uid: string): Promise<void> {
    try {
      await client.getIndex(uid);
    } catch {
      const task = await client.createIndex(uid, { primaryKey: 'id' });

      await client.tasks.waitForTask(task, { timeout: 30000, interval: 100 });
    }
  }
}

type MeiliClient = InstanceType<(typeof import('meilisearch'))['MeiliSearch']>;

async function createMeiliClient(): Promise<MeiliClient> {
  const { MeiliSearch } = await import('meilisearch');

  return new MeiliSearch({
    host: meiliUrl(),
    apiKey: meiliApiKey(),
  });
}

interface LanceSearchRow {
  id?: unknown;
  _distance?: unknown;
}

interface SearchDocument {
  id: string;
  dkbId: string;
  regionId: string;
  recordId: string;
  title: string;
  summary: string;
  text: string;
  domains: string[];
  topics: string[];
  keywords: string[];
  entities: string[];
  aliases: string[];
  regionType: string;
  sourceType: string;
  updatedAt: string;
  sourceHash: string | null;
  _rankingScore?: number;
}

function lanceRootFor(artifactRoot: string): string {
  return process.env.DKB_VECTOR_PATH
    ? path.resolve(process.env.DKB_VECTOR_PATH)
    : path.join(artifactRoot, 'kr.index.vector.lance');
}

async function removeLegacyLanceRoot(artifactRoot: string): Promise<void> {
  if (process.env.DKB_VECTOR_PATH) {
    return;
  }

  await fs.rm(path.join(artifactRoot, 'vector.lance'), { recursive: true, force: true });
}

function lanceTableNameFor(registryId: string): string {
  return `kr_${safeIndexPart(registryId)}`;
}

function searchDocumentFor(document: VectorDocument): SearchDocument {
  return {
    id: document.id,
    dkbId: document.dkbId,
    regionId: document.regionId,
    recordId: document.recordId,
    title: document.title,
    summary: document.summary,
    text: document.text,
    domains: document.domains,
    topics: document.topics,
    keywords: document.keywords,
    entities: document.entities,
    aliases: document.aliases,
    regionType: document.regionType,
    sourceType: document.sourceType,
    updatedAt: document.updatedAt,
    sourceHash: document.sourceHash,
  };
}

function lanceDocumentFor(document: VectorDocument): Omit<SearchDocument, 'domains' | 'topics' | 'keywords' | 'entities' | 'aliases' | 'sourceHash'> & {
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
    regionId: document.regionId,
    recordId: document.recordId,
    title: document.title,
    summary: document.summary,
    text: document.text,
    domains: document.domains.join(' '),
    topics: document.topics.join(' '),
    keywords: document.keywords.join(' '),
    entities: document.entities.join(' '),
    aliases: document.aliases.join(' '),
    regionType: document.regionType,
    sourceType: document.sourceType,
    updatedAt: document.updatedAt,
    sourceHash: document.sourceHash ?? '',
  };
}

function meiliSettings(): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    searchableAttributes: ['title', 'summary', 'keywords', 'topics', 'entities', 'aliases', 'text'],
    filterableAttributes: ['dkbId', 'regionId', 'recordId', 'sourceType', 'regionType', 'updatedAt'],
    sortableAttributes: ['updatedAt'],
    displayedAttributes: [
      'id',
      'dkbId',
      'regionId',
      'recordId',
      'title',
      'summary',
      'topics',
      'entities',
      'aliases',
      'regionType',
      'sourceType',
      'updatedAt',
      'sourceHash',
    ],
  };
  const source = process.env.DKB_MEILI_EMBEDDER_SOURCE ?? '';

  if (source) {
    settings.embedders = {
      [embedderName()]: embedderConfig(source),
    };
  }

  return settings;
}

function embedderConfig(source: string): Record<string, unknown> {
  if (source === 'ollama') {
    return {
      source: 'ollama',
      model: process.env.DKB_MEILI_EMBEDDER_MODEL ?? 'nomic-embed-text',
      url: process.env.DKB_MEILI_EMBEDDER_URL ?? 'http://host.docker.internal:11434/api/embeddings',
      documentTemplate: "{{doc.title}} {{doc.summary}} {{doc.topics}} {{doc.entities}} {{doc.aliases}}",
    };
  }

  if (source === 'huggingFace') {
    return {
      source: 'huggingFace',
      model: process.env.DKB_MEILI_EMBEDDER_MODEL ?? 'BAAI/bge-base-en-v1.5',
      documentTemplate: "{{doc.title}} {{doc.summary}} {{doc.topics}} {{doc.entities}} {{doc.aliases}}",
    };
  }

  if (source === 'rest') {
    return {
      source: 'rest',
      url: process.env.DKB_MEILI_EMBEDDER_URL,
      request: {
        input: '{{text}}',
      },
      response: {
        data: [
          {
            embedding: '{{embedding}}',
          },
        ],
      },
      dimensions: Number(process.env.DKB_MEILI_EMBEDDER_DIMENSIONS ?? 768),
      documentTemplate: "{{doc.title}} {{doc.summary}} {{doc.topics}} {{doc.entities}} {{doc.aliases}}",
    };
  }

  return {
    source,
    model: process.env.DKB_MEILI_EMBEDDER_MODEL,
    documentTemplate: "{{doc.title}} {{doc.summary}} {{doc.topics}} {{doc.entities}} {{doc.aliases}}",
  };
}

function embedderName(): string {
  return process.env.DKB_MEILI_EMBEDDER_NAME ?? 'dkb-local';
}

function hasMeiliEmbedder(): boolean {
  return Boolean(process.env.DKB_MEILI_EMBEDDER_SOURCE);
}

function semanticRatio(): number {
  return boundedNumber(process.env.DKB_MEILI_SEMANTIC_RATIO, DEFAULT_SEMANTIC_RATIO, 0, 1);
}

function rankingScoreThreshold(): number {
  return boundedNumber(process.env.DKB_MEILI_RANKING_SCORE_THRESHOLD, DEFAULT_RANKING_SCORE_THRESHOLD, 0, 1);
}

function boundedNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
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
    artifactType: 'kr',
    registryId,
    indexUid: backend.krIndexUid ?? indexUidFor(registryId),
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
      regionId: document.regionId,
      title: document.title,
      regionType: document.regionType,
      sourceType: document.sourceType,
      textHash: stableTextHash(document.text),
    })),
  }, null, 2)}\n`, 'utf8');
}

function scoreVectorDocument(document: VectorDocument, queryTokens: string[]): number {
  return scoreRecord({
    id: document.regionId,
    title: document.title,
    content: document.summary,
    source: document.id,
    topics: document.topics,
    keywords: document.keywords,
    entities: document.entities,
    aliases: document.aliases,
    updatedAt: document.updatedAt,
  }, queryTokens).score;
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
