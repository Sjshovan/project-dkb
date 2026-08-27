import path from 'node:path';
import { readSourceIndex, sourceAssetsFromChunks, writeSourceIndex } from '@dkb/providers-bundled/sourceIndex.js';
import { loadLibrary, uniqueLoadedDkbs } from '@dkb/protocol/manifest.js';
import type { LoadedDkb } from '@dkb/protocol/types.js';
import { readLlamaIndexCompilerRecords, sourceUnitFromLlamaIndexRecord } from '@dkb/providers-bundled/llamaindexArtifacts.js';
import { refreshLibraryArtifactMetadata } from '../compiler/compile.js';

export interface RuntimeCatalogRefreshResult {
  recordCount: number;
  packageCount: number;
}

export async function refreshRuntimeCatalogFromInstalledArtifacts(
  stateRoot: string,
): Promise<RuntimeCatalogRefreshResult> {
  const resolvedRoot = path.resolve(stateRoot);
  const loaded = await installedDkbsForRuntimeRoot(resolvedRoot);
  const sourceIndexes = await Promise.all(loaded.dkbs.map((dkb) => sourceIndexForInstalledDkb(dkb)));
  const sourceUnits = sourceIndexes.flatMap((index) => index.units);
  const sourceEdges = sourceIndexes.flatMap((index) => index.edges);

  await writeSourceIndex(resolvedRoot, sourceUnits, sourceEdges);
  await refreshLibraryArtifactMetadata(resolvedRoot);

  return {
    recordCount: sourceUnits.length,
    packageCount: loaded.dkbs.length,
  };
}

export async function sourceIndexForInstalledDkb(dkb: LoadedDkb): Promise<Awaited<ReturnType<typeof readSourceIndex>>> {
  try {
    const compilerRecords = await readLlamaIndexCompilerRecords(dkb.root);

    if (compilerRecords.length > 0) {
      const units = compilerRecords
        .map((record) => sourceUnitFromLlamaIndexRecord(dkb, record))
        .sort((left, right) => left.id.localeCompare(right.id));

      return {
        assets: sourceAssetsFromChunks(units),
        units,
        edges: [],
      };
    }
  } catch {
    // Legacy packages compiled without a LlamaIndex bundle still use source.index.
  }

  try {
    return await readSourceIndex(dkb.root);
  } catch {
    return {
      assets: [],
      units: [],
      edges: [],
    };
  }
}

async function installedDkbsForRuntimeRoot(root: string): Promise<{ registryId: string; dkbs: LoadedDkb[] }> {
  try {
    const library = await loadLibrary(root);

    return {
      registryId: library.manifest.id,
      dkbs: uniqueLoadedDkbs([
        ...library.collections.flatMap((collection) => collection.dkbs),
        ...library.dkbs,
      ]),
    };
  } catch {
    return {
      registryId: safeId(path.basename(root) || 'runtime'),
      dkbs: [],
    };
  }
}

function safeId(value: string): string {
  const id = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

  return id || 'runtime';
}
