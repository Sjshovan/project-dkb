import path from 'node:path';
import { stableHash } from '../contracts/hash.js';
import type { KnowledgeRegionDescriptor } from '../contracts/types.js';
import { buildKnowledgeRegionDescriptorsFromCollection, buildKnowledgeRegionDescriptorsFromDkb } from '../knowledge/regionDescriptors.js';
import { resolveDkbCapabilities, type DkbCapabilities } from '../protocol/capabilities.js';
import { loadRegistry } from '../protocol/manifest.js';
import { deriveKnowledgeSpace, type KnowledgeSpaceIdentity } from '../protocol/space.js';
import type { LoadedCollection, LoadedDkb, LoadedRegistry } from '../protocol/types.js';

export interface DkrOrigin {
  registryId: string;
  collectionId: string | null;
  dkbId: string;
  recordId: string;
}

export interface RegistryRegion extends KnowledgeRegionDescriptor {
  origin: DkrOrigin;
  capabilities: Pick<DkbCapabilities['access'], 'read' | 'write' | 'append'>;
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

export interface RegistryRegionIndex {
  registryId: string;
  registryHash: string;
  regions: RegistryRegion[];
  metadata: RegistryCatalog['metadata'];
}

export async function describeRegistry(registryPath: string): Promise<RegistryCatalog> {
  return catalogFromRegistry(await loadRegistry(registryPath));
}

export async function buildRegistryRegions(registryPath: string): Promise<RegistryRegionIndex> {
  return buildRegistryRegionsFromRegistry(await loadRegistry(registryPath));
}

export function catalogFromRegistry(registry: LoadedRegistry): RegistryCatalog {
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

export async function buildRegistryRegionsFromRegistry(registry: LoadedRegistry): Promise<RegistryRegionIndex> {
  const registryHash = stableHash({
    id: registry.manifest.id,
    version: registry.manifest.version,
    collections: registry.collections.map((collection) => collection.manifest.id),
    dkbs: registry.dkbs.map((dkb) => dkb.manifest.id),
  });
  const duplicateTracker = createDuplicateTracker();
  const regions: RegistryRegion[] = [];

  for (const collection of registry.collections) {
    const includedRoots = new Set<string>();

    for (const dkb of collection.dkbs) {
      if (duplicateTracker.track(dkb, `collection:${collection.manifest.id}`)) {
        includedRoots.add(path.resolve(dkb.root));
      }
    }

    const collectionBuild = await buildKnowledgeRegionDescriptorsFromCollection(collection);

    for (const region of collectionBuild.regions) {
      const dkb = dkbForRegion(collection, region);

      if (!dkb || !includedRoots.has(path.resolve(dkb.root))) {
        continue;
      }

      regions.push(toRegistryRegion(registry.manifest.id, collection.manifest.id, dkb, region));
    }
  }

  for (const dkb of registry.dkbs) {
    if (!duplicateTracker.track(dkb, 'dkb')) {
      continue;
    }

    const collectionHash = stableHash({
      type: 'standalone-dkb',
      registryId: registry.manifest.id,
      dkbId: dkb.manifest.id,
      version: dkb.manifest.version,
    });
    const dkbRegions = await buildKnowledgeRegionDescriptorsFromDkb(dkb, collectionHash);

    regions.push(...dkbRegions.map((region) => toRegistryRegion(registry.manifest.id, null, dkb, region)));
  }

  return {
    registryId: registry.manifest.id,
    registryHash,
    regions: regions.sort((a, b) => a.id.localeCompare(b.id)),
    metadata: {
      duplicateDkbRoots: duplicateTracker.duplicates,
    },
  };
}

function toRegistryRegion(
  registryId: string,
  collectionId: string | null,
  dkb: LoadedDkb,
  region: KnowledgeRegionDescriptor,
): RegistryRegion {
  const capabilities = resolveDkbCapabilities(dkb.manifest);
  const origin = {
    registryId,
    collectionId,
    dkbId: dkb.manifest.id,
    recordId: region.fetch.recordId ?? region.fetchPlan?.recordId ?? region.id,
  };

  return {
    ...region,
    origin,
    capabilities: {
      read: capabilities.access.read,
      write: capabilities.access.write,
      append: capabilities.access.append,
    },
    metadata: {
      ...(region.metadata ?? {}),
      origin,
      capabilities,
    },
  };
}

function dkbForRegion(collection: LoadedCollection, region: KnowledgeRegionDescriptor): LoadedDkb | null {
  const dkbId = region.fetch.dkbId ?? region.fetchPlan?.dkbId;

  return collection.dkbs.find((candidate) => candidate.manifest.id === dkbId) ?? null;
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
