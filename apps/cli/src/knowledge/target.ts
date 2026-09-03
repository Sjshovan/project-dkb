import path from 'node:path';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { loadCollection, loadDkb, loadLibrary, loadManifest } from '@sjshovan/dkb-protocol/manifest.js';
import type { LoadedCollection, LoadedDkb } from '@sjshovan/dkb-protocol/types.js';

export type KnowledgeTargetType = 'dkb' | 'collection' | 'library';

export interface KnowledgeTargetDkbRef {
  dkbId: string;
  root: string;
  collectionId: string | null;
  standalone: boolean;
}

export interface KnowledgeTargetDuplicate {
  root: string;
  firstSeenAt: string;
  duplicateAt: string;
  dkbId: string;
}

export interface KnowledgeTargetResolution {
  path: string;
  type: KnowledgeTargetType;
  id: string;
  name: string;
  version: string;
  targetHash: string;
  units: Array<{
    collection: LoadedCollection;
    collectionId: string | null;
    standalone: boolean;
  }>;
  includedDkbs: KnowledgeTargetDkbRef[];
  duplicateDkbRoots: KnowledgeTargetDuplicate[];
}

export interface KnowledgeTargetSummary {
  path: string;
  type: KnowledgeTargetType;
  id: string;
  name: string;
  version: string;
  targetHash: string;
  includedDkbs: KnowledgeTargetDkbRef[];
  duplicateDkbRoots: KnowledgeTargetDuplicate[];
}

export async function resolveKnowledgeTarget(targetPath: string): Promise<KnowledgeTargetResolution> {
  const resolvedPath = path.resolve(targetPath);
  const manifest = await loadManifest(resolvedPath);

  if (manifest.type === 'library') {
    return resolveLibraryTarget(await loadLibrary(resolvedPath), resolvedPath);
  }

  if (manifest.type === 'collection') {
    return resolveCollectionTarget(await loadCollection(resolvedPath), resolvedPath);
  }

  const dkb = await loadDkb(resolvedPath);
  const includedDkbs = [dkbRef(dkb, null, true)];

  return {
    path: resolvedPath,
    type: 'dkb',
    id: dkb.manifest.id,
    name: dkb.manifest.name,
    version: dkb.manifest.version,
    targetHash: stableHash({
      type: 'dkb-target',
      id: dkb.manifest.id,
      version: dkb.manifest.version,
      root: dkb.root,
    }),
    units: [
      {
        collection: {
          root: dkb.root,
          manifest: {
            id: dkb.manifest.id,
            name: dkb.manifest.name,
            version: dkb.manifest.version,
            members: {},
            dkbs: [],
          },
          dkbs: [dkb],
        },
        collectionId: null,
        standalone: true,
      },
    ],
    includedDkbs,
    duplicateDkbRoots: [],
  };
}

function resolveCollectionTarget(collection: LoadedCollection, resolvedPath: string): KnowledgeTargetResolution {
  const includedDkbs = collection.dkbs.map((dkb) => dkbRef(dkb, collection.manifest.id, false));

  return {
    path: resolvedPath,
    type: 'collection',
    id: collection.manifest.id,
    name: collection.manifest.name,
    version: collection.manifest.version,
    targetHash: stableHash({
      type: 'collection-target',
      id: collection.manifest.id,
      version: collection.manifest.version,
      includedDkbs,
    }),
    units: [{ collection, collectionId: collection.manifest.id, standalone: false }],
    includedDkbs,
    duplicateDkbRoots: [],
  };
}

function resolveLibraryTarget(library: Awaited<ReturnType<typeof loadLibrary>>, resolvedPath: string): KnowledgeTargetResolution {
  const duplicateTracker = createDuplicateTracker();
  const units: KnowledgeTargetResolution['units'] = [];
  const includedDkbs: KnowledgeTargetDkbRef[] = [];

  for (const collection of library.collections) {
    const dkbs = collection.dkbs.filter((dkb) => duplicateTracker.track(dkb, `collection:${collection.manifest.id}`));

    if (dkbs.length === 0) {
      continue;
    }

    units.push({
      collection: {
        ...collection,
        dkbs,
      },
      collectionId: collection.manifest.id,
      standalone: false,
    });
    includedDkbs.push(...dkbs.map((dkb) => dkbRef(dkb, collection.manifest.id, false)));
  }

  const standalone = library.dkbs.filter((dkb) => duplicateTracker.track(dkb, 'dkb'));

  if (standalone.length > 0) {
    units.push({
      collection: {
        root: library.root,
        manifest: {
          id: `${library.manifest.id}-standalone`,
          name: `${library.manifest.name} Standalone DKBs`,
          version: library.manifest.version,
          members: {},
          dkbs: [],
        },
        dkbs: standalone,
      },
      collectionId: null,
      standalone: true,
    });
    includedDkbs.push(...standalone.map((dkb) => dkbRef(dkb, null, true)));
  }

  return {
    path: resolvedPath,
    type: 'library',
    id: library.manifest.id,
    name: library.manifest.name,
    version: library.manifest.version,
    targetHash: stableHash({
      type: 'library-target',
      id: library.manifest.id,
      version: library.manifest.version,
      includedDkbs,
    }),
    units,
    includedDkbs,
    duplicateDkbRoots: duplicateTracker.duplicates,
  };
}

export function summarizeKnowledgeTarget(target: KnowledgeTargetResolution): KnowledgeTargetSummary {
  return {
    path: target.path,
    type: target.type,
    id: target.id,
    name: target.name,
    version: target.version,
    targetHash: target.targetHash,
    includedDkbs: target.includedDkbs,
    duplicateDkbRoots: target.duplicateDkbRoots,
  };
}

function dkbRef(dkb: LoadedDkb, collectionId: string | null, standalone: boolean): KnowledgeTargetDkbRef {
  return {
    dkbId: dkb.manifest.id,
    root: dkb.root,
    collectionId,
    standalone,
  };
}

function createDuplicateTracker() {
  const seen = new Map<string, { seenAt: string; dkbId: string }>();
  const duplicates: KnowledgeTargetDuplicate[] = [];

  return {
    duplicates,
    track(dkb: LoadedDkb, seenAt: string): boolean {
      const identity = dkb.identityKey ?? `root:${path.resolve(dkb.root)}`;
      const previous = seen.get(identity);

      if (previous) {
        duplicates.push({
          root: path.resolve(dkb.root),
          firstSeenAt: previous.seenAt,
          duplicateAt: seenAt,
          dkbId: dkb.manifest.id,
        });

        return false;
      }

      seen.set(identity, {
        seenAt,
        dkbId: dkb.manifest.id,
      });

      return true;
    },
  };
}
