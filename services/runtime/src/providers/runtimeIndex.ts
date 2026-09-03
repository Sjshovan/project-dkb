import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { LoadedDkb } from '@sjshovan/dkb-protocol/types.js';
import type { DkbRuntimeActivation, DkbRuntimeActivationEntry } from '@sjshovan/dkb-protocol/runtimeActivation.js';
import { readRetrievalProfileLock, resolveProviderRetrievalProfile, type DkbResolvedRetrievalProfile } from '@sjshovan/dkb-pipeline/profile.js';
import { DkbProviderHost } from '@sjshovan/dkb-pipeline/host.js';
import type { DkbIndexMutationResult, DkbIndexProvider, DkbJsonValue } from '@sjshovan/dkb-pipeline/types.js';
import { validateIndexMutationResult } from '@sjshovan/dkb-pipeline/validation.js';
import { DkbSdkError } from '@sjshovan/dkb-pipeline/sdk.js';
import { DKB_RETRIEVAL_BUILD_ARTIFACTS, resolveLibraryActivationBuilds, validateStoredPackageBuild } from '@sjshovan/dkb-library/builds.js';
import path from 'node:path';
import type { DkbRuntimeContext } from '../runtime/context.js';

export interface PreparedRuntimeIndexPackage {
  providerId: string;
  mode: DkbIndexProvider['mode'];
  validation: { documentCount: number };
  installed?: DkbIndexMutationResult;
  /** Discard only an exact index this preparation positively created, never all package spaces. */
  rollback(): Promise<DkbIndexMutationResult | null>;
}

export async function prepareRuntimeIndexPackage(input: {
  runtime: DkbRuntimeContext;
  runtimeId: string;
  runtimeStateRoot: string;
  libraryRoot: string;
  libraryId: string;
  dkb: LoadedDkb;
  target?: string;
  selection: DkbRuntimeActivationEntry;
  signal?: AbortSignal;
}): Promise<PreparedRuntimeIndexPackage> {
  const host = await DkbProviderHost.create({
    root: input.runtimeStateRoot,
    libraryRoot: input.libraryRoot,
    distribution: input.runtime.distribution,
    ...(input.target ? { target: input.target } : {}),
  });

  try {
    const selected = host.config.target.index;
    const provider = host.provider<DkbIndexProvider>('index');
    const profile = await resolveProviderRetrievalProfile(host);
    const buildGraph = await validateStoredPackageBuild(input.dkb.root, input.selection);
    const packageProfile = await readRetrievalProfileLock(buildGraph.retrievalPath);
    if (packageProfile.profile.index.provider !== selected || packageProfile.profile.index.mode !== provider.mode || packageProfile.profile.index.format !== provider.format) {
      throw new DkbError(
        `Index provider mismatch for ${input.dkb.manifest.id}@${input.dkb.manifest.version}: Library selects ${selected}/${provider.format}, package requires ${packageProfile.profile.index.provider}/${packageProfile.profile.index.format}`,
      );
    }
    if (packageProfile.compatibilityDigest !== stableHash(profile.compatibility)) {
      throw new DkbError(
        `Pipeline compatibility mismatch for ${input.dkb.manifest.id}@${input.dkb.manifest.version}: Runtime ${embeddingLabel(profile.embedding)}, package ${embeddingLabel(packageProfile.profile.embedding)}`,
      );
    }
    if (input.selection.evidenceProfileDigest !== profile.evidenceProfileDigest
      || input.selection.retrievalProfileDigest !== profile.retrievalProfileDigest
      || buildGraph.retrieval.compatibilityDigest !== packageProfile.compatibilityDigest) {
      throw new DkbError(
        `Build graph mismatch for ${input.dkb.manifest.id}@${input.dkb.manifest.version}: selected pipeline ${profile.retrievalProfileDigest}, package ${input.selection.retrievalProfileDigest}`,
      );
    }
    if (!provider.validatePackage) {
      throw new DkbError(`Selected index provider ${selected} cannot validate compiled packages`);
    }
    const options = host.optionsFor(selected);
    const validation = validatePackageResult(await provider.validatePackage({
      dkb: input.dkb,
      artifactsRoot: path.join(buildGraph.retrievalPath, DKB_RETRIEVAL_BUILD_ARTIFACTS),
      compatibility: profile.compatibility as unknown as Record<string, DkbJsonValue>,
      options,
      ...(input.signal ? { signal: input.signal } : {}),
    }), selected, buildGraph.evidence.recordCount);
    let installed: DkbIndexMutationResult | undefined;
    if (provider.mode === 'managed') {
      try {
        installed = validateLifecycleResult(await provider.installPackage({
          libraryRoot: input.libraryRoot,
          libraryId: input.libraryId,
          dkb: input.dkb,
          artifactsRoot: path.join(buildGraph.retrievalPath, DKB_RETRIEVAL_BUILD_ARTIFACTS),
          compatibility: profile.compatibility as unknown as Record<string, DkbJsonValue>,
          options,
          ...(input.signal ? { signal: input.signal } : {}),
        }), selected, 'install', validation.documentCount);
      } catch (error) {
        throw new DkbError(
          `Managed index preparation failed for ${input.dkb.manifest.id}@${input.dkb.manifest.version}: ${error instanceof Error ? error.message : String(error)}. `
          + `Provider ${selected} may have left an unactivated index. Automatic deletion is unsafe because the install result did not establish whether DKB created it. `
          + `Inspect this package's indexes with the provider's administration tools, then run dkb pipeline verify ${input.target ?? host.config.activeTarget} --runtime ${input.runtimeId} before retrying.`,
          error instanceof DkbError || error instanceof DkbSdkError ? error.code : 'runtime_index_preparation_failed',
        );
      }
    }

    return {
      providerId: selected,
      mode: provider.mode,
      validation,
      ...(installed ? { installed } : {}),
      rollback: async () => {
        if (!installed?.created) {
          return null;
        }
        return discardPreparedIndex({
          ...input, target: input.target ?? host.config.activeTarget,
          artifactsRoot: path.join(buildGraph.retrievalPath, DKB_RETRIEVAL_BUILD_ARTIFACTS),
          indexId: installed.indexId, profile, optionsDigest: stableHash(options),
        });
      },
    };
  } finally {
    await host.dispose();
  }
}

async function discardPreparedIndex(input: {
  runtime: DkbRuntimeContext;
  runtimeStateRoot: string;
  libraryRoot: string;
  libraryId: string;
  dkb: LoadedDkb;
  target: string;
  artifactsRoot: string;
  indexId: string;
  profile: DkbResolvedRetrievalProfile;
  optionsDigest: string;
}): Promise<DkbIndexMutationResult> {
  const host = await DkbProviderHost.create({ root: input.runtimeStateRoot, libraryRoot: input.libraryRoot, target: input.target, distribution: input.runtime.distribution });
  try {
    const profile = await resolveProviderRetrievalProfile(host);
    const provider = host.provider<DkbIndexProvider>('index');
    const options = host.optionsFor(host.config.target.index);
    if (profile.configDigest !== input.profile.configDigest
      || profile.providerBuildDigest !== input.profile.providerBuildDigest
      || profile.retrievalProfileDigest !== input.profile.retrievalProfileDigest
      || stableHash(options) !== input.optionsDigest) {
      throw new DkbError(`Pipeline changed after preparing index ${input.indexId}; no cleanup was attempted through the changed provider.`, 'runtime_index_cleanup_required');
    }
    if (provider.mode !== 'managed' || typeof provider.discardPackage !== 'function') {
      throw new DkbError(`Provider ${host.config.target.index} cannot discard exact index ${input.indexId}; broad package deletion is unsafe.`, 'runtime_index_cleanup_required');
    }
    await host.assertCurrent();
    const result = validateLifecycleResult(await provider.discardPackage({
      libraryRoot: input.libraryRoot, libraryId: input.libraryId, dkb: input.dkb,
      artifactsRoot: input.artifactsRoot, indexId: input.indexId,
      compatibility: input.profile.compatibility as unknown as Record<string, DkbJsonValue>, options,
    }), host.config.target.index, 'discard');
    if (result.indexId !== input.indexId) {
      throw new DkbError(`Provider ${host.config.target.index} reported cleanup for ${result.indexId}, not prepared index ${input.indexId}.`, 'provider_output_invalid');
    }
    return result;
  } finally { await host.dispose(); }
}

function embeddingLabel(embedding: { space: string; dimensions: number } | undefined): string {
  return embedding ? `${embedding.space}/${embedding.dimensions}` : 'lexical-only';
}

export async function verifyRuntimeIndex(input: {
  runtime: DkbRuntimeContext;
  runtimeStateRoot: string;
  libraryRoot: string;
  libraryId: string;
  packageId?: string;
  packageVersion?: string;
  target?: string;
  activation: DkbRuntimeActivation;
  signal?: AbortSignal;
}): Promise<DkbIndexMutationResult | null> {
  const host = await DkbProviderHost.create({
    root: input.runtimeStateRoot,
    libraryRoot: input.libraryRoot,
    distribution: input.runtime.distribution,
    ...(input.target ? { target: input.target } : {}),
  });

  try {
    const provider = host.provider<DkbIndexProvider>('index');

    if (!provider.verifyRuntime) {
      return null;
    }
    const profile = await resolveProviderRetrievalProfile(host);
    const packages = await resolveLibraryActivationBuilds(input.libraryRoot, input.activation);
    return validateLifecycleResult(await provider.verifyRuntime({
      libraryRoot: input.libraryRoot,
      libraryId: input.libraryId,
      packages,
      packageId: input.packageId,
      packageVersion: input.packageVersion,
      compatibility: profile.compatibility as unknown as Record<string, DkbJsonValue>,
      options: host.optionsFor(host.config.target.index),
      ...(input.signal ? { signal: input.signal } : {}),
    }), host.config.target.index, 'verify');
  } finally {
    await host.dispose();
  }
}

export async function cleanupRuntimeIndexPackage(input: {
  runtime: DkbRuntimeContext;
  runtimeStateRoot: string;
  libraryRoot: string;
  libraryId: string;
  packageId: string;
  packageVersion: string;
  target: string;
  signal?: AbortSignal;
}): Promise<DkbIndexMutationResult | null> {
  const host = await DkbProviderHost.create({
    root: input.runtimeStateRoot,
    libraryRoot: input.libraryRoot,
    target: input.target,
    distribution: input.runtime.distribution,
  });

  try {
    const provider = host.provider<DkbIndexProvider>('index');

    if (provider.mode !== 'managed' || !provider.uninstallPackage) {
      return null;
    }
    return validateLifecycleResult(await provider.uninstallPackage({
      libraryRoot: input.libraryRoot,
      libraryId: input.libraryId,
      packageId: input.packageId,
      packageVersion: input.packageVersion,
      options: host.optionsFor(host.config.target.index),
      ...(input.signal ? { signal: input.signal } : {}),
    }), host.config.target.index, 'uninstall');
  } finally {
    await host.dispose();
  }
}

function validatePackageResult(value: unknown, providerId: string, expectedCount: number): { documentCount: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new DkbError(`${providerId} returned an invalid package validation result`, 'provider_output_invalid');
  }
  const documentCount = (value as { documentCount?: unknown }).documentCount;
  if (!Number.isInteger(documentCount) || Number(documentCount) < 0 || documentCount !== expectedCount) {
    throw new DkbError(`${providerId} package validation count must equal ${expectedCount} canonical Evidence records`, 'provider_output_invalid');
  }
  return { documentCount: Number(documentCount) };
}

function validateLifecycleResult(value: unknown, providerId: string, operation: 'install' | 'verify' | 'uninstall' | 'discard', expectedCount?: number): DkbIndexMutationResult {
  const result = validateIndexMutationResult(value, providerId);
  const allowed = operation === 'uninstall' || operation === 'discard' ? ['removed', 'orphaned'] : ['ready'];
  if (!allowed.includes(result.status) || (expectedCount !== undefined && result.documentCount !== expectedCount)
    || (operation === 'install' && typeof result.created !== 'boolean')
    || (result.status === 'orphaned' && !result.warning)) {
    throw new DkbError(`${providerId} returned inconsistent ${operation} status or Evidence count`, 'provider_output_invalid');
  }
  return result;
}
