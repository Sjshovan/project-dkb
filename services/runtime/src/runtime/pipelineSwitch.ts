import fs from 'node:fs/promises';
import path from 'node:path';
import { selectStoredPackageBuild } from '@sjshovan/dkb-library/builds.js';
import { libraryStateIdentity, readLibraryState } from '@sjshovan/dkb-library/state.js';
import type { DkbRetrievalBuildGrant } from '@sjshovan/dkb-protocol/builds.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { loadDkbPackage, loadLibrary } from '@sjshovan/dkb-protocol/manifest.js';
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
import { attachSignedRetrievalBuild } from './registryInstall.js';
import { closeRuntimeQuerySnapshot, invalidateRuntimeQuerySnapshot } from './querySnapshot.js';
import {
  createRuntimeActivation,
  ensureRuntimeState,
  writeRuntimeSelection,
} from './activation.js';
import { prepareRuntimeIndexPackage, type PreparedRuntimeIndexPackage } from '../providers/runtimeIndex.js';
import type { DkbRuntimeContext } from './context.js';

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
  preparation: 'retained' | 'downloaded';
  selection: DkbRuntimeActivationEntry;
  index: PreparedRuntimeIndexPackage;
}

export async function switchRuntimePipelineFromRegistry(options: {
  runtime: DkbRuntimeContext;
  stateRoot?: string;
  libraryRoot?: string;
  target: string;
  registryUrl?: string;
  grants?: Record<string, { build: DkbRetrievalBuildGrant; installGrant: string }>;
  timeoutMs?: number;
  progress?: DkbProgressReporter;
  libraryBinding?: DkbRuntimeLibraryBinding;
}): Promise<DkbRuntimePipelineSwitchResult> {
  const instance = await ensureRuntimeState(options.stateRoot);
  const libraryRoot = path.resolve(options.libraryRoot ?? instance.libraryRoot);
  await loadLibrary(libraryRoot);
  const target = requiredTarget(options.target);
  const registryUrl = options.registryUrl?.trim();
  const client = registryUrl ? new DkbRegistryClient({ baseUrl: registryUrl, token: '' }) : null;
  const stageRoot = path.join(instance.stateDir, `pipeline-stage-${process.pid}-${Date.now().toString(36)}`);
  const prepared: PreparedPackage[] = [];
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
    const compatibilityDigest = stableHash(profile.compatibility);
    const state = await readLibraryState(libraryRoot);
    const entries = Object.values(state.entries)
      .filter((entry) => entry.kind === 'dkb' && entry.status === 'installed')
      .sort((left, right) => left.identity.localeCompare(right.identity));
    const library = await loadLibrary(libraryRoot);
    let publicKeys: Promise<DkbSigningKeyRecord[]> | null = null;
    const trustedKeys = () => {
      if (!client) throw new DkbError('A Registry URL is required to download missing builds');
      publicKeys ??= trustedRegistryKeys(client);
      return publicKeys;
    };
    await fs.mkdir(stageRoot, { recursive: true });

    for (const entry of entries) {
      const packageRoot = path.resolve(libraryRoot, entry.path);
      const preparedBuild = await preparePackageBuild({
        client,
        trustedKeys,
        packageRoot,
        stageRoot: path.join(stageRoot, safePathSegment(entry.identity)),
        id: entry.identity,
        version: requiredVersion(entry.version, entry.identity),
        source: entry.source,
        target,
        evidenceProfileDigest: profile.evidenceProfileDigest,
        retrievalProfileDigest: profile.retrievalProfileDigest,
        compatibilityDigest,
        timeoutMs: options.timeoutMs,
        progress: options.progress,
        grant: options.grants?.[entry.identity],
      });
      const dkb = await loadDkbPackage(packageRoot, entry.identity);
      const index = await prepareRuntimeIndexPackage({
        runtime: options.runtime,
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
    await closeRuntimeQuerySnapshot(instance.stateRoot);
    await writeRuntimeSelection(instance.stateRoot, {
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
    for (const item of prepared) await item.index.rollback().catch(() => undefined);
    invalidateRuntimeQuerySnapshot(instance.stateRoot);
    throw error;
  } finally {
    await host?.dispose();
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
  grants?: Record<string, { build: DkbRetrievalBuildGrant; installGrant: string }>;
  progress?: DkbProgressReporter;
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
  });
}

async function preparePackageBuild(input: {
  client: DkbRegistryClient | null;
  trustedKeys: () => Promise<DkbSigningKeyRecord[]>;
  packageRoot: string;
  stageRoot: string;
  id: string;
  version: string;
  source: 'local' | 'registry';
  target: string;
  evidenceProfileDigest: string;
  retrievalProfileDigest: string;
  compatibilityDigest: string;
  timeoutMs?: number;
  progress?: DkbProgressReporter;
  grant?: { build: DkbRetrievalBuildGrant; installGrant: string };
}): Promise<{ preparation: 'retained' | 'downloaded'; selection: DkbRuntimeActivationEntry }> {
  try {
    const graph = await selectStoredPackageBuild({ root: input.packageRoot, ...profileSelection(input) });
    return { preparation: 'retained', selection: graph.selection };
  } catch (error) {
    if (input.source !== 'registry') {
      const message = error instanceof Error ? error.message : String(error);
      if (!/No stored Retrieval Build exists/u.test(message)) throw error;
      throw new DkbError(
        `Editable DKB ${input.id}@${input.version} has no stored build for ${input.target}. `
        + `Run dkb build ${input.packageRoot} --pipeline ${input.target}, then retry.`,
      );
    }
    if (!input.client || !input.grant) {
      throw new DkbError(
        `Registry DKB ${input.id}@${input.version} needs a signed ${input.target} build. `
        + 'Re-run from an authenticated DKB CLI so it can request an exact download grant.',
      );
    }
    const build = input.grant.build;
    assertBuildGrantMatchesTarget(build, input);
    const downloadClient = new DkbRegistryClient({
      baseUrl: input.client.baseUrl,
      token: '',
      installGrant: input.grant.installGrant,
    });
    const layerRoot = `${input.stageRoot}.layers`;
    await fs.mkdir(layerRoot, { recursive: true });
    try {
      const archivePath = path.join(layerRoot, 'retrieval.dkbbuild');
      await downloadClient.writeInstallLayer(build.artifact, archivePath, { progress: input.progress });
      const graph = await attachSignedRetrievalBuild({
        grant: build,
        archivePath,
        packageRoot: input.packageRoot,
        trustedKeys: await input.trustedKeys(),
        progress: input.progress,
      });
      return { preparation: 'downloaded', selection: graph.selection };
    } finally {
      await fs.rm(layerRoot, { recursive: true, force: true }).catch(() => undefined);
    }
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
  const value = await client.publicKeys();
  const keys = value && typeof value === 'object' && Array.isArray((value as { keys?: unknown }).keys)
    ? (value as { keys: DkbSigningKeyRecord[] }).keys
    : null;
  if (!keys) throw new DkbError('Registry public-key response is invalid');
  return keys;
}

function assertBuildGrantMatchesTarget(build: DkbRetrievalBuildGrant, target: {
  target: string;
  evidenceProfileDigest: string;
  retrievalProfileDigest: string;
  compatibilityDigest: string;
}): void {
  if (build.target !== target.target
    || build.evidenceProfileDigest !== target.evidenceProfileDigest
    || build.retrievalProfileDigest !== target.retrievalProfileDigest
    || build.compatibilityDigest !== target.compatibilityDigest) {
    throw new DkbError(`Registry build for ${target.target} does not match the Runtime's resolved provider identities`);
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
