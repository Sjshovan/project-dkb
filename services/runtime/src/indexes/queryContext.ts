import path from 'node:path';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import type { DkbEvidenceCatalogAsset, DkbEvidenceCatalogRecord } from '@sjshovan/dkb-protocol/evidence/catalog.js';
import { DEFAULT_DKB_DISTRIBUTION } from '@sjshovan/dkb-distribution-default';
import { DkbProviderHost } from '@sjshovan/dkb-pipeline/host.js';
import type { DkbEmbeddingProvider, DkbIndexProvider, DkbIndexRuntime, DkbRetrievalProvider, DkbRetrievalRuntime } from '@sjshovan/dkb-pipeline/types.js';
import { resolveProviderRetrievalProfile } from '@sjshovan/dkb-pipeline/profile.js';
import { maybeReadRuntimeLock, resolveLibraryRuntimeBuilds } from '@sjshovan/dkb-library/builds.js';
import { readEvidenceCatalog } from '@sjshovan/dkb-library/evidenceCatalog.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

export interface QueryContext {
  root: string;
  collectionId: string;
  cacheKey: string;
  artifactHash: string;
  evidenceAssets: DkbEvidenceCatalogAsset[];
  evidenceRecords: DkbEvidenceCatalogRecord[];
  evidenceById: Map<string, DkbEvidenceCatalogRecord>;
  evidenceAssetsByKey: Map<string, DkbEvidenceCatalogAsset>;
  evidenceByIdentifier: Map<string, DkbEvidenceCatalogRecord[]>;
  index?: DkbIndexRuntime;
  retrieval: DkbRetrievalRuntime;
  providerHost: DkbProviderHost;
  createdAt: string;
  lastUsedAt: string;
}

const residentContexts = new Map<string, QueryContext>();

export async function createQueryContext(root: string, collectionId: string): Promise<QueryContext> {
  const resolvedRoot = path.resolve(root);
  const artifactHash = await queryArtifactHash(resolvedRoot);
  const providerHost = await DkbProviderHost.create({ root: resolvedRoot, distribution: DEFAULT_DKB_DISTRIBUTION });
  let indexRuntime: DkbIndexRuntime | null = null;
  let retrievalRuntime: DkbRetrievalRuntime | null = null;

  try {
    const embeddingProvider = providerHost.provider<DkbEmbeddingProvider>('embedding');
    const embeddingOptions = providerHost.optionsFor(providerHost.config.target.embedding);
    const indexProvider = providerHost.provider<DkbIndexProvider>('index');
    const indexOptions = providerHost.optionsFor(providerHost.config.target.index);
    const resolvedProfile = await resolveProviderRetrievalProfile(providerHost);
    const compatibility = resolvedProfile.compatibility;
    const packages = await resolveLibraryRuntimeBuilds(resolvedRoot);
    const catalogs = packages.map((item) => readEvidenceCatalog(item.evidenceRoot));
    const evidenceAssets = catalogs.flatMap((catalog) => catalog.assets)
      .sort((left, right) => `${left.packageId}/${left.id}`.localeCompare(`${right.packageId}/${right.id}`));
    const evidenceRecords = catalogs.flatMap((catalog) => catalog.records)
      .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
    const runtimeLock = await maybeReadRuntimeLock(resolvedRoot);
    if (runtimeLock && (
      runtimeLock.evidenceProfileDigest !== resolvedProfile.evidenceProfileDigest
      || runtimeLock.retrievalProfileDigest !== resolvedProfile.retrievalProfileDigest
      || runtimeLock.compatibilityDigest !== stableHash(compatibility)
    )) {
      throw new DkbError(
        `Active Runtime Build ${runtimeLock.retrievalProfileDigest} does not match selected pipeline ${resolvedProfile.retrievalProfileDigest}`,
      );
    }
    indexRuntime = await indexProvider.openRuntime({
      libraryRoot: resolvedRoot,
      libraryId: collectionId,
      packages,
      compatibility,
      embedQuery: (text, signal) => embeddingProvider.embedQuery({ text, options: embeddingOptions, ...(signal ? { signal } : {}) }),
      options: indexOptions,
    });
    const retrievalProvider = providerHost.provider<DkbRetrievalProvider>('retrieval');
    retrievalRuntime = await retrievalProvider.openRuntime({
      index: indexRuntime,
      evidence: { assets: evidenceAssets, records: evidenceRecords },
      options: providerHost.optionsFor(providerHost.config.target.retrieval),
    });

    return {
      root: resolvedRoot,
      collectionId,
      cacheKey: queryContextCacheKey(resolvedRoot, collectionId, artifactHash),
      artifactHash,
      evidenceAssets,
      evidenceRecords,
      evidenceById: new Map(evidenceRecords.map((record) => [record.evidenceId, record])),
      evidenceAssetsByKey: new Map(evidenceAssets.map((asset) => [`${asset.packageId}/${asset.id}`, asset])),
      evidenceByIdentifier: evidenceIdentifierIndex(evidenceRecords),
      providerHost,
      retrieval: retrievalRuntime,
      ...(indexRuntime ? { index: indexRuntime } : {}),
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
  } catch (error) {
    await retrievalRuntime?.close();
    await indexRuntime?.close();
    await providerHost.dispose();
    throw error;
  }
}

function evidenceIdentifierIndex(records: DkbEvidenceCatalogRecord[]): Map<string, DkbEvidenceCatalogRecord[]> {
  const result = new Map<string, DkbEvidenceCatalogRecord[]>();

  for (const record of records) {
    const identifiers = identifiersForEvidence(record);

    for (const identifier of identifiers) {
      const list = result.get(identifier) ?? [];

      list.push(record);
      result.set(identifier, list);
    }
  }

  return result;
}

function identifiersForEvidence(record: DkbEvidenceCatalogRecord): string[] {
  return [...new Set(`${record.title}\n${record.text}\n${record.keywords.join(' ')}`
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
      void context.retrieval.close();
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
      void context.retrieval.close();
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
    await context.retrieval.close();
    await context.index?.close();
    await context.providerHost.dispose();
  }));

  return contexts.length;
}

export async function queryArtifactHash(root: string): Promise<string> {
  const runtimeLock = await maybeReadRuntimeLock(root);
  return stableHash(runtimeLock ?? { root: path.resolve(root), status: 'uncompiled' });
}

function queryContextCacheKey(root: string, collectionId: string, artifactHash: string): string {
  return stableHash({
    root,
    collectionId,
    artifactHash,
  });
}
