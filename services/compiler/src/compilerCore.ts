import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { adapterFor } from '@sjshovan/dkb-library/adapters/index.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { loadCompose } from '@sjshovan/dkb-protocol/manifest.js';
import { DKB_COMPILE_RECEIPT_PATH, resolveFrom } from '@sjshovan/dkb-protocol/paths.js';
import type { LoadedCollection } from '@sjshovan/dkb-protocol/types.js';
import {
  DKB_EVIDENCE_BUILD_IR,
  listPackageBuilds,
  readRetrievalBuildProfile,
  mergeStoredPackageBuilds,
} from '@sjshovan/dkb-library/builds.js';
import { DKB_EVIDENCE_CATALOG_FILENAME } from '@sjshovan/dkb-protocol/evidence/catalog.js';
import { DKB_ARTIFACT_MANIFEST_FILENAME } from '@sjshovan/dkb-protocol/artifacts.js';
import { retrievalProfileLockForRetrievalPipelines } from '@sjshovan/dkb-pipeline/profile.js';
import { validateEvidenceIr, type DkbEvidenceIr } from '@sjshovan/dkb-protocol/evidence/ir.js';
import { DkbProviderHost } from '@sjshovan/dkb-pipeline/host.js';
import { indexedSourceUnitFromPipelineRecord } from './records.js';
import { embedDkbEvidenceWithProviderHost } from './pipelineRunner.js';
import { summarizeEvidenceCorpus } from './buildStatistics.js';
import { assertDiskCapacity, estimateIngestionWorkingBytes, estimateRetrievalWorkingBytes } from './diskCapacity.js';
import { withCompileLock } from './compileLock.js';
import { isGeneratedPackagePath, uniqueDkbs } from './sourceHashing.js';
import {
  quickSourceSnapshotForRegistry,
  sourceStatisticsForSnapshot,
  writeCompileCache,
} from './compileCache.js';
import { writeAtomicCompileArtifacts } from './buildStorage.js';
import type { CompilerArtifactState, RegistryCompileState } from './compilerState.js';
import { createCompilerWorkDirectory } from './workRoot.js';
import {
  collectRegistryState,
  lockPackageForDkb,
  pipelineFromEvidenceIr,
  providerStageStatistics,
  resolvedProviderProfile,
} from './compilationState.js';
import {
  cachedCompileResultFor,
  lockForState,
  readCompileStatistics,
  writeCompileReceipt,
} from './compileReceipts.js';
import type {
  CompiledCollection,
  CompiledComposeProject,
  CompileComposeProjectOptions,
  CompileRetrievalFromEvidenceOptions,
  PreparedPackageBuildTarget,
} from './compilerContracts.js';

export { COMPILE_LOCK_PATH } from './compileLock.js';
export { COMPILE_CACHE_PATH } from './compileCache.js';
export { verifyComposeProject } from './compileReceipts.js';
export type {
  CompiledCollection,
  CompiledComposeProject,
  CompileComposeProfile,
  CompileComposeProjectOptions,
  CompileRetrievalFromEvidenceOptions,
  PreparedPackageBuildTarget,
  VerifyComposeProjectResult,
} from './compilerContracts.js';
export const COMPILE_RECEIPT_PATH = DKB_COMPILE_RECEIPT_PATH;

export async function compileCollection(collection: LoadedCollection): Promise<CompiledCollection> {
  const dkbs = await Promise.all(collection.dkbs.map(async (dkb) => {
    const adapter = await adapterFor(dkb.manifest.adapter);
    const records = await adapter.readRecords(dkb);
    return {
      id: dkb.manifest.id,
      name: dkb.manifest.name,
      version: dkb.manifest.version,
      adapter: dkb.manifest.adapter,
      records: records.length,
    };
  }));

  return {
    id: collection.manifest.id,
    name: collection.manifest.name,
    version: collection.manifest.version,
    dkbs,
    recordCount: dkbs.reduce((total, dkb) => total + dkb.records, 0),
  };
}

export async function compileComposeProject(
  root: string,
  options: CompileComposeProjectOptions,
): Promise<CompiledComposeProject> {
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
    const existingBuilds = await listPackageBuilds(resolvedRoot);
    const existingMatch = existingBuilds.retrieval.find((build) => build.profileDigest === desiredProfile.retrievalProfileDigest);
    const existingProfile = existingMatch ? await readRetrievalBuildProfile(existingMatch.path) : null;
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
          ...(statistics ? {
            statistics: {
              ...statistics,
              diskCapacity: { retrieval: [] },
              providerStages: [],
            },
          } : {}),
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
      await writeCompileReceipt(lockPath, written.lock);
      await writeCompileCache(resolvedRoot, registry, sourceSnapshot, lockPath);
      const compileCacheWriteMs = elapsedMs(cacheWriteStart);
      const statistics = await readCompileStatistics(resolvedRoot, sourceStatistics);

      return {
        registryId: registry.manifest.id,
        recordCount: state.sourceUnits.length,
        evidenceCatalogPath: path.join(written.buildGraph.evidencePath, DKB_EVIDENCE_CATALOG_FILENAME),
        retrievalManifestPath: path.join(written.buildGraph.retrievalPath, DKB_ARTIFACT_MANIFEST_FILENAME),
        retrievalBuildPath: written.buildGraph.retrievalPath,
        lockPath,
        lock: written.lock,
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
          ...(statistics ? {
            statistics: {
              ...statistics,
              diskCapacity: {
                ingestion: ingestionCapacity,
                retrieval: state.compilerArtifacts.map((artifact) => artifact.diskCapacity),
              },
              providerStages: providerStageStatistics(state),
            },
          } : {}),
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
    const packageEvidence = evidence.evidence.filter((record) => {
      return record.packageId === dkb.manifest.id && record.packageVersion === dkb.manifest.version;
    });
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
    const providerHost = await DkbProviderHost.create({
      root: contextRoot,
      distribution: options.distribution,
      target: desiredProfile.target,
    });

    try {
      const compiled = await embedDkbEvidenceWithProviderHost(providerHost, pipelineFromEvidenceIr(evidence));
      const units = compiled.records.map((record) => indexedSourceUnitFromPipelineRecord(dkb, record));
      const artifact: CompilerArtifactState = {
        dkb,
        dkbRoot: dkb.root,
        compiled,
        evidence,
        corpus,
        diskCapacity: retrievalCapacity,
      };
      const retrievalProfileLock = retrievalProfileLockForRetrievalPipelines(desiredProfile, [compiled]);
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
        retrievalBuildPath: written.buildGraph.retrievalPath,
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
          ...(statistics ? {
            statistics: {
              ...statistics,
              diskCapacity: { retrieval: [retrievalCapacity] },
              providerStages: providerStageStatistics(state),
            },
          } : {}),
        },
      };
    } finally {
      await providerHost.dispose();
    }
  });
}

export async function ensurePackageBuildForTarget(
  root: string,
  options: CompileRetrievalFromEvidenceOptions,
): Promise<PreparedPackageBuildTarget> {
  const resolvedRoot = path.resolve(root);
  const contextRoot = path.resolve(options.contextRoot ?? resolvedRoot);
  const profile = await resolvedProviderProfile(contextRoot, options.distribution, options.target, options.libraryRoot);
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

  const profileEvidence = builds.evidence.filter((build) => build.profileDigest === profile.evidenceProfileDigest);
  const unambiguousEvidence = profileEvidence.length === 1 ? profileEvidence[0] : undefined;
  const stagingParent = await createCompilerWorkDirectory('dkb-package-build-');
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
      await compileRetrievalFromEvidence(stagingRoot, evidence, {
        distribution: options.distribution,
        target: options.target,
        contextRoot,
      });
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

function elapsedMs(start: number): number {
  return Math.round((performance.now() - start) * 1000) / 1000;
}
