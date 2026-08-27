import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { refreshRuntimeCatalogFromInstalledArtifacts } from '@dkb/runtime/runtime/catalog.js';
import { ensureRuntimeState, invalidateRuntimeQuerySnapshot } from '@dkb/runtime/runtime/state.js';
import { DkbError } from '@dkb/protocol/errors.js';
import { parseDkbIdentity, registryPackagePath } from '@dkb/protocol/identity.js';
import { discoverLibraryEntries, loadManifest } from '@dkb/protocol/manifest.js';
import type { DkbLibraryLockManifest, DkbSourceManifest } from '@dkb/protocol/types.js';
import { applyLibraryLock, maybeReadLibraryLock, readLibraryState } from '@dkb/library/state.js';
import { syncLibrary } from '@dkb/library/resolver.js';
import { snapshotLibraryArtifacts, type LibraryArtifactSnapshot } from '@dkb/library/artifactSnapshot.js';
import { DKB_PACKAGE_EXTENSION } from '@dkb/registry-client/archive.js';
import { DkbRegistryClient, type DkbRegistryCollectionRevision, type DkbRegistryRelease } from '@dkb/registry-client/client.js';
import { installDkbArchiveIntoRuntime, preflightDkbInstall } from './packageRegistry.js';
import type { DkbProgressReporter } from '@dkb/protocol/progress.js';

export interface CollectionInstallResult {
  status: 'installed' | 'updated' | 'already_installed';
  collectionId: string;
  revision: number;
  digest: string;
  members: Array<{ id: string; version: string; digest: string }>;
  libraryRoot: string;
}

export async function publishCollectionFromLibrary(options: {
  collectionPath: string;
  libraryRoot: string;
  client: DkbRegistryClient;
  visibility?: 'public' | 'private' | 'unlisted';
}): Promise<DkbRegistryCollectionRevision> {
  const collectionRoot = path.resolve(options.collectionPath);
  const manifest = await loadManifest(collectionRoot);
  if (manifest.type !== 'collection') throw new DkbError(`Publish target is not a Collection: ${collectionRoot}`);

  const collectionIdentity = parseDkbIdentity(manifest.name, 'Collection identity');
  const localEntries = new Map((await discoverLibraryEntries(options.libraryRoot)).map((entry) => [entry.manifest.name, entry]));
  const members: Array<{ id: string; version: string }> = [];

  for (const [identity, selector] of Object.entries(manifest.members ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    const parsed = parseDkbIdentity(identity, `Collection ${manifest.name} member`);
    let release: DkbRegistryRelease;

    try {
      release = await options.client.packageRelease(identity, selector === 'latest' ? undefined : selector);
    } catch (error) {
      const local = localEntries.get(identity);
      if (parsed.namespace !== collectionIdentity.namespace || !local || local.manifest.type !== 'dkb') {
        const detail = error instanceof Error ? ` Registry response: ${error.message}` : '';
        throw new DkbError(
          `Collection member ${identity}@${selector} is not published. `
          + (parsed.namespace === collectionIdentity.namespace
            ? `No editable local DKB named ${identity} exists in this Library.`
            : `Foreign namespace @${parsed.namespace} must publish it first.`)
          + detail,
        );
      }

      if (selector !== 'latest' && selector !== local.manifest.version) {
        throw new DkbError(`Local ${identity}@${local.manifest.version} cannot satisfy Collection selector ${selector}.`);
      }

      await options.client.publish({
        sourcePath: local.root,
        visibility: options.visibility === 'public' ? 'public' : 'private',
      });
      release = await options.client.packageRelease(identity, selector === 'latest' ? undefined : selector);
    }

    members.push({ id: release.packageId, version: release.version });
  }

  if (members.length === 0) throw new DkbError(`Collection ${manifest.name} has no members to publish.`);

  return options.client.publishCollection({
    id: manifest.name,
    name: manifest.displayName ?? manifest.name,
    description: manifest.description,
    visibility: options.visibility ?? 'private',
    members,
  });
}

export async function installRegistryCollection(options: {
  client: DkbRegistryClient;
  collectionId: string;
  revision?: number;
  libraryRoot?: string;
  update?: boolean;
  progress?: DkbProgressReporter;
}): Promise<CollectionInstallResult> {
  const runtime = await ensureRuntimeState(options.libraryRoot);
  const libraryRoot = runtime.stateRoot;
  const collectionId = parseDkbIdentity(options.collectionId, 'Collection identity').identity;
  const revision = await options.client.collectionRevision(collectionId, options.revision);
  const state = await readLibraryState(libraryRoot);
  const current = state.entries[collectionId];

  if (current) {
    if (current.kind !== 'collection') throw new DkbError(`${collectionId} is already installed as a DKB.`);
    if (current.revision === revision.revision && current.digest === revision.digest) {
      return resultFor('already_installed', revision, libraryRoot);
    }
    if (!options.update) {
      throw new DkbError(`${collectionId}@r${current.revision ?? '?'} is already installed. Run collection update to move to r${revision.revision}.`);
    }
  }

  assertNoDuplicateMembers(revision);
  const releases = await Promise.all(revision.manifest.members.map(async (member) => {
    const release = await options.client.packageRelease(member.id, member.version);
    if (release.packageTreeHash !== member.digest) {
      throw new DkbError(`Collection snapshot digest mismatch for ${member.id}@${member.version}.`);
    }
    return release;
  }));

  const replaceable = new Set<string>();
  const unchanged = new Set<string>();
  for (const release of releases) {
    const installed = state.entries[release.packageId];
    if (!installed) continue;
    if (installed.kind !== 'dkb') throw new DkbError(`${release.packageId} is installed as a Collection, not a DKB.`);
    if (installed.version === release.version && (!installed.digest || installed.digest === release.packageTreeHash)) {
      unchanged.add(release.packageId);
      continue;
    }

    const allowedOwner = `collection:${collectionId}`;
    if (!options.update || installed.requiredBy.some((owner) => owner !== allowedOwner)) {
      throw new DkbError(
        `Version conflict for ${release.packageId}: installed ${installed.version ?? '?'}, `
        + `${collectionId}@r${revision.revision} requires ${release.version}.`,
      );
    }
    replaceable.add(release.packageId);
  }

  const transaction = await snapshotLibraryMutation(libraryRoot, [
    collectionId,
    ...new Set([...releases.map((release) => release.packageId), ...currentCollectionMembers(state, collectionId)]),
  ]);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-collection-install-'));
  const originalManifest = await requireLibraryManifest(libraryRoot);
  const originalRootIds = new Set(Object.keys(originalManifest.roots ?? {}));
  const previousMemberIds = currentCollectionMembers(state, collectionId);

  try {
    const keysResponse = await options.client.publicKeys();
    const trustedKeys = isRecord(keysResponse) && Array.isArray(keysResponse.keys) ? keysResponse.keys : null;
    if (!trustedKeys) throw new DkbError('Registry returned an invalid signing-key document.');

    if (current) {
      await prepareCollectionUpdate(libraryRoot, collectionId, state);
    }

    for (const release of releases) {
      if (unchanged.has(release.packageId)) continue;
      await preflightDkbInstall({
        runtimeRoot: libraryRoot,
        candidate: release,
        force: replaceable.has(release.packageId),
      });
    }

    for (const release of releases) {
      if (unchanged.has(release.packageId)) continue;
      const archivePath = path.join(tempRoot, `${safeFilename(release.packageId)}-${release.version}${DKB_PACKAGE_EXTENSION}`);
      await options.client.writePackageArchive(release.packageId, archivePath, release.version, { progress: options.progress });
      await installDkbArchiveIntoRuntime({
        archivePath,
        runtimeRoot: libraryRoot,
        trustedKeys: trustedKeys as Parameters<typeof installDkbArchiveIntoRuntime>[0]['trustedKeys'],
        expectedArchiveHash: release.archiveHash,
        force: replaceable.has(release.packageId),
        progress: options.progress,
      });
    }

    await writeInstalledCollection(libraryRoot, revision);
    await activateCollectionRoot(
      libraryRoot,
      revision,
      new Set([...releases.map((release) => release.packageId), ...previousMemberIds]),
      originalRootIds,
    );
    await pruneOldCollectionMembers(libraryRoot, state, collectionId, new Set(releases.map((release) => release.packageId)));
    await refreshRuntimeCatalogFromInstalledArtifacts(libraryRoot);
    invalidateRuntimeQuerySnapshot(libraryRoot);
    await transaction.commit();

    return resultFor(current ? 'updated' : 'installed', revision, libraryRoot);
  } catch (error) {
    await transaction.rollback();
    invalidateRuntimeQuerySnapshot(libraryRoot);
    throw error;
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

export async function uninstallRegistryCollection(options: {
  collectionId: string;
  libraryRoot?: string;
}): Promise<{ status: 'removed'; collectionId: string; removedDkbs: string[]; libraryRoot: string }> {
  const runtime = await ensureRuntimeState(options.libraryRoot);
  const libraryRoot = runtime.stateRoot;
  const collectionId = parseDkbIdentity(options.collectionId, 'Collection identity').identity;
  const state = await readLibraryState(libraryRoot);
  const collection = state.entries[collectionId];
  if (!collection || collection.kind !== 'collection') throw new DkbError(`Registry Collection is not installed: ${collectionId}`);
  if (collection.source !== 'registry') throw new DkbError(`Editable local Collection ${collectionId} must be deactivated with dkb library remove.`);

  const removable = Object.values(state.entries)
    .filter((entry) => entry.kind === 'dkb' && entry.source === 'registry'
      && entry.requiredBy.length === 1 && entry.requiredBy[0] === `collection:${collectionId}`)
    .map((entry) => entry.identity);
  const transaction = await snapshotLibraryMutation(libraryRoot, [collectionId, ...removable]);

  try {
    const manifest = await requireLibraryManifest(libraryRoot);
    const roots = { ...(manifest.roots ?? {}) };
    delete roots[collectionId];
    await writeJsonAtomic(path.join(libraryRoot, 'dkb.json'), { ...manifest, roots });
    await syncLibrary(libraryRoot);

    for (const identity of [collectionId, ...removable]) {
      await fs.rm(registryPackagePath(libraryRoot, identity), { recursive: true, force: true });
    }
    await refreshRuntimeCatalogFromInstalledArtifacts(libraryRoot);
    invalidateRuntimeQuerySnapshot(libraryRoot);
    await transaction.commit();

    return { status: 'removed', collectionId, removedDkbs: removable.sort(), libraryRoot };
  } catch (error) {
    await transaction.rollback();
    invalidateRuntimeQuerySnapshot(libraryRoot);
    throw error;
  }
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
  await writeJsonAtomic(path.join(libraryRoot, 'dkb.json'), { ...manifest, roots });
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

  await writeJsonAtomic(path.join(libraryRoot, 'dkb.json'), { ...manifest, roots });
  await syncLibrary(libraryRoot);
}

async function writeInstalledCollection(libraryRoot: string, revision: DkbRegistryCollectionRevision): Promise<void> {
  const target = registryPackagePath(libraryRoot, revision.collectionId);
  await fs.mkdir(target, { recursive: true });
  await writeJsonAtomic(path.join(target, 'dkb.json'), {
    manifestVersion: 1,
    type: 'collection',
    name: revision.collectionId,
    displayName: revision.manifest.name,
    members: Object.fromEntries(revision.manifest.members.map((member) => [member.id, member.version])),
    meta: {
      revision: revision.revision,
      digest: revision.digest,
    },
  });
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
      await fs.rm(registryPackagePath(libraryRoot, identity), { recursive: true, force: true });
    }
  }
}

function currentCollectionMembers(state: Awaited<ReturnType<typeof readLibraryState>>, collectionId: string): string[] {
  return Object.values(state.entries)
    .filter((entry) => entry.kind === 'dkb' && entry.requiredBy.includes(`collection:${collectionId}`))
    .map((entry) => entry.identity);
}

async function snapshotLibraryMutation(libraryRoot: string, identities: string[]): Promise<{
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
}> {
  const transactionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-library-rollback-'));
  const manifestSource = await fs.readFile(path.join(libraryRoot, 'dkb.json'), 'utf8');
  const lock = await maybeReadLibraryLock(libraryRoot);
  const snapshots: Array<{ identity: string; source: string; snapshot: string; existed: boolean }> = [];
  let artifactSnapshot: LibraryArtifactSnapshot;

  try {
    for (const identity of [...new Set(identities)]) {
      const source = registryPackagePath(libraryRoot, identity);
      const snapshot = path.join(transactionRoot, safeFilename(identity));
      const existed = await exists(source);
      if (existed) await fs.cp(source, snapshot, { recursive: true });
      snapshots.push({ identity, source, snapshot, existed });
    }
    artifactSnapshot = await snapshotLibraryArtifacts(libraryRoot);
  } catch (error) {
    await fs.rm(transactionRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    commit: async () => {
      await artifactSnapshot.commit();
      await fs.rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined);
    },
    rollback: async () => {
      for (const item of snapshots) {
        await fs.rm(item.source, { recursive: true, force: true });
        if (item.existed) {
          await fs.mkdir(path.dirname(item.source), { recursive: true });
          await fs.cp(item.snapshot, item.source, { recursive: true });
        }
      }
      await fs.writeFile(path.join(libraryRoot, 'dkb.json'), manifestSource, 'utf8');
      await restoreLibraryLock(libraryRoot, lock);
      await artifactSnapshot.rollback();
      await fs.rm(transactionRoot, { recursive: true, force: true });
    },
  };
}

async function restoreLibraryLock(libraryRoot: string, lock: DkbLibraryLockManifest | null): Promise<void> {
  if (lock) {
    await applyLibraryLock(libraryRoot, lock);
    return;
  }

  const manifest = await requireLibraryManifest(libraryRoot);
  await applyLibraryLock(libraryRoot, {
    library: { name: manifest.name },
    generation: 0,
    entries: {},
    resolvedAt: new Date().toISOString(),
  });
  await fs.rm(path.join(libraryRoot, 'dkb-lock.json'), { force: true });
}

async function requireLibraryManifest(libraryRoot: string): Promise<DkbSourceManifest> {
  const manifest = await loadManifest(libraryRoot);
  if (manifest.type !== 'library') throw new DkbError(`Not a DKB Library: ${libraryRoot}`);
  return manifest;
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const temp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
  const backup = `${target}.replace-${process.pid}-${Date.now().toString(36)}`;
  const hadTarget = await exists(target);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (hadTarget) await fs.rename(target, backup);
  try {
    await fs.rename(temp, target);
    await fs.rm(backup, { recursive: true, force: true });
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true });
    if (hadTarget && await exists(backup)) await fs.rename(backup, target);
    throw error;
  }
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

function assertNoDuplicateMembers(revision: DkbRegistryCollectionRevision): void {
  const seen = new Set<string>();
  for (const member of revision.manifest.members) {
    parseDkbIdentity(member.id, `Collection ${revision.collectionId} member`);
    if (seen.has(member.id)) throw new DkbError(`Collection revision contains duplicate member ${member.id}.`);
    seen.add(member.id);
  }
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'entry';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
