import path from 'node:path';
import { readEvidenceCatalog } from '@sjshovan/dkb-library/evidenceCatalog.js';
import { resolveLibraryActivationBuilds } from '@sjshovan/dkb-library/builds.js';
import type { DkbRuntimeActivation } from '@sjshovan/dkb-protocol/runtimeActivation.js';

export interface RuntimeCatalogRefreshResult {
  recordCount: number;
  packageCount: number;
}

/**
 * Validate the exact immutable builds selected by installed packages. Runtime
 * keeps no second aggregate evidence or artifact tree; query contexts open the
 * same build roots directly.
 */
export async function refreshRuntimeCatalogFromInstalledArtifacts(
  libraryRoot: string,
  activation: DkbRuntimeActivation,
): Promise<RuntimeCatalogRefreshResult> {
  const packages = await resolveLibraryActivationBuilds(path.resolve(libraryRoot), activation);
  const catalogs = packages.map((item) => readEvidenceCatalog(item.evidenceRoot));

  return {
    recordCount: catalogs.reduce((total, catalog) => total + catalog.records.length, 0),
    packageCount: packages.length,
  };
}
