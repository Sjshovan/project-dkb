import path from 'node:path';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import type { DkbEvidenceCatalogAsset, DkbEvidenceCatalogRecord } from '@sjshovan/dkb-protocol/evidence/catalog.js';
import type { DkbRuntimeActivation } from '@sjshovan/dkb-protocol/runtimeActivation.js';
import { DkbProviderHost } from '@sjshovan/dkb-pipeline/host.js';
import type { DkbEmbeddingProvider, DkbIndexProvider, DkbIndexRuntime, DkbJsonValue, DkbRetrievalProvider, DkbRetrievalRuntime } from '@sjshovan/dkb-pipeline/types.js';
import { evidenceIdsForRetrievalScope, validateIndexRuntime, validateRetrievalHits, validateRetrievalRuntime, validateVector } from '@sjshovan/dkb-pipeline/validation.js';
import { resolveProviderRetrievalProfile } from '@sjshovan/dkb-pipeline/profile.js';
import { resolveLibraryActivationBuilds } from '@sjshovan/dkb-library/builds.js';
import { readSourceRevisions, type HistoricalEvidence } from '@sjshovan/dkb-library/sourceRevisions.js';
import { readLibraryState } from '@sjshovan/dkb-library/state.js';
import { readEvidenceCatalog } from '@sjshovan/dkb-library/evidenceCatalog.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbRuntimeContext } from '../runtime/context.js';
import { assertFileSnapshotCurrent, type FileSnapshot } from '@sjshovan/dkb-protocol/fileSnapshot.js';
import { captureQueryInputs } from './queryInputs.js';
import { verifyRuntimeRegistryBuilds } from '../runtime/registryInstall.js';

export interface QueryContext {
  root: string;
  ownerRoot: string;
  collectionId: string;
  cacheKey: string;
  artifactHash: string;
  evidenceAssets: DkbEvidenceCatalogAsset[];
  evidenceRecords: DkbEvidenceCatalogRecord[];
  evidenceById: Map<string, DkbEvidenceCatalogRecord>;
  historicalEvidenceById?: Map<string, HistoricalEvidence>;
  evidenceAssetsByKey: Map<string, DkbEvidenceCatalogAsset>;
  evidenceByIdentifier: Map<string, DkbEvidenceCatalogRecord[]>;
  index?: DkbIndexRuntime;
  retrieval: DkbRetrievalRuntime;
  providerHost: DkbProviderHost;
  validatedInputs: FileSnapshot;
  createdAt: string;
  lastUsedAt: string;
}

const residentContexts = new Map<string, QueryContext>();
interface OpeningContext {
  root: string;
  ownerRoot: string;
  invalidated: boolean;
  promise: Promise<QueryContext>;
}

const openingContexts = new Map<string, OpeningContext>();

export interface QueryContextActivation {
  runtimeStateRoot?: string;
  activation?: DkbRuntimeActivation;
}

export async function createQueryContext(
  root: string,
  collectionId: string,
  runtime: DkbRuntimeContext,
  active: QueryContextActivation = {},
): Promise<QueryContext> {
  if (!active.activation || !active.runtimeStateRoot) {
    throw new DkbError('A validated Runtime activation is required to open a query context. Run dkb runtime refresh, then query through that Runtime.', 'runtime_activation_required');
  }
  const resolvedRoot = path.resolve(root);
  const providerRoot = path.resolve(active.runtimeStateRoot ?? resolvedRoot);
  const providerHost = await DkbProviderHost.create({
    root: providerRoot,
    ...(providerRoot !== resolvedRoot ? { libraryRoot: resolvedRoot } : {}),
    target: active.activation.target,
    distribution: runtime.distribution,
  });
  let indexRuntime: DkbIndexRuntime | null = null;
  let retrievalRuntime: DkbRetrievalRuntime | null = null;

  try {
    const embeddingId = providerHost.config.target.embedding;
    const embeddingProvider = embeddingId ? providerHost.provider<DkbEmbeddingProvider>('embedding') : null;
    const embeddingOptions = embeddingId ? providerHost.optionsFor(embeddingId) : undefined;
    const indexProvider = providerHost.provider<DkbIndexProvider>('index');
    const indexOptions = providerHost.optionsFor(providerHost.config.target.index);
    const resolvedProfile = await resolveProviderRetrievalProfile(providerHost);
    const compatibility = resolvedProfile.compatibility;
    const activation = active.activation;
    const artifactHash = queryArtifactHash(activation);
    const validatedInputs = await captureQueryInputs(resolvedRoot, activation);
    const packages = await resolveLibraryActivationBuilds(resolvedRoot, activation);
    await verifyRuntimeRegistryBuilds(resolvedRoot, activation);
    const state = await readLibraryState(resolvedRoot);
    const historicalEvidenceById = new Map<string, HistoricalEvidence>();
    for (const item of packages) {
      const entry = state.entries[item.dkb.manifest.id];
      if (entry?.source !== 'local') continue;
      for (const historical of await readSourceRevisions(item.dkb.root, item.dkb.manifest.id, item.dkb.manifest.version)) {
        historicalEvidenceById.set(historical.record.evidenceId, historical);
      }
    }
    const catalogs = packages.map((item) => readEvidenceCatalog(item.evidenceRoot));
    const evidenceAssets = catalogs.flatMap((catalog) => catalog.assets)
      .sort((left, right) => `${left.packageId}/${left.id}`.localeCompare(`${right.packageId}/${right.id}`));
    const evidenceRecords = catalogs.flatMap((catalog) => catalog.records)
      .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
    if (
      activation.evidenceProfileDigest !== resolvedProfile.evidenceProfileDigest
      || activation.retrievalProfileDigest !== resolvedProfile.retrievalProfileDigest
      || activation.compatibilityDigest !== stableHash(compatibility)
    ) {
      throw new DkbError(
        `Runtime activation ${activation.retrievalProfileDigest} does not match selected pipeline ${resolvedProfile.retrievalProfileDigest}`,
      );
    }
    const expectedDimensions = resolvedProfile.embedding?.dimensions;
    indexRuntime = validateIndexRuntime(await indexProvider.openRuntime({
      libraryRoot: resolvedRoot,
      libraryId: collectionId,
      packages,
      compatibility: compatibility as unknown as Record<string, DkbJsonValue>,
      ...(embeddingProvider && embeddingOptions ? {
        embedQuery: async (text: string, signal?: AbortSignal) => validateVector(
          await embeddingProvider.embedQuery({ text, options: embeddingOptions, ...(signal ? { signal } : {}) }),
          expectedDimensions,
          `${embeddingId} query embedding`,
        ),
      } : {}),
      options: indexOptions,
    }), providerHost.describe().providers.find((item) => item.kind === 'index')?.id ?? providerHost.config.target.index);
    const retrievalProvider = providerHost.provider<DkbRetrievalProvider>('retrieval');
    const rawRetrieval = validateRetrievalRuntime(await retrievalProvider.openRuntime({
      index: indexRuntime,
      evidence: { assets: evidenceAssets, records: evidenceRecords },
      options: providerHost.optionsFor(providerHost.config.target.retrieval),
    }), providerHost.describe().providers.find((item) => item.kind === 'retrieval')?.id ?? providerHost.config.target.retrieval, retrievalProvider.protocol);
    const knownEvidenceIds = new Set(evidenceRecords.map((record) => record.evidenceId));
    retrievalRuntime = {
      providerId: rawRetrieval.providerId,
      protocol: rawRetrieval.protocol,
      async search(input) {
        if (!input.query.trim()) throw new DkbError('Retrieval query must not be empty');
        if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1_000) throw new DkbError('Retrieval limit must be between 1 and 1000');
        const result = await rawRetrieval.search(input);
        const allowedEvidenceIds = input.scope
          ? evidenceIdsForRetrievalScope(evidenceRecords, input.scope)
          : knownEvidenceIds;
        return {
          hits: validateRetrievalHits(result.hits, knownEvidenceIds, input.limit, rawRetrieval.providerId, allowedEvidenceIds),
          trace: result.trace as Record<string, DkbJsonValue>,
        };
      },
      close: () => rawRetrieval.close(),
    };

    await Promise.all([assertFileSnapshotCurrent(validatedInputs), providerHost.assertCurrent()]);
    return {
      root: resolvedRoot,
      ownerRoot: providerRoot,
      collectionId,
      cacheKey: queryContextCacheKey(providerRoot, resolvedRoot, collectionId, artifactHash, runtime),
      artifactHash,
      evidenceAssets,
      evidenceRecords,
      evidenceById: new Map(evidenceRecords.map((record) => [record.evidenceId, record])),
      historicalEvidenceById,
      evidenceAssetsByKey: new Map(evidenceAssets.map((asset) => [`${asset.packageId}/${asset.id}`, asset])),
      evidenceByIdentifier: evidenceIdentifierIndex(evidenceRecords),
      providerHost,
      validatedInputs,
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

export async function getQueryContext(root: string, collectionId: string, runtime: DkbRuntimeContext, active: QueryContextActivation): Promise<QueryContext> {
  const resolvedRoot = path.resolve(root);
  const providerRoot = path.resolve(active.runtimeStateRoot ?? resolvedRoot);
  const artifactHash = active.activation ? queryArtifactHash(active.activation) : 'resolve';
  const cacheKey = queryContextCacheKey(providerRoot, resolvedRoot, collectionId, artifactHash, runtime);
  const cached = residentContexts.get(cacheKey);

  if (cached) {
    await assertQueryContextCurrent(cached);
    cached.lastUsedAt = new Date().toISOString();

    return cached;
  }

  let opening = openingContexts.get(cacheKey);
  if (!opening) {
    const entry: OpeningContext = {
      root: resolvedRoot,
      ownerRoot: providerRoot,
      invalidated: false,
      promise: createQueryContext(resolvedRoot, collectionId, runtime, active).then(async (context) => {
        if (entry.invalidated) {
          await disposeContext(context);
          throw new DkbError('Runtime query context was invalidated while opening. Retry after Runtime refresh.', 'runtime_context_invalidated');
        }
        residentContexts.set(context.cacheKey, context);
        return context;
      }).finally(() => {
        if (openingContexts.get(cacheKey) === entry) openingContexts.delete(cacheKey);
      }),
    };
    opening = entry;
    openingContexts.set(cacheKey, opening);
  }
  return opening.promise;
}

export async function assertQueryContextCurrent(context: QueryContext): Promise<void> {
  await Promise.all([
    assertFileSnapshotCurrent(context.validatedInputs),
    context.providerHost.assertCurrent(),
  ]);
}

export function invalidateQueryContext(root?: string): number {
  const pending = invalidateOpeningContexts(root).length;
  if (!root) {
    const count = residentContexts.size;

    for (const context of residentContexts.values()) {
      void disposeContext(context).catch(reportContextDisposalFailure);
    }
    residentContexts.clear();

    return count + pending;
  }

  const resolvedRoot = path.resolve(root);
  let removed = 0;

  for (const [key, context] of residentContexts.entries()) {
    if (context.ownerRoot === resolvedRoot || context.root === resolvedRoot) {
      void disposeContext(context).catch(reportContextDisposalFailure);
      residentContexts.delete(key);
      removed += 1;
    }
  }

  return removed + pending;
}

export async function closeQueryContext(root?: string): Promise<number> {
  const pending = invalidateOpeningContexts(root);
  const resolvedRoot = root ? path.resolve(root) : undefined;
  const contexts = [...residentContexts.entries()]
    .filter(([, context]) => !resolvedRoot || context.ownerRoot === resolvedRoot || context.root === resolvedRoot);

  for (const [key] of contexts) {
    residentContexts.delete(key);
  }

  await Promise.all([
    ...contexts.map(([, context]) => disposeContext(context)),
    ...pending.map((entry) => entry.promise.then(() => undefined, () => undefined)),
  ]);

  return contexts.length + pending.length;
}

function invalidateOpeningContexts(root?: string): OpeningContext[] {
  const resolvedRoot = root ? path.resolve(root) : undefined;
  const selected = [...openingContexts.entries()].filter(([, entry]) =>
    !resolvedRoot || entry.ownerRoot === resolvedRoot || entry.root === resolvedRoot);
  for (const [key, entry] of selected) {
    entry.invalidated = true;
    openingContexts.delete(key);
  }
  return selected.map(([, entry]) => entry);
}

async function disposeContext(context: QueryContext): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => context.retrieval.close()),
    Promise.resolve().then(() => context.index?.close()),
    Promise.resolve().then(() => context.providerHost.dispose()),
  ]);
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), 'Runtime query context disposal failed');
}

function reportContextDisposalFailure(error: unknown): void {
  console.error(JSON.stringify({ event: 'dkb.runtime.context_disposal_failed', message: error instanceof Error ? error.message : String(error) }));
}

export function queryArtifactHash(activation: DkbRuntimeActivation): string {
  return stableHash(activation);
}

function queryContextCacheKey(root: string, libraryRoot: string, collectionId: string, artifactHash: string, runtime: DkbRuntimeContext): string {
  return stableHash({
    root,
    libraryRoot,
    collectionId,
    artifactHash,
    distribution: `${runtime.distribution.id}@${runtime.distribution.version}`,
  });
}
