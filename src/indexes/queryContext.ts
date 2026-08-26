import fs from 'node:fs/promises';
import path from 'node:path';
import { stableHash } from '../contracts/hash.js';
import { artifactLockPath, resolveFrom } from '../protocol/paths.js';
import { vectorDocumentsForSourceUnits, type VectorDocument } from './vectorStore.js';
import { SOURCE_GRAPH_PATH, SOURCE_INDEX_PATH, SOURCE_VECTOR_PATH, readSourceIndex, type IndexedSourceAsset, type IndexedSourceUnit } from './sourceIndex.js';
import type { LexicalRuntimeSnapshot } from './lexicalStore.js';
import { BUNDLED_PROVIDER_PLUGINS } from '../providers/bundled.js';
import { DkbProviderHost } from '../providers/host.js';
import type { DkbEmbeddingProvider, DkbIndexProvider, DkbIndexRuntime } from '../providers/types.js';
import { resolveProviderRetrievalProfile } from '../profiles/retrievalProfile.js';

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
  index?: DkbIndexRuntime;
  lexical?: Pick<LexicalRuntimeSnapshot, 'search' | 'close'>;
  providerHost: DkbProviderHost;
  embedQuery(query: string): Promise<number[]>;
  createdAt: string;
  lastUsedAt: string;
}

const residentContexts = new Map<string, QueryContext>();

export async function createQueryContext(root: string, collectionId: string): Promise<QueryContext> {
  const resolvedRoot = path.resolve(root);
  const artifactHash = await queryArtifactHash(resolvedRoot);
  const sourceIndex = await maybeReadSourceIndex(resolvedRoot);
  const searchRegistryId = await searchRegistryIdFor(resolvedRoot, collectionId);
  const providerHost = await DkbProviderHost.create({ root: resolvedRoot, bundled: BUNDLED_PROVIDER_PLUGINS });
  let indexRuntime: DkbIndexRuntime | null = null;

  try {
    const embeddingProvider = providerHost.provider<DkbEmbeddingProvider>('embedding');
    const embeddingOptions = providerHost.optionsFor(providerHost.config.target.embedding);
    const indexProvider = providerHost.provider<DkbIndexProvider>('index');
    const indexOptions = providerHost.optionsFor(providerHost.config.target.index);
    const compatibility = (await resolveProviderRetrievalProfile(providerHost)).compatibility;
    indexRuntime = await indexProvider.openRuntime({
      libraryRoot: resolvedRoot,
      libraryId: searchRegistryId,
      compatibility,
      embedQuery: (text, signal) => embeddingProvider.embedQuery({ text, options: embeddingOptions, ...(signal ? { signal } : {}) }),
      options: indexOptions,
    });
    const activeAssets = indexRuntime?.assets ?? sourceIndex.assets;
    const activeUnits = indexRuntime?.units ?? sourceIndex.units;
    const lexical = indexRuntime?.lexicalSearch
      ? { search: indexRuntime.lexicalSearch, close() {} }
      : undefined;

    return {
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
      providerHost,
      embedQuery: (query) => embeddingProvider.embedQuery({ text: query, options: embeddingOptions }),
      ...(indexRuntime ? { index: indexRuntime } : {}),
      ...(lexical ? { lexical } : {}),
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
  } catch (error) {
    await indexRuntime?.close();
    await providerHost.dispose();
    throw error;
  }
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
      void context.index?.close();
      void context.providerHost.dispose();
    }
    residentContexts.clear();

    return count;
  }

  const resolvedRoot = path.resolve(root);
  let removed = 0;

  for (const [key, context] of residentContexts.entries()) {
    if (context.root === resolvedRoot) {
      void context.index?.close();
      void context.providerHost.dispose();
      residentContexts.delete(key);
      removed += 1;
    }
  }

  return removed;
}

export async function closeQueryContext(root?: string): Promise<number> {
  const resolvedRoot = root ? path.resolve(root) : undefined;
  const contexts = [...residentContexts.entries()]
    .filter(([, context]) => !resolvedRoot || context.root === resolvedRoot);

  for (const [key] of contexts) {
    residentContexts.delete(key);
  }

  await Promise.all(contexts.map(async ([, context]) => {
    context.lexical?.close();
    await context.index?.close();
    await context.providerHost.dispose();
  }));

  return contexts.length;
}

export async function queryArtifactHash(root: string): Promise<string> {
  const lockPath = artifactLockPath(root);
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
