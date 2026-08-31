import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { LoadedDkb } from '@sjshovan/dkb-protocol/types.js';
import type { DkbRuntimeActivation, DkbRuntimeActivationEntry } from '@sjshovan/dkb-protocol/runtimeActivation.js';
import { readRetrievalProfileLock, resolveProviderRetrievalProfile } from '@sjshovan/dkb-pipeline/profile.js';
import { DkbProviderHost } from '@sjshovan/dkb-pipeline/host.js';
import type { DkbIndexMutationResult, DkbIndexProvider } from '@sjshovan/dkb-pipeline/types.js';
import { DKB_RETRIEVAL_BUILD_ARTIFACTS, resolveLibraryActivationBuilds, validateStoredPackageBuild } from '@sjshovan/dkb-library/builds.js';
import path from 'node:path';
import type { DkbRuntimeContext } from '../runtime/context.js';

export interface PreparedRuntimeIndexPackage {
  providerId: string;
  mode: DkbIndexProvider['mode'];
  validation: { documentCount: number };
  installed?: DkbIndexMutationResult;
  rollback(): Promise<void>;
}

export async function prepareRuntimeIndexPackage(input: {
  runtime: DkbRuntimeContext;
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
        `Pipeline compatibility mismatch for ${input.dkb.manifest.id}@${input.dkb.manifest.version}: Library ${profile.embedding.space}/${profile.embedding.dimensions}, package ${packageProfile.profile.embedding.space}/${packageProfile.profile.embedding.dimensions}`,
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
    const validation = await provider.validatePackage({
      dkb: input.dkb,
      artifactsRoot: path.join(buildGraph.retrievalPath, DKB_RETRIEVAL_BUILD_ARTIFACTS),
      compatibility: profile.compatibility,
      options,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const installed = provider.mode === 'managed'
      ? await provider.installPackage?.({
          libraryRoot: input.libraryRoot,
          libraryId: input.libraryId,
          dkb: input.dkb,
          artifactsRoot: path.join(buildGraph.retrievalPath, DKB_RETRIEVAL_BUILD_ARTIFACTS),
          compatibility: profile.compatibility,
          options,
          ...(input.signal ? { signal: input.signal } : {}),
        })
      : undefined;

    if (provider.mode === 'managed' && !installed) {
      throw new DkbError(`Managed index provider ${selected} cannot install package indexes`);
    }

    return {
      providerId: selected,
      mode: provider.mode,
      validation,
      ...(installed ? { installed } : {}),
      rollback: async () => {
        if (!installed?.created) {
          return;
        }
        await cleanupRuntimeIndexPackage({
          runtime: input.runtime,
          runtimeStateRoot: input.runtimeStateRoot,
          libraryRoot: input.libraryRoot,
          libraryId: input.libraryId,
          packageId: input.dkb.manifest.id,
          packageVersion: input.dkb.manifest.version,
          target: input.target ?? host.config.activeTarget,
        });
      },
    };
  } finally {
    await host.dispose();
  }
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
    return provider.verifyRuntime({
      libraryRoot: input.libraryRoot,
      libraryId: input.libraryId,
      packages,
      packageId: input.packageId,
      packageVersion: input.packageVersion,
      compatibility: profile.compatibility,
      options: host.optionsFor(host.config.target.index),
      ...(input.signal ? { signal: input.signal } : {}),
    });
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
    return provider.uninstallPackage({
      libraryRoot: input.libraryRoot,
      libraryId: input.libraryId,
      packageId: input.packageId,
      packageVersion: input.packageVersion,
      options: host.optionsFor(host.config.target.index),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } finally {
    await host.dispose();
  }
}
