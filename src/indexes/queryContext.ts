import fs from 'node:fs/promises';
import path from 'node:path';
import { stableHash } from '../contracts/hash.js';
import { manifestPath, resolveFrom } from '../protocol/paths.js';
import { KR_GRAPH_PATH, KR_INDEX_PATH, KR_VECTOR_PATH, readKrIndex, type IndexedKnowledgeRegion } from './knowledgeIndex.js';
import { readGraphArtifact, type GraphArtifact } from './graphRetrieval.js';
import { vectorDocumentsFor, type VectorDocument } from './vectorStore.js';
import { SOURCE_INDEX_PATH, readSourceIndex, type IndexedSourceUnit } from './sourceIndex.js';

export interface QueryContext {
  root: string;
  collectionId: string;
  cacheKey: string;
  artifactHash: string;
  records: IndexedKnowledgeRegion[];
  sourceUnits: IndexedSourceUnit[];
  graphArtifact: GraphArtifact | null;
  vectorDocuments: VectorDocument[];
  vectorArtifactRoot: string;
  searchRegistryId: string;
  createdAt: string;
  lastUsedAt: string;
}

const residentContexts = new Map<string, QueryContext>();

export async function createQueryContext(root: string, collectionId: string): Promise<QueryContext> {
  const resolvedRoot = path.resolve(root);
  const artifactHash = await queryArtifactHash(resolvedRoot);
  const records = await readKrIndex(resolvedRoot);
  const sourceIndex = await maybeReadSourceIndex(resolvedRoot);
  const context: QueryContext = {
    root: resolvedRoot,
    collectionId,
    cacheKey: queryContextCacheKey(resolvedRoot, collectionId, artifactHash),
    artifactHash,
    records,
    sourceUnits: sourceIndex.units,
    graphArtifact: await readGraphArtifact(resolvedRoot),
    vectorDocuments: vectorDocumentsFor(records),
    vectorArtifactRoot: path.dirname(resolveFrom(resolvedRoot, KR_VECTOR_PATH)),
    searchRegistryId: await searchRegistryIdFor(resolvedRoot, collectionId),
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  };

  return context;
}

export async function getQueryContext(root: string, collectionId: string): Promise<QueryContext> {
  const resolvedRoot = path.resolve(root);
  const artifactHash = await queryArtifactHash(resolvedRoot);
  const cacheKey = queryContextCacheKey(resolvedRoot, collectionId, artifactHash);
  const cached = residentContexts.get(cacheKey);

  if (cached) {
    cached.lastUsedAt = new Date().toISOString();

    return cached;
  }

  const context = await createQueryContext(resolvedRoot, collectionId);

  residentContexts.set(context.cacheKey, context);

  return context;
}

export function invalidateQueryContext(root?: string): number {
  if (!root) {
    const count = residentContexts.size;

    residentContexts.clear();

    return count;
  }

  const resolvedRoot = path.resolve(root);
  let removed = 0;

  for (const [key, context] of residentContexts.entries()) {
    if (context.root === resolvedRoot) {
      residentContexts.delete(key);
      removed += 1;
    }
  }

  return removed;
}

export async function queryArtifactHash(root: string): Promise<string> {
  const lockPath = manifestPath(root, 'dkb-lock.json');
  const lock = await maybeReadFile(lockPath);

  if (lock) {
    return stableHash({
      lockPath,
      lock,
    });
  }

  const artifacts = await Promise.all([
    artifactSnapshot(resolveFrom(root, KR_INDEX_PATH)),
    artifactSnapshot(resolveFrom(root, KR_GRAPH_PATH)),
    artifactSnapshot(resolveFrom(root, KR_VECTOR_PATH)),
    artifactSnapshot(resolveFrom(root, SOURCE_INDEX_PATH)),
  ]);

  return stableHash({
    root,
    artifacts,
  });
}

async function maybeReadSourceIndex(root: string): Promise<{ units: IndexedSourceUnit[] }> {
  try {
    return await readSourceIndex(root);
  } catch {
    return { units: [] };
  }
}

function queryContextCacheKey(root: string, collectionId: string, artifactHash: string): string {
  return stableHash({
    root,
    collectionId,
    artifactHash,
  });
}

async function artifactSnapshot(target: string): Promise<{ path: string; mtimeMs: number | null; size: number | null }> {
  try {
    const stat = await fs.stat(target);

    return {
      path: target,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
  } catch {
    return {
      path: target,
      mtimeMs: null,
      size: null,
    };
  }
}

async function searchRegistryIdFor(root: string, fallback: string): Promise<string> {
  try {
    const manifest = JSON.parse(await fs.readFile(resolveFrom(root, KR_VECTOR_PATH), 'utf8')) as { registryId?: unknown };

    return typeof manifest.registryId === 'string' && manifest.registryId.length > 0 ? manifest.registryId : fallback;
  } catch {
    return fallback;
  }
}

async function maybeReadFile(target: string): Promise<string | null> {
  try {
    return await fs.readFile(target, 'utf8');
  } catch {
    return null;
  }
}
