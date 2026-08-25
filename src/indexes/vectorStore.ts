import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
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
const MEILI_ENGINE = 'meilisearch';
const SEMANTIC_EDGE_THRESHOLD = 0.18;
const QUERY_SCORE_THRESHOLD = 0.12;
const DEFAULT_MEILI_URL = 'http://127.0.0.1:7700';
const DEFAULT_SEMANTIC_RATIO = 0.5;
const DEFAULT_RANKING_SCORE_THRESHOLD = 0.15;

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

export interface PackageSearchMutationResult {
  backend: SearchBackendDescription;
  documentCount: number;
  taskUid?: number;
  timingsMs: {
    total: number;
    ensureIndex: number;
    taskWait: number;
    verify: number;
  };
}

export interface SearchBackendDescription {
  engine: 'meilisearch' | 'lancedb' | 'dkb-local-hash';
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

export async function upsertSearchPackage(input: {
  registryId: string;
  artifactRoot?: string;
  dkbId: string;
  packageVersion: string;
  documents: VectorDocument[];
}): Promise<PackageSearchMutationResult> {
  const backend = searchBackendForEnvironment();

  if (backend instanceof MeilisearchBackend) {
    return backend.upsertPackage(input);
  }

  return {
    backend: backend.describe(),
    documentCount: input.documents.length,
    timingsMs: { total: 0, ensureIndex: 0, taskWait: 0, verify: 0 },
  };
}

export async function deleteSearchPackage(input: {
  registryId: string;
  artifactRoot?: string;
  dkbId: string;
  packageVersion: string;
  documents?: VectorDocument[];
}): Promise<PackageSearchMutationResult> {
  const backend = searchBackendForEnvironment();

  if (backend instanceof MeilisearchBackend) {
    return backend.deletePackage(input);
  }

  return {
    backend: backend.describe(),
    documentCount: 0,
    timingsMs: { total: 0, ensureIndex: 0, taskWait: 0, verify: 0 },
  };
}

export async function countSearchPackageDocuments(input: {
  registryId: string;
  dkbId: string;
  packageVersion: string;
  documents?: VectorDocument[];
}): Promise<number> {
  const backend = searchBackendForEnvironment();

  return backend instanceof MeilisearchBackend
    ? backend.countPackageDocuments(input)
    : 0;
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
  const backendDescription = sync.engine === MEILI_ENGINE || sync.engine === LANCEDB_ENGINE
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
  return `dkb_chunks_${safeIndexPart(registryId)}`;
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
        indexUid: uid,
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

  async upsertPackage(input: {
    registryId: string;
    dkbId: string;
    packageVersion: string;
    documents: VectorDocument[];
  }): Promise<PackageSearchMutationResult> {
    const started = performance.now();
    const uid = indexUidFor(input.registryId);
    const client = await createMeiliClient();
    const ensureStart = performance.now();

    await this.ensureIndex(client, uid);
    const ensureDone = performance.now();
    const index = client.index<SearchDocument>(uid);
    let taskUid: number | undefined;
    let taskWaitMs = 0;

    if (input.documents.length > 0) {
      const task = await index.addDocuments(input.documents.map((document) => packageSearchDocumentFor(document, input.dkbId, input.packageVersion)), { primaryKey: 'id' });
      const waitStarted = performance.now();

      taskUid = task.taskUid;
      await client.tasks.waitForTask(task, { timeout: 60000, interval: 100 });
      taskWaitMs = performance.now() - waitStarted;
    }

    const verifyStart = performance.now();
    const documentCount = await this.countPackageDocuments({
      registryId: input.registryId,
      dkbId: input.dkbId,
      packageVersion: input.packageVersion,
      documents: input.documents,
    });
    const verifyMs = performance.now() - verifyStart;

    if (documentCount !== input.documents.length) {
      throw new Error(`Meilisearch package upsert verification failed for ${input.dkbId}@${input.packageVersion}: expected ${input.documents.length}, got ${documentCount}`);
    }

    return {
      backend: {
        ...this.describe(),
        indexUid: uid,
      },
      documentCount,
      taskUid,
      timingsMs: {
        total: roundMs(performance.now() - started),
        ensureIndex: roundMs(ensureDone - ensureStart),
        taskWait: roundMs(taskWaitMs),
        verify: roundMs(verifyMs),
      },
    };
  }

  async deletePackage(input: {
    registryId: string;
    dkbId: string;
    packageVersion: string;
    documents?: VectorDocument[];
  }): Promise<PackageSearchMutationResult> {
    const started = performance.now();
    const uid = indexUidFor(input.registryId);
    const client = await createMeiliClient();
    const ensureStart = performance.now();

    await this.ensureIndex(client, uid);
    const ensureDone = performance.now();
    const index = client.index<SearchDocument>(uid);
    const documentIds = input.documents?.map((document) => packageSearchDocumentFor(document, input.dkbId, input.packageVersion).id);
    const task = documentIds
      ? await index.deleteDocuments(documentIds)
      : await index.deleteDocuments({
          filter: packageFilter(input.dkbId, input.packageVersion),
        } as never);
    const waitStarted = performance.now();

    await client.tasks.waitForTask(task, { timeout: 60000, interval: 100 });
    const taskWaitMs = performance.now() - waitStarted;
    const verifyStart = performance.now();
    const documentCount = await this.countPackageDocuments(input);
    const verifyMs = performance.now() - verifyStart;

    if (documentCount !== 0) {
      throw new Error(`Meilisearch package delete verification failed for ${input.dkbId}@${input.packageVersion}: ${documentCount} documents remain`);
    }

    return {
      backend: {
        ...this.describe(),
        indexUid: uid,
      },
      documentCount,
      taskUid: task.taskUid,
      timingsMs: {
        total: roundMs(performance.now() - started),
        ensureIndex: roundMs(ensureDone - ensureStart),
        taskWait: roundMs(taskWaitMs),
        verify: roundMs(verifyMs),
      },
    };
  }

  async countPackageDocuments(input: {
    registryId: string;
    dkbId: string;
    packageVersion: string;
    documents?: VectorDocument[];
  }): Promise<number> {
    const client = await createMeiliClient();
    const index = client.index<SearchDocument>(indexUidFor(input.registryId));

    if (input.documents) {
      const ids = input.documents.map((document) => packageSearchDocumentFor(document, input.dkbId, input.packageVersion).id);
      const results = await Promise.all(ids.map((id) => index.getDocument(id).then(() => true, () => false)));

      return results.filter(Boolean).length;
    }

    const response = await index.search('', {
      limit: 0,
      filter: packageFilter(input.dkbId, input.packageVersion),
    } as never) as { estimatedTotalHits?: number };

    return Number(response.estimatedTotalHits ?? 0);
  }

  async query(input: { registryId: string; documents: VectorDocument[]; query: string; limit: number; lexicalQueries?: string[] }): Promise<SearchQueryResult> {
    const uid = indexUidFor(input.registryId);

    try {
      const client = await createMeiliClient();
      const index = client.index<SearchDocument>(uid);
      const queryVector = isUserProvidedEmbedder() ? await embedQuery(input.query) : undefined;
      const vectorResponse = await index.search<SearchDocument>(input.query, {
        limit: input.limit,
        showRankingScore: true,
        rankingScoreThreshold: rankingScoreThreshold(),
        hybrid: hasMeiliEmbedder() ? {
          embedder: embedderName(),
          semanticRatio: semanticRatio(),
        } : undefined,
        vector: queryVector,
      } as never);
      const lexicalQueries = hasMeiliEmbedder() ? uniqueLexicalQueries([input.query, ...(input.lexicalQueries ?? [])]) : [];
      const lexicalResponses = await Promise.all(lexicalQueries.map((lexicalQuery) => index.search<SearchDocument>(lexicalQuery, {
            limit: input.limit,
            showRankingScore: true,
            rankingScoreThreshold: rankingScoreThreshold(),
          } as never)));
      const hits = mergeMeiliHits([
        ...vectorResponse.hits,
        ...lexicalResponses.flatMap((response) => response.hits),
      ], input.limit);

      return {
        hits: hits.map((hit) => ({
          id: typeof hit.canonicalId === 'string' ? hit.canonicalId : canonicalMeiliDocumentId(hit.id),
          score: typeof hit._rankingScore === 'number' ? hit._rankingScore : 0,
          source: MEILI_ENGINE,
        })),
        trace: {
          ...this.describe(),
          indexUid: uid,
        },
      };
    } catch (error) {
      return {
        hits: [],
        trace: {
          engine: MEILI_ENGINE,
          status: 'unavailable',
          url: meiliUrl(),
          indexUid: uid,
          reason: `Meilisearch query failed: ${errorMessage(error)}`,
        },
      };
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
          const hitId = canonicalMeiliDocumentId(hit.id);

          if (hitId === document.id) {
            continue;
          }

          const score = typeof hit._rankingScore === 'number' ? hit._rankingScore : 0;

          if (score < SEMANTIC_EDGE_THRESHOLD) {
            continue;
          }

          const [left, right] = [document.id, hitId].sort((a, b) => a.localeCompare(b));
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
        indexUid: uid,
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
      const index = client.index<SearchDocument>(uid);
      const settingsTask = await index.updateSettings(meiliSettings());

      await client.tasks.waitForTask(settingsTask, { timeout: 30000, interval: 100 });
    }
  }
}

function mergeMeiliHits(hits: SearchDocument[], limit: number): SearchDocument[] {
  const byId = new Map<string, SearchDocument>();

  for (const hit of hits) {
    const id = typeof hit.canonicalId === 'string' ? hit.canonicalId : canonicalMeiliDocumentId(hit.id);
    const existing = byId.get(id);

    if (!existing || Number(hit._rankingScore ?? 0) > Number(existing._rankingScore ?? 0)) {
      byId.set(id, hit);
    }
  }

  return [...byId.values()]
    .sort((left, right) => Number(right._rankingScore ?? 0) - Number(left._rankingScore ?? 0)
      || (typeof left.canonicalId === 'string' ? left.canonicalId : left.id)
        .localeCompare(typeof right.canonicalId === 'string' ? right.canonicalId : right.id))
    .slice(0, limit);
}

function uniqueLexicalQueries(values: string[]): string[] {
  return [...new Set(values
    .map((value) => value.trim())
    .filter(Boolean))]
    .slice(0, 6);
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
  canonicalId?: string;
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
  _vectors?: Record<string, number[]>;
  _rankingScore?: number;
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

function searchDocumentFor(document: VectorDocument): SearchDocument {
  return {
    // Meilisearch primary keys may only contain alphanumerics, hyphens, and
    // underscores. DKB canonical IDs intentionally contain separators such as
    // "/" and ":", so keep the canonical form in memory and store a lossless
    // backend-safe representation in Meilisearch.
    id: meiliDocumentId(versionedMeiliDocumentId(document)),
    canonicalId: document.id,
    packageId: document.packageId ?? document.dkbId,
    packageVersion: document.packageVersion ?? '0.0.0',
    dkbId: document.dkbId,
    recordId: document.recordId,
    title: document.title,
    summary: document.summary,
    text: document.text,
    domains: document.domains,
    topics: document.topics,
    keywords: document.keywords,
    entities: document.entities,
    aliases: document.aliases,
    sourceType: document.sourceType,
    updatedAt: document.updatedAt,
    sourceHash: document.sourceHash,
    ...(document.embedding ? { _vectors: { [embedderName()]: document.embedding } } : {}),
  };
}

function packageSearchDocumentFor(document: VectorDocument, dkbId: string, packageVersion: string): SearchDocument {
  return searchDocumentFor({
    ...document,
    packageId: dkbId,
    packageVersion,
  });
}

function meiliDocumentId(canonicalId: string): string {
  return Buffer.from(canonicalId, 'utf8').toString('base64url');
}

function canonicalMeiliDocumentId(id: string): string {
  try {
    const decoded = Buffer.from(id, 'base64url').toString('utf8');
    const parts = decoded.split('|');

    return parts.length >= 4 ? parts.slice(3).join('|') : decoded;
  } catch {
    // Preserve compatibility with an existing index created by an older
    // runtime. It will be rebuilt on the next lifecycle operation.
    return id;
  }
}

function versionedMeiliDocumentId(document: VectorDocument): string {
  return [
    document.packageId ?? document.dkbId,
    document.packageVersion ?? '0.0.0',
    document.sourceHash ?? '',
    document.id,
  ].join('|');
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

function meiliSettings(): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    searchableAttributes: ['title', 'summary', 'keywords', 'topics', 'entities', 'aliases', 'text'],
    filterableAttributes: ['packageId', 'packageVersion', 'dkbId', 'recordId', 'sourceType', 'updatedAt'],
    sortableAttributes: ['updatedAt'],
    displayedAttributes: [
      'id',
      'canonicalId',
      'packageId',
      'packageVersion',
      'dkbId',
      'recordId',
      'title',
      'summary',
      'topics',
      'entities',
      'aliases',
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

function packageFilter(dkbId: string, packageVersion: string): string {
  return `packageId = "${escapeMeiliFilterString(dkbId)}" AND packageVersion = "${escapeMeiliFilterString(packageVersion)}"`;
}

function escapeMeiliFilterString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function embedderConfig(source: string): Record<string, unknown> {
  if (source === 'userProvided') {
    return {
      source: 'userProvided',
      dimensions: Number(process.env.DKB_MEILI_EMBEDDER_DIMENSIONS ?? 384),
    };
  }
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

function isUserProvidedEmbedder(): boolean {
  return process.env.DKB_MEILI_EMBEDDER_SOURCE === 'userProvided';
}

async function embedQuery(query: string): Promise<number[]> {
  const url = process.env.DKB_QUERY_EMBEDDER_URL;

  if (!url) {
    throw new Error('DKB_QUERY_EMBEDDER_URL is required when using a userProvided Meilisearch embedder');
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ texts: [query] }),
  });
  const body = await response.json() as { vectors?: unknown };
  const vector = Array.isArray(body.vectors) && Array.isArray(body.vectors[0])
    ? body.vectors[0]
    : null;

  if (!response.ok || !vector || !vector.every((value) => typeof value === 'number')) {
    throw new Error(`DKB query embedder failed (${response.status})`);
  }

  return vector;
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
