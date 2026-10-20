import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveLibraryActivationBuilds, selectStoredPackageBuild } from '@sjshovan/dkb-library/builds.js';
import { withDkbFileLock } from '@sjshovan/dkb-library/locks.js';
import { assertLibraryReadFence, captureLibraryReadFence } from '@sjshovan/dkb-library/mutation.js';
import { libraryStateIdentity, readLibraryState } from '@sjshovan/dkb-library/state.js';
import { validateInstallPlan, type DkbInstallPlan } from '@sjshovan/dkb-protocol/builds.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { loadDkbPackage, loadLibrary } from '@sjshovan/dkb-protocol/manifest.js';
import { evidenceBuildPath, retrievalBuildPath } from '@sjshovan/dkb-protocol/paths.js';
import type { DkbProgressReporter } from '@sjshovan/dkb-protocol/progress.js';
import {
  DKB_RUNTIME_BINDING_FORMAT,
  type DkbRuntimeActivationEntry,
  type DkbRuntimeLibraryBinding,
} from '@sjshovan/dkb-protocol/runtimeActivation.js';
import type { DkbSigningKeyRecord } from '@sjshovan/dkb-protocol/types.js';
import { DkbProviderHost } from '@sjshovan/dkb-pipeline/host.js';
import { resolveProviderRetrievalProfile } from '@sjshovan/dkb-pipeline/profile.js';
import { DkbRegistryClient } from '@sjshovan/dkb-registry-client/client.js';
import { normalizeRegistryUrl, validateRegistryTransportUrl } from '@sjshovan/dkb-registry-client/config.js';
import {
  attachSignedBuildChainWithinMutation,
  parseRegistryTrustedKeys,
  verifySignedInstallPlanForInstalledSource,
  verifyRetainedRegistryBuild,
  verifyRuntimeRegistryBuilds,
} from './registryInstall.js';
import { assertFileSnapshotCurrent, captureFileSnapshot, type FileSnapshot } from '@sjshovan/dkb-protocol/fileSnapshot.js';
import { captureQueryInputs } from '../indexes/queryInputs.js';
import { closeRuntimeQuerySnapshot, invalidateRuntimeQuerySnapshot } from './querySnapshot.js';
import { withRuntimeMutation } from './mutation.js';
import {
  createRuntimeActivation,
  ensureRuntimeState,
  promoteRuntimeSelection,
} from './activation.js';
import { prepareRuntimeIndexPackage, type PreparedRuntimeIndexPackage } from '../providers/runtimeIndex.js';
import { reconcileManagedIndexPackages, type ManagedIndexCleanup } from '../providers/managedIndexRetention.js';
import type { DkbRuntimeContext } from './context.js';
import { defaultRuntimeStateRoot } from './paths.js';
import { assertRuntimePipelinePreparation, type DkbRuntimePipelinePreparation } from './pipelinePreparation.js';

export interface DkbRuntimePipelineSwitchResult {
  status: 'pipeline_switched';
  runtimeId: string;
  target: string;
  previousTarget: string | null;
  libraryPath: string;
  evidenceProfileDigest: string;
  retrievalProfileDigest: string;
  compatibilityDigest: string;
  activationGeneration: number;
  indexCleanup?: ManagedIndexCleanup;
  warning?: string;
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

export interface DkbRuntimePipelineBuildGrant {
  plan: DkbInstallPlan;
  installGrant: string;
  registryTransportUrl?: string;
}

interface PreparedPackage {
  id: string;
  version: string;
  source: 'local' | 'registry';
  preparation: 'retained' | 'downloaded';
  selection: DkbRuntimeActivationEntry;
  index: PreparedRuntimeIndexPackage;
  inputs: FileSnapshot;
}

export async function switchRuntimePipelineFromRegistry(options: {
  runtime: DkbRuntimeContext;
  stateRoot?: string;
  libraryRoot?: string;
  target: string;
  registryUrl?: string;
  registryTransportUrl?: string;
  grants?: Record<string, DkbRuntimePipelineBuildGrant>;
  timeoutMs?: number;
  progress?: DkbProgressReporter;
  libraryBinding?: DkbRuntimeLibraryBinding;
  expected?: DkbRuntimePipelinePreparation;
}): Promise<DkbRuntimePipelineSwitchResult> {
  const stateRoot = path.resolve(options.stateRoot ?? defaultRuntimeStateRoot());
  const registryTransportUrl = options.registryTransportUrl?.trim();
  return withRuntimeMutation(stateRoot, async () => {
    const result = await switchRuntimePipelineUnlocked({
      ...options, stateRoot, ...(registryTransportUrl ? { registryTransportUrl } : {}),
    });
    // Activation is committed and its Library lease released before maintenance.
    // Cleanup failure must never roll back the new snapshot or its prepared indexes.
    const indexCleanup = await reconcileManagedIndexPackages({ runtime: options.runtime, stateRoot, runtimeId: result.runtimeId });
    return { ...result, indexCleanup, ...(indexCleanup.pending ? { warning: indexCleanup.warnings.join(' ') } : {}) };
  });
}

async function switchRuntimePipelineUnlocked(options: {
  runtime: DkbRuntimeContext;
  stateRoot: string;
  libraryRoot?: string;
  target: string;
  registryUrl?: string;
  registryTransportUrl?: string;
  grants?: Record<string, DkbRuntimePipelineBuildGrant>;
  timeoutMs?: number;
  progress?: DkbProgressReporter;
  libraryBinding?: DkbRuntimeLibraryBinding;
  expected?: DkbRuntimePipelinePreparation;
}): Promise<DkbRuntimePipelineSwitchResult> {
  const instance = await ensureRuntimeState(options.stateRoot);
  const libraryRoot = path.resolve(options.libraryRoot ?? instance.libraryRoot);
  await captureLibraryReadFence(libraryRoot);
  await loadLibrary(libraryRoot);
  return withDkbFileLock(libraryRoot, 'library-mutation', () => switchRuntimePipelineWithinLibraryMutation(
    { ...options, libraryRoot },
    instance,
  ));
}

async function switchRuntimePipelineWithinLibraryMutation(options: {
  runtime: DkbRuntimeContext;
  stateRoot: string;
  libraryRoot: string;
  target: string;
  registryUrl?: string;
  registryTransportUrl?: string;
  grants?: Record<string, DkbRuntimePipelineBuildGrant>;
  timeoutMs?: number;
  progress?: DkbProgressReporter;
  libraryBinding?: DkbRuntimeLibraryBinding;
  expected?: DkbRuntimePipelinePreparation;
}, instance: Awaited<ReturnType<typeof ensureRuntimeState>>): Promise<DkbRuntimePipelineSwitchResult> {
  const libraryRoot = options.libraryRoot;
  const libraryFence = await captureLibraryReadFence(libraryRoot);
  const target = requiredTarget(options.target);
  if (options.expected !== undefined) await assertRuntimePipelinePreparation(options.expected, instance, libraryRoot, target);
  const registryTransportUrl = options.registryTransportUrl?.trim();
  const stageRoot = path.join(instance.stateDir, `pipeline-stage-${process.pid}-${Date.now().toString(36)}`);
  const prepared: PreparedPackage[] = [];
  const publicKeys = new Map<string, Promise<DkbSigningKeyRecord[]>>();
  let host: DkbProviderHost | null = null;

  try {
    host = await DkbProviderHost.create({
      root: instance.stateRoot,
      libraryRoot,
      target,
      distribution: options.runtime.distribution,
    });
    const unhealthy = (await host.health(['embedding', 'index', 'retrieval'])).filter((provider) => !provider.ok);
    if (unhealthy.length > 0) {
      throw new DkbError(
        `Cannot activate ${target}; required providers are unhealthy: ${unhealthy.map((provider) => `${provider.id} (${provider.detail ?? 'health check failed'})`).join('; ')}.`,
      );
    }
    const profile = await resolveProviderRetrievalProfile(host);
    if (options.expected !== undefined) await assertRuntimePipelinePreparation(options.expected, instance, libraryRoot, target, profile);
    const compatibilityDigest = stableHash(profile.compatibility);
    const state = await readLibraryState(libraryRoot);
    const entries = Object.values(state.entries)
      .filter((entry) => entry.kind === 'dkb' && entry.status === 'installed')
      .sort((left, right) => left.identity.localeCompare(right.identity));
    const library = await loadLibrary(libraryRoot);
    await fs.mkdir(stageRoot, { recursive: true });

    for (const entry of entries) {
      const packageRoot = path.resolve(libraryRoot, entry.path);
      const preparedBuild = await preparePackageBuild({
        packageRoot,
        libraryRoot,
        stageRoot: path.join(stageRoot, safePathSegment(entry.identity)),
        id: entry.identity,
        version: requiredVersion(entry.version, entry.identity),
        source: entry.source,
        registryUrl: entry.registryUrl,
        registryTransportUrl,
        trustedKeys: (client) => {
          const key = client.baseUrl;
          let pending = publicKeys.get(key);
          if (!pending) {
            pending = trustedRegistryKeys(client);
            publicKeys.set(key, pending);
          }
          return pending;
        },
        target,
        evidenceProfileDigest: profile.evidenceProfileDigest,
        retrievalProfileDigest: profile.retrievalProfileDigest,
        compatibilityDigest,
        timeoutMs: options.timeoutMs,
        progress: options.progress,
        grant: options.grants?.[entry.identity],
      });
      const dkb = await loadDkbPackage(packageRoot, entry.identity);
      const inputs = await captureFileSnapshot([
        evidenceBuildPath(packageRoot, preparedBuild.selection.evidenceProfileDigest, preparedBuild.selection.evidenceDigest),
        retrievalBuildPath(packageRoot, preparedBuild.selection.retrievalProfileDigest, preparedBuild.selection.retrievalBuildDigest),
      ], { recursive: true });
      const index = await prepareRuntimeIndexPackage({
        runtime: options.runtime,
        runtimeId: instance.runtimeId,
        runtimeStateRoot: instance.stateRoot,
        libraryRoot,
        libraryId: library.manifest.id,
        dkb,
        target,
        selection: preparedBuild.selection,
      });
      prepared.push({
        id: entry.identity,
        version: dkb.manifest.version,
        source: entry.source,
        preparation: preparedBuild.preparation,
        selection: preparedBuild.selection,
        index,
        inputs,
      });
    }

    const identity = await libraryStateIdentity(libraryRoot);
    const activation = createRuntimeActivation({
      runtimeId: instance.runtimeId,
      library: identity,
      target,
      evidenceProfileDigest: profile.evidenceProfileDigest,
      retrievalProfileDigest: profile.retrievalProfileDigest,
      compatibilityDigest,
      packages: Object.fromEntries(prepared.map((item) => [item.id, item.selection])),
      generation: (instance.activation?.generation ?? 0) + 1,
      generatedAt: new Date().toISOString(),
    });
    const candidateInputs = await captureQueryInputs(libraryRoot, activation);
    await resolveLibraryActivationBuilds(libraryRoot, activation);
    await verifyRuntimeRegistryBuilds(libraryRoot, activation);
    await Promise.all([host.assertCurrent(), assertFileSnapshotCurrent(candidateInputs), ...prepared.map((item) => assertFileSnapshotCurrent(item.inputs))]);
    await closeRuntimeQuerySnapshot(instance.stateRoot);
    await Promise.all([host.assertCurrent(), assertFileSnapshotCurrent(candidateInputs), ...prepared.map((item) => assertFileSnapshotCurrent(item.inputs))]);
    await assertLibraryReadFence(libraryRoot, libraryFence);
    await promoteRuntimeSelection(instance.stateRoot, {
      format: DKB_RUNTIME_BINDING_FORMAT,
      runtimeId: instance.runtimeId,
      library: options.libraryBinding ?? (
        path.resolve(instance.libraryRoot) === libraryRoot
          ? instance.binding.library
          : { kind: 'local', path: libraryRoot }
      ),
      target,
      updatedAt: new Date().toISOString(),
    }, activation);
    invalidateRuntimeQuerySnapshot(instance.stateRoot);

    return {
      status: 'pipeline_switched',
      runtimeId: instance.runtimeId,
      target,
      previousTarget: instance.activation?.target ?? instance.binding.target ?? null,
      libraryPath: libraryRoot,
      evidenceProfileDigest: profile.evidenceProfileDigest,
      retrievalProfileDigest: profile.retrievalProfileDigest,
      compatibilityDigest,
      activationGeneration: activation.generation,
      packageCount: prepared.length,
      packages: prepared.map((item) => ({
        id: item.id,
        version: item.version,
        source: item.source,
        preparation: item.preparation,
        evidenceDigest: item.selection.evidenceDigest,
        retrievalBuildDigest: item.selection.retrievalBuildDigest,
      })),
    };
  } catch (error) {
    const cleanupWarnings: string[] = [];
    for (const item of [...prepared].reverse()) {
      try {
        const result = await item.index.rollback();
        if (result?.status === 'orphaned') cleanupWarnings.push(`${item.id}@${item.version} (${item.index.providerId}, index ${result.indexId}): ${result.warning}`);
      } catch (cleanupError) {
        cleanupWarnings.push(`${item.id}@${item.version} (${item.index.providerId}, index ${item.index.installed?.indexId ?? 'unknown'}): ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      }
    }
    invalidateRuntimeQuerySnapshot(instance.stateRoot);
    if (cleanupWarnings.length > 0) {
      throw new DkbError(
        `${error instanceof Error ? error.message : String(error)} Managed-index rollback needs attention: ${cleanupWarnings.join('; ')}. `
        + `Restore the provider service, inspect these indexes, and remove only confirmed orphans using its administration tools. `
        + `Run dkb pipeline verify ${target} --runtime ${instance.runtimeId}, then retry dkb pipeline use ${target} --runtime ${instance.runtimeId}.`,
        'runtime_index_cleanup_required',
      );
    }
    throw error;
  } finally {
    if (host) await host.dispose().catch(() => undefined);
    await fs.rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function refreshRuntimeActivation(options: {
  runtime: DkbRuntimeContext;
  stateRoot?: string;
  progress?: DkbProgressReporter;
  libraryBinding?: DkbRuntimeLibraryBinding;
}): Promise<DkbRuntimePipelineSwitchResult> {
  const instance = await ensureRuntimeState(options.stateRoot);
  return switchRuntimePipelineFromRegistry({
    runtime: options.runtime,
    stateRoot: instance.stateRoot,
    target: instance.binding.target,
    ...(options.progress ? { progress: options.progress } : {}),
    ...(options.libraryBinding ? { libraryBinding: options.libraryBinding } : {}),
  });
}

export async function switchRuntimeLibrary(options: {
  runtime: DkbRuntimeContext;
  stateRoot?: string;
  libraryRoot: string;
  target?: string;
  registryUrl?: string;
  grants?: Record<string, DkbRuntimePipelineBuildGrant>;
  progress?: DkbProgressReporter;
  libraryBinding?: DkbRuntimeLibraryBinding;
}): Promise<DkbRuntimePipelineSwitchResult> {
  const instance = await ensureRuntimeState(options.stateRoot);
  return switchRuntimePipelineFromRegistry({
    runtime: options.runtime,
    stateRoot: instance.stateRoot,
    libraryRoot: options.libraryRoot,
    target: options.target ?? instance.binding.target,
    ...(options.registryUrl ? { registryUrl: options.registryUrl } : {}),
    ...(options.grants ? { grants: options.grants } : {}),
    ...(options.progress ? { progress: options.progress } : {}),
    ...(options.libraryBinding ? { libraryBinding: options.libraryBinding } : {}),
  });
}

async function preparePackageBuild(input: {
  packageRoot: string;
  libraryRoot: string;
  stageRoot: string;
  id: string;
  version: string;
  source: 'local' | 'registry';
  registryUrl?: string;
  registryTransportUrl?: string;
  trustedKeys: (client: DkbRegistryClient) => Promise<DkbSigningKeyRecord[]>;
  target: string;
  evidenceProfileDigest: string;
  retrievalProfileDigest: string;
  compatibilityDigest: string;
  timeoutMs?: number;
  progress?: DkbProgressReporter;
  grant?: DkbRuntimePipelineBuildGrant;
}): Promise<{ preparation: 'retained' | 'downloaded'; selection: DkbRuntimeActivationEntry }> {
  let retained: Awaited<ReturnType<typeof selectStoredPackageBuild>> | null = null;
  try {
    retained = await selectStoredPackageBuild({ root: input.packageRoot, ...profileSelection(input) });
  } catch (error) {
    if (!(error instanceof DkbError) || error.code !== 'retrieval_build_missing') throw error;
  }

  if (retained) {
    if (input.source === 'local') return { preparation: 'retained', selection: retained.selection };
    if (!input.registryUrl) {
      throw new DkbError(`Registry DKB ${input.id}@${input.version} does not retain an exact Registry origin.`);
    }
    try {
      await verifyRetainedRegistryBuild({
        libraryRoot: input.libraryRoot,
        registryUrl: input.registryUrl,
        packageRoot: input.packageRoot,
        graph: retained,
        target: input.target,
      });
      return { preparation: 'retained', selection: retained.selection };
    } catch (error) {
      if (!input.grant) throw error;
    }
  }

  if (input.source !== 'registry') {
    throw new DkbError(
      `Editable DKB ${input.id}@${input.version} has no stored build for ${input.target}. `
      + `Run dkb build ${input.packageRoot} --pipeline ${input.target}, then retry.`,
    );
  }
  if (!input.grant) {
    throw new DkbError(
      `Registry DKB ${input.id}@${input.version} needs a signed ${input.target} build. `
      + 'Re-run from an authenticated DKB CLI so it can request an exact download grant.',
    );
  }
  if (!input.registryUrl) {
    throw new DkbError(`Registry DKB ${input.id}@${input.version} does not retain an exact Registry origin.`);
  }
  const plan = validateInstallPlan(
    input.grant.plan,
    `Runtime Pipeline install plan for ${input.id}@${input.version}`,
  );
  assertInstallPlanMatchesTarget(plan, input);
  const transportUrl = input.grant.registryTransportUrl
    ? validateRegistryTransportUrl(input.registryUrl, input.grant.registryTransportUrl)
    : normalizeRegistryUrl(input.registryTransportUrl ?? input.registryUrl);
  const publicClient = new DkbRegistryClient({ baseUrl: transportUrl, token: '' });
  const downloadClient = new DkbRegistryClient({
    baseUrl: transportUrl,
    token: '',
    installGrant: input.grant.installGrant,
  });
  const trustedKeys = await input.trustedKeys(publicClient);
  await verifySignedInstallPlanForInstalledSource({
    plan,
    packageRoot: input.packageRoot,
    trustedKeys,
  });
  const layerRoot = `${input.stageRoot}.layers`;
  await fs.mkdir(layerRoot, { recursive: true });
  try {
    await downloadClient.writeInstallLayer(
      plan.artifacts[1],
      path.join(layerRoot, 'evidence.dkbevidence'),
      { progress: input.progress },
    );
    await downloadClient.writeInstallLayer(
      plan.artifacts[2],
      path.join(layerRoot, 'retrieval.dkbbuild'),
      { progress: input.progress },
    );
    const graph = await attachSignedBuildChainWithinMutation({
      plan,
      layerRoot,
      packageRoot: input.packageRoot,
      libraryRoot: input.libraryRoot,
      registryUrl: input.registryUrl,
      trustedKeys,
      progress: input.progress,
    });
    return { preparation: 'downloaded', selection: graph.selection };
  } finally {
    await fs.rm(layerRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function profileSelection(input: {
  target: string;
  evidenceProfileDigest: string;
  retrievalProfileDigest: string;
  compatibilityDigest: string;
}) {
  return {
    target: input.target,
    evidenceProfileDigest: input.evidenceProfileDigest,
    retrievalProfileDigest: input.retrievalProfileDigest,
    compatibilityDigest: input.compatibilityDigest,
  };
}

async function trustedRegistryKeys(client: DkbRegistryClient): Promise<DkbSigningKeyRecord[]> {
  return parseRegistryTrustedKeys(await client.publicKeys());
}

function assertInstallPlanMatchesTarget(plan: DkbInstallPlan, target: {
  id: string;
  version: string;
  target: string;
  evidenceProfileDigest: string;
  retrievalProfileDigest: string;
  compatibilityDigest: string;
}): void {
  if (plan.package.id !== target.id
    || plan.package.version !== target.version
    || plan.evidenceProfileDigest !== target.evidenceProfileDigest
    || plan.retrievalProfileDigest !== target.retrievalProfileDigest
    || plan.compatibilityDigest !== target.compatibilityDigest) {
    throw new DkbError(`Registry install plan for ${target.target} does not match the Runtime's resolved provider identities`);
  }
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
