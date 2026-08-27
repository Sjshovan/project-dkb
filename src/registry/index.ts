import path from 'node:path';
import { stableHash } from '@dkb/protocol/contracts/hash.js';
import type { IndexedSourceUnit } from '@dkb/providers-bundled/sourceIndex.js';
import { sourceIndexForInstalledDkb } from '@dkb/runtime/runtime/catalog.js';
import { resolveDkbCapabilities, type DkbCapabilities } from '@dkb/protocol/capabilities.js';
import { loadLibrary } from '@dkb/protocol/manifest.js';
import { deriveKnowledgeSpace, type KnowledgeSpaceIdentity } from '@dkb/protocol/space.js';
import type { LoadedCollection, LoadedDkb, LoadedLibrary } from '@dkb/protocol/types.js';

export interface DkrOrigin {
  registryId: string;
  collectionId: string | null;
  dkbId: string;
  sourceId: string;
}

export interface RegistryChunk {
  id: string;
  title: string;
  contentHash: string;
  updatedAt: string;
  origin: DkrOrigin;
  capabilities: Pick<DkbCapabilities['access'], 'read' | 'write' | 'append'>;
  metadata: Record<string, unknown>;
}

export interface RegistryCatalog {
  registryId: string;
  name: string;
  version: string;
  space: KnowledgeSpaceIdentity;
  collections: Array<{
    id: string;
    name: string;
    version: string;
    root: string;
    roles: string[];
    space: KnowledgeSpaceIdentity;
    dkbCount: number;
    dkbIds: string[];
  }>;
  dkbs: Array<{
    id: string;
    name: string;
    version: string;
    root: string;
    roles: string[];
    space: KnowledgeSpaceIdentity;
    capabilities: DkbCapabilities;
  }>;
  metadata: {
    duplicateDkbRoots: Array<{
      root: string;
      firstSeenAt: string;
      duplicateAt: string;
      dkbId: string;
    }>;
  };
}

export interface RegistryChunkIndex {
  registryId: string;
  registryHash: string;
  chunks: RegistryChunk[];
  metadata: RegistryCatalog['metadata'];
}

export async function describeRegistry(registryPath: string): Promise<RegistryCatalog> {
  return catalogFromRegistry(await loadLibrary(registryPath));
}

export async function buildRegistryChunks(registryPath: string): Promise<RegistryChunkIndex> {
  return buildRegistryChunksFromRegistry(await loadLibrary(registryPath));
}

export function catalogFromRegistry(registry: LoadedLibrary): RegistryCatalog {
  const duplicateTracker = createDuplicateTracker();
  const collections = registry.collections.map((collection) => {
    for (const dkb of collection.dkbs) {
      duplicateTracker.track(dkb, `collection:${collection.manifest.id}`);
    }

    return {
      id: collection.manifest.id,
      name: collection.manifest.name,
      version: collection.manifest.version,
      root: collection.root,
      roles: collection.manifest.roles ?? [],
      space: deriveKnowledgeSpace({
        namespace: collection.manifest.namespace ?? registry.manifest.namespace,
        appId: collection.manifest.appId ?? registry.manifest.appId,
        registryId: registry.manifest.id,
        collectionId: collection.manifest.id,
      }),
      dkbCount: collection.dkbs.length,
      dkbIds: collection.dkbs.map((dkb) => dkb.manifest.id),
    };
  });
  const dkbs = registry.dkbs.map((dkb) => {
    duplicateTracker.track(dkb, 'dkb');

    return {
      id: dkb.manifest.id,
      name: dkb.manifest.name,
      version: dkb.manifest.version,
      root: dkb.root,
      roles: dkb.manifest.roles ?? [],
      space: deriveKnowledgeSpace({
        owner: dkb.manifest.owner,
        namespace: dkb.manifest.namespace ?? registry.manifest.namespace,
        appId: dkb.manifest.appId ?? registry.manifest.appId,
        registryId: registry.manifest.id,
        dkbId: dkb.manifest.id,
      }),
      capabilities: resolveDkbCapabilities(dkb.manifest),
    };
  });

  return {
    registryId: registry.manifest.id,
    name: registry.manifest.name,
    version: registry.manifest.version,
    space: deriveKnowledgeSpace({
      namespace: registry.manifest.namespace,
      appId: registry.manifest.appId,
      registryId: registry.manifest.id,
    }),
    collections,
    dkbs,
    metadata: {
      duplicateDkbRoots: duplicateTracker.duplicates,
    },
  };
}

export async function buildRegistryChunksFromRegistry(registry: LoadedLibrary): Promise<RegistryChunkIndex> {
  const registryHash = stableHash({
    id: registry.manifest.id,
    version: registry.manifest.version,
    collections: registry.collections.map((collection) => collection.manifest.id),
    dkbs: registry.dkbs.map((dkb) => dkb.manifest.id),
  });
  const duplicateTracker = createDuplicateTracker();
  const chunks: RegistryChunk[] = [];

  for (const collection of registry.collections) {
    const includedRoots = new Set<string>();

    for (const dkb of collection.dkbs) {
      if (duplicateTracker.track(dkb, `collection:${collection.manifest.id}`)) {
        includedRoots.add(path.resolve(dkb.root));
      }
    }

    for (const dkb of collection.dkbs) {
      if (!includedRoots.has(path.resolve(dkb.root))) {
        continue;
      }

      chunks.push(...await registryChunksForDkb(registry.manifest.id, collection.manifest.id, dkb));
    }
  }

  for (const dkb of registry.dkbs) {
    if (!duplicateTracker.track(dkb, 'dkb')) {
      continue;
    }

    chunks.push(...await registryChunksForDkb(registry.manifest.id, null, dkb));
  }

  return {
    registryId: registry.manifest.id,
    registryHash,
    chunks: chunks.sort((a, b) => a.id.localeCompare(b.id)),
    metadata: {
      duplicateDkbRoots: duplicateTracker.duplicates,
    },
  };
}

async function registryChunksForDkb(
  registryId: string,
  collectionId: string | null,
  dkb: LoadedDkb,
): Promise<RegistryChunk[]> {
  const sourceIndex = await sourceIndexForInstalledDkb(dkb);

  return sourceIndex.units.map((unit) => toRegistryChunk(registryId, collectionId, dkb, unit));
}

function toRegistryChunk(
  registryId: string,
  collectionId: string | null,
  dkb: LoadedDkb,
  unit: IndexedSourceUnit,
): RegistryChunk {
  const capabilities = resolveDkbCapabilities(dkb.manifest);
  const origin = {
    registryId,
    collectionId,
    dkbId: dkb.manifest.id,
    sourceId: unit.id,
  };

  return {
    id: unit.id,
    title: unit.title,
    contentHash: unit.hash,
    updatedAt: unit.updatedAt,
    origin,
    capabilities: {
      read: capabilities.access.read,
      write: capabilities.access.write,
      append: capabilities.access.append,
    },
    metadata: {
      origin,
      capabilities,
      assetId: unit.assetId,
      locator: unit.locator,
    },
  };
}

function createDuplicateTracker() {
  const seen = new Map<string, { seenAt: string; dkbId: string }>();
  const duplicates: RegistryCatalog['metadata']['duplicateDkbRoots'] = [];

  return {
    duplicates,
    track(dkb: LoadedDkb, seenAt: string): boolean {
      const root = path.resolve(dkb.root);
      const previous = seen.get(root);

      if (previous) {
        duplicates.push({
          root,
          firstSeenAt: previous.seenAt,
          duplicateAt: seenAt,
          dkbId: dkb.manifest.id,
        });

        return false;
      }

      seen.set(root, {
        seenAt,
        dkbId: dkb.manifest.id,
      });

      return true;
    },
  };
}
