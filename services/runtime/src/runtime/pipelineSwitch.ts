import fs from 'node:fs/promises';
import path from 'node:path';
import { mergeStoredPackageBuilds, listPackageBuilds, activateStoredPackageBuild, maybeReadRuntimeLock, validatePackageBuildGraph, writeRuntimeLock } from '@sjshovan/dkb-library/builds.js';
import { snapshotLibraryArtifacts } from '@sjshovan/dkb-library/artifactSnapshot.js';
import { readLibraryState } from '@sjshovan/dkb-library/state.js';
import { DKB_RUNTIME_LOCK_FORMAT, validateRuntimeLock, type DkbRuntimeLock, type DkbRuntimeLockEntry } from '@sjshovan/dkb-protocol/builds.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { loadDkbPackage, loadLibrary } from '@sjshovan/dkb-protocol/manifest.js';
import type { DkbProgressReporter } from '@sjshovan/dkb-protocol/progress.js';
import type { DkbSigningKeyRecord } from '@sjshovan/dkb-protocol/types.js';
import { DKB_CONFIG_FORMAT, DKB_CONFIG_PATH, readDkbContextConfig, writeDkbContextConfig } from '@sjshovan/dkb-pipeline/config.js';
import { DkbProviderHost } from '@sjshovan/dkb-pipeline/host.js';
import { resolveProviderRetrievalProfile, writeRetrievalProfileLock, maybeReadRetrievalProfileLock } from '@sjshovan/dkb-pipeline/profile.js';
import { DEFAULT_DKB_DISTRIBUTION } from '@sjshovan/dkb-distribution-default';
import { DkbRegistryClient } from '@sjshovan/dkb-registry-client/client.js';
import { materializeDkbInstallPlan } from './registryInstall.js';
import { refreshRuntimeCatalogFromInstalledArtifacts } from './catalog.js';
import { closeRuntimeQuerySnapshot, ensureRuntimeState, invalidateRuntimeQuerySnapshot } from './state.js';
import { prepareRuntimeIndexPackage, verifyRuntimeIndex, type PreparedRuntimeIndexPackage } from '../providers/runtimeIndex.js';

export interface DkbRuntimePipelineSwitchResult {
  status: 'pipeline_switched';
  target: string;
  previousTarget: string | null;
  libraryPath: string;
  evidenceProfileDigest: string;
  retrievalProfileDigest: string;
  compatibilityDigest: string;
  packageCount: number;
  packages: Array<{
    id: string;
    version: string;
    source: 'local' | 'registry';
    preparation: 'retained' | 'downloaded';
    evidenceDigest: string;
    retrievalBuildDigest: string;
  }>;
}

interface PreparedPackage {
  id: string;
  version: string;
  source: 'local' | 'registry';
  currentRoot: string;
  stagedRoot: string;
  preparation: 'retained' | 'downloaded';
  runtimeEntry: DkbRuntimeLockEntry;
  index: PreparedRuntimeIndexPackage;
}

/**
 * Prepare every package for one exact target before replacing any active
 * package. The caller must serialize Runtime mutations around this operation.
 */
export async function switchRuntimePipelineFromRegistry(options: {
  stateRoot?: string;
  target: string;
  registryUrl: string;
  registryToken?: string;
  timeoutMs?: number;
  progress?: DkbProgressReporter;
}): Promise<DkbRuntimePipelineSwitchResult> {
  const runtime = await ensureRuntimeState(options.stateRoot);
  const target = requiredTarget(options.target);
  const client = new DkbRegistryClient({ baseUrl: options.registryUrl, token: options.registryToken });
  const stageRoot = path.join(runtime.stateDir, `pipeline-stage-${process.pid}-${Date.now().toString(36)}`);
  const backupRoot = path.join(runtime.stateDir, `pipeline-backup-${process.pid}-${Date.now().toString(36)}`);
  const configPath = path.join(runtime.stateRoot, ...DKB_CONFIG_PATH.split('/'));
  let host: DkbProviderHost | null = null;
  let artifactSnapshot: Awaited<ReturnType<typeof snapshotLibraryArtifacts>> | null = null;
  let previousRuntime: DkbRuntimeLock | null = null;
  let previousConfigBytes: Buffer | null = null;
  const prepared: PreparedPackage[] = [];
  const promoted: Array<{ currentRoot: string; backupRoot: string }> = [];
  let configWritten = false;

  try {
    host = await DkbProviderHost.create({ root: runtime.stateRoot, target, distribution: DEFAULT_DKB_DISTRIBUTION });
    artifactSnapshot = await snapshotLibraryArtifacts(runtime.stateRoot);
    previousRuntime = await maybeReadRuntimeLock(runtime.stateRoot);
    previousConfigBytes = await fs.readFile(configPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const profile = await resolveProviderRetrievalProfile(host);
    const compatibilityDigest = stableHash(profile.compatibility);
    const state = await readLibraryState(runtime.stateRoot);
    const entries = Object.values(state.entries)
      .filter((entry) => entry.kind === 'dkb' && entry.status === 'installed')
      .sort((left, right) => left.identity.localeCompare(right.identity));
    if (entries.length === 0) {
      throw new DkbError('The Runtime Library has no installed DKBs to prepare for a pipeline switch.');
    }
    await fs.mkdir(stageRoot, { recursive: true });
    const publicKeys = entries.some((entry) => entry.source === 'registry')
      ? await trustedRegistryKeys(client)
      : [];
    const library = await loadLibrary(runtime.stateRoot);

    for (const entry of entries) {
      const currentRoot = path.resolve(runtime.stateRoot, entry.path);
      const stagedRoot = path.join(stageRoot, safePathSegment(entry.identity));
      const preparation = await preparePackage({
        client,
        publicKeys,
        currentRoot,
        stagedRoot,
        id: entry.identity,
        version: requiredVersion(entry.version, entry.identity),
        source: entry.source,
        target,
        evidenceProfileDigest: profile.evidenceProfileDigest,
        retrievalProfileDigest: profile.retrievalProfileDigest,
        compatibilityDigest,
        timeoutMs: options.timeoutMs,
        progress: options.progress,
      });
      const dkb = await loadDkbPackage(stagedRoot, entry.identity);
      const graph = await validatePackageBuildGraph(stagedRoot);
      const runtimeEntry = graph.runtime.packages[entry.identity];
      if (!runtimeEntry) throw new DkbError(`Prepared Runtime lock does not contain ${entry.identity}`);
      const index = await prepareRuntimeIndexPackage({
        libraryRoot: runtime.stateRoot,
        libraryId: library.manifest.id,
        dkb,
        target,
      });
      prepared.push({
        id: entry.identity,
        version: dkb.manifest.version,
        source: entry.source,
        currentRoot,
        stagedRoot,
        preparation,
        runtimeEntry,
        index,
      });
    }

    await closeRuntimeQuerySnapshot(runtime.stateRoot);
    await fs.mkdir(backupRoot, { recursive: true });
    for (const item of prepared) {
      const backup = path.join(backupRoot, safePathSegment(item.id));
      await fs.rename(item.currentRoot, backup);
      try {
        await fs.rename(item.stagedRoot, item.currentRoot);
      } catch (error) {
        await fs.rename(backup, item.currentRoot).catch(() => undefined);
        throw error;
      }
      promoted.push({ currentRoot: item.currentRoot, backupRoot: backup });
    }

    const packageEntries = Object.fromEntries(prepared.map((item) => [item.id, item.runtimeEntry]));
    const runtimeLock = validateRuntimeLock({
      format: DKB_RUNTIME_LOCK_FORMAT,
      target,
      evidenceProfileDigest: profile.evidenceProfileDigest,
      retrievalProfileDigest: profile.retrievalProfileDigest,
      compatibilityDigest,
      packages: packageEntries,
      generation: (previousRuntime?.generation ?? 0) + 1,
      generatedAt: new Date().toISOString(),
    });
    const firstProfile = await maybeReadRetrievalProfileLock(prepared[0]!.currentRoot);
    if (!firstProfile || firstProfile.profileDigest !== profile.retrievalProfileDigest) {
      throw new DkbError(`Prepared packages do not contain the exact retrieval profile for ${target}`);
    }
    await writeRetrievalProfileLock(runtime.stateRoot, firstProfile);
    await writeRuntimeLock(runtime.stateRoot, runtimeLock);
    await refreshRuntimeCatalogFromInstalledArtifacts(runtime.stateRoot);
    for (const item of prepared) {
      await verifyRuntimeIndex({
        libraryRoot: runtime.stateRoot,
        libraryId: library.manifest.id,
        packageId: item.id,
        packageVersion: item.version,
        target,
      });
    }

    const currentConfig = await readDkbContextConfig(configPath);
    await writeDkbContextConfig(configPath, {
      ...currentConfig,
      format: DKB_CONFIG_FORMAT,
      activeTarget: target,
    });
    configWritten = true;
    invalidateRuntimeQuerySnapshot(runtime.stateRoot);
    await artifactSnapshot.commit();
    await fs.rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);

    return {
      status: 'pipeline_switched',
      target,
      previousTarget: previousRuntime?.target ?? null,
      libraryPath: runtime.stateRoot,
      evidenceProfileDigest: profile.evidenceProfileDigest,
      retrievalProfileDigest: profile.retrievalProfileDigest,
      compatibilityDigest,
      packageCount: prepared.length,
      packages: prepared.map((item) => ({
        id: item.id,
        version: item.version,
        source: item.source,
        preparation: item.preparation,
        evidenceDigest: item.runtimeEntry.evidenceDigest,
        retrievalBuildDigest: item.runtimeEntry.retrievalBuildDigest,
      })),
    };
  } catch (error) {
    await closeRuntimeQuerySnapshot(runtime.stateRoot).catch(() => undefined);
    for (const item of [...promoted].reverse()) {
      await fs.rm(item.currentRoot, { recursive: true, force: true }).catch(() => undefined);
      await fs.rename(item.backupRoot, item.currentRoot).catch(() => undefined);
    }
    for (const item of prepared) await item.index.rollback().catch(() => undefined);
    await artifactSnapshot?.rollback().catch(() => undefined);
    if (configWritten) await restoreConfig(configPath, previousConfigBytes).catch(() => undefined);
    invalidateRuntimeQuerySnapshot(runtime.stateRoot);
    throw error;
  } finally {
    await host?.dispose();
    await fs.rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function preparePackage(input: {
  client: DkbRegistryClient;
  publicKeys: DkbSigningKeyRecord[];
  currentRoot: string;
  stagedRoot: string;
  id: string;
  version: string;
  source: 'local' | 'registry';
  target: string;
  evidenceProfileDigest: string;
  retrievalProfileDigest: string;
  compatibilityDigest: string;
  timeoutMs?: number;
  progress?: DkbProgressReporter;
}): Promise<'retained' | 'downloaded'> {
  await fs.cp(input.currentRoot, input.stagedRoot, { recursive: true, errorOnExist: true, force: false });
  const builds = await listPackageBuilds(input.stagedRoot);
  if (builds.retrieval.some((build) => build.profileDigest === input.retrievalProfileDigest)) {
    await activateStoredPackageBuild({
      root: input.stagedRoot,
      target: input.target,
      evidenceProfileDigest: input.evidenceProfileDigest,
      retrievalProfileDigest: input.retrievalProfileDigest,
      compatibilityDigest: input.compatibilityDigest,
    });
    return 'retained';
  }
  if (input.source !== 'registry') {
    throw new DkbError(
      `Editable DKB ${input.id}@${input.version} has no stored build for ${input.target}. `
      + `Run dkb build ${input.currentRoot} --pipeline ${input.target}, then retry the switch.`,
    );
  }

  const requested = await input.client.requestBuild(input.id, input.version, input.target);
  if (requested.status === 'queued') {
    if (!requested.jobId) throw new DkbError(`Registry queued ${input.id}@${input.version} without a build job id`);
    await waitForBuild(input.client, input.id, input.version, requested.jobId, input.timeoutMs);
  }
  const plan = await input.client.installPlan(input.id, input.version, input.target);
  assertPlanMatchesTarget(planIdentity(plan), input);
  const layerRoot = `${input.stagedRoot}.layers`;
  const downloadedRoot = `${input.stagedRoot}.downloaded`;
  await fs.rm(input.stagedRoot, { recursive: true, force: true });
  await fs.mkdir(layerRoot, { recursive: true });
  try {
    for (const artifact of plan.artifacts) {
      const extension = artifact.kind === 'source' ? '.dkbpkg' : artifact.kind === 'evidence' ? '.dkbevidence' : '.dkbbuild';
      await input.client.writeInstallLayer(artifact, path.join(layerRoot, `${artifact.kind}${extension}`), { progress: input.progress });
    }
    await materializeDkbInstallPlan({
      plan,
      layerRoot,
      destinationRoot: downloadedRoot,
      trustedKeys: input.publicKeys,
      progress: input.progress,
    });
    await mergeStoredPackageBuilds(input.currentRoot, downloadedRoot);
    await fs.rename(downloadedRoot, input.stagedRoot);
  } finally {
    await fs.rm(layerRoot, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(downloadedRoot, { recursive: true, force: true }).catch(() => undefined);
  }
  return 'downloaded';
}

async function waitForBuild(
  client: DkbRegistryClient,
  packageId: string,
  version: string,
  jobId: number,
  timeoutMs = 30 * 60_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = await client.buildJob(packageId, version, jobId);
    if (job.status === 'published') return;
    if (job.status === 'failed' || job.status === 'revoked') {
      throw new DkbError(`Registry build failed for ${packageId}@${version} (${job.target}): ${job.error ?? job.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new DkbError(`Timed out waiting for Registry build ${jobId} for ${packageId}@${version}`);
}

async function trustedRegistryKeys(client: DkbRegistryClient): Promise<DkbSigningKeyRecord[]> {
  const value = await client.publicKeys();
  const keys = value && typeof value === 'object' && Array.isArray((value as { keys?: unknown }).keys)
    ? (value as { keys: DkbSigningKeyRecord[] }).keys
    : null;
  if (!keys) throw new DkbError('Registry public-key response is invalid');
  return keys;
}

function planIdentity(plan: Awaited<ReturnType<DkbRegistryClient['installPlan']>>) {
  return {
    target: plan.target,
    evidenceProfileDigest: plan.evidenceProfileDigest,
    retrievalProfileDigest: plan.retrievalProfileDigest,
    compatibilityDigest: plan.compatibilityDigest,
  };
}

function assertPlanMatchesTarget(
  plan: ReturnType<typeof planIdentity>,
  target: Pick<Parameters<typeof preparePackage>[0], 'target' | 'evidenceProfileDigest' | 'retrievalProfileDigest' | 'compatibilityDigest'>,
): void {
  if (plan.target !== target.target
    || plan.evidenceProfileDigest !== target.evidenceProfileDigest
    || plan.retrievalProfileDigest !== target.retrievalProfileDigest
    || plan.compatibilityDigest !== target.compatibilityDigest) {
    throw new DkbError(`Registry build for ${target.target} does not match the Runtime's resolved provider identities`);
  }
}

async function restoreConfig(configPath: string, previous: Buffer | null): Promise<void> {
  if (!previous) {
    await fs.rm(configPath, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, previous);
}

function requiredTarget(value: string): string {
  const target = value.trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(target)) throw new DkbError(`Invalid pipeline target: ${value}`);
  return target;
}

function requiredVersion(value: string | undefined, identity: string): string {
  if (!value) throw new DkbError(`Installed DKB ${identity} does not have a resolved version`);
  return value;
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, '_');
}
