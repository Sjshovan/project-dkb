import path from 'node:path';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { resolveFrom } from '@sjshovan/dkb-protocol/paths.js';
import type { DkbLockManifest, LoadedDkb, LoadedLibrary } from '@sjshovan/dkb-protocol/types.js';
import { validatePackageBuildGraph } from '@sjshovan/dkb-library/builds.js';
import { readEvidenceCatalog } from '@sjshovan/dkb-library/evidenceCatalog.js';
import type { DkbEvidenceCatalogRecord } from '@sjshovan/dkb-protocol/evidence/catalog.js';
import {
  resolveProviderRetrievalProfile,
  retrievalProfileLockForRetrievalPipelines,
  type DkbResolvedRetrievalProfile,
} from '@sjshovan/dkb-pipeline/profile.js';
import {
  buildEvidenceIr,
  evidenceIdentityForRecord,
  type DkbEvidenceIr,
} from '@sjshovan/dkb-protocol/evidence/ir.js';
import { DkbProviderHost, type DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import type { DkbEvidencePipeline, DkbJsonValue, IndexedSourceUnit } from '@sjshovan/dkb-pipeline/types.js';
import { evidenceSourceRecordFromPipelineRecord, indexedSourceUnitFromPipelineRecord } from './records.js';
import { embedDkbEvidenceWithProviderHost, ingestDkbWithProviderHost } from './pipelineRunner.js';
import { summarizeEvidenceCorpus } from './buildStatistics.js';
import { assertDiskCapacity, estimateRetrievalWorkingBytes } from './diskCapacity.js';
import { hashStoreForDkb, uniqueDkbs } from './sourceHashing.js';
import { quickStoreSnapshotsForDkb, sourceStatisticsForStores, storesForDkb } from './compileCache.js';
import type { CompileComposeProfile } from './compilerContracts.js';
import type { CompilerArtifactState, RegistryCompileState } from './compilerState.js';
import type { ProviderExecutionFactory } from './providerExecution.js';

export function pipelineFromEvidenceIr(evidence: DkbEvidenceIr): DkbEvidencePipeline {
  const chunkByEvidence = new Map<string, DkbEvidenceIr['chunks'][number]>();
  for (const chunk of evidence.chunks) {
    if (chunkByEvidence.has(chunk.evidenceId)) {
      throw new DkbError(`Evidence Build ${evidence.evidenceDigest} has multiple chunks for ${chunk.evidenceId}`);
    }
    chunkByEvidence.set(chunk.evidenceId, chunk);
  }

  return {
    documents: [],
    chunks: [],
    records: evidence.evidence.map((record) => {
      const chunk = chunkByEvidence.get(record.evidenceId);
      if (!chunk) throw new DkbError(`Evidence Build ${evidence.evidenceDigest} is missing chunk metadata for ${record.evidenceId}`);

      return {
        id: record.evidenceId,
        chunkId: chunk.chunkId,
        text: record.text,
        provenance: {
          assetId: record.assetId,
          storeId: record.storeId,
          sourceType: record.sourceType,
          locator: record.locator as Record<string, DkbJsonValue>,
          assetLocator: record.assetLocator as Record<string, DkbJsonValue>,
          title: record.title,
          sourceHash: record.sourceHash,
          updatedAt: typeof record.provenance.dkb_updated_at === 'string' ? record.provenance.dkb_updated_at : '1970-01-01T00:00:00.000Z',
          chunkOrdinal: chunk.ordinal,
          chunkStart: chunk.start,
          chunkEnd: chunk.end,
        },
        metadata: {
          ...(record.provenance as Record<string, DkbJsonValue>),
          dkb_package_id: record.packageId,
          dkb_package_version: record.packageVersion,
          dkb_source_hash: record.sourceHash,
          dkb_evidence_id: record.evidenceId,
          dkb_text_hash: record.textHash,
        },
      };
    }),
    receipts: [],
  };
}

export function providerStageStatistics(
  state: RegistryCompileState,
): NonNullable<CompileComposeProfile['statistics']>['providerStages'] {
  return state.compilerArtifacts.map((artifact) => {
    const evidenceProviderIds = new Set(state.resolvedProfile?.providers
      .filter((provider) => provider.kind === 'evidence' || provider.kind === 'parser' || provider.kind === 'chunker')
      .map((provider) => provider.id) ?? []);
    const evidenceReceipt = artifact.compiled.receipts.find((receipt) => evidenceProviderIds.has(receipt.providerId));
    const embeddingReceipt = artifact.compiled.receipts.find((receipt) => {
      return receipt.providerId === state.resolvedProfile?.embedding?.provider
        && isRecord(receipt.diagnostics?.timingsMs);
    });
    const evidenceExecution = isRecord(evidenceReceipt?.diagnostics?.execution) ? evidenceReceipt.diagnostics.execution : undefined;
    const ingestionTimingsMs = numberRecord(evidenceExecution?.timingsMs);
    const ingestionWrapperTimingsMs = numberRecord(evidenceExecution?.wrapperTimingsMs);
    const embeddingTimingsMs = numberRecord(embeddingReceipt?.diagnostics?.timingsMs);

    return {
      packageId: artifact.dkb.manifest.id,
      ...(ingestionTimingsMs ? { ingestionTimingsMs } : {}),
      ...(ingestionWrapperTimingsMs ? { ingestionWrapperTimingsMs } : {}),
      ...(embeddingTimingsMs ? { embeddingTimingsMs } : {}),
    };
  });
}

export async function collectRegistryState(
  registry: LoadedLibrary,
  desiredProfile: DkbResolvedRetrievalProfile,
  distribution: DkbDistribution,
  contextRoot = registry.root,
  targetOptions?: Record<string, Record<string, unknown>>,
  signal?: AbortSignal,
  execution?: ProviderExecutionFactory,
): Promise<RegistryCompileState> {
  signal?.throwIfAborted();
  const allDkbs = uniqueDkbs([
    ...registry.collections.flatMap((collection) => collection.dkbs),
    ...registry.dkbs,
  ]);
  const providerHost = await DkbProviderHost.create({
    root: contextRoot,
    distribution,
    target: desiredProfile.target,
    ...(targetOptions ? { targetOptions } : {}),
  });
  let packageEntries: Awaited<ReturnType<typeof collectDkbState>>[];

  try {
    // Await every owner before disposing the shared host or permitting scratch cleanup.
    const settled = await Promise.allSettled(allDkbs.map(async (dkb) => collectDkbState(dkb, desiredProfile, registry.root, providerHost, signal, execution)));
    const failures = settled.filter((entry) => entry.status === 'rejected');
    if (failures.length) {
      const uncertain = failures.find((entry) => entry.reason instanceof DkbError && entry.reason.code === 'compile_termination_unconfirmed');
      throw (uncertain ?? failures[0]!).reason;
    }
    packageEntries = settled.map((entry) => (entry as PromiseFulfilledResult<Awaited<ReturnType<typeof collectDkbState>>>).value);
  } catch (error) {
    // Disposal must not replace the compilation outcome (particularly an unconfirmed worker stop).
    await providerHost.dispose().catch(() => undefined);
    throw error;
  }
  const sourceUnits = packageEntries.flatMap((entry) => entry.sourceUnits);
  const packages = Object.fromEntries(packageEntries.map((entry) => [entry.package.id, entry.package]));
  const compilerArtifacts = packageEntries.flatMap((entry) => entry.compilerArtifact ? [entry.compilerArtifact] : []);
  const retrievalProfileLock = compilerArtifacts.length > 0
    ? retrievalProfileLockForRetrievalPipelines(desiredProfile, compilerArtifacts.map((artifact) => artifact.compiled))
    : undefined;

  return {
    sourceUnits,
    packages,
    compilerArtifacts,
    retrievalProfileLock,
    resolvedProfile: desiredProfile,
    providerHost,
  };
}

export async function resolvedProviderProfile(
  root: string,
  distribution: DkbDistribution,
  target?: string,
  libraryRoot?: string,
  targetOptions?: Record<string, Record<string, unknown>>,
): Promise<DkbResolvedRetrievalProfile> {
  const host = await DkbProviderHost.create({
    root,
    distribution,
    ...(target ? { target } : {}),
    ...(libraryRoot ? { libraryRoot } : {}),
    ...(targetOptions ? { targetOptions } : {}),
  });

  try {
    return await resolveProviderRetrievalProfile(host);
  } finally {
    await host.dispose();
  }
}

export async function collectRegistryStateForVerification(registry: LoadedLibrary): Promise<RegistryCompileState> {
  const allDkbs = uniqueDkbs([
    ...registry.collections.flatMap((collection) => collection.dkbs),
    ...registry.dkbs,
  ]);
  const packageEntries = await Promise.all(allDkbs.map((dkb) => collectDkbVerificationState(dkb, registry.root)));

  return {
    sourceUnits: packageEntries.flatMap((entry) => entry.sourceUnits),
    packages: Object.fromEntries(packageEntries.map((entry) => [entry.package.id, entry.package])),
    compilerArtifacts: [],
  };
}

export async function lockPackageForDkb(
  dkb: LoadedDkb,
  sourceUnits: IndexedSourceUnit[],
  artifactRoot: string,
): Promise<DkbLockManifest['packages'][string]> {
  const sourceUnitsByStore = countSourceUnitsByStore(sourceUnits);
  const stores = await Promise.all(storesForDkb(dkb).map(async (store) => {
    const storePath = store.path ? resolveFrom(dkb.root, store.path) : null;

    return {
      id: store.id,
      type: store.type,
      path: storePath ? path.relative(dkb.root, storePath).replace(/\\/g, '/') || '.' : undefined,
      connectionRef: store.connectionRef,
      hash: storePath ? await hashStoreForDkb(dkb, store, storePath) : stableHash({ connectionRef: store.connectionRef, type: store.type }),
      recordCount: sourceUnitsByStore.get(store.id) ?? 0,
    };
  }));

  return {
    id: dkb.manifest.id,
    name: dkb.manifest.name,
    version: dkb.manifest.version,
    path: dkb.packagePath ? path.relative(artifactRoot, dkb.packagePath).replace(/\\/g, '/') : null,
    manifestHash: dkb.manifestHash ?? stableHash(dkb.manifest),
    sourceInventoryHash: stableHash(stores),
    recordCount: sourceUnits.length,
    stores,
  };
}

async function collectDkbVerificationState(dkb: LoadedDkb, artifactRoot: string): Promise<{
  package: DkbLockManifest['packages'][string];
  sourceUnits: IndexedSourceUnit[];
}> {
  const graph = await validatePackageBuildGraph(dkb.root);
  const catalog = readEvidenceCatalog(graph.evidencePath);
  const sourceUnits = catalog.records.map(sourceUnitFromEvidenceCatalog);
  return {
    package: await lockPackageForDkb(dkb, sourceUnits, artifactRoot),
    sourceUnits,
  };
}

async function collectDkbState(
  dkb: LoadedDkb,
  desiredProfile: DkbResolvedRetrievalProfile,
  artifactRoot: string,
  providerHost: DkbProviderHost,
  signal?: AbortSignal,
  execution?: ProviderExecutionFactory,
): Promise<{
  package: DkbLockManifest['packages'][string];
  sourceUnits: IndexedSourceUnit[];
  compilerArtifact?: CompilerArtifactState;
}> {
  const built = await buildSourceUnitsForDkb(dkb, desiredProfile, providerHost, signal, execution);

  return {
    package: await lockPackageForDkb(dkb, built.units, artifactRoot),
    sourceUnits: built.units,
    compilerArtifact: {
      dkb,
      dkbRoot: dkb.root,
      compiled: built.compiled,
      evidence: built.evidence,
      corpus: built.corpus,
      diskCapacity: built.diskCapacity,
    },
  };
}

async function buildSourceUnitsForDkb(
  dkb: LoadedDkb,
  desiredProfile: DkbResolvedRetrievalProfile,
  providerHost: DkbProviderHost,
  signal?: AbortSignal,
  execution?: ProviderExecutionFactory,
) {
  const ingested = await ingestDkbWithProviderHost(providerHost, dkb, { signal, execution });
  signal?.throwIfAborted();
  const evidenceRecords = ingested.records.map((record) => evidenceSourceRecordFromPipelineRecord(dkb, record));
  const evidence = buildEvidenceIr([{ records: evidenceRecords }], {
    evidenceProfileDigest: desiredProfile.evidenceProfileDigest,
  });
  const sourceStatistics = sourceStatisticsForStores(await quickStoreSnapshotsForDkb(dkb));
  const corpus = summarizeEvidenceCorpus(evidence, sourceStatistics);
  const diskCapacity = await assertDiskCapacity(
    dkb.root,
    estimateRetrievalWorkingBytes(corpus, desiredProfile.embedding?.dimensions ?? 0),
    `retrieval compilation of ${dkb.manifest.id}@${dkb.manifest.version}`,
  );
  const annotated = annotateEvidenceIds(dkb, ingested, evidence.evidenceProfileDigest);
  const compiled = await embedDkbEvidenceWithProviderHost(providerHost, annotated, { signal });
  const unique = new Map<string, IndexedSourceUnit>();

  for (const record of compiled.records) {
    const unit = indexedSourceUnitFromPipelineRecord(dkb, record);
    unique.set(unit.id, unit);
  }

  return {
    units: [...unique.values()].sort((a, b) => a.id.localeCompare(b.id)),
    compiled,
    evidence,
    corpus,
    diskCapacity,
  };
}

function annotateEvidenceIds(
  dkb: LoadedDkb,
  compiled: DkbEvidencePipeline,
  evidenceProfileDigest: string,
): DkbEvidencePipeline {
  return {
    ...compiled,
    records: compiled.records.map((record) => {
      const source = evidenceSourceRecordFromPipelineRecord(dkb, record);
      const sourceEvidenceId = evidenceIdentityForRecord(source).evidenceId;
      const evidenceId = stableHash({ sourceEvidenceId, evidenceProfileDigest });
      return {
        ...record,
        id: evidenceId,
        metadata: {
          ...record.metadata,
          dkb_evidence_id: evidenceId,
        },
      };
    }),
  };
}

function sourceUnitFromEvidenceCatalog(record: DkbEvidenceCatalogRecord): IndexedSourceUnit {
  return {
    id: record.evidenceId,
    evidenceId: record.evidenceId,
    assetId: record.assetId,
    dkbId: record.packageId,
    packageVersion: record.packageVersion,
    storeId: record.storeId,
    type: record.sourceType,
    locator: record.locator,
    assetLocator: record.assetLocator,
    title: record.title,
    text: record.text,
    keywords: record.keywords,
    capabilities: record.capabilities,
    ...(record.queryable ? { queryable: record.queryable } : {}),
    hash: record.textHash,
    updatedAt: record.updatedAt,
    chunkOrdinal: record.chunkOrdinal,
    chunkStart: record.chunkStart,
    chunkEnd: record.chunkEnd,
    ...(record.heading ? { heading: record.heading } : {}),
  };
}

function countSourceUnitsByStore(units: IndexedSourceUnit[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const unit of units) counts.set(unit.storeId, (counts.get(unit.storeId) ?? 0) + 1);
  return counts;
}

function numberRecord(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value).filter((entry): entry is [string, number] => {
    return typeof entry[1] === 'number' && Number.isFinite(entry[1]);
  });
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
