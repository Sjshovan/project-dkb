import fs from 'node:fs/promises';
import path from 'node:path';
import { stableHash } from '../contracts/hash.js';
import { manifestPath, resolveFrom } from '../protocol/paths.js';
import { vectorDocumentsForSourceUnits, type VectorDocument } from './vectorStore.js';
import { SOURCE_GRAPH_PATH, SOURCE_INDEX_PATH, SOURCE_VECTOR_PATH, readSourceIndex, type IndexedSourceAsset, type IndexedSourceUnit } from './sourceIndex.js';
import { buildFaissRuntimeSnapshot, closeFaissSnapshot, type FaissRuntimeSnapshot } from './faissStore.js';
import { buildLexicalRuntimeSnapshot, type LexicalRuntimeSnapshot } from './lexicalStore.js';

export interface QueryContext {
  root: string;
  collectionId: string;
  cacheKey: string;
  artifactHash: string;
  sourceAssets: IndexedSourceAsset[];
  sourceUnits: IndexedSourceUnit[];
  sourceUnitsById: Map<string, IndexedSourceUnit>;
  sourceAssetsByKey: Map<string, IndexedSourceAsset>;
  sourceUnitsByIdentifier: Map<string, IndexedSourceUnit[]>;
  vectorDocuments: VectorDocument[];
  vectorArtifactRoot: string;
  searchRegistryId: string;
  faiss?: FaissRuntimeSnapshot;
  lexical?: LexicalRuntimeSnapshot;
  createdAt: string;
  lastUsedAt: string;
}

const residentContexts = new Map<string, QueryContext>();

export async function createQueryContext(root: string, collectionId: string): Promise<QueryContext> {
  const resolvedRoot = path.resolve(root);
  const artifactHash = await queryArtifactHash(resolvedRoot);
  const sourceIndex = await maybeReadSourceIndex(resolvedRoot);
  const searchRegistryId = await searchRegistryIdFor(resolvedRoot, collectionId);
  const faiss = await buildFaissRuntimeSnapshot(resolvedRoot, searchRegistryId);
  const activeAssets = faiss?.assets ?? sourceIndex.assets;
  const activeUnits = faiss?.units ?? sourceIndex.units;
  const lexical = faiss
    ? buildLexicalRuntimeSnapshot({
      packages: faiss.packages,
      numericIdToUnitId: faiss.numericIdToUnitId,
      unitsById: new Map(activeUnits.map((unit) => [unit.id, unit])),
    }) ?? undefined
    : undefined;
  const context: QueryContext = {
    root: resolvedRoot,
    collectionId,
    cacheKey: queryContextCacheKey(resolvedRoot, collectionId, artifactHash),
    artifactHash,
    sourceAssets: activeAssets,
    sourceUnits: activeUnits,
    sourceUnitsById: new Map(activeUnits.map((unit) => [unit.id, unit])),
    sourceAssetsByKey: new Map(activeAssets.map((asset) => [`${asset.dkbId}/${asset.id}`, asset])),
    sourceUnitsByIdentifier: sourceUnitIdentifierIndex(activeUnits),
    vectorDocuments: vectorDocumentsForSourceUnits(activeUnits),
    vectorArtifactRoot: path.dirname(resolveFrom(resolvedRoot, SOURCE_VECTOR_PATH)),
    searchRegistryId,
    ...(faiss ? { faiss } : {}),
    ...(lexical ? { lexical } : {}),
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  };

  return context;
}

function sourceUnitIdentifierIndex(units: IndexedSourceUnit[]): Map<string, IndexedSourceUnit[]> {
  const result = new Map<string, IndexedSourceUnit[]>();

  for (const unit of units) {
    const identifiers = identifiersForSourceUnit(unit);

    for (const identifier of identifiers) {
      const list = result.get(identifier) ?? [];

      list.push(unit);
      result.set(identifier, list);
    }
  }

  return result;
}

function identifiersForSourceUnit(unit: IndexedSourceUnit): string[] {
  return [...new Set(`${unit.title}\n${unit.text}\n${unit.keywords.join(' ')}`
    .match(/\b[A-Za-z0-9][A-Za-z0-9_-]*\d[A-Za-z0-9_-]*\b/g)
    ?.map((identifier) => identifier.trim().toLowerCase())
    .filter(Boolean) ?? [])];
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

    for (const context of residentContexts.values()) {
      void closeFaissSnapshot(context.faiss);
      context.lexical?.close();
    }
    residentContexts.clear();

    return count;
  }

  const resolvedRoot = path.resolve(root);
  let removed = 0;

  for (const [key, context] of residentContexts.entries()) {
    if (context.root === resolvedRoot) {
      void closeFaissSnapshot(context.faiss);
      context.lexical?.close();
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
    artifactSnapshot(resolveFrom(root, SOURCE_INDEX_PATH)),
    artifactSnapshot(resolveFrom(root, SOURCE_GRAPH_PATH)),
    artifactSnapshot(resolveFrom(root, SOURCE_VECTOR_PATH)),
  ]);

  return stableHash({
    root,
    artifacts,
  });
}

async function maybeReadSourceIndex(root: string): Promise<{ assets: IndexedSourceAsset[]; units: IndexedSourceUnit[] }> {
  try {
    return await readSourceIndex(root);
  } catch {
    return { assets: [], units: [] };
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
    const manifest = JSON.parse(await fs.readFile(resolveFrom(root, SOURCE_VECTOR_PATH), 'utf8')) as { registryId?: unknown };

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
