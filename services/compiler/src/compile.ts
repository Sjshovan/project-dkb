import { canCompileSourceUnits } from '@dkb/library/adapters/adapter.js';
import { adapterFor, adapterForStore } from '@dkb/library/adapters/index.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { stableHash } from '@dkb/protocol/contracts/hash.js';
import { DkbError } from '@dkb/protocol/errors.js';
import { loadCompose } from '@dkb/protocol/manifest.js';
import { DKB_ARTIFACT_LOCK_PATH, DKB_ARTIFACTS_DIR, DKB_CACHE_DIR, DKB_LOCKS_DIR, DKB_RUNTIME_LOCK_PATH, artifactLockPath, manifestPath, resolveFrom } from '@dkb/protocol/paths.js';
import { validateDkbLockManifest } from '@dkb/protocol/validation.js';
import type { DkbLockArtifact, DkbLockManifest, DkbStore, LoadedCollection, LoadedDkb, LoadedLibrary } from '@dkb/protocol/types.js';
import { SOURCE_GRAPH_PATH, SOURCE_INDEX_PATH, SOURCE_VECTOR_PATH, readSourceIndex, type IndexedSourceUnit } from '@dkb/providers-bundled/sourceIndex.js';
import { analyzeSourceUnits, writeSourceAnalysisArtifacts } from './sourceAnalysis.js';
import { DKB_ARTIFACT_MANIFEST_PATH, validateDkbArtifactManifest, writeDkbArtifactManifest, type DkbArtifactCompiler } from '@dkb/library/artifacts.js';
import {
  DKB_EVIDENCE_BUILD_IR,
  listPackageBuilds,
  maybeReadRuntimeLock,
  mergeStoredPackageBuilds,
  validatePackageBuildGraph,
  writePackageBuildGraph,
  type DkbPackageBuildGraph,
} from '@dkb/library/builds.js';
import type { LlamaIndexCompilerResult } from '@dkb/providers-bundled/llamaindex.js';
import {
  readLlamaIndexCompilerRecords,
  sourceUnitFromLlamaIndexRecord,
  writeLlamaIndexCompilerBundle,
  type LlamaIndexCompilerBundleManifest,
} from '@dkb/providers-bundled/llamaindexArtifacts.js';
import {
  DKB_RETRIEVAL_PROFILE_LOCK_PATH,
  resolveProviderRetrievalProfile,
  retrievalProfileLockForCompilerResults,
  writeRetrievalProfileLock,
  type DkbResolvedRetrievalProfile,
  type DkbRetrievalProfileLock,
} from '@dkb/pipeline/profile.js';
import { buildEvidenceIr, evidenceIdentityForRecord, DKB_EVIDENCE_IR_PATH, readEvidenceIr, validateEvidenceIr, writeEvidenceIr, type DkbEvidenceIr } from '@dkb/protocol/evidence/ir.js';
import { BUNDLED_PROVIDER_PLUGINS } from '@dkb/providers-bundled/bundled.js';
import { DkbProviderHost } from '@dkb/pipeline/host.js';
import { sourceUnitFromPipelineRecord } from '@dkb/providers-bundled/records.js';
import { embedDkbEvidenceWithProviderHost, ingestDkbWithProviderHost } from './pipelineRunner.js';
import type { DkbCompiledPipeline, DkbIndexProvider, DkbPipelineRecord } from '@dkb/pipeline/types.js';
import { loadFaissPackageArtifact } from '@dkb/providers-bundled/faissStore.js';

export const COMPILE_LOCK_PATH = `${DKB_LOCKS_DIR}/compile.lock`;
export const COMPILE_CACHE_PATH = `${DKB_CACHE_DIR}/compile-cache.json`;
const COMPILE_CACHE_VERSION = 1;
const COMPILE_LOCK_TIMEOUT_MS = 30_000;
const COMPILE_LOCK_STALE_MS = 10 * 60_000;
const COMPILE_LOCK_RETRY_MS = 100;
const QUICK_ARTIFACT_PATHS = [
  SOURCE_INDEX_PATH,
  SOURCE_GRAPH_PATH,
  SOURCE_VECTOR_PATH,
  DKB_ARTIFACT_MANIFEST_PATH,
];

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
  databasePath: string;
  chunkIndexPath: string;
  artifactManifestPath: string;
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
}

export interface PreparedPackageBuildTarget {
  target: string;
  preparation: 'retained' | 'retrieval_compiled' | 'evidence_compiled';
  evidenceProfileDigest: string;
  retrievalProfileDigest: string;
}

export interface CompileComposeProjectOptions {
  force?: boolean;
  mode?: 'library' | 'package';
  target?: string;
  contextRoot?: string;
}

export interface CompileRetrievalFromEvidenceOptions {
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

interface CompileCacheManifest {
  version: typeof COMPILE_CACHE_VERSION;
  registryId: string;
  lockHash: string;
  sourceSnapshotHash: string;
  artifactSnapshotHash: string;
  sources: QuickStoreSnapshot[];
  artifacts: QuickPathSnapshot[];
  createdAt: string;
  platform: {
    os: NodeJS.Platform;
    node: string;
  };
}

interface AtomicCompileArtifactTimings {
  stagePrepare: number;
  sourceAnalysis: number;
  chunkIndex: number;
  vector: number;
  graph: number;
  compilerArtifacts: number;
  lock: number;
  artifactManifest: number;
  buildGraph: number;
  validation: number;
  promotion: number;
  cleanup: number;
  total: number;
}

interface CompilerArtifactState {
  dkb: LoadedDkb;
  dkbRoot: string;
  result: LlamaIndexCompilerResult;
  compiled: DkbCompiledPipeline;
  evidence: DkbEvidenceIr;
}

interface RegistryCompileState {
  sourceUnits: IndexedSourceUnit[];
  packages: DkbLockManifest['packages'];
  chunkRepositoryHash: string;
  sourceAnalysis: ReturnType<typeof analyzeSourceUnits>;
  compilerArtifacts: CompilerArtifactState[];
  retrievalProfileLock?: DkbRetrievalProfileLock;
  resolvedProfile?: DkbResolvedRetrievalProfile;
  providerHost?: DkbProviderHost;
}

interface QuickSourceSnapshot {
  cacheable: boolean;
  hash: string;
  sources: QuickStoreSnapshot[];
}

interface QuickArtifactSnapshot {
  hash: string;
  artifacts: QuickPathSnapshot[];
  requiredArtifactsReady: boolean;
}

interface QuickStoreSnapshot {
  dkbId: string;
  storeId: string;
  type: DkbStore['type'];
  path?: string;
  connectionRef?: string;
  cacheable: boolean;
  reason?: string;
  hash: string;
  entries: QuickPathSnapshot[];
}

interface QuickPathSnapshot {
  path: string;
  exists: boolean;
  type?: 'file' | 'directory';
  size?: number;
  mtimeMs?: number;
  entries?: Array<{
    path: string;
    size: number;
    mtimeMs: number;
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

export async function compileComposeProject(root: string, options: CompileComposeProjectOptions = {}): Promise<CompiledComposeProject> {
  const resolvedRoot = path.resolve(root);

  return withCompileLock(resolvedRoot, async () => {
    const totalStart = performance.now();
    const registry = await loadCompose(resolvedRoot);
    const contextRoot = path.resolve(options.contextRoot ?? resolvedRoot);
    const desiredProfile = await resolvedProviderProfile(contextRoot, options.target);
    const chunkIndexPath = resolveFrom(resolvedRoot, SOURCE_INDEX_PATH);
    const lockPath = artifactLockPath(resolvedRoot);
    const sourceSnapshotStart = performance.now();
    const sourceSnapshot = await quickSourceSnapshotForRegistry(registry);
    const sourceSnapshotMs = elapsedMs(sourceSnapshotStart);
    const cacheLookupStart = performance.now();
    const allDkbs = uniqueDkbs([
      ...registry.collections.flatMap((collection) => collection.dkbs),
      ...registry.dkbs,
    ]);
    const existingProfile = await import('@dkb/pipeline/profile.js').then((module) => module.maybeReadRetrievalProfileLock(resolvedRoot));
    const profileDrift = !existingProfile
      || existingProfile.profile.configDigest !== desiredProfile.configDigest
      || existingProfile.profile.providerBuildDigest !== desiredProfile.providerBuildDigest;
    const cached = options.force || profileDrift
      ? null
      : await cachedCompileResultFor(resolvedRoot, registry, sourceSnapshot, chunkIndexPath, lockPath);
    const cacheLookupMs = elapsedMs(cacheLookupStart);

    if (cached) {
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
        },
      };
    }

    const collectStateStart = performance.now();
    const state = await collectRegistryState(registry, desiredProfile, contextRoot);
    const collectStateMs = elapsedMs(collectStateStart);

    try {
      const aggregateStart = performance.now();
      const written = await writeAtomicCompileArtifacts(resolvedRoot, registry, state, allDkbs, options.mode === 'package' ? 'faiss-package' : 'full');
      const aggregateArtifactsMs = elapsedMs(aggregateStart);
      const cacheWriteStart = performance.now();
      const lock = written.lock;
      await writeCompileCache(resolvedRoot, registry, sourceSnapshot, lockPath);
      const compileCacheWriteMs = elapsedMs(cacheWriteStart);

      return {
        registryId: registry.manifest.id,
        recordCount: state.sourceUnits.length,
        databasePath: chunkIndexPath,
        chunkIndexPath,
        artifactManifestPath: resolveFrom(resolvedRoot, DKB_ARTIFACT_MANIFEST_PATH),
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
    const desiredProfile = await resolvedProviderProfile(contextRoot, options.target);
    if (desiredProfile.evidenceProfileDigest !== evidence.evidenceProfileDigest) {
      throw new DkbError(
        `Evidence Profile mismatch: target ${options.target} requires ${desiredProfile.evidenceProfileDigest}, Evidence Build uses ${evidence.evidenceProfileDigest}`,
      );
    }
    const packageEvidence = evidence.evidence.filter((record) => record.packageId === dkb.manifest.id && record.packageVersion === dkb.manifest.version);
    if (packageEvidence.length !== evidence.evidence.length) {
      throw new DkbError(`Evidence Build identity does not match ${dkb.manifest.id}@${dkb.manifest.version}`);
    }
    const providerHost = await DkbProviderHost.create({ root: contextRoot, bundled: BUNDLED_PROVIDER_PLUGINS, target: desiredProfile.target });

    try {
      const evidencePipeline = pipelineFromEvidenceIr(evidence);
      const compiled = await embedDkbEvidenceWithProviderHost(providerHost, evidencePipeline);
      const result = compilerResultForPipeline(dkb, desiredProfile, compiled);
      const units = result.records.map((record) => sourceUnitFromLlamaIndexRecord(dkb, record));
      const sourceAnalysis = analyzeSourceUnits(units);
      const artifact: CompilerArtifactState = {
        dkb,
        dkbRoot: dkb.root,
        result,
        compiled,
        evidence,
      };
      const retrievalProfileLock = retrievalProfileLockForCompilerResults(desiredProfile, [result]);
      const state: RegistryCompileState = {
        sourceUnits: sourceAnalysis.sourceUnits,
        packages: {
          [dkb.manifest.id]: await lockPackageForDkb(dkb, sourceAnalysis.sourceUnits, registry.root),
        },
        chunkRepositoryHash: stableHash(sourceAnalysis.sourceUnits.map(chunkForHash)),
        sourceAnalysis,
        compilerArtifacts: [artifact],
        retrievalProfileLock,
        resolvedProfile: desiredProfile,
        providerHost,
      };
      const written = await writeAtomicCompileArtifacts(resolvedRoot, registry, state, allDkbs, 'faiss-package');
      const chunkIndexPath = resolveFrom(resolvedRoot, SOURCE_INDEX_PATH);

      return {
        registryId: registry.manifest.id,
        recordCount: state.sourceUnits.length,
        databasePath: chunkIndexPath,
        chunkIndexPath,
        artifactManifestPath: resolveFrom(resolvedRoot, DKB_ARTIFACT_MANIFEST_PATH),
        lockPath: artifactLockPath(resolvedRoot),
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
  options: { target: string; contextRoot?: string },
): Promise<PreparedPackageBuildTarget> {
  const resolvedRoot = path.resolve(root);
  const contextRoot = path.resolve(options.contextRoot ?? resolvedRoot);
  const profile = await resolvedProviderProfile(contextRoot, options.target);
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
      await compileRetrievalFromEvidence(stagingRoot, evidence, { target: options.target, contextRoot });
    } else {
      await compileComposeProject(stagingRoot, {
        mode: 'package',
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

async function writeAtomicCompileArtifacts(
  root: string,
  registry: LoadedLibrary,
  state: Awaited<ReturnType<typeof collectRegistryState>>,
  allDkbs: LoadedDkb[],
  artifactProfile: 'full' | 'faiss-package',
): Promise<{ lock: DkbLockManifest; timings: AtomicCompileArtifactTimings }> {
  const totalStart = performance.now();
  const timings: AtomicCompileArtifactTimings = {
    stagePrepare: 0,
    sourceAnalysis: 0,
    chunkIndex: 0,
    vector: 0,
    graph: 0,
    compilerArtifacts: 0,
    lock: 0,
    artifactManifest: 0,
    buildGraph: 0,
    validation: 0,
    promotion: 0,
    cleanup: 0,
    total: 0,
  };
  const stageParent = resolveFrom(root, `${DKB_CACHE_DIR}/compile-stage-${process.pid}-${Date.now().toString(36)}`);
  const stageRoot = path.join(stageParent, 'root');
  const artifactDir = resolveFrom(root, DKB_ARTIFACTS_DIR);
  const artifactBackup = `${artifactDir}.replace-${process.pid}-${Date.now().toString(36)}`;
  const profilePath = resolveFrom(root, DKB_RETRIEVAL_PROFILE_LOCK_PATH);
  const profileBackup = `${profilePath}.replace-${process.pid}-${Date.now().toString(36)}`;
  const runtimeLockPath = resolveFrom(root, DKB_RUNTIME_LOCK_PATH);
  const runtimeLockBackup = `${runtimeLockPath}.replace-${process.pid}-${Date.now().toString(36)}`;

  await fs.rm(stageParent, { recursive: true, force: true });
  await fs.mkdir(stageRoot, { recursive: true });
  await fs.copyFile(manifestPath(root, 'dkb.json'), manifestPath(stageRoot, 'dkb.json'));
  timings.stagePrepare = elapsedMs(totalStart);

  try {
    if (!state.providerHost) {
      throw new DkbError('Compilation provider host is unavailable');
    }

    const sourceAnalysisStart = performance.now();
    await writeSourceAnalysisArtifacts(stageRoot, registry.manifest.id, state.sourceAnalysis);
    timings.sourceAnalysis = elapsedMs(sourceAnalysisStart);
    timings.chunkIndex = timings.sourceAnalysis;
    const compilerArtifactStart = performance.now();
    await writeCompilerBundles(stageRoot, state.compilerArtifacts, state.providerHost, {
      writeAggregate: false,
      writeRecordBundles: artifactProfile === 'full',
      compatibility: state.retrievalProfileLock?.compatibility ?? {},
    });
    await writeProfileArtifacts(stageRoot, state);
    timings.compilerArtifacts = elapsedMs(compilerArtifactStart);

    const lockStart = performance.now();
    const lock = await lockForState(stageRoot, registry, state, new Date().toISOString());
    const stageLockPath = artifactLockPath(stageRoot);

    await fs.mkdir(path.dirname(stageLockPath), { recursive: true });
    await fs.writeFile(stageLockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
    timings.lock = elapsedMs(lockStart);
    const artifactManifestStart = performance.now();
    await writeDkbArtifactManifest(stageRoot, lock, { compiler: artifactCompilerForState(state) });
    timings.artifactManifest = elapsedMs(artifactManifestStart);

    const buildGraphStart = performance.now();
    const buildGraph = await writeBuildGraph(stageRoot, root, state);
    if (buildGraph) await validatePackageBuildGraph(stageRoot, buildGraph.runtime);
    timings.buildGraph = elapsedMs(buildGraphStart);

    const validationStart = performance.now();
    const validation = await validateDkbArtifactManifest(stageRoot);
    timings.validation = elapsedMs(validationStart);

    if (!validation.ok) {
      throw new DkbError(`Staged compiled artifact validation failed at ${stageRoot}`);
    }

    if (process.env.DKB_TEST_ABORT_COMPILE_AFTER_STAGE_VALIDATION === '1') {
      throw new DkbError(`Aborted compile after staged artifact validation at ${stageRoot}`);
    }

    const promotionStart = performance.now();
    await fs.mkdir(path.dirname(artifactDir), { recursive: true });
    await moveIfExists(artifactDir, artifactBackup);
    if (state.retrievalProfileLock) {
      await moveIfExists(profilePath, profileBackup);
    }
    if (buildGraph) await moveIfExists(runtimeLockPath, runtimeLockBackup);

    const promotedBuilds: string[] = [];
    const supersededBuilds: Array<{ original: string; staged: string }> = [];

    try {
      if (buildGraph) {
        for (const source of [buildGraph.evidencePath, buildGraph.retrievalPath]) {
          const target = path.join(root, path.relative(stageRoot, source));
          if (await promoteBuildDirectory(source, target)) promotedBuilds.push(target);
        }
        const activeRetrievalTarget = path.join(root, path.relative(stageRoot, buildGraph.retrievalPath));
        supersededBuilds.push(...await stageSupersededRetrievalBuilds(activeRetrievalTarget, stageParent));
      }
      await fs.rename(resolveFrom(stageRoot, DKB_ARTIFACTS_DIR), artifactDir);
      if (state.retrievalProfileLock) {
        await fs.rename(resolveFrom(stageRoot, DKB_RETRIEVAL_PROFILE_LOCK_PATH), profilePath);
      }
      if (buildGraph) await fs.rename(resolveFrom(stageRoot, DKB_RUNTIME_LOCK_PATH), runtimeLockPath);
      await fs.rm(artifactBackup, { recursive: true, force: true });
      await fs.rm(profileBackup, { force: true });
      await fs.rm(runtimeLockBackup, { force: true });
    } catch (error) {
      await fs.rm(artifactDir, { recursive: true, force: true });
      if (state.retrievalProfileLock) {
        await fs.rm(profilePath, { force: true });
      }
      if (buildGraph) await fs.rm(runtimeLockPath, { force: true });
      await Promise.all(promotedBuilds.map((target) => fs.rm(target, { recursive: true, force: true })));
      for (const build of [...supersededBuilds].reverse()) {
        await fs.mkdir(path.dirname(build.original), { recursive: true });
        await fs.rename(build.staged, build.original).catch(() => undefined);
      }
      await moveIfExists(artifactBackup, artifactDir);
      if (state.retrievalProfileLock) {
        await moveIfExists(profileBackup, profilePath);
      }
      if (buildGraph) await moveIfExists(runtimeLockBackup, runtimeLockPath);
      throw error;
    }

    timings.promotion = elapsedMs(promotionStart);
    timings.total = elapsedMs(totalStart);

    return { lock, timings };
  } finally {
    const cleanupStart = performance.now();
    await fs.rm(stageParent, { recursive: true, force: true });
    timings.cleanup = elapsedMs(cleanupStart);
  }
}

async function writeBuildGraph(
  stageRoot: string,
  destinationRoot: string,
  state: RegistryCompileState,
): Promise<DkbPackageBuildGraph | null> {
  if (state.compilerArtifacts.length !== 1 || !state.retrievalProfileLock || !state.resolvedProfile) return null;

  const artifact = state.compilerArtifacts[0]!;
  const packageReceipt = state.packages[artifact.dkb.manifest.id];
  if (!packageReceipt) throw new DkbError(`Compiled package receipt is missing for ${artifact.dkb.manifest.id}`);
  const previous = await maybeReadRuntimeLock(destinationRoot);
  const sourceDigest = stableHash({
    manifestHash: packageReceipt.manifestHash,
    sourceInventoryHash: packageReceipt.sourceInventoryHash,
  });

  return writePackageBuildGraph({
    root: stageRoot,
    package: {
      id: artifact.dkb.manifest.id,
      version: artifact.dkb.manifest.version,
      sourceDigest,
    },
    evidence: await readEvidenceIr(stageRoot),
    retrievalProfile: state.retrievalProfileLock,
    target: state.resolvedProfile.target,
    generation: (previous?.generation ?? 0) + 1,
  });
}

async function promoteBuildDirectory(source: string, target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return false;
  } catch {
    // The immutable build is new to this root.
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.rename(source, target);
    return true;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
    if (code === 'EEXIST' || code === 'ENOTEMPTY') return false;
    throw error;
  }
}

async function stageSupersededRetrievalBuilds(
  activeTarget: string,
  stageParent: string,
): Promise<Array<{ original: string; staged: string }>> {
  const profileRoot = path.dirname(activeTarget);
  const activeName = path.basename(activeTarget);
  const entries = await fs.readdir(profileRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const moved: Array<{ original: string; staged: string }> = [];

  try {
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.name === activeName) continue;
      const original = path.join(profileRoot, entry.name);
      const staged = path.join(stageParent, 'superseded-retrieval', entry.name);
      await fs.mkdir(path.dirname(staged), { recursive: true });
      await fs.rename(original, staged);
      moved.push({ original, staged });
    }
  } catch (error) {
    for (const build of [...moved].reverse()) {
      await fs.rename(build.staged, build.original).catch(() => undefined);
    }
    throw error;
  }

  return moved;
}

async function writeCompilerBundles(
  stageRoot: string,
  compilerArtifacts: CompilerArtifactState[],
  providerHost: DkbProviderHost,
  options: { writeAggregate: boolean; writeRecordBundles: boolean; compatibility: Record<string, unknown> },
): Promise<void> {
  if (compilerArtifacts.length === 0) {
    return;
  }

  const primary = compilerArtifacts[0]!;
  const combinedResult = compilerArtifacts.length === 1
    ? primary.result
    : {
        compiler: primary.result.compiler,
        execution: {
          mode: 'registry-aggregate',
          workers: compilerArtifacts.reduce((total, artifact) => total + (artifact.result.execution?.workers ?? 0), 0),
        },
        records: compilerArtifacts.flatMap((artifact) => artifact.result.records),
      };

  if (options.writeRecordBundles) {
    await writeLlamaIndexCompilerBundle(stageRoot, combinedResult, {
      changedSourceKeys: compilerArtifacts.length === 1 ? primary.result.cache?.changedSourceKeys : undefined,
      writeAggregate: options.writeAggregate,
    });
  }

  // A package release owns one FAISS snapshot. A multi-package registry keeps
  // its aggregate source/vector indexes here and each installed package keeps
  // its independently replaceable FAISS artifact.
  if (compilerArtifacts.length === 1) {
    const target = providerHost.config.target;
    const indexProvider = providerHost.provider<DkbIndexProvider>('index');

    if (!indexProvider.compilePackage) {
      throw new DkbError(`Selected index provider ${target.index} does not support package compilation`);
    }
    await indexProvider.compilePackage({
      root: stageRoot,
      dkb: primary.dkb,
      compiled: primary.compiled,
      compatibility: options.compatibility,
      options: providerHost.optionsFor(target.index),
    });
  }
}

async function writeProfileArtifacts(stageRoot: string, state: RegistryCompileState): Promise<void> {
  if (!state.retrievalProfileLock || state.compilerArtifacts.length === 0) {
    return;
  }

  await writeRetrievalProfileLock(stageRoot, state.retrievalProfileLock);
  const evidence = state.compilerArtifacts[0]?.evidence;
  if (!evidence || state.compilerArtifacts.some((artifact) => artifact.evidence.evidenceDigest !== evidence.evidenceDigest)) {
    throw new DkbError('Compilation state does not contain one canonical Evidence Build');
  }
  await writeEvidenceIr(stageRoot, evidence);
}

function artifactCompilerForState(state: RegistryCompileState): DkbArtifactCompiler | undefined {
  if (state.compilerArtifacts.length === 0) {
    return undefined;
  }

  if (state.compilerArtifacts.length === 1) {
    return state.compilerArtifacts[0].result.compiler;
  }

  return {
    id: 'dkb.multi-compiler',
    compilers: state.compilerArtifacts.map((artifact) => artifact.result.compiler),
  };
}

async function moveIfExists(source: string, target: string): Promise<void> {
  try {
    await fs.rename(source, target);
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : '';

    if (code !== 'ENOENT') {
      throw error;
    }
  }
}

export async function verifyComposeProject(root: string): Promise<VerifyComposeProjectResult> {
  const resolvedRoot = path.resolve(root);
  const lockPath = artifactLockPath(resolvedRoot);
  const registry = await loadCompose(resolvedRoot);
  const current = await collectRegistryStateForVerification(registry);
  const lock = validateDkbLockManifest(parseLock(await fs.readFile(lockPath, 'utf8'), lockPath), lockPath);
  const expected = await lockForState(resolvedRoot, registry, current, lock.compiled?.compiledAt ?? new Date().toISOString());
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
    {
      name: 'artifacts.sourceIndex',
      ok: sameArtifact(lock.artifacts.sourceIndex, expected.artifacts.sourceIndex),
      detail: `${lock.artifacts.sourceIndex.hash ?? 'null'} expected ${expected.artifacts.sourceIndex.hash ?? 'null'}`,
    },
    {
      name: 'artifacts.sourceGraph',
      ok: sameArtifact(lock.artifacts.sourceGraph, expected.artifacts.sourceGraph),
      detail: `${lock.artifacts.sourceGraph.hash ?? 'null'} expected ${expected.artifacts.sourceGraph.hash ?? 'null'}`,
    },
    {
      name: 'artifacts.sourceVector',
      ok: sameArtifact(lock.artifacts.sourceVector, expected.artifacts.sourceVector),
      detail: `${lock.artifacts.sourceVector.hash ?? 'null'} expected ${expected.artifacts.sourceVector.hash ?? 'null'}`,
    },
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
        differences.push(`${packageId}:${String(field)}`);
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
  chunkIndexPath: string,
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

  const validation = await validateDkbArtifactManifest(root);

  if (!validation.ok) {
    return null;
  }

  const lock = validateDkbLockManifest(parseLock(lockSource, lockPath), lockPath);

  return {
    registryId: lock.registry.id,
    recordCount: lock.compiled?.recordCount ?? Object.values(lock.packages).reduce((total, item) => total + item.recordCount, 0),
    databasePath: chunkIndexPath,
    chunkIndexPath,
    artifactManifestPath: resolveFrom(root, DKB_ARTIFACT_MANIFEST_PATH),
    lockPath,
    lock,
    cacheHit: true,
  };
}

async function readCompileCache(root: string): Promise<CompileCacheManifest | null> {
  const cachePath = resolveFrom(root, COMPILE_CACHE_PATH);

  try {
    const parsed = JSON.parse(await fs.readFile(cachePath, 'utf8')) as unknown;

    return isCompileCacheManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isCompileCacheManifest(value: unknown): value is CompileCacheManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<CompileCacheManifest>;

  return candidate.version === COMPILE_CACHE_VERSION
    && typeof candidate.registryId === 'string'
    && typeof candidate.lockHash === 'string'
    && typeof candidate.sourceSnapshotHash === 'string'
    && typeof candidate.artifactSnapshotHash === 'string'
    && Array.isArray(candidate.sources)
    && Array.isArray(candidate.artifacts);
}

async function writeCompileCache(
  root: string,
  registry: LoadedLibrary,
  sourceSnapshot: QuickSourceSnapshot,
  lockPath: string,
): Promise<void> {
  if (!sourceSnapshot.cacheable) {
    await fs.rm(resolveFrom(root, COMPILE_CACHE_PATH), { force: true });

    return;
  }

  const lockSource = await fs.readFile(lockPath, 'utf8');
  const artifactSnapshot = await quickArtifactSnapshotFor(root);
  const cache: CompileCacheManifest = {
    version: COMPILE_CACHE_VERSION,
    registryId: registry.manifest.id,
    lockHash: hashString(lockSource),
    sourceSnapshotHash: sourceSnapshot.hash,
    artifactSnapshotHash: artifactSnapshot.hash,
    sources: sourceSnapshot.sources,
    artifacts: artifactSnapshot.artifacts,
    createdAt: new Date().toISOString(),
    platform: {
      os: process.platform,
      node: process.version,
    },
  };

  const cachePath = resolveFrom(root, COMPILE_CACHE_PATH);

  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

async function quickSourceSnapshotForRegistry(registry: LoadedLibrary): Promise<QuickSourceSnapshot> {
  const dkbs = uniqueDkbs([
    ...registry.collections.flatMap((collection) => collection.dkbs),
    ...registry.dkbs,
  ]);
  const sources = (await Promise.all(dkbs.map((dkb) => quickStoreSnapshotsForDkb(dkb)))).flat()
    .sort((left, right) => left.dkbId.localeCompare(right.dkbId) || left.storeId.localeCompare(right.storeId));
  const cacheable = sources.every((source) => source.cacheable);
  const hash = stableHash({
    version: COMPILE_CACHE_VERSION,
    registry: registry.manifest,
    dkbs: dkbs.map((dkb) => ({
      id: dkb.manifest.id,
      manifestHash: dkb.manifestHash ?? stableHash(dkb.manifest),
      packagePath: dkb.packagePath ?? null,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    sources,
  });

  return {
    cacheable,
    hash,
    sources,
  };
}

async function quickStoreSnapshotsForDkb(dkb: LoadedDkb): Promise<QuickStoreSnapshot[]> {
  return Promise.all(storesForDkb(dkb).map(async (store) => quickStoreSnapshotFor(dkb, store)));
}

async function quickStoreSnapshotFor(dkb: LoadedDkb, store: DkbStore): Promise<QuickStoreSnapshot> {
  if (store.permissions?.read === false) {
    return quickNonPathStoreSnapshot(dkb, store, 'read_disabled');
  }

  if (!store.path) {
    return quickNonPathStoreSnapshot(dkb, store, 'store_has_no_local_path');
  }

  const absolutePath = resolveFrom(dkb.root, store.path);
  const relativePath = path.relative(dkb.root, absolutePath).replace(/\\/g, '/') || '.';
  const includedPaths = includedSourcePathsForStore(store);

  if (includedPaths) {
    const entries = await Promise.all(includedPaths.map((item) => quickPathSnapshot(resolveFrom(dkb.root, item), item)));
    const cacheable = entries.every((entry) => entry.exists);

    return {
      dkbId: dkb.manifest.id,
      storeId: store.id,
      type: store.type,
      path: relativePath,
      connectionRef: store.connectionRef,
      cacheable,
      reason: cacheable ? undefined : 'included_local_source_missing',
      hash: stableHash({ store, entries }),
      entries,
    };
  }

  const snapshot = await quickPathSnapshot(absolutePath, relativePath);
  const cacheable = snapshot.exists;

  return {
    dkbId: dkb.manifest.id,
    storeId: store.id,
    type: store.type,
    path: relativePath,
    connectionRef: store.connectionRef,
    cacheable,
    reason: cacheable ? undefined : 'local_path_missing',
    hash: stableHash({ store, snapshot }),
    entries: [snapshot],
  };
}

function quickNonPathStoreSnapshot(dkb: LoadedDkb, store: DkbStore, reason: string): QuickStoreSnapshot {
  return {
    dkbId: dkb.manifest.id,
    storeId: store.id,
    type: store.type,
    path: store.path,
    connectionRef: store.connectionRef,
    cacheable: reason === 'read_disabled',
    reason,
    hash: stableHash({ store, reason }),
    entries: [],
  };
}

async function quickArtifactSnapshotFor(root: string): Promise<QuickArtifactSnapshot> {
  const artifacts = await Promise.all(QUICK_ARTIFACT_PATHS.map(async (artifactPath) => quickPathSnapshot(resolveFrom(root, artifactPath), artifactPath)));
  const requiredArtifactsReady = artifacts.every((artifact) => artifact.exists);

  return {
    hash: stableHash({
      version: COMPILE_CACHE_VERSION,
      artifacts,
    }),
    artifacts,
    requiredArtifactsReady,
  };
}

async function quickPathSnapshot(target: string, relativePath: string): Promise<QuickPathSnapshot> {
  try {
    const stat = await fs.stat(target);

    if (stat.isFile()) {
      return {
        path: relativePath,
        exists: true,
        type: 'file',
        size: stat.size,
        mtimeMs: normalizeMtime(stat.mtimeMs),
      };
    }

    if (stat.isDirectory()) {
      return {
        path: relativePath,
        exists: true,
        type: 'directory',
        entries: await listFileSnapshots(target, target),
      };
    }

    return {
      path: relativePath,
      exists: false,
    };
  } catch {
    return {
      path: relativePath,
      exists: false,
    };
  }
}

async function listFileSnapshots(root: string, base: string): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const snapshots = await Promise.all(entries
    .filter((entry) => !isDkbSystemArtifact(entry.name))
    .map(async (entry) => {
      const target = path.join(root, entry.name);

      if (entry.isDirectory()) {
        return listFileSnapshots(target, base);
      }

      if (!entry.isFile()) {
        return [];
      }

      const stat = await fs.stat(target);

      return [{
        path: path.relative(base, target).replace(/\\/g, '/'),
        size: stat.size,
        mtimeMs: normalizeMtime(stat.mtimeMs),
      }];
    }));

  return snapshots.flat().sort((left, right) => left.path.localeCompare(right.path));
}

function storesForDkb(dkb: LoadedDkb): DkbStore[] {
  return dkb.manifest.stores ?? [{
    id: dkb.manifest.adapter,
    type: dkb.manifest.adapter === 'folder' ? 'filesystem' as const : 'sqlite' as const,
    path: dkb.manifest.entrypoint,
  }];
}

function normalizeMtime(value: number): number {
  return Math.trunc(value);
}

async function maybeReadFile(target: string): Promise<string | null> {
  try {
    return await fs.readFile(target, 'utf8');
  } catch {
    return null;
  }
}

function hashString(value: string): string {
  const hash = createHash('sha256');

  hash.update(value);

  return `sha256:${hash.digest('hex')}`;
}

async function collectRegistryState(
  registry: LoadedLibrary,
  desiredProfile: DkbResolvedRetrievalProfile,
  contextRoot = registry.root,
): Promise<RegistryCompileState> {
  const allDkbs = uniqueDkbs([
    ...registry.collections.flatMap((collection) => collection.dkbs),
    ...registry.dkbs,
  ]);
  const providerHost = await DkbProviderHost.create({ root: contextRoot, bundled: BUNDLED_PROVIDER_PLUGINS, target: desiredProfile.target });
  let packageEntries: Awaited<ReturnType<typeof collectDkbState>>[];

  try {
    packageEntries = await Promise.all(allDkbs.map(async (dkb) => collectDkbState(dkb, desiredProfile, registry.root, providerHost)));
  } catch (error) {
    await providerHost.dispose();
    throw error;
  }
  const sourceUnits = packageEntries.flatMap((entry) => entry.sourceAnalysis.sourceUnits);
  const packages = Object.fromEntries(packageEntries.map((entry) => [entry.package.id, entry.package]));
  const sourceAnalysis = {
    sourceUnits,
    sourceEdges: packageEntries.flatMap((entry) => entry.sourceAnalysis.sourceEdges),
  };

  const compilerArtifacts = packageEntries.flatMap((entry) => entry.compilerArtifact ? [entry.compilerArtifact] : []);
  const retrievalProfileLock = desiredProfile && compilerArtifacts.length > 0
    ? retrievalProfileLockForCompilerResults(desiredProfile, compilerArtifacts.map((artifact) => artifact.result))
    : undefined;

  return {
    sourceUnits,
    packages,
    chunkRepositoryHash: stableHash(sourceUnits.map(chunkForHash)),
    sourceAnalysis,
    compilerArtifacts,
    retrievalProfileLock,
    resolvedProfile: desiredProfile,
    providerHost,
  };
}

async function resolvedProviderProfile(root: string, target?: string): Promise<DkbResolvedRetrievalProfile> {
  const host = await DkbProviderHost.create({ root, bundled: BUNDLED_PROVIDER_PLUGINS, ...(target ? { target } : {}) });

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
  const sourceUnits = packageEntries.flatMap((entry) => entry.sourceAnalysis.sourceUnits);
  const packages = Object.fromEntries(packageEntries.map((entry) => [entry.package.id, entry.package]));
  const sourceAnalysis = {
    sourceUnits,
    sourceEdges: packageEntries.flatMap((entry) => entry.sourceAnalysis.sourceEdges),
  };

  return {
    sourceUnits,
    packages,
    chunkRepositoryHash: stableHash(sourceUnits.map(chunkForHash)),
    sourceAnalysis,
    compilerArtifacts: [],
  };
}

async function collectDkbVerificationState(dkb: LoadedDkb, artifactRoot: string): Promise<{
  package: DkbLockManifest['packages'][string];
  sourceAnalysis: ReturnType<typeof analyzeSourceUnits>;
}> {
  try {
    const sourceIndex = await readSourceIndex(dkb.root);

    if (sourceIndex.units.length > 0) {
      const sourceAnalysis = {
        sourceUnits: sourceIndex.units,
        sourceEdges: sourceIndex.edges,
      };

      return {
        package: await lockPackageForDkb(dkb, sourceAnalysis.sourceUnits, artifactRoot),
        sourceAnalysis,
      };
    }
  } catch {
    // Packages without a portable source index verify against another compiled artifact.
  }

  try {
    const compilerRecords = await readLlamaIndexCompilerRecords(dkb.root);

    if (compilerRecords.length > 0) {
      const unique = new Map<string, IndexedSourceUnit>();

      for (const record of compilerRecords) {
        const unit = sourceUnitFromLlamaIndexRecord(dkb, record);
        unique.set(unit.id, unit);
      }

      const sourceAnalysis = analyzeSourceUnits([...unique.values()].sort((a, b) => a.id.localeCompare(b.id)));

      return {
        package: await lockPackageForDkb(dkb, sourceAnalysis.sourceUnits, artifactRoot),
        sourceAnalysis,
      };
    }
  } catch {
    // Packages without a compiler bundle verify against direct source adapters.
  }

  try {
    const artifact = await loadFaissPackageArtifact(dkb);

    if (artifact.units.length > 0) {
      const sourceAnalysis = analyzeSourceUnits(artifact.units);

      return {
        package: await lockPackageForDkb(dkb, sourceAnalysis.sourceUnits, artifactRoot),
        sourceAnalysis,
      };
    }
  } catch {
    // Packages without a FAISS catalog verify against direct source adapters.
  }

  const state = await collectDkbState(dkb, undefined, artifactRoot);

  return {
    package: state.package,
    sourceAnalysis: state.sourceAnalysis,
  };
}

async function collectDkbState(
  dkb: LoadedDkb,
  desiredProfile?: DkbResolvedRetrievalProfile,
  artifactRoot = dkb.root,
  providerHost?: DkbProviderHost,
): Promise<{
  package: DkbLockManifest['packages'][string];
  sourceAnalysis: ReturnType<typeof analyzeSourceUnits>;
  compilerArtifact?: CompilerArtifactState;
}> {
  const built = await buildSourceUnitsForDkb(dkb, desiredProfile, providerHost);
  const rawSourceUnits = built.units;
  const sourceAnalysis = analyzeSourceUnits(rawSourceUnits);

  return {
    package: await lockPackageForDkb(dkb, sourceAnalysis.sourceUnits, artifactRoot),
    sourceAnalysis,
    compilerArtifact: built.compilerResult ? {
      dkb,
      dkbRoot: dkb.root,
      result: built.compilerResult,
      compiled: built.compiled!,
      evidence: built.evidence!,
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
    chunkRepositoryHash: stableHash(sourceUnits.map(chunkForHash)),
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
  compilerResult?: LlamaIndexCompilerResult;
  compiled?: DkbCompiledPipeline;
  evidence?: DkbEvidenceIr;
}> {
  if (providerHost) {
    if (!desiredProfile) {
      throw new DkbError(`Provider compilation for ${dkb.manifest.id} requires a resolved pipeline profile`);
    }
    const ingested = await ingestDkbWithProviderHost(providerHost, dkb);
    const unembeddedResult = compilerResultForPipeline(dkb, desiredProfile, ingested);
    const evidence = buildEvidenceIr([unembeddedResult], {
      evidenceProfileDigest: desiredProfile.evidenceProfileDigest,
    });
    const annotated = annotateEvidenceIds(ingested, unembeddedResult, evidence.evidenceProfileDigest);
    const compiled = await embedDkbEvidenceWithProviderHost(providerHost, annotated);
    const result = compilerResultForPipeline(dkb, desiredProfile, compiled);

    if (desiredProfile && result.compiler.model !== desiredProfile.embedding.model) {
      throw new DkbError(`Pipeline embedding model mismatch: configured ${desiredProfile.embedding.model}, provider produced ${result.compiler.model}`);
    }
    const unique = new Map<string, IndexedSourceUnit>();

    for (const record of result.records) {
      const unit = sourceUnitFromLlamaIndexRecord(dkb, record);
      unique.set(unit.id, unit);
    }

    return {
      units: [...unique.values()].sort((a, b) => a.id.localeCompare(b.id)),
      compilerResult: result,
      compiled,
      evidence,
    };
  }
  const batches = await Promise.all(storesForDkb(dkb).map((store) => buildSourceUnitsForStore(dkb, store)));

  return {
    units: batches.flat().sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function annotateEvidenceIds(
  compiled: DkbCompiledPipeline,
  result: LlamaIndexCompilerResult,
  evidenceProfileDigest: string,
): DkbCompiledPipeline {
  if (compiled.records.length !== result.records.length) {
    throw new DkbError('Ingestion result changed record count while materializing Evidence IR');
  }

  return {
    ...compiled,
    records: compiled.records.map((record, index) => {
      const source = result.records[index];
      if (!source) throw new DkbError(`Evidence source record ${index} is missing`);
      const sourceEvidenceId = evidenceIdentityForRecord(source).evidenceId;
      const evidenceId = stableHash({ sourceEvidenceId, evidenceProfileDigest });
      const sourceMetadata = isRecord(record.metadata.sourceMetadata) ? record.metadata.sourceMetadata : {};

      return {
        ...record,
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

function compilerResultForPipeline(
  dkb: LoadedDkb,
  desiredProfile: DkbResolvedRetrievalProfile | undefined,
  compiled: DkbCompiledPipeline,
): LlamaIndexCompilerResult {
  if (!desiredProfile) {
    throw new DkbError(`Provider compilation for ${dkb.manifest.id} requires a resolved pipeline profile`);
  }
  const native = llamaIndexResult(compiled.nativeResult);

  return {
    compiler: {
      id: desiredProfile.compiler,
      model: desiredProfile.embedding.model,
      image: `evidence:${desiredProfile.evidenceProfileDigest}`,
    },
    ...(native?.execution ? { execution: native.execution } : {}),
    records: compiled.records.map((record) => compilerRecordForPipeline(dkb, record)),
    ...(native?.cache ? { cache: native.cache } : {}),
  };
}

function compilerRecordForPipeline(dkb: LoadedDkb, record: DkbPipelineRecord): LlamaIndexCompilerResult['records'][number] {
  const unit = sourceUnitFromPipelineRecord(dkb, record);
  const sourceMetadata = isRecord(record.metadata.sourceMetadata) ? record.metadata.sourceMetadata : {};

  return {
    id: unit.id,
    assetId: unit.assetId,
    storeId: unit.storeId,
    type: unit.type === 'postgres' ? 'database' : unit.type,
    locator: unit.locator,
    assetLocator: unit.assetLocator,
    title: unit.title,
    text: unit.text,
    hash: unit.hash,
    updatedAt: unit.updatedAt,
    chunkOrdinal: unit.chunkOrdinal,
    chunkStart: unit.chunkStart,
    chunkEnd: unit.chunkEnd,
    metadata: {
      ...sourceMetadata,
      dkb_package_id: dkb.manifest.id,
      dkb_package_version: dkb.manifest.version,
      dkb_path: typeof sourceMetadata.dkb_path === 'string' ? sourceMetadata.dkb_path : JSON.stringify(unit.assetLocator),
      dkb_source_hash: typeof sourceMetadata.dkb_source_hash === 'string' ? sourceMetadata.dkb_source_hash : unit.hash,
    },
    embedding: [...(record.embedding ?? [])],
  };
}

function llamaIndexResult(value: unknown): LlamaIndexCompilerResult | null {
  if (!isRecord(value) || !isRecord(value.compiler) || !Array.isArray(value.records)) {
    return null;
  }
  return value as unknown as LlamaIndexCompilerResult;
}

async function buildSourceUnitsForStore(dkb: LoadedDkb, store: DkbStore): Promise<IndexedSourceUnit[]> {
  if (store.permissions?.read === false) {
    return [];
  }

  const adapter = await adapterForStore(store.type);

  if (canCompileSourceUnits(adapter)) {
    return adapter.compileSourceUnits({ dkb, store });
  }

  throw new DkbError(`Store type ${store.type} does not support direct chunk compilation`);
}

function countSourceUnitsByStore(units: IndexedSourceUnit[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const unit of units) {
    counts.set(unit.storeId, (counts.get(unit.storeId) ?? 0) + 1);
  }

  return counts;
}

function chunkForHash(unit: IndexedSourceUnit): Record<string, unknown> {
  return {
    id: unit.id,
    assetId: unit.assetId,
    dkbId: unit.dkbId,
    storeId: unit.storeId,
    type: unit.type,
    locator: unit.locator,
    assetLocator: unit.assetLocator,
    title: unit.title,
    text: unit.text,
    keywords: unit.keywords,
    hash: unit.hash,
    updatedAt: unit.updatedAt,
    chunkOrdinal: unit.chunkOrdinal,
    chunkStart: unit.chunkStart,
    chunkEnd: unit.chunkEnd,
  };
}

async function lockForState(root: string, registry: LoadedLibrary, state: Awaited<ReturnType<typeof collectRegistryState>>, compiledAt: string): Promise<DkbLockManifest> {
  const sourceIndexHash = await maybeHashFile(resolveFrom(root, SOURCE_INDEX_PATH));
  const sourceGraphHash = await maybeHashFile(resolveFrom(root, SOURCE_GRAPH_PATH));
  const sourceVectorHash = await maybeHashArtifact(resolveFrom(root, SOURCE_VECTOR_PATH));

  return {
    registry: {
      id: registry.manifest.id,
      name: registry.manifest.name,
      version: registry.manifest.version,
    },
    packages: state.packages,
    artifacts: {
      sourceIndex: artifact(SOURCE_INDEX_PATH, sourceIndexHash),
      sourceGraph: artifact(SOURCE_GRAPH_PATH, sourceGraphHash),
      sourceVector: artifact(SOURCE_VECTOR_PATH, sourceVectorHash),
    },
    ...(state.retrievalProfileLock ? {
      retrievalProfile: {
        path: DKB_RETRIEVAL_PROFILE_LOCK_PATH,
        profileDigest: state.retrievalProfileLock.profileDigest,
      },
    } : {}),
    compiled: {
      path: SOURCE_INDEX_PATH,
      artifactHash: sourceIndexHash,
      chunkRepositoryHash: state.chunkRepositoryHash,
      indexHash: stableHash({ sourceIndexHash, sourceGraphHash, sourceVectorHash }),
      recordCount: state.sourceUnits.length,
      compiledAt,
    },
  };
}

async function withCompileLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const lock = await acquireCompileLock(root);

  try {
    return await fn();
  } finally {
    await releaseCompileLock(lock);
  }
}

async function acquireCompileLock(root: string): Promise<{ path: string; token: string }> {
  const lockPath = resolveFrom(root, COMPILE_LOCK_PATH);
  const token = stableHash({
    pid: process.pid,
    host: os.hostname(),
    root,
    startedAt: new Date().toISOString(),
    random: Math.random(),
  });
  const started = Date.now();

  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      await fs.mkdir(lockPath);
      await fs.writeFile(path.join(lockPath, 'owner.json'), `${JSON.stringify({
        token,
        pid: process.pid,
        host: os.hostname(),
        createdAt: new Date().toISOString(),
      }, null, 2)}\n`, 'utf8');

      return { path: lockPath, token };
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : '';

      if (code !== 'EEXIST') {
        throw error;
      }

      if (await removeStaleCompileLock(lockPath)) {
        continue;
      }

      if (Date.now() - started >= COMPILE_LOCK_TIMEOUT_MS) {
        throw new DkbError(`Timed out waiting for compile lock at ${lockPath}`);
      }

      await delay(COMPILE_LOCK_RETRY_MS);
    }
  }
}

async function removeStaleCompileLock(lockPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(lockPath);

    if (Date.now() - stat.mtimeMs < COMPILE_LOCK_STALE_MS) {
      return false;
    }

    await fs.rm(lockPath, { recursive: true, force: true });

    return true;
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : '';

    if (code === 'ENOENT') {
      return true;
    }

    throw error;
  }
}

async function releaseCompileLock(lock: { path: string; token: string }): Promise<void> {
  try {
    const owner = JSON.parse(await fs.readFile(path.join(lock.path, 'owner.json'), 'utf8')) as { token?: unknown };

    if (owner.token !== lock.token) {
      return;
    }
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : '';

    if (code !== 'ENOENT') {
      throw error;
    }
  }

  await fs.rm(lock.path, { recursive: true, force: true });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function elapsedMs(start: number): number {
  return Math.round((performance.now() - start) * 1000) / 1000;
}

async function hashStore(storePath: string): Promise<string> {
  const stats = await fs.stat(storePath);

  if (stats.isFile()) {
    return hashFile(storePath);
  }

  if (!stats.isDirectory()) {
    throw new DkbError(`Unsupported store path for hashing: ${storePath}`);
  }

  const entries = await listFiles(storePath);
  const hashed = await Promise.all(entries.map(async (file) => ({
    path: path.relative(storePath, file).replace(/\\/g, '/'),
    hash: await hashFile(file),
  })));

  return stableHash(hashed);
}

async function hashStoreForDkb(dkb: LoadedDkb, store: DkbStore, storePath: string): Promise<string> {
  const includedPaths = includedSourcePathsForStore(store);

  if (!includedPaths) {
    return hashStore(storePath);
  }

  const hashed = await Promise.all(includedPaths.map(async (relativePath) => ({
    path: relativePath,
    hash: await hashFile(resolveFrom(dkb.root, relativePath)),
  })));

  return stableHash(hashed.sort((left, right) => left.path.localeCompare(right.path)));
}

function includedSourcePathsForStore(store: DkbStore): string[] | null {
  const included = store.meta?.includePaths;

  if (!Array.isArray(included)) {
    return null;
  }

  const paths = included
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.replace(/\\/g, '/'))
    .sort((left, right) => left.localeCompare(right));

  return paths.length > 0 ? paths : null;
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries
    .filter((entry) => !isDkbSystemArtifact(entry.name))
    .map(async (entry) => {
    const target = path.join(root, entry.name);

    if (entry.isDirectory()) {
      return listFiles(target);
    }

    return entry.isFile() ? [target] : [];
  }));

  return nested.flat().sort((a, b) => a.localeCompare(b));
}

function isGeneratedPackagePath(root: string, source: string): boolean {
  const relative = path.relative(root, source);
  if (!relative) return false;
  const [first] = relative.split(path.sep);
  return first === '.dkb';
}

function isDkbSystemArtifact(name: string): boolean {
  return name === '.dkb'
    || name === 'dkb-lock.json'
    || name === 'dkb-release.json'
    || name === '.dkb-package.json'
    || name === DKB_RETRIEVAL_PROFILE_LOCK_PATH;
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');

  hash.update(await fs.readFile(file));

  return `sha256:${hash.digest('hex')}`;
}

async function maybeHashFile(file: string): Promise<string | null> {
  try {
    return await hashFile(file);
  } catch {
    return null;
  }
}

async function maybeHashArtifact(target: string): Promise<string | null> {
  try {
    const stats = await fs.stat(target);

    if (stats.isDirectory()) {
      return await hashStore(target);
    }

    return await hashFile(target);
  } catch {
    return null;
  }
}

function uniqueDkbs(dkbs: LoadedDkb[]): LoadedDkb[] {
  const seen = new Set<string>();

  return dkbs.filter((dkb) => {
    if (seen.has(dkb.manifest.id)) {
      return false;
    }

    seen.add(dkb.manifest.id);

    return true;
  });
}

function parseLock(source: string, lockPath: string): unknown {
  try {
    return JSON.parse(source);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    throw new DkbError(`Unable to read lockfile at ${lockPath}: ${reason}`);
  }
}

function artifact(pathValue: string, hash: string | null): DkbLockArtifact {
  return {
    path: pathValue,
    hash,
    status: hash ? 'built' : 'not_built',
  };
}

function sameArtifact(left: DkbLockArtifact, right: DkbLockArtifact): boolean {
  return left.path === right.path && left.hash === right.hash && left.status === right.status;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
