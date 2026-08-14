import path from 'node:path';
import { readKrIndex, writeGraphArtifacts, writeKrIndex, writeVectorArtifacts } from '../indexes/knowledgeIndex.js';
import { loadRegistry } from '../protocol/manifest.js';
import type { LoadedDkb } from '../protocol/types.js';

export interface RuntimeCatalogRefreshResult {
  recordCount: number;
  packageCount: number;
}

export async function refreshRuntimeCatalogFromInstalledArtifacts(stateRoot: string): Promise<RuntimeCatalogRefreshResult> {
  const resolvedRoot = path.resolve(stateRoot);
  const loaded = await installedDkbsForRuntimeRoot(resolvedRoot);
  const records = (await Promise.all(loaded.dkbs.map(async (dkb) => {
    try {
      return await readKrIndex(dkb.root);
    } catch {
      return [];
    }
  }))).flat();

  await writeKrIndex(resolvedRoot, records);
  const vectorArtifacts = await writeVectorArtifacts(resolvedRoot, loaded.registryId, records);
  await writeGraphArtifacts(resolvedRoot, loaded.dkbs, records, vectorArtifacts.semanticNeighbors);

  return {
    recordCount: records.length,
    packageCount: loaded.dkbs.length,
  };
}

async function installedDkbsForRuntimeRoot(root: string): Promise<{ registryId: string; dkbs: LoadedDkb[] }> {
  try {
    const registry = await loadRegistry(root);

    return {
      registryId: registry.manifest.id,
      dkbs: [
        ...registry.collections.flatMap((collection) => collection.dkbs),
        ...registry.dkbs,
      ],
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
