import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { LoadedDkb } from '@sjshovan/dkb-protocol/types.js';
import { maybeReadRetrievalProfileLock, resolveProviderRetrievalProfile } from '@sjshovan/dkb-pipeline/profile.js';
import { DEFAULT_DKB_DISTRIBUTION } from '@sjshovan/dkb-distribution-default';
import { DkbProviderHost } from '@sjshovan/dkb-pipeline/host.js';
import type { DkbIndexMutationResult, DkbIndexProvider } from '@sjshovan/dkb-pipeline/types.js';
import { DKB_RETRIEVAL_BUILD_ARTIFACTS, resolveLibraryRuntimeBuilds, validatePackageBuildGraph } from '@sjshovan/dkb-library/builds.js';
import path from 'node:path';

export interface PreparedRuntimeIndexPackage {
  providerId: string;
  mode: DkbIndexProvider['mode'];
  validation: { documentCount: number };
  installed?: DkbIndexMutationResult;
  rollback(): Promise<void>;
}

export async function prepareRuntimeIndexPackage(input: {
  libraryRoot: string;
  libraryId: string;
  dkb: LoadedDkb;
  target?: string;
  signal?: AbortSignal;
}): Promise<PreparedRuntimeIndexPackage> {
  const host = await DkbProviderHost.create({
    root: input.libraryRoot,
    distribution: DEFAULT_DKB_DISTRIBUTION,
    ...(input.target ? { target: input.target } : {}),
  });

  try {
    const selected = host.config.target.index;
    const provider = host.provider<DkbIndexProvider>('index');
    const profile = await resolveProviderRetrievalProfile(host);
    const buildGraph = await validatePackageBuildGraph(input.dkb.root);
    const packageProfile = await maybeReadRetrievalProfileLock(input.dkb.root);

    if (!packageProfile) {
      throw new DkbError(`Compiled package ${input.dkb.manifest.id}@${input.dkb.manifest.version} is missing dkb-profile.lock.json`);
    }
    if (packageProfile.profile.index.provider !== selected || packageProfile.profile.index.mode !== provider.mode || packageProfile.profile.index.format !== provider.format) {
      throw new DkbError(
        `Index provider mismatch for ${input.dkb.manifest.id}@${input.dkb.manifest.version}: Library selects ${selected}/${provider.format}, package requires ${packageProfile.profile.index.provider}/${packageProfile.profile.index.format}`,
      );
    }
    if (packageProfile.compatibilityDigest !== stableHash(profile.compatibility)) {
      throw new DkbError(
        `Pipeline compatibility mismatch for ${input.dkb.manifest.id}@${input.dkb.manifest.version}: Library ${profile.embedding.model}/${profile.embedding.dimensions}, package ${packageProfile.profile.embedding.model}/${packageProfile.profile.embedding.dimensions}`,
      );
    }
    if (buildGraph.runtime.evidenceProfileDigest !== profile.evidenceProfileDigest
      || buildGraph.runtime.retrievalProfileDigest !== profile.retrievalProfileDigest
      || buildGraph.runtime.compatibilityDigest !== packageProfile.compatibilityDigest) {
      throw new DkbError(
        `Build graph mismatch for ${input.dkb.manifest.id}@${input.dkb.manifest.version}: selected pipeline ${profile.retrievalProfileDigest}, package ${buildGraph.runtime.retrievalProfileDigest}`,
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
          libraryRoot: input.libraryRoot,
          libraryId: input.libraryId,
          packageId: input.dkb.manifest.id,
          packageVersion: input.dkb.manifest.version,
        });
      },
    };
  } finally {
    await host.dispose();
  }
}

export async function verifyRuntimeIndex(input: {
  libraryRoot: string;
  libraryId: string;
  packageId?: string;
  packageVersion?: string;
  target?: string;
  signal?: AbortSignal;
}): Promise<DkbIndexMutationResult | null> {
  const host = await DkbProviderHost.create({
    root: input.libraryRoot,
    distribution: DEFAULT_DKB_DISTRIBUTION,
    ...(input.target ? { target: input.target } : {}),
  });

  try {
    const provider = host.provider<DkbIndexProvider>('index');

    if (!provider.verifyRuntime) {
      return null;
    }
    const profile = await resolveProviderRetrievalProfile(host);
    const packages = await resolveLibraryRuntimeBuilds(input.libraryRoot);
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
  libraryRoot: string;
  libraryId: string;
  packageId: string;
  packageVersion: string;
  signal?: AbortSignal;
}): Promise<DkbIndexMutationResult | null> {
  const host = await DkbProviderHost.create({ root: input.libraryRoot, distribution: DEFAULT_DKB_DISTRIBUTION });

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
