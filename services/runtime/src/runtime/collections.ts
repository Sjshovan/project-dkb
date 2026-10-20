import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { parseDkbIdentity, registryPackagePath } from '@sjshovan/dkb-protocol/identity.js';
import { loadManifest } from '@sjshovan/dkb-protocol/manifest.js';
import type { DkbSourceManifest } from '@sjshovan/dkb-protocol/types.js';
import { validateRegistryCollectionRevision } from '@sjshovan/dkb-protocol/registryCollections.js';
import { readLibraryState, applyLibraryLock, maybeReadLibraryLock } from '@sjshovan/dkb-library/state.js';
import { promoteLibraryPath, removeLibraryPath, withLibraryMutation, writeLibraryMutationFile } from '@sjshovan/dkb-library/mutation.js';
import { syncLibrary } from '@sjshovan/dkb-library/resolver.js';
import type { DkbRegistryClient, DkbRegistryCollectionRevision } from '@sjshovan/dkb-registry-client/client.js';
import { normalizeRegistryUrl } from '@sjshovan/dkb-registry-client/config.js';
import { installDkbPlanIntoLibraryWithinMutation } from './registryInstall.js';
import { prepareCollectionPlans } from './collectionPlans.js';
import type { DkbProgressReporter } from '@sjshovan/dkb-protocol/progress.js';

export interface CollectionInstallResult {
  status: 'installed' | 'updated' | 'already_installed';
  collectionId: string;
  revision: number;
  digest: string;
  members: Array<{ id: string; version: string; digest: string }>;
  libraryRoot: string;
}

/** Acquisition only: native login and delegated grants share one transaction. */
export type CollectionRegistrySource = Pick<DkbRegistryClient, 'baseUrl' | 'collectionRevision' | 'publicKeys' | 'installPlan' | 'writeInstallLayer'>;

export async function installRegistryCollection(options: {
  client: CollectionRegistrySource;
  collectionId: string;
  revision?: number;
  libraryRoot?: string;
  update?: boolean;
  progress?: DkbProgressReporter;
}): Promise<CollectionInstallResult> {
  const libraryRoot = requiredLibraryRoot(options.libraryRoot);
  return withLibraryMutation(libraryRoot, () => installRegistryCollectionUnlocked(options, libraryRoot));
}

async function installRegistryCollectionUnlocked(
  options: Parameters<typeof installRegistryCollection>[0],
  libraryRoot: string,
): Promise<CollectionInstallResult> {
  const collectionId = parseDkbIdentity(options.collectionId, 'Collection identity').identity;
  const revision = validateRegistryCollectionRevision(await options.client.collectionRevision(collectionId, options.revision), { collectionId, revision: options.revision });
  const state = await readLibraryState(libraryRoot);
  const current = state.entries[collectionId];

  if (current) {
    if (current.kind !== 'collection') throw new DkbError(`${collectionId} is already installed as a DKB.`);
    if (current.source !== 'registry') throw new DkbError(`Editable local Collection ${collectionId} cannot be replaced by a Registry Collection.`);
    if (current.revision === revision.revision && current.digest !== revision.digest) {
      throw new DkbError(`Collection ${collectionId}@r${revision.revision} changed its immutable digest.`);
    }
    if (current.registryUrl && normalizeRegistryUrl(current.registryUrl) !== normalizeRegistryUrl(options.client.baseUrl) && current.digest !== revision.digest) {
      throw new DkbError(`Registry origin conflict for ${collectionId}. Uninstall it before changing its Registry origin.`);
    }
    if (current.revision !== revision.revision && !options.update) {
      throw new DkbError(`${collectionId}@r${current.revision ?? '?'} is already installed. Run collection update to move to r${revision.revision}.`);
    }
  }

  const { members, trustedKeys, unchanged, replaceable } = await prepareCollectionPlans({ ...options, libraryRoot, revision });
  if (current?.revision === revision.revision && unchanged.size === members.length) {
    const installed = await loadManifest(path.resolve(libraryRoot, current.path));
    const retained = validateRegistryCollectionRevision({
      collectionId: installed.name, revision: installed.meta?.revision, digest: installed.meta?.digest,
      manifest: { type: installed.type, id: installed.name, name: installed.displayName ?? installed.name,
        revision: installed.meta?.revision, digest: installed.meta?.digest,
        members: Object.entries(installed.members ?? {}).map(([id, version]) => ({ id, version, digest: state.entries[id]?.digest })),
      },
    }, { collectionId, revision: revision.revision });
    if (retained.digest !== revision.digest) throw new DkbError(`Installed Collection ${collectionId} differs from its immutable Registry snapshot.`);
    return resultFor('already_installed', revision, libraryRoot);
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-collection-install-'));
  const originalManifest = await requireLibraryManifest(libraryRoot);
  const originalRootIds = new Set(Object.keys(originalManifest.roots ?? {}));
  const previousMemberIds = currentCollectionMembers(state, collectionId);

  try {
    if (current) {
      await prepareCollectionUpdate(libraryRoot, collectionId, state);
    }

    for (const { release, plan } of members) {
      if (unchanged.has(release.packageId)) continue;
      const layerRoot = path.join(tempRoot, ...release.packageId.split('/'));
      await fs.mkdir(layerRoot, { recursive: true });
      for (const artifact of plan.artifacts) {
        const extension = artifact.kind === 'source' ? '.dkbpkg' : artifact.kind === 'evidence' ? '.dkbevidence' : '.dkbbuild';
        await options.client.writeInstallLayer(artifact, path.join(layerRoot, `${artifact.kind}${extension}`), { progress: options.progress });
      }
      await installDkbPlanIntoLibraryWithinMutation({
        plan,
        layerRoot,
        libraryRoot,
        trustedKeys,
        registryUrl: options.client.baseUrl,
        force: replaceable.has(release.packageId),
        progress: options.progress,
      });
    }

    await writeInstalledCollection(libraryRoot, revision);
    await activateCollectionRoot(
      libraryRoot,
      revision,
      new Set([...members.map(({ release }) => release.packageId), ...previousMemberIds]),
      originalRootIds,
    );
    const lock = (await maybeReadLibraryLock(libraryRoot))!;
    const installed = lock.entries[collectionId]!;
    await applyLibraryLock(libraryRoot, { ...lock, entries: { ...lock.entries, [collectionId]: {
      ...installed, registryUrl: current?.registryUrl ?? normalizeRegistryUrl(options.client.baseUrl),
    } } });
    await pruneOldCollectionMembers(libraryRoot, state, collectionId, new Set(members.map(({ release }) => release.packageId)));

    return resultFor(current ? 'updated' : 'installed', revision, libraryRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

export async function uninstallRegistryCollection(options: {
  collectionId: string;
  libraryRoot?: string;
}): Promise<{ status: 'removed'; collectionId: string; removedDkbs: string[]; libraryRoot: string }> {
  const libraryRoot = requiredLibraryRoot(options.libraryRoot);
  return withLibraryMutation(libraryRoot, () => uninstallRegistryCollectionUnlocked(options, libraryRoot));
}

async function uninstallRegistryCollectionUnlocked(
  options: Parameters<typeof uninstallRegistryCollection>[0],
  libraryRoot: string,
): Promise<{ status: 'removed'; collectionId: string; removedDkbs: string[]; libraryRoot: string }> {
  const collectionId = parseDkbIdentity(options.collectionId, 'Collection identity').identity;
  const state = await readLibraryState(libraryRoot);
  const collection = state.entries[collectionId];
  if (!collection || collection.kind !== 'collection') throw new DkbError(`Registry Collection is not installed: ${collectionId}`);
  if (collection.source !== 'registry') throw new DkbError(`Editable local Collection ${collectionId} must be deactivated with dkb library remove.`);

  const removable = Object.values(state.entries)
    .filter((entry) => entry.kind === 'dkb' && entry.source === 'registry'
      && entry.requiredBy.length === 1 && entry.requiredBy[0] === `collection:${collectionId}`)
    .map((entry) => entry.identity);
  const manifest = await requireLibraryManifest(libraryRoot);
  const roots = { ...(manifest.roots ?? {}) };
  delete roots[collectionId];
  await writeLibraryMutationJson(libraryRoot, path.join(libraryRoot, 'dkb.json'), { ...manifest, roots });
  await syncLibrary(libraryRoot);

  for (const identity of [collectionId, ...removable]) {
    await removeLibraryPath(libraryRoot, registryPackagePath(libraryRoot, identity));
  }

  return { status: 'removed', collectionId, removedDkbs: removable.sort(), libraryRoot };
}

async function activateCollectionRoot(
  libraryRoot: string,
  revision: DkbRegistryCollectionRevision,
  memberIds: Set<string>,
  originalRootIds: Set<string>,
): Promise<void> {
  const manifest = await requireLibraryManifest(libraryRoot);
  const roots = { ...(manifest.roots ?? {}) };

  for (const identity of memberIds) {
    if (!originalRootIds.has(identity)) delete roots[identity];
  }
  roots[revision.collectionId] = { revision: revision.revision };
  await writeLibraryMutationJson(libraryRoot, path.join(libraryRoot, 'dkb.json'), { ...manifest, roots });
  await syncLibrary(libraryRoot);
}

async function prepareCollectionUpdate(
  libraryRoot: string,
  collectionId: string,
  state: Awaited<ReturnType<typeof readLibraryState>>,
): Promise<void> {
  const manifest = await requireLibraryManifest(libraryRoot);
  const roots = { ...(manifest.roots ?? {}) };
  delete roots[collectionId];

  for (const identity of currentCollectionMembers(state, collectionId)) {
    const entry = state.entries[identity];
    if (entry?.version) roots[identity] = { version: entry.version };
  }

  await writeLibraryMutationJson(libraryRoot, path.join(libraryRoot, 'dkb.json'), { ...manifest, roots });
  await syncLibrary(libraryRoot);
}

async function writeInstalledCollection(libraryRoot: string, revision: DkbRegistryCollectionRevision): Promise<void> {
  const target = registryPackagePath(libraryRoot, revision.collectionId);
  const stagingParent = path.join(libraryRoot, '.dkb', 'tmp');
  await fs.mkdir(stagingParent, { recursive: true });
  const staged = await fs.mkdtemp(path.join(stagingParent, 'collection-'));
  const manifest = {
    manifestVersion: 1,
    type: 'collection',
    name: revision.collectionId,
    displayName: revision.manifest.name,
    members: Object.fromEntries(revision.manifest.members.map((member) => [member.id, member.version])),
    meta: {
      revision: revision.revision,
      digest: revision.digest,
    },
  };
  try {
    await fs.writeFile(path.join(staged, 'dkb.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await promoteLibraryPath(libraryRoot, staged, target);
  } finally {
    // Promotion transfers ownership into the Library journal; this is only the
    // empty original staging path, never a retained backup or installed tree.
    await fs.rm(staged, { recursive: true, force: true });
  }
}

async function pruneOldCollectionMembers(
  libraryRoot: string,
  previousState: Awaited<ReturnType<typeof readLibraryState>>,
  collectionId: string,
  retained: Set<string>,
): Promise<void> {
  for (const identity of currentCollectionMembers(previousState, collectionId)) {
    if (retained.has(identity)) continue;
    const previous = previousState.entries[identity];
    if (previous?.source === 'registry' && previous.requiredBy.length === 1) {
      await removeLibraryPath(libraryRoot, registryPackagePath(libraryRoot, identity));
    }
  }
}

function currentCollectionMembers(state: Awaited<ReturnType<typeof readLibraryState>>, collectionId: string): string[] {
  return Object.values(state.entries)
    .filter((entry) => entry.kind === 'dkb' && entry.requiredBy.includes(`collection:${collectionId}`))
    .map((entry) => entry.identity);
}

function requiredLibraryRoot(value?: string): string {
  const root = value ?? process.env.DKB_LIBRARY_PATH;
  if (!root) throw new DkbError('A Library is required. Pass --library or set DKB_LIBRARY_PATH.');
  return path.resolve(root);
}

async function requireLibraryManifest(libraryRoot: string): Promise<DkbSourceManifest> {
  const manifest = await loadManifest(libraryRoot);
  if (manifest.type !== 'library') throw new DkbError(`Not a DKB Library: ${libraryRoot}`);
  return manifest;
}

async function writeLibraryMutationJson(root: string, target: string, value: unknown): Promise<void> {
  await writeLibraryMutationFile(root, target, `${JSON.stringify(value, null, 2)}\n`);
}

function resultFor(status: CollectionInstallResult['status'], revision: DkbRegistryCollectionRevision, libraryRoot: string): CollectionInstallResult {
  return {
    status,
    collectionId: revision.collectionId,
    revision: revision.revision,
    digest: revision.digest,
    members: revision.manifest.members,
    libraryRoot,
  };
}
