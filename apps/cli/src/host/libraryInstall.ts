import type { DkbProgressReporter } from '@sjshovan/dkb-protocol/progress.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbAlreadyInstalledResult, DkbRegistryInstallResult } from '@sjshovan/dkb-runtime/runtime/registryInstall.js';
import type { CollectionInstallResult } from '@sjshovan/dkb-runtime/runtime/collections.js';
import { runDockerOwnerWorker, type DockerLibraryOwner } from './dockerOwnerWorker.js';
import { ownerResultReader } from './libraryOwnerResult.js';
import { withOwnerCancellation } from './libraryOwnerCancellation.js';
import { LIBRARY_COLLECTION_INSTALL_FORMAT, type LibraryCollectionInstallRequest, type LibraryGrantRequest, type LibraryInstallRequest } from './libraryInstallContract.js';

type InstallOptions = { progress?: DkbProgressReporter; signal?: AbortSignal; libraryName: string };
export function installDockerLibraryPackage(owner: DockerLibraryOwner, request: LibraryInstallRequest, options: InstallOptions): Promise<DkbRegistryInstallResult | DkbAlreadyInstalledResult>;
export function installDockerLibraryPackage(owner: DockerLibraryOwner, request: LibraryCollectionInstallRequest, options: InstallOptions): Promise<CollectionInstallResult>;

/** A separate fixed grant-only profile; ordinary Library workers remain offline. */
export async function installDockerLibraryPackage(owner: DockerLibraryOwner, request: LibraryGrantRequest,
  options: InstallOptions,
): Promise<DkbRegistryInstallResult | DkbAlreadyInstalledResult | CollectionInstallResult> {
  const reader = ownerResultReader(options.progress, options.libraryName);
  try {
    const result = await withOwnerCancellation(options.signal, signal => runDockerOwnerWorker('install', owner, request,
      { signal, onOutput: reader.output }));
    return reader.finish(result.code) as DkbRegistryInstallResult | DkbAlreadyInstalledResult | CollectionInstallResult;
  } catch (error) {
    if (request.format === LIBRARY_COLLECTION_INSTALL_FORMAT && error instanceof DkbError
      && ['library_owner_cancelled', 'library_owner_timeout'].includes(error.code)) {
      throw new DkbError(`${error.message} Run: dkb library status --library ${JSON.stringify(options.libraryName)}. `
        + `If recovery is required, run: dkb library recover --library ${JSON.stringify(options.libraryName)}.`, error.code);
    }
    throw error;
  }
}
