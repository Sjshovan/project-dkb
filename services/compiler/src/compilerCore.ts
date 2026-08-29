import { adapterFor } from '@sjshovan/dkb-library/adapters/index.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { loadCompose } from '@sjshovan/dkb-protocol/manifest.js';
import { DKB_COMPILE_RECEIPT_PATH, DKB_RUNTIME_LOCK_PATH, resolveFrom } from '@sjshovan/dkb-protocol/paths.js';
import { validateDkbLockManifest } from '@sjshovan/dkb-protocol/validation.js';
import type { DkbLockManifest, LoadedCollection, LoadedDkb, LoadedLibrary } from '@sjshovan/dkb-protocol/types.js';
import {
  DKB_EVIDENCE_BUILD_IR,
  listPackageBuilds,
  maybeReadRuntimeLock,
  mergeStoredPackageBuilds,
  validatePackageBuildGraph,
  type DkbPackageBuildGraph,
} from '@sjshovan/dkb-library/builds.js';
import { readEvidenceCatalog } from '@sjshovan/dkb-library/evidenceCatalog.js';
import { DKB_EVIDENCE_CATALOG_FILENAME, type DkbEvidenceCatalogRecord } from '@sjshovan/dkb-protocol/evidence/catalog.js';
import { DKB_ARTIFACT_MANIFEST_FILENAME, validateArtifactManifest } from '@sjshovan/dkb-protocol/artifacts.js';
import {
  DKB_RETRIEVAL_PROFILE_LOCK_PATH,
  resolveProviderRetrievalProfile,
  retrievalProfileLockForCompiledPipelines,
  type DkbResolvedRetrievalProfile,
} from '@sjshovan/dkb-pipeline/profile.js';
import { buildEvidenceIr, evidenceIdentityForRecord, DKB_EVIDENCE_IR_FORMAT, validateEvidenceIr, type DkbEvidenceIr } from '@sjshovan/dkb-protocol/evidence/ir.js';
import { DkbProviderHost, type DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import { evidenceSourceRecordFromPipelineRecord, indexedSourceUnitFromPipelineRecord } from './records.js';
import { embedDkbEvidenceWithProviderHost, ingestDkbWithProviderHost } from './pipelineRunner.js';
import type { DkbCompiledPipeline, IndexedSourceUnit } from '@sjshovan/dkb-pipeline/types.js';
import {
  summarizeBuildStorage,
  summarizeEvidenceCorpus,
  type DkbBuildStorageStatistics,
  type DkbCorpusStatistics,
  type DkbSourceStatistics,
} from './buildStatistics.js';
import {
  assertDiskCapacity,
  estimateIngestionWorkingBytes,
  estimateRetrievalWorkingBytes,
  type DkbDiskCapacityCheck,
} from './diskCapacity.js';
import { COMPILE_LOCK_PATH, withCompileLock } from './compileLock.js';
import {
  hashStoreForDkb,
  isGeneratedPackagePath,
  maybeHashArtifact,
  maybeHashFile,
  parseLock,
  uniqueDkbs,
} from './sourceHashing.js';
import {
  COMPILE_CACHE_PATH,
  COMPILE_CACHE_VERSION,
  hashString,
  maybeReadFile,
  quickArtifactSnapshotFor,
  quickSourceSnapshotForRegistry,
  quickStoreSnapshotsForDkb,
  readCompileCache,
  sourceStatisticsForSnapshot,
  sourceStatisticsForStores,
  storesForDkb,
  writeCompileCache,
  type QuickSourceSnapshot,
} from './compileCache.js';
import { writeAtomicCompileArtifacts } from './buildStorage.js';
import type {
  AtomicCompileArtifactTimings,
  CompilerArtifactState,
  RegistryCompileState,
} from './compilerState.js';

export { COMPILE_LOCK_PATH } from './compileLock.js';
export { COMPILE_CACHE_PATH } from './compileCache.js';
export const COMPILE_RECEIPT_PATH = DKB_COMPILE_RECEIPT_PATH;

export interface CompiledCollection {
  id: string;
  name: string;
  version: string;
  dkbs: Array<{
    id: string;
    name: string;
    version: string;
    adapter: string;
    records: number;
  }>;
  recordCount: number;
}

export interface CompiledComposeProject {
  registryId: string;
  recordCount: number;
  evidenceCatalogPath: string;
  retrievalManifestPath: string;
  runtimeLockPath: string;
  lockPath: string;
  lock: DkbLockManifest;
  cacheHit: boolean;
  profile?: CompileComposeProfile;
}

export interface CompileComposeProfile {
  timingsMs: {
    sourceSnapshot: number;
    cacheLookup: number;
    collectState: number;
    aggregateArtifacts: number;
    compileCacheWrite: number;
    total: number;
  };
  aggregateTimingsMs?: AtomicCompileArtifactTimings;
  statistics?: {
    corpus: DkbCorpusStatistics;
    storage: DkbBuildStorageStatistics;
    diskCapacity: {
      ingestion?: DkbDiskCapacityCheck;
      retrieval: DkbDiskCapacityCheck[];
    };
    providerStages: Array<{
      packageId: string;
      ingestionTimingsMs?: Record<string, number>;
      ingestionWrapperTimingsMs?: Record<string, number>;
      embeddingTimingsMs?: Record<string, number>;
    }>;
  };
}

export interface PreparedPackageBuildTarget {
  target: string;
  preparation: 'retained' | 'retrieval_compiled' | 'evidence_compiled';
  evidenceProfileDigest: string;
  retrievalProfileDigest: string;
}

export interface CompileComposeProjectOptions {
  distribution: DkbDistribution;
  force?: boolean;
  mode?: 'library' | 'package';
  target?: string;
  contextRoot?: string;
}

export interface CompileRetrievalFromEvidenceOptions {
  distribution: DkbDistribution;
  target: string;
  contextRoot?: string;
}

export interface VerifyComposeProjectResult {
  ok: boolean;
  lockPath: string;
  checks: Array<{
    name: string;
    ok: boolean;
    detail: string;
  }>;
}

export async function compileCollection(collection: LoadedCollection): Promise<CompiledCollection> {
  const dkbs = await Promise.all(
    collection.dkbs.map(async (dkb) => {
      const adapter = await adapterFor(dkb.manifest.adapter);
      const records = await adapter.readRecords(dkb);

      return {
        id: dkb.manifest.id,
        name: dkb.manifest.name,
        version: dkb.manifest.version,
        adapter: dkb.manifest.adapter,
        records: records.length,
      };
    }),
  );

  return {
    id: collection.manifest.id,
    name: collection.manifest.name,
    version: collection.manifest.version,
    dkbs,
    recordCount: dkbs.reduce((total, dkb) => total + dkb.records, 0),
  };
}

export async function compileComposeProject(root: string, options: CompileComposeProjectOptions): Promise<CompiledComposeProject> {
  const resolvedRoot = path.resolve(root);

  return withCompileLock(resolvedRoot, async () => {
    const totalStart = performance.now();
    const registry = await loadCompose(resolvedRoot);
    const contextRoot = path.resolve(options.contextRoot ?? resolvedRoot);
    const desiredProfile = await resolvedProviderProfile(contextRoot, options.distribution, options.target);
    const lockPath = resolveFrom(resolvedRoot, COMPILE_RECEIPT_PATH);
    const sourceSnapshotStart = performance.now();
    const sourceSnapshot = await quickSourceSnapshotForRegistry(registry);
    const sourceStatistics = sourceStatisticsForSnapshot(sourceSnapshot);
    const sourceSnapshotMs = elapsedMs(sourceSnapshotStart);
    const cacheLookupStart = performance.now();
    const allDkbs = uniqueDkbs([
      ...registry.collections.flatMap((collection) => collection.dkbs),
      ...registry.dkbs,
    ]);
    const existingProfile = await import('@sjshovan/dkb-pipeline/profile.js').then((module) => module.maybeReadRetrievalProfileLock(resolvedRoot));
    const profileDrift = !existingProfile
      || existingProfile.profile.configDigest !== desiredProfile.configDigest
      || existingProfile.profile.providerBuildDigest !== desiredProfile.providerBuildDigest;
    const cached = options.force || profileDrift
      ? null
      : await cachedCompileResultFor(resolvedRoot, registry, sourceSnapshot, lockPath);
    const cacheLookupMs = elapsedMs(cacheLookupStart);

    if (cached) {
      const statistics = await readCompileStatistics(resolvedRoot, sourceStatistics);
      return {
        ...cached,
        profile: {
          timingsMs: {
            sourceSnapshot: sourceSnapshotMs,
            cacheLookup: cacheLookupMs,
            collectState: 0,
            aggregateArtifacts: 0,
            compileCacheWrite: 0,
            total: elapsedMs(totalStart),
          },
          ...(statistics ? { statistics: {
            ...statistics,
            diskCapacity: { retrieval: [] },
            providerStages: [],
          } } : {}),
        },
      };
    }

    const ingestionCapacity = await assertDiskCapacity(
      resolvedRoot,
      estimateIngestionWorkingBytes(sourceStatistics.bytes),
      `ingestion of ${registry.manifest.id}`,
    );
    const collectStateStart = performance.now();
    const state = await collectRegistryState(registry, desiredProfile, options.distribution, contextRoot);
    const collectStateMs = elapsedMs(collectStateStart);

    try {
      const aggregateStart = performance.now();
      const written = await writeAtomicCompileArtifacts(
        resolvedRoot,
        state,
        async (stageRoot, buildGraph) => lockForState(stageRoot, registry, state, new Date().toISOString(), buildGraph),
      );
      const aggregateArtifactsMs = elapsedMs(aggregateStart);
      const cacheWriteStart = performance.now();
      const lock = written.lock;
      await writeCompileReceipt(lockPath, lock);
      await writeCompileCache(resolvedRoot, registry, sourceSnapshot, lockPath);
      const compileCacheWriteMs = elapsedMs(cacheWriteStart);
      const statistics = await readCompileStatistics(resolvedRoot, sourceStatistics);

      return {
        registryId: registry.manifest.id,
        recordCount: state.sourceUnits.length,
        evidenceCatalogPath: path.join(written.buildGraph.evidencePath, DKB_EVIDENCE_CATALOG_FILENAME),
        retrievalManifestPath: path.join(written.buildGraph.retrievalPath, DKB_ARTIFACT_MANIFEST_FILENAME),
        runtimeLockPath: resolveFrom(resolvedRoot, DKB_RUNTIME_LOCK_PATH),
        lockPath,
        lock,
        cacheHit: false,
        profile: {
          timingsMs: {
            sourceSnapshot: sourceSnapshotMs,
            cacheLookup: cacheLookupMs,
            collectState: collectStateMs,
            aggregateArtifacts: aggregateArtifactsMs,
            compileCacheWrite: compileCacheWriteMs,
            total: elapsedMs(totalStart),
          },
          aggregateTimingsMs: written.timings,
          ...(statistics ? { statistics: {
            ...statistics,
            diskCapacity: {
              ingestion: ingestionCapacity,
              retrieval: state.compilerArtifacts.map((artifact) => artifact.diskCapacity),
            },
            providerStages: providerStageStatistics(state),
          } } : {}),
        },
      };
    } finally {
      await state.providerHost?.dispose();
    }
  });
}

export async function compileRetrievalFromEvidence(
  root: string,
  inputEvidence: DkbEvidenceIr,
  options: CompileRetrievalFromEvidenceOptions,
): Promise<CompiledComposeProject> {
  const resolvedRoot = path.resolve(root);
  const evidence = validateEvidenceIr(inputEvidence, 'retrieval-only Evidence Build');

  return withCompileLock(resolvedRoot, async () => {
    const totalStart = performance.now();
    const registry = await loadCompose(resolvedRoot);
    const allDkbs = uniqueDkbs([
      ...registry.collections.flatMap((collection) => collection.dkbs),
      ...registry.dkbs,
    ]);
    if (allDkbs.length !== 1) {
      throw new DkbError(`Retrieval-only compilation requires exactly one PackageVersion, got ${allDkbs.length}`);
    }
    const dkb = allDkbs[0]!;
    const contextRoot = path.resolve(options.contextRoot ?? resolvedRoot);
    const desiredProfile = await resolvedProviderProfile(contextRoot, options.distribution, options.target);
    if (desiredProfile.evidenceProfileDigest !== evidence.evidenceProfileDigest) {
      throw new DkbError(
        `Evidence Profile mismatch: target ${options.target} requires ${desiredProfile.evidenceProfileDigest}, Evidence Build uses ${evidence.evidenceProfileDigest}`,
      );
    }
    const packageEvidence = evidence.evidence.filter((record) => record.packageId === dkb.manifest.id && record.packageVersion === dkb.manifest.version);
    if (packageEvidence.length !== evidence.evidence.length) {
      throw new DkbError(`Evidence Build identity does not match ${dkb.manifest.id}@${dkb.manifest.version}`);
    }
    const sourceStatistics = sourceStatisticsForSnapshot(await quickSourceSnapshotForRegistry(registry));
    const corpus = summarizeEvidenceCorpus(evidence, sourceStatistics);
    const retrievalCapacity = await assertDiskCapacity(
      resolvedRoot,
      estimateRetrievalWorkingBytes(corpus, desiredProfile.embedding.dimensions),
      `retrieval compilation of ${dkb.manifest.id}@${dkb.manifest.version}`,
    );
    const providerHost = await DkbProviderHost.create({ root: contextRoot, distribution: options.distribution, target: desiredProfile.target });

    try {
      const evidencePipeline = pipelineFromEvidenceIr(evidence);
      const compiled = await embedDkbEvidenceWithProviderHost(providerHost, evidencePipeline);
      const units = compiled.records.map((record) => indexedSourceUnitFromPipelineRecord(dkb, record));
      const artifact: CompilerArtifactState = {
        dkb,
        dkbRoot: dkb.root,
        compiled,
        evidence,
        corpus,
        diskCapacity: retrievalCapacity,
      };
      const retrievalProfileLock = retrievalProfileLockForCompiledPipelines(desiredProfile, [compiled]);
      const state: RegistryCompileState = {
        sourceUnits: units,
        packages: {
          [dkb.manifest.id]: await lockPackageForDkb(dkb, units, registry.root),
        },
        compilerArtifacts: [artifact],
        retrievalProfileLock,
        resolvedProfile: desiredProfile,
        providerHost,
      };
      const written = await writeAtomicCompileArtifacts(
        resolvedRoot,
        state,
        async (stageRoot, buildGraph) => lockForState(stageRoot, registry, state, new Date().toISOString(), buildGraph),
      );
      const lockPath = resolveFrom(resolvedRoot, COMPILE_RECEIPT_PATH);
      await writeCompileReceipt(lockPath, written.lock);
      const statistics = await readCompileStatistics(resolvedRoot, sourceStatistics);

      return {
        registryId: registry.manifest.id,
        recordCount: state.sourceUnits.length,
        evidenceCatalogPath: path.join(written.buildGraph.evidencePath, DKB_EVIDENCE_CATALOG_FILENAME),
        retrievalManifestPath: path.join(written.buildGraph.retrievalPath, DKB_ARTIFACT_MANIFEST_FILENAME),
        runtimeLockPath: resolveFrom(resolvedRoot, DKB_RUNTIME_LOCK_PATH),
        lockPath,
        lock: written.lock,
        cacheHit: false,
        profile: {
          timingsMs: {
            sourceSnapshot: 0,
            cacheLookup: 0,
            collectState: 0,
            aggregateArtifacts: written.timings.total,
            compileCacheWrite: 0,
            total: elapsedMs(totalStart),
          },
          aggregateTimingsMs: written.timings,
          ...(statistics ? { statistics: {
            ...statistics,
            diskCapacity: { retrieval: [retrievalCapacity] },
            providerStages: providerStageStatistics(state),
          } } : {}),
        },
      };
    } finally {
      await providerHost.dispose();
    }
  });
}

/**
 * Materialize one exact package build without changing the package's active
 * artifacts or Runtime lock. This is the CLI-side preparation boundary used
 * before a Runtime performs an atomic Library-wide pipeline switch.
 */
export async function ensurePackageBuildForTarget(
  root: string,
  options: { distribution: DkbDistribution; target: string; contextRoot?: string },
): Promise<PreparedPackageBuildTarget> {
  const resolvedRoot = path.resolve(root);
  const contextRoot = path.resolve(options.contextRoot ?? resolvedRoot);
  const profile = await resolvedProviderProfile(contextRoot, options.distribution, options.target);
  const builds = await listPackageBuilds(resolvedRoot);
  const matchingRetrieval = builds.retrieval.filter((build) => build.profileDigest === profile.retrievalProfileDigest);
  if (matchingRetrieval.length > 1) {
    throw new DkbError(
      `Package has multiple Retrieval Builds for exact profile ${profile.retrievalProfileDigest}; immutable compilation is non-deterministic`,
    );
  }
  if (matchingRetrieval.length === 1) {
    return {
      target: profile.target,
      preparation: 'retained',
      evidenceProfileDigest: profile.evidenceProfileDigest,
      retrievalProfileDigest: profile.retrievalProfileDigest,
    };
  }

  const current = await maybeReadRuntimeLock(resolvedRoot);
  const currentEntry = current && current.evidenceProfileDigest === profile.evidenceProfileDigest
    ? Object.values(current.packages)[0]
    : undefined;
  const exactEvidence = currentEntry
    ? builds.evidence.find((build) => build.profileDigest === profile.evidenceProfileDigest
      && build.evidenceDigest === currentEntry.evidenceDigest)
    : undefined;
  const unambiguousEvidence = exactEvidence
    ?? (builds.evidence.filter((build) => build.profileDigest === profile.evidenceProfileDigest).length === 1
      ? builds.evidence.find((build) => build.profileDigest === profile.evidenceProfileDigest)
      : undefined);
  const stagingParent = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-package-build-'));
  const stagingRoot = path.join(stagingParent, 'package');

  try {
    await fs.cp(resolvedRoot, stagingRoot, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: (source) => !isGeneratedPackagePath(resolvedRoot, source),
    });
    if (unambiguousEvidence) {
      const evidencePath = path.join(unambiguousEvidence.path, DKB_EVIDENCE_BUILD_IR);
      const evidence = validateEvidenceIr(JSON.parse(await fs.readFile(evidencePath, 'utf8')), evidencePath);
      await compileRetrievalFromEvidence(stagingRoot, evidence, { distribution: options.distribution, target: options.target, contextRoot });
    } else {
      await compileComposeProject(stagingRoot, {
        mode: 'package',
        distribution: options.distribution,
        force: true,
        target: options.target,
        contextRoot,
      });
    }
    await mergeStoredPackageBuilds(stagingRoot, resolvedRoot);
    const prepared = await listPackageBuilds(resolvedRoot);
    if (!prepared.retrieval.some((build) => build.profileDigest === profile.retrievalProfileDigest)) {
      throw new DkbError(`Compiler did not retain the expected Retrieval Build for ${options.target}`);
    }
    return {
      target: profile.target,
      preparation: unambiguousEvidence ? 'retrieval_compiled' : 'evidence_compiled',
      evidenceProfileDigest: profile.evidenceProfileDigest,
      retrievalProfileDigest: profile.retrievalProfileDigest,
    };
  } finally {
    await fs.rm(stagingParent, { recursive: true, force: true });
  }
}

function pipelineFromEvidenceIr(evidence: DkbEvidenceIr): DkbCompiledPipeline {
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
        metadata: {
          assetId: record.assetId,
          storeId: record.storeId,
          type: record.sourceType,
          locator: record.locator,
          assetLocator: record.assetLocator,
          title: record.title,
          hash: record.textHash,
          updatedAt: '1970-01-01T00:00:00.000Z',
          chunkOrdinal: chunk.ordinal,
          chunkStart: chunk.start,
          chunkEnd: chunk.end,
          sourceMetadata: {
            ...record.provenance,
            dkb_package_id: record.packageId,
            dkb_package_version: record.packageVersion,
            dkb_source_hash: record.sourceHash,
            dkb_evidence_id: record.evidenceId,
          },
        },
      };
    }),
    receipts: [],
  };
}

export async function verifyComposeProject(root: string): Promise<VerifyComposeProjectResult> {
  const resolvedRoot = path.resolve(root);
  const lockPath = resolveFrom(resolvedRoot, COMPILE_RECEIPT_PATH);
  const registry = await loadCompose(resolvedRoot);
  const current = await collectRegistryStateForVerification(registry);
  const lock = validateDkbLockManifest(parseLock(await fs.readFile(lockPath, 'utf8'), lockPath), lockPath);
  const expected = await lockForState(resolvedRoot, registry, current, lock.compiled?.compiledAt ?? new Date().toISOString());
  const buildChecks = await Promise.all(uniqueDkbs([
    ...registry.collections.flatMap((collection) => collection.dkbs),
    ...registry.dkbs,
  ]).map(async (dkb) => {
    try {
      const graph = await validatePackageBuildGraph(dkb.root);
      return {
        name: `build.${dkb.manifest.id}`,
        ok: graph.evidence.package.id === dkb.manifest.id && graph.evidence.package.version === dkb.manifest.version,
        detail: `${graph.evidence.evidenceDigest} -> ${graph.retrieval.retrievalBuildDigest}`,
      };
    } catch (error) {
      return { name: `build.${dkb.manifest.id}`, ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }));
  const checks = [
    {
      name: 'registry',
      ok: lock.registry.id === expected.registry.id,
      detail: `${lock.registry.id} expected ${expected.registry.id}`,
    },
    {
      name: 'packages',
      ok: stableHash(lock.packages) === stableHash(expected.packages),
      detail: packageVerificationDetail(lock.packages, expected.packages),
    },
    ...buildChecks,
  ];

  return {
    ok: checks.every((check) => check.ok),
    lockPath,
    checks,
  };
}

function packageVerificationDetail(
  locked: DkbLockManifest['packages'],
  current: DkbLockManifest['packages'],
): string {
  const differences: string[] = [];
  const packageIds = [...new Set([...Object.keys(locked), ...Object.keys(current)])].sort();

  for (const packageId of packageIds) {
    const lockedPackage = locked[packageId];
    const currentPackage = current[packageId];

    if (!lockedPackage || !currentPackage) {
      differences.push(`${packageId}:presence`);
      continue;
    }

    for (const field of Object.keys(lockedPackage) as Array<keyof typeof lockedPackage>) {
      if (stableHash(lockedPackage[field]) !== stableHash(currentPackage[field])) {
        differences.push(`${packageId}:${String(field)} (${String(lockedPackage[field])} != ${String(currentPackage[field])})`);
      }
    }
  }

  return differences.length > 0
    ? `package lock mismatch in ${differences.join(', ')}`
    : 'package manifest, source, and chunk hashes match lockfile';
}

async function cachedCompileResultFor(
  root: string,
  registry: LoadedLibrary,
  sourceSnapshot: QuickSourceSnapshot,
  lockPath: string,
): Promise<CompiledComposeProject | null> {
  if (!sourceSnapshot.cacheable) {
    return null;
  }

  const [lockSource, cache] = await Promise.all([
    maybeReadFile(lockPath),
    readCompileCache(root),
  ]);

  if (!lockSource || !cache || cache.version !== COMPILE_CACHE_VERSION || cache.registryId !== registry.manifest.id) {
    return null;
  }

  const lockHash = hashString(lockSource);

  if (cache.lockHash !== lockHash || cache.sourceSnapshotHash !== sourceSnapshot.hash) {
    return null;
  }

  const artifactSnapshot = await quickArtifactSnapshotFor(root);

  if (!artifactSnapshot.requiredArtifactsReady || cache.artifactSnapshotHash !== artifactSnapshot.hash) {
    return null;
  }

  const dkbs = uniqueDkbs([...registry.collections.flatMap((collection) => collection.dkbs), ...registry.dkbs]);
  if (dkbs.length !== 1) return null;
  const graph = await validatePackageBuildGraph(dkbs[0]!.root).catch(() => null);
  if (!graph) return null;

  const lock = validateDkbLockManifest(parseLock(lockSource, lockPath), lockPath);

  return {
    registryId: lock.registry.id,
    recordCount: lock.compiled?.recordCount ?? Object.values(lock.packages).reduce((total, item) => total + item.recordCount, 0),
    evidenceCatalogPath: path.join(graph.evidencePath, DKB_EVIDENCE_CATALOG_FILENAME),
    retrievalManifestPath: path.join(graph.retrievalPath, DKB_ARTIFACT_MANIFEST_FILENAME),
    runtimeLockPath: resolveFrom(root, DKB_RUNTIME_LOCK_PATH),
    lockPath,
    lock,
    cacheHit: true,
  };
}

async function writeCompileReceipt(target: string, lock: DkbLockManifest): Promise<void> {
  const temporary = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  await fs.rm(target, { force: true });
  await fs.rename(temporary, target);
}

async function readCompileStatistics(
  root: string,
  source: DkbSourceStatistics,
): Promise<{ corpus: DkbCorpusStatistics; storage: DkbBuildStorageStatistics } | null> {
  try {
    const compose = await loadCompose(root);
    const dkbs = uniqueDkbs([
      ...compose.collections.flatMap((collection) => collection.dkbs),
      ...compose.dkbs,
    ]);
    const layers = await Promise.all(dkbs.map(async (dkb) => {
      const graph = await validatePackageBuildGraph(dkb.root);
      const evidencePath = path.join(graph.evidencePath, DKB_EVIDENCE_BUILD_IR);
      const manifestPath = path.join(graph.retrievalPath, DKB_ARTIFACT_MANIFEST_FILENAME);
      return {
        evidence: validateEvidenceIr(JSON.parse(await fs.readFile(evidencePath, 'utf8')), evidencePath),
        manifest: validateArtifactManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')), manifestPath),
        root: dkb.root,
      };
    }));
    const evidence = {
      format: layers[0]?.evidence.format ?? DKB_EVIDENCE_IR_FORMAT,
      evidenceProfileDigest: layers[0]?.evidence.evidenceProfileDigest ?? stableHash({ empty: true }),
      evidenceDigest: stableHash(layers.map((layer) => layer.evidence.evidenceDigest)),
      evidence: layers.flatMap((layer) => layer.evidence.evidence),
      chunks: layers.flatMap((layer) => layer.evidence.chunks),
    } as DkbEvidenceIr;

    return {
      corpus: summarizeEvidenceCorpus(evidence, source),
      storage: await summarizeBuildStorage(root, layers.map((layer) => layer.manifest), source.bytes, layers.map((layer) => layer.root)),
    };
  } catch {
    return null;
  }
}

function providerStageStatistics(state: RegistryCompileState): NonNullable<CompileComposeProfile['statistics']>['providerStages'] {
  return state.compilerArtifacts.map((artifact) => {
    const evidenceProviderIds = new Set(state.resolvedProfile?.providers
      .filter((provider) => provider.kind === 'evidence' || provider.kind === 'parser' || provider.kind === 'chunker')
      .map((provider) => provider.id) ?? []);
    const evidenceReceipt = artifact.compiled.receipts.find((receipt) => evidenceProviderIds.has(receipt.providerId));
    const embeddingReceipt = artifact.compiled.receipts.find((receipt) => {
      return receipt.providerId === state.resolvedProfile?.embedding.adapter
        && isRecord(receipt.build.timingsMs);
    });
    const evidenceExecution = isRecord(evidenceReceipt?.build.execution) ? evidenceReceipt.build.execution : undefined;
    const ingestionTimingsMs = numberRecord(evidenceExecution?.timingsMs);
    const ingestionWrapperTimingsMs = numberRecord(evidenceExecution?.wrapperTimingsMs);
    const embeddingTimingsMs = numberRecord(embeddingReceipt?.build.timingsMs);

    return {
      packageId: artifact.dkb.manifest.id,
      ...(ingestionTimingsMs ? { ingestionTimingsMs } : {}),
      ...(ingestionWrapperTimingsMs ? { ingestionWrapperTimingsMs } : {}),
      ...(embeddingTimingsMs ? { embeddingTimingsMs } : {}),
    };
  });
}

function numberRecord(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value).filter((entry): entry is [string, number] => {
    return typeof entry[1] === 'number' && Number.isFinite(entry[1]);
  });
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

async function collectRegistryState(
  registry: LoadedLibrary,
  desiredProfile: DkbResolvedRetrievalProfile,
  distribution: DkbDistribution,
  contextRoot = registry.root,
): Promise<RegistryCompileState> {
  const allDkbs = uniqueDkbs([
    ...registry.collections.flatMap((collection) => collection.dkbs),
    ...registry.dkbs,
  ]);
  const providerHost = await DkbProviderHost.create({ root: contextRoot, distribution, target: desiredProfile.target });
  let packageEntries: Awaited<ReturnType<typeof collectDkbState>>[];

  try {
    packageEntries = await Promise.all(allDkbs.map(async (dkb) => collectDkbState(dkb, desiredProfile, registry.root, providerHost)));
  } catch (error) {
    await providerHost.dispose();
    throw error;
  }
  const sourceUnits = packageEntries.flatMap((entry) => entry.sourceUnits);
  const packages = Object.fromEntries(packageEntries.map((entry) => [entry.package.id, entry.package]));

  const compilerArtifacts = packageEntries.flatMap((entry) => entry.compilerArtifact ? [entry.compilerArtifact] : []);
  const retrievalProfileLock = desiredProfile && compilerArtifacts.length > 0
    ? retrievalProfileLockForCompiledPipelines(desiredProfile, compilerArtifacts.map((artifact) => artifact.compiled))
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

async function resolvedProviderProfile(root: string, distribution: DkbDistribution, target?: string): Promise<DkbResolvedRetrievalProfile> {
  const host = await DkbProviderHost.create({ root, distribution, ...(target ? { target } : {}) });

  try {
    return await resolveProviderRetrievalProfile(host);
  } finally {
    await host.dispose();
  }
}

async function collectRegistryStateForVerification(registry: LoadedLibrary): Promise<RegistryCompileState> {
  const allDkbs = uniqueDkbs([
    ...registry.collections.flatMap((collection) => collection.dkbs),
    ...registry.dkbs,
  ]);
  const packageEntries = await Promise.all(allDkbs.map((dkb) => collectDkbVerificationState(dkb, registry.root)));
  const sourceUnits = packageEntries.flatMap((entry) => entry.sourceUnits);
  const packages = Object.fromEntries(packageEntries.map((entry) => [entry.package.id, entry.package]));

  return {
    sourceUnits,
    packages,
    compilerArtifacts: [],
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
  desiredProfile?: DkbResolvedRetrievalProfile,
  artifactRoot = dkb.root,
  providerHost?: DkbProviderHost,
): Promise<{
  package: DkbLockManifest['packages'][string];
  sourceUnits: IndexedSourceUnit[];
  compilerArtifact?: CompilerArtifactState;
}> {
  const built = await buildSourceUnitsForDkb(dkb, desiredProfile, providerHost);

  return {
    package: await lockPackageForDkb(dkb, built.units, artifactRoot),
    sourceUnits: built.units,
    compilerArtifact: built.compiled ? {
      dkb,
      dkbRoot: dkb.root,
      compiled: built.compiled!,
      evidence: built.evidence!,
      corpus: built.corpus!,
      diskCapacity: built.diskCapacity!,
    } : undefined,
  };
}

async function lockPackageForDkb(
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

async function buildSourceUnitsForDkb(
  dkb: LoadedDkb,
  desiredProfile?: DkbResolvedRetrievalProfile,
  providerHost?: DkbProviderHost,
): Promise<{
  units: IndexedSourceUnit[];
  compiled?: DkbCompiledPipeline;
  evidence?: DkbEvidenceIr;
  corpus?: DkbCorpusStatistics;
  diskCapacity?: DkbDiskCapacityCheck;
}> {
  if (providerHost) {
    if (!desiredProfile) {
      throw new DkbError(`Provider compilation for ${dkb.manifest.id} requires a resolved pipeline profile`);
    }
    const ingested = await ingestDkbWithProviderHost(providerHost, dkb);
    const evidenceRecords = ingested.records.map((record) => evidenceSourceRecordFromPipelineRecord(dkb, record));
    const evidence = buildEvidenceIr([{ records: evidenceRecords }], {
      evidenceProfileDigest: desiredProfile.evidenceProfileDigest,
    });
    const sourceStatistics = sourceStatisticsForStores(await quickStoreSnapshotsForDkb(dkb));
    const corpus = summarizeEvidenceCorpus(evidence, sourceStatistics);
    const diskCapacity = await assertDiskCapacity(
      dkb.root,
      estimateRetrievalWorkingBytes(corpus, desiredProfile.embedding.dimensions),
      `retrieval compilation of ${dkb.manifest.id}@${dkb.manifest.version}`,
    );
    const annotated = annotateEvidenceIds(dkb, ingested, evidence.evidenceProfileDigest);
    const compiled = await embedDkbEvidenceWithProviderHost(providerHost, annotated);
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
  throw new DkbError(
    `Compilation for ${dkb.manifest.id} requires a selected Evidence provider. `
    + 'Library adapters never parse or chunk source content.',
  );
}

function annotateEvidenceIds(
  dkb: LoadedDkb,
  compiled: DkbCompiledPipeline,
  evidenceProfileDigest: string,
): DkbCompiledPipeline {
  return {
    ...compiled,
    records: compiled.records.map((record) => {
      const source = evidenceSourceRecordFromPipelineRecord(dkb, record);
      const sourceEvidenceId = evidenceIdentityForRecord(source).evidenceId;
      const evidenceId = stableHash({ sourceEvidenceId, evidenceProfileDigest });
      const sourceMetadata = isRecord(record.metadata.sourceMetadata) ? record.metadata.sourceMetadata : {};

      return {
        ...record,
        id: evidenceId,
        metadata: {
          ...record.metadata,
          sourceMetadata: {
            ...sourceMetadata,
            dkb_evidence_id: evidenceId,
          },
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

  for (const unit of units) {
    counts.set(unit.storeId, (counts.get(unit.storeId) ?? 0) + 1);
  }

  return counts;
}

async function lockForState(
  root: string,
  registry: LoadedLibrary,
  state: Awaited<ReturnType<typeof collectRegistryState>>,
  compiledAt: string,
  inputGraph?: DkbPackageBuildGraph,
): Promise<DkbLockManifest> {
  const packageDkbs = uniqueDkbs([
    ...registry.collections.flatMap((collection) => collection.dkbs),
    ...registry.dkbs,
  ]);
  const graph = inputGraph ?? (packageDkbs.length === 1 ? await validatePackageBuildGraph(packageDkbs[0]!.root) : undefined);
  const evidencePath = graph?.evidencePath ?? '';
  const retrievalPath = graph?.retrievalPath ?? '';
  const relative = (value: string) => value ? path.relative(root, value).replace(/\\/g, '/') : '';

  return {
    format: 'dkb.compile-receipt.v2',
    registry: {
      id: registry.manifest.id,
      name: registry.manifest.name,
      version: registry.manifest.version,
    },
    packages: state.packages,
    builds: {
      evidence: {
        path: relative(evidencePath),
        profileDigest: graph?.evidence.evidenceProfileDigest ?? null,
        digest: graph?.evidence.evidenceDigest ?? null,
        status: graph ? 'built' : 'not_built',
      },
      retrieval: {
        path: relative(retrievalPath),
        profileDigest: graph?.retrieval.retrievalProfileDigest ?? null,
        digest: graph?.retrieval.retrievalBuildDigest ?? null,
        compatibilityDigest: graph?.retrieval.compatibilityDigest ?? null,
        status: graph ? 'built' : 'not_built',
      },
      runtime: {
        path: DKB_RUNTIME_LOCK_PATH,
        target: graph?.runtime.target ?? '',
        digest: graph ? stableHash(graph.runtime) : null,
        status: graph ? 'built' : 'not_built',
      },
    },
    compiled: {
      recordCount: state.sourceUnits.length,
      compiledAt,
    },
  };
}

function elapsedMs(start: number): number {
  return Math.round((performance.now() - start) * 1000) / 1000;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
