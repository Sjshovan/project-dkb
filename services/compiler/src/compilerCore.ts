import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { loadCompose, loadManifest } from '@sjshovan/dkb-protocol/manifest.js';
import { DKB_COMPILE_RECEIPT_PATH, evidenceBuildPath, resolveFrom } from '@sjshovan/dkb-protocol/paths.js';
import { validateEvidenceBuildLock } from '@sjshovan/dkb-protocol/builds.js';
import { assertProviderExecutionIdentities } from '@sjshovan/dkb-protocol/providerReceipts.js';
import {
  DKB_EVIDENCE_BUILD_IR,
  DKB_EVIDENCE_BUILD_LOCK,
  listPackageBuilds,
  readRetrievalBuildProfile,
  mergeStoredPackageBuilds,
} from '@sjshovan/dkb-library/builds.js';
import { DKB_EVIDENCE_CATALOG_FILENAME } from '@sjshovan/dkb-protocol/evidence/catalog.js';
import { DKB_ARTIFACT_MANIFEST_FILENAME } from '@sjshovan/dkb-protocol/artifacts.js';
import { retrievalProfileLockForRetrievalPipelines } from '@sjshovan/dkb-pipeline/profile.js';
import { validateEvidenceIr, type DkbEvidenceIr } from '@sjshovan/dkb-protocol/evidence/ir.js';
import { withCompilationHost } from './compilationHost.js';
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
  CompiledComposeProject,
  CompiledKnowledgeTarget,
  CompiledLibraryProject,
  CompileComposeProjectOptions,
  CompileRetrievalFromEvidenceOptions,
  PreparedPackageBuildTarget,
} from './compilerContracts.js';

export { COMPILE_LOCK_PATH } from './compileLock.js';
export { COMPILE_CACHE_PATH } from './compileCache.js';
export { verifyComposeProject } from './compileReceipts.js';
export type {
  CompiledComposeProject,
  CompiledKnowledgeTarget,
  CompiledLibraryProject,
  CompileComposeProfile,
  CompileComposeProjectOptions,
  CompileRetrievalFromEvidenceOptions,
  PreparedPackageBuildTarget,
  VerifyComposeProjectResult,
} from './compilerContracts.js';
export const COMPILE_RECEIPT_PATH = DKB_COMPILE_RECEIPT_PATH;

export async function compileComposeProject(
  root: string,
  options: CompileComposeProjectOptions,
): Promise<CompiledComposeProject> {
  options.signal?.throwIfAborted();
  const resolvedRoot = path.resolve(root);
  const manifest = await loadManifest(resolvedRoot);
  if (manifest.type !== 'dkb') {
    throw new DkbError(
      `PackageVersion compilation requires a DKB manifest at ${resolvedRoot}; found ${manifest.type}. `
      + 'Use the Library compilation operation to build each editable DKB independently.',
    );
  }

  return withCompileLock(resolvedRoot, async () => {
    const totalStart = performance.now();
    const registry = await loadCompose(resolvedRoot);
    const contextRoot = path.resolve(options.contextRoot ?? resolvedRoot);
    return withCompilationHost({ root: contextRoot, distribution: options.distribution,
      ...(options.target ? { target: options.target } : {}),
      ...(options.targetOptions ? { targetOptions: options.targetOptions } : {}),
    }, async (providerHost, desiredProfile) => {
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
      options.signal?.throwIfAborted();

      if (cached) {
        const statistics = await readCompileStatistics(resolvedRoot, sourceStatistics);
        await providerHost.assertCurrent();
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
      const state = await collectRegistryState(registry, desiredProfile, providerHost, options.signal, options.execution);
      state.packageSourceDigest = options.sourceDigest;
      const collectStateMs = elapsedMs(collectStateStart);

      const aggregateStart = performance.now();
      const written = await writeAtomicCompileArtifacts(
        resolvedRoot,
        state,
        async (stageRoot, buildGraph) => lockForState(stageRoot, registry, state, new Date().toISOString(), buildGraph),
        options.signal,
      );
      const aggregateArtifactsMs = elapsedMs(aggregateStart);
      const cacheWriteStart = performance.now();
      await writeCompileReceipt(lockPath, written.lock);
      await writeCompileCache(resolvedRoot, registry, sourceSnapshot, lockPath);
      const compileCacheWriteMs = elapsedMs(cacheWriteStart);
      const statistics = await readCompileStatistics(resolvedRoot, sourceStatistics);

      return {
        type: 'package',
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
    });
  }, options.signal);
}

export async function compileKnowledgeTarget(
  root: string,
  options: CompileComposeProjectOptions,
): Promise<CompiledKnowledgeTarget> {
  options.signal?.throwIfAborted();
  const resolvedRoot = path.resolve(root);
  const manifest = await loadManifest(resolvedRoot);
  if (manifest.type === 'dkb') return compileComposeProject(resolvedRoot, options);
  if (manifest.type === 'collection') {
    throw new DkbError(
      `Collection ${manifest.name} does not have Evidence or Retrieval Builds. `
      + 'Compile its owning Library or one editable member DKB.',
    );
  }

  const library = await loadCompose(resolvedRoot);
  const packages = uniqueDkbs([
    ...library.collections.flatMap((collection) => collection.dkbs),
    ...library.dkbs,
  ]);
  const vendorRoot = path.join(resolvedRoot, 'vendor');
  const editable = packages.filter((dkb) => !isInside(vendorRoot, dkb.root));
  const installed = packages.filter((dkb) => isInside(vendorRoot, dkb.root));
  const results: CompiledLibraryProject['packages'] = [];

  for (const dkb of editable) {
    const compiled = await compileComposeProject(dkb.root, {
      ...options,
      contextRoot: options.contextRoot ?? resolvedRoot,
    });
    results.push({
      id: dkb.manifest.id,
      version: dkb.manifest.version,
      root: dkb.root,
      recordCount: compiled.recordCount,
      cacheHit: compiled.cacheHit,
      retrievalBuildPath: compiled.retrievalBuildPath,
      lockPath: compiled.lockPath,
    });
  }

  return {
    type: 'library',
    libraryId: library.manifest.id,
    root: resolvedRoot,
    packageCount: results.length,
    registryPackageCount: installed.length,
    recordCount: results.reduce((total, result) => total + result.recordCount, 0),
    cacheHit: results.every((result) => result.cacheHit),
    packages: results,
    registryPackages: installed.map((dkb) => ({
      id: dkb.manifest.id,
      version: dkb.manifest.version,
      root: dkb.root,
      status: 'retained',
    })),
  };
}

export async function compileRetrievalFromEvidence(
  root: string,
  inputEvidence: DkbEvidenceIr,
  options: CompileRetrievalFromEvidenceOptions,
): Promise<CompiledComposeProject> {
  options.signal?.throwIfAborted();
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
    return withCompilationHost({ root: contextRoot, distribution: options.distribution,
      target: options.target,
      ...(options.targetOptions ? { targetOptions: options.targetOptions } : {}),
    }, async (providerHost, desiredProfile) => {
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
        estimateRetrievalWorkingBytes(corpus, desiredProfile.embedding?.dimensions ?? 0),
        `retrieval compilation of ${dkb.manifest.id}@${dkb.manifest.version}`,
      );
      const evidenceLockPath = path.join(evidenceBuildPath(resolvedRoot, evidence.evidenceProfileDigest, evidence.evidenceDigest), DKB_EVIDENCE_BUILD_LOCK);
      const parentLock = validateEvidenceBuildLock(options.evidenceLock
        ?? JSON.parse(await fs.readFile(evidenceLockPath, 'utf8')), evidenceLockPath);
      if (parentLock.package.id !== dkb.manifest.id || parentLock.package.version !== dkb.manifest.version
        || parentLock.evidenceProfileDigest !== evidence.evidenceProfileDigest || parentLock.evidenceDigest !== evidence.evidenceDigest
        || parentLock.recordCount !== evidence.evidence.length || parentLock.chunkCount !== evidence.chunks.length
        || (options.sourceDigest !== undefined && parentLock.package.sourceDigest !== options.sourceDigest)) {
        throw new DkbError('Retrieval compilation requires the exact parent Evidence Build receipt');
      }
      const pipeline = pipelineFromEvidenceIr(evidence);
      pipeline.receipts = parentLock.providerReceipts;
      const compiled = await embedDkbEvidenceWithProviderHost(providerHost, pipeline, { signal: options.signal });
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
      assertProviderExecutionIdentities(parentLock.providerReceipts, retrievalProfileLock, 'evidence');
      const state: RegistryCompileState = {
        sourceUnits: units,
        packages: {
          [dkb.manifest.id]: await lockPackageForDkb(dkb, units, registry.root),
        },
        ...(options.sourceDigest ? { packageSourceDigest: options.sourceDigest } : {}),
        compilerArtifacts: [artifact],
        retrievalProfileLock,
        resolvedProfile: desiredProfile,
        providerHost,
      };
      const written = await writeAtomicCompileArtifacts(
        resolvedRoot,
        state,
        async (stageRoot, buildGraph) => lockForState(stageRoot, registry, state, new Date().toISOString(), buildGraph),
        options.signal,
      );
      const lockPath = resolveFrom(resolvedRoot, COMPILE_RECEIPT_PATH);
      await writeCompileReceipt(lockPath, written.lock);
      const statistics = await readCompileStatistics(resolvedRoot, sourceStatistics);

      return {
        type: 'package',
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
    });
  }, options.signal);
}

export async function ensurePackageBuildForTarget(
  root: string,
  options: CompileRetrievalFromEvidenceOptions,
): Promise<PreparedPackageBuildTarget> {
  options.signal?.throwIfAborted();
  const resolvedRoot = path.resolve(root);
  const contextRoot = path.resolve(options.contextRoot ?? resolvedRoot);
  const profile = await resolvedProviderProfile(contextRoot, options.distribution, options.target, options.libraryRoot, options.targetOptions);
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
  let retainStaging = false;

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
      const evidenceLockPath = path.join(unambiguousEvidence.path, DKB_EVIDENCE_BUILD_LOCK);
      const evidenceLock = validateEvidenceBuildLock(JSON.parse(await fs.readFile(evidenceLockPath, 'utf8')), evidenceLockPath);
      await compileRetrievalFromEvidence(stagingRoot, evidence, {
        distribution: options.distribution,
        target: options.target,
        contextRoot,
        evidenceLock,
        signal: options.signal,
        ...(options.targetOptions ? { targetOptions: options.targetOptions } : {}),
      });
    } else {
      await compileComposeProject(stagingRoot, {
        distribution: options.distribution,
        force: true,
        signal: options.signal,
        target: options.target,
        contextRoot,
        ...(options.targetOptions ? { targetOptions: options.targetOptions } : {}),
      });
    }
    options.signal?.throwIfAborted();
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
  } catch (error) {
    retainStaging = error instanceof DkbError && error.code === 'compile_termination_unconfirmed';
    throw error;
  } finally {
    if (!retainStaging) await fs.rm(stagingParent, { recursive: true, force: true });
  }
}

function elapsedMs(start: number): number {
  return Math.round((performance.now() - start) * 1000) / 1000;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
