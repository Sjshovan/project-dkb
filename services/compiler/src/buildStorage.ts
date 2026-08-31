import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import {
  DKB_CACHE_DIR,
  manifestPath,
  resolveFrom,
} from '@sjshovan/dkb-protocol/paths.js';
import type { DkbLockManifest } from '@sjshovan/dkb-protocol/types.js';
import {
  validatePackageBuildGraph,
  writePackageBuildGraph,
  type DkbPackageBuildGraph,
} from '@sjshovan/dkb-library/builds.js';
import type { DkbProviderHost } from '@sjshovan/dkb-pipeline/host.js';
import type { DkbIndexProvider } from '@sjshovan/dkb-pipeline/types.js';
import type {
  AtomicCompileArtifactTimings,
  CompilerArtifactState,
  RegistryCompileState,
} from './compilerState.js';

export async function writeAtomicCompileArtifacts(
  root: string,
  state: RegistryCompileState,
  createLock: (stageRoot: string, buildGraph: DkbPackageBuildGraph) => Promise<DkbLockManifest>,
): Promise<{ lock: DkbLockManifest; timings: AtomicCompileArtifactTimings; buildGraph: DkbPackageBuildGraph }> {
  const totalStart = performance.now();
  const timings: AtomicCompileArtifactTimings = {
    stagePrepare: 0,
    retrievalArtifacts: 0,
    lock: 0,
    buildGraph: 0,
    validation: 0,
    promotion: 0,
    cleanup: 0,
    total: 0,
  };
  const stageParent = resolveFrom(root, `${DKB_CACHE_DIR}/compile-stage-${process.pid}-${Date.now().toString(36)}`);
  const stageRoot = path.join(stageParent, 'root');

  await fs.rm(stageParent, { recursive: true, force: true });
  await fs.mkdir(stageRoot, { recursive: true });
  await fs.copyFile(manifestPath(root, 'dkb.json'), manifestPath(stageRoot, 'dkb.json'));
  timings.stagePrepare = elapsedMs(totalStart);

  try {
    if (!state.providerHost) {
      throw new DkbError('Compilation provider host is unavailable');
    }

    const retrievalStart = performance.now();
    const stagedArtifactsRoot = path.join(stageParent, 'retrieval-artifacts');
    await writeRetrievalArtifacts(stagedArtifactsRoot, state.compilerArtifacts, state.providerHost, {
      compatibility: state.retrievalProfileLock?.compatibility ?? {},
    });
    timings.retrievalArtifacts = elapsedMs(retrievalStart);

    const buildGraphStart = performance.now();
    const buildGraph = await writeBuildGraph(stageRoot, stagedArtifactsRoot, state);
    await validatePackageBuildGraph(stageRoot, buildGraph.selection);
    timings.buildGraph = elapsedMs(buildGraphStart);

    const validationStart = performance.now();
    await validatePackageBuildGraph(stageRoot, buildGraph.selection);
    timings.validation = elapsedMs(validationStart);

    if (process.env.DKB_TEST_ABORT_COMPILE_AFTER_STAGE_VALIDATION === '1') {
      throw new DkbError(`Aborted compile after staged Build validation at ${stageRoot}`);
    }

    const lockStart = performance.now();
    const lock = await createLock(stageRoot, buildGraph);
    timings.lock = elapsedMs(lockStart);

    const promotionStart = performance.now();
    const promotedBuilds: string[] = [];

    try {
      for (const source of [buildGraph.evidencePath, buildGraph.retrievalPath]) {
        const target = path.join(root, path.relative(stageRoot, source));
        if (await promoteBuildDirectory(source, target)) promotedBuilds.push(target);
      }
    } catch (error) {
      await Promise.all(promotedBuilds.map((target) => fs.rm(target, { recursive: true, force: true })));
      throw error;
    }

    const promotedBuildGraph = await validatePackageBuildGraph(root, buildGraph.selection);
    timings.promotion = elapsedMs(promotionStart);
    timings.total = elapsedMs(totalStart);

    return { lock, timings, buildGraph: promotedBuildGraph };
  } finally {
    const cleanupStart = performance.now();
    await fs.rm(stageParent, { recursive: true, force: true });
    timings.cleanup = elapsedMs(cleanupStart);
  }
}

async function writeBuildGraph(
  stageRoot: string,
  artifactsRoot: string,
  state: RegistryCompileState,
): Promise<DkbPackageBuildGraph> {
  if (state.compilerArtifacts.length !== 1 || !state.retrievalProfileLock || !state.resolvedProfile) {
    throw new DkbError('A compile job must resolve exactly one PackageVersion and one retrieval target');
  }

  const artifact = state.compilerArtifacts[0]!;
  const packageReceipt = state.packages[artifact.dkb.manifest.id];
  if (!packageReceipt) throw new DkbError(`Compiled package receipt is missing for ${artifact.dkb.manifest.id}`);
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
    evidence: artifact.evidence,
    retrievalProfile: state.retrievalProfileLock,
    artifactsRoot,
    target: state.resolvedProfile.target,
  });
}

async function writeRetrievalArtifacts(
  artifactsRoot: string,
  compilerArtifacts: CompilerArtifactState[],
  providerHost: DkbProviderHost,
  options: { compatibility: Record<string, unknown> },
): Promise<void> {
  if (compilerArtifacts.length === 0) return;
  if (compilerArtifacts.length !== 1) {
    throw new DkbError(`Retrieval Build compilation requires exactly one PackageVersion, got ${compilerArtifacts.length}`);
  }

  const primary = compilerArtifacts[0]!;
  const target = providerHost.config.target;
  const indexProvider = providerHost.provider<DkbIndexProvider>('index');
  if (!indexProvider.compilePackage) {
    throw new DkbError(`Selected index provider ${target.index} does not support package compilation`);
  }

  await fs.mkdir(artifactsRoot, { recursive: true });
  await indexProvider.compilePackage({
    artifactsRoot,
    dkb: primary.dkb,
    compiled: primary.compiled,
    compatibility: options.compatibility,
    options: providerHost.optionsFor(target.index),
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

function elapsedMs(start: number): number {
  return Math.round((performance.now() - start) * 1000) / 1000;
}
