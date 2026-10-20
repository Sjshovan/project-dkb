import path from 'node:path';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { parseDkbIdentity, registryPackagePath } from '@sjshovan/dkb-protocol/identity.js';
import { discoverLibraryEntries, loadLibrary, loadManifest } from '@sjshovan/dkb-protocol/manifest.js';
import type {
  DkbLibraryLockEntry,
  DkbLibraryLockManifest,
  DkbLibraryRootRequirement,
  DkbSourceManifest,
  LoadedDkb,
} from '@sjshovan/dkb-protocol/types.js';
import { applyLibraryLock, maybeReadLibraryLock } from './state.js';
import { withLibraryMutation, writeLibraryMutationFile } from './mutation.js';

export interface SyncLibraryResult {
  status: 'synchronized' | 'unchanged';
  lock: DkbLibraryLockManifest;
}

export async function resolveLibraryLock(libraryRoot: string): Promise<DkbLibraryLockManifest> {
  const root = path.resolve(libraryRoot);
  const sourceManifest = await loadManifest(root);
  if (sourceManifest.type !== 'library') {
    throw new DkbError(`Expected a Library manifest at ${path.join(root, 'dkb.json')}`);
  }

  const library = await loadLibrary(root);
  const directEntries = await discoverLibraryEntries(root);
  const localIdentities = new Set(directEntries.map((entry) => entry.manifest.name));
  const previous = await maybeReadLibraryLock(root);
  const now = new Date().toISOString();
  const entries: Record<string, DkbLibraryLockEntry> = {};

  for (const collection of library.collections) {
    const relative = relativeEntryPath(root, collection.root);
    const source = localIdentities.has(collection.manifest.id) ? 'local' as const : 'registry' as const;
    const previousEntry = previous?.entries[collection.manifest.id];
    const digest = collection.manifest.digest ?? stableHash({
      identity: collection.manifest.id,
      members: collection.manifest.members,
      revision: collection.manifest.revision ?? null,
    });

    entries[collection.manifest.id] = {
      identity: collection.manifest.id,
      kind: 'collection',
      source,
      ...(collection.manifest.revision ? { revision: collection.manifest.revision } : {}),
      digest,
      path: relative,
      ...registryOrigin(source, previousEntry, { digest, path: relative }, sourceManifest.registry?.url),
      requiredBy: [`root:${collection.manifest.id}`],
      installedAt: reusableInstalledAt(previousEntry, { digest, path: relative }) ?? now,
    };

    for (const dkb of collection.dkbs) {
      addDkbEntry(entries, root, dkb, localIdentities, previous, `collection:${collection.manifest.id}`, sourceManifest, now);
    }
  }

  for (const dkb of library.dkbs) {
    addDkbEntry(entries, root, dkb, localIdentities, previous, `root:${dkb.manifest.id}`, sourceManifest, now);
  }

  // A DKB can be both a direct root and a Collection member. loadLibrary
  // deduplicates it from the standalone output, so preserve the direct reason.
  for (const [identity, requirement] of Object.entries(sourceManifest.roots ?? {})) {
    const entry = entries[identity];
    if (entry?.kind === 'dkb' && !entry.requiredBy.includes(`root:${identity}`)) {
      entry.requiredBy.push(`root:${identity}`);
      entry.requiredBy.sort();
    }
    assertRequirementMatchesResolved(identity, requirement, entry);
  }

  const candidate = {
    library: {
      name: sourceManifest.name,
      ...(previous?.library.retrievalProfileDigest
        ? { retrievalProfileDigest: previous.library.retrievalProfileDigest }
        : {}),
    },
    generation: (previous?.generation ?? 0) + 1,
    entries: Object.fromEntries(Object.entries(entries).sort(([left], [right]) => left.localeCompare(right))),
    resolvedAt: now,
  } satisfies DkbLibraryLockManifest;

  if (previous && stableHash({ library: previous.library, entries: previous.entries }) === stableHash({ library: candidate.library, entries: candidate.entries })) {
    return previous;
  }

  return candidate;
}

export async function syncLibrary(libraryRoot: string): Promise<SyncLibraryResult> {
  return withLibraryMutation(libraryRoot, async () => {
    const previous = await maybeReadLibraryLock(libraryRoot);
    await applyLibraryLock(libraryRoot, await resolveLibraryLock(libraryRoot));
    const lock = (await maybeReadLibraryLock(libraryRoot))!;
    return { status: previous?.generation === lock.generation ? 'unchanged' : 'synchronized', lock };
  });
}

async function addLibraryRootOwned(libraryRoot: string, identity: string): Promise<SyncLibraryResult> {
  parseDkbIdentity(identity);
  const root = path.resolve(libraryRoot);
  const manifest = await requireLibraryManifest(root);
  const direct = (await discoverLibraryEntries(root)).find((entry) => entry.manifest.name === identity);
  const installedPath = registryPackagePath(root, identity);
  const installedManifest = direct ? null : await maybeManifest(installedPath);

  if (!direct && !installedManifest) {
    throw new DkbError(`No local or Registry-installed Library entry exists for ${identity}`);
  }

  const requirement: DkbLibraryRootRequirement = direct
    ? { path: relativeEntryPath(root, direct.root) }
    : installedManifest!.type === 'dkb'
      ? { version: installedManifest!.version! }
      : { revision: registryRevision(installedManifest!) };

  return mutateLibraryRoots(root, manifest, {
    ...(manifest.roots ?? {}),
    [identity]: requirement,
  });
}

async function removeLibraryRootOwned(libraryRoot: string, identity: string): Promise<SyncLibraryResult> {
  parseDkbIdentity(identity);
  const root = path.resolve(libraryRoot);
  const manifest = await requireLibraryManifest(root);
  const roots = { ...(manifest.roots ?? {}) };

  if (!roots[identity]) {
    throw new DkbError(`Library root is not active: ${identity}`);
  }
  delete roots[identity];

  return mutateLibraryRoots(root, manifest, roots);
}

function addDkbEntry(
  entries: Record<string, DkbLibraryLockEntry>,
  libraryRoot: string,
  dkb: LoadedDkb,
  localIdentities: Set<string>,
  previous: DkbLibraryLockManifest | null,
  requiredBy: string,
  libraryManifest: DkbSourceManifest,
  now: string,
): void {
  const relative = relativeEntryPath(libraryRoot, dkb.root);
  const source = localIdentities.has(dkb.manifest.id) ? 'local' as const : 'registry' as const;
  const previousEntry = previous?.entries[dkb.manifest.id];
  const digest = source === 'registry'
    && previousEntry?.source === 'registry'
    && previousEntry?.version === dkb.manifest.version
    && previousEntry.path === relative
    && previousEntry.digest
    ? previousEntry.digest
    : dkb.manifestHash ?? stableHash({ identity: dkb.manifest.id, version: dkb.manifest.version });
  const existing = entries[dkb.manifest.id];

  if (existing) {
    if (existing.version !== dkb.manifest.version || existing.digest !== digest || existing.path !== relative) {
      throw new DkbError(`Conflicting DKB resolutions for ${dkb.manifest.id}`);
    }
    if (!existing.requiredBy.includes(requiredBy)) existing.requiredBy.push(requiredBy);
    existing.requiredBy.sort();
    return;
  }

  entries[dkb.manifest.id] = {
    identity: dkb.manifest.id,
    kind: 'dkb',
    source,
    version: dkb.manifest.version,
    digest,
    path: relative,
    ...registryOrigin(source, previousEntry, { digest, path: relative }, libraryManifest.registry?.url),
    requiredBy: [requiredBy],
    installedAt: reusableInstalledAt(previousEntry, { digest, path: relative }) ?? now,
  };
}

async function mutateLibraryRoots(
  root: string,
  manifest: DkbSourceManifest,
  roots: NonNullable<DkbSourceManifest['roots']>,
): Promise<SyncLibraryResult> {
  await writeLibraryMutationFile(root, path.join(root, 'dkb.json'), `${JSON.stringify({ ...manifest, roots }, null, 2)}\n`);
  return syncLibrary(root);
}

async function requireLibraryManifest(root: string): Promise<DkbSourceManifest> {
  const manifest = await loadManifest(root);
  if (manifest.type !== 'library') throw new DkbError(`Not a DKB Library: ${root}`);
  return manifest;
}

async function maybeManifest(root: string): Promise<DkbSourceManifest | null> {
  try {
    return await loadManifest(root);
  } catch {
    return null;
  }
}

function assertRequirementMatchesResolved(
  identity: string,
  requirement: DkbLibraryRootRequirement,
  entry: DkbLibraryLockEntry | undefined,
): void {
  if (!entry) throw new DkbError(`Library root did not resolve: ${identity}`);
  if (requirement.version && requirement.version !== 'latest' && entry.version !== requirement.version) {
    throw new DkbError(`Version conflict for ${identity}: requested ${requirement.version}, resolved ${entry.version ?? '-'}`);
  }
  if (typeof requirement.revision === 'number' && entry.revision !== requirement.revision) {
    throw new DkbError(`Revision conflict for ${identity}: requested r${requirement.revision}, resolved r${entry.revision ?? '-'}`);
  }
}

function reusableInstalledAt(
  previous: DkbLibraryLockEntry | undefined,
  candidate: { digest: string; path: string },
): string | null {
  return previous?.digest === candidate.digest && previous.path === candidate.path ? previous.installedAt : null;
}

function registryOrigin(
  source: 'local' | 'registry',
  previous: DkbLibraryLockEntry | undefined,
  candidate: { digest: string; path: string },
  defaultUrl?: string,
): { registryUrl?: string } {
  if (source !== 'registry') return {};
  const url = previous?.source === 'registry' && previous.digest === candidate.digest && previous.path === candidate.path
    ? previous.registryUrl ?? defaultUrl : defaultUrl;
  return url ? { registryUrl: url } : {};
}

function relativeEntryPath(root: string, entryRoot: string): string {
  const relative = path.relative(root, entryRoot).replace(/\\/g, '/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new DkbError(`Library entry must stay under ${root}: ${entryRoot}`);
  }
  return relative;
}

function registryRevision(manifest: DkbSourceManifest): number {
  const revision = manifest.meta?.revision;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) {
    throw new DkbError(`Registry Collection ${manifest.name} is missing its immutable revision`);
  }
  return revision;
}

export async function addLibraryRoot(libraryRoot: string, identity: string): Promise<SyncLibraryResult> {
  return withLibraryMutation(libraryRoot, () => addLibraryRootOwned(libraryRoot, identity));
}

export async function removeLibraryRoot(libraryRoot: string, identity: string): Promise<SyncLibraryResult> {
  return withLibraryMutation(libraryRoot, () => removeLibraryRootOwned(libraryRoot, identity));
}
