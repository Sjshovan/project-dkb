import path from 'node:path';
import { writeSearchArtifacts, vectorDocumentsForSourceUnits, type VectorDocument } from '../indexes/vectorStore.js';
import { readSourceIndex, sourceAssetsFromChunks, writeSourceIndex } from '../indexes/sourceIndex.js';
import { loadRegistry } from '../protocol/manifest.js';
import { SOURCE_VECTOR_PATH } from '../indexes/sourceIndex.js';
import type { LoadedDkb } from '../protocol/types.js';
import { readLlamaIndexCompilerRecords, sourceUnitFromLlamaIndexRecord } from '../compiler/llamaindexArtifacts.js';

export interface RuntimeCatalogRefreshResult {
  recordCount: number;
  packageCount: number;
}

export interface RuntimeCatalogRefreshOptions {
  syncSearch?: boolean;
}

export interface RuntimeCompiledPackageDocuments {
  dkb: LoadedDkb;
  documents: VectorDocument[];
}

export async function refreshRuntimeCatalogFromInstalledArtifacts(
  stateRoot: string,
  options: RuntimeCatalogRefreshOptions = {},
): Promise<RuntimeCatalogRefreshResult> {
  const resolvedRoot = path.resolve(stateRoot);
  const loaded = await installedDkbsForRuntimeRoot(resolvedRoot);
  const sourceIndexes = await Promise.all(loaded.dkbs.map((dkb) => sourceIndexForInstalledDkb(dkb)));
  const sourceUnits = sourceIndexes.flatMap((index) => index.units);
  const sourceEdges = sourceIndexes.flatMap((index) => index.edges);

  await writeSourceIndex(resolvedRoot, sourceUnits, sourceEdges);
  if (options.syncSearch !== false) {
    await writeSearchArtifacts(loaded.registryId, path.join(resolvedRoot, SOURCE_VECTOR_PATH), await compilerVectorDocuments(loaded.dkbs, sourceUnits));
  }

  return {
    recordCount: sourceUnits.length,
    packageCount: loaded.dkbs.length,
  };
}

export async function compiledSearchDocumentsForDkb(dkb: LoadedDkb): Promise<RuntimeCompiledPackageDocuments> {
  const sourceIndex = await sourceIndexForInstalledDkb(dkb);
  const vectorsBySourceUnit = await compilerVectorsForDkb(dkb);
  const documents = vectorDocumentsForSourceUnits(sourceIndex.units).map((document) => {
    const embedding = vectorsBySourceUnit.get(document.id);

    return {
      ...document,
      packageId: dkb.manifest.id,
      packageVersion: dkb.manifest.version,
      ...(embedding ? { embedding } : {}),
    };
  });

  if (compilerVectorsRequired() && documents.length > 0 && documents.some((document) => !document.embedding)) {
    throw new Error(`Installed package ${dkb.manifest.id}@${dkb.manifest.version} is missing compiler vectors required by the Meilisearch userProvided runtime`);
  }

  return { dkb, documents };
}

/**
 * Join compiler vectors to the exact compiled source chunks they describe.
 * Packages without a compiler-vector artifact are intentionally rejected by the
 * user-provided-vector backend instead of being silently re-embedded.
 */
async function compilerVectorDocuments(dkbs: LoadedDkb[], sourceUnits: Awaited<ReturnType<typeof readSourceIndex>>['units']): Promise<VectorDocument[]> {
  const vectorsBySourceUnit = new Map<string, number[]>();

  for (const dkb of dkbs) {
    const vectors = await compilerVectorsForDkb(dkb);

    for (const [id, embedding] of vectors.entries()) {
      vectorsBySourceUnit.set(id, embedding);
    }
  }

  const documents = vectorDocumentsForSourceUnits(sourceUnits).map((document) => {
    const embedding = vectorsBySourceUnit.get(document.id);
    return embedding ? { ...document, embedding } : document;
  });

  if (compilerVectorsRequired() && documents.length > 0 && documents.some((document) => !document.embedding)) {
    throw new Error('Installed package is missing compiler vectors required by the Meilisearch userProvided runtime');
  }

  return documents;
}

async function compilerVectorsForDkb(dkb: LoadedDkb): Promise<Map<string, number[]>> {
  const vectorsBySourceUnit = new Map<string, number[]>();

  try {
    const records = await readLlamaIndexCompilerRecords(dkb.root);

    for (const item of records) {
      if (typeof item.id === 'string' && Array.isArray(item.embedding) && item.embedding.length > 0 && item.embedding.every((value) => typeof value === 'number')) {
        vectorsBySourceUnit.set(item.id, item.embedding as number[]);
      }
    }
  } catch {
    // A package compiled with another profile remains installable, but it has
    // no compatible vectors for this explicit user-provided-vector runtime.
  }

  return vectorsBySourceUnit;
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

function compilerVectorsRequired(): boolean {
  return (process.env.DKB_SEARCH_ENGINE ?? '').toLowerCase() === 'meilisearch'
    && process.env.DKB_MEILI_EMBEDDER_SOURCE === 'userProvided';
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
