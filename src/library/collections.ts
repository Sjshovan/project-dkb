import fs from 'node:fs/promises';
import path from 'node:path';
import { DkbError } from '@dkb/protocol/errors.js';
import { identityDisplayName, parseDkbIdentity, registryPackagePath } from '@dkb/protocol/identity.js';
import { discoverLibraryEntries, loadManifest } from '@dkb/protocol/manifest.js';
import { validateDkbManifest } from '@dkb/protocol/validation.js';
import type { DkbSourceManifest, DkbVersionSelector } from '@dkb/protocol/types.js';
import { addLibraryRoot, syncLibrary, type SyncLibraryResult } from './resolver.js';

export interface CreateCollectionResult extends SyncLibraryResult {
  identity: string;
  root: string;
  manifestPath: string;
}

export async function createLocalCollection(options: {
  libraryRoot: string;
  identity: string;
  displayName?: string;
  directoryName?: string;
}): Promise<CreateCollectionResult> {
  const libraryRoot = path.resolve(options.libraryRoot);
  const identity = parseDkbIdentity(options.identity, 'Collection identity');
  const existing = (await discoverLibraryEntries(libraryRoot)).find((entry) => entry.manifest.name === identity.identity);
  if (existing) throw new DkbError(`Library entry already exists: ${identity.identity} at ${existing.root}`);

  const directoryName = options.directoryName ?? identity.name;
  if (directoryName === 'vendor' || directoryName === '.dkb' || directoryName.includes('/') || directoryName.includes('\\')) {
    throw new DkbError(`Invalid local Collection directory name: ${directoryName}`);
  }
  const root = path.join(libraryRoot, directoryName);
  const target = path.join(root, 'dkb.json');
  if (await exists(root)) throw new DkbError(`Collection directory already exists: ${root}`);

  const manifest = {
    type: 'collection',
    name: identity.identity,
    displayName: options.displayName ?? identityDisplayName(identity.identity),
    description: '',
    members: {},
  } satisfies DkbSourceManifest;

  await fs.mkdir(root, { recursive: false });
  try {
    await fs.writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const synced = await addLibraryRoot(libraryRoot, identity.identity);
    return { ...synced, identity: identity.identity, root, manifestPath: target };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function setCollectionMember(options: {
  libraryRoot: string;
  collectionIdentity: string;
  dkbIdentity: string;
  selector: DkbVersionSelector;
}): Promise<SyncLibraryResult & { collectionIdentity: string; dkbIdentity: string; selector: string }> {
  const collectionIdentity = parseDkbIdentity(options.collectionIdentity, 'Collection identity').identity;
  const dkbIdentity = parseDkbIdentity(options.dkbIdentity, 'DKB identity').identity;
  const collection = await editableCollection(options.libraryRoot, collectionIdentity);
  const dkb = await availableDkbManifest(options.libraryRoot, dkbIdentity);

  validateSelector(options.selector);
  if (options.selector !== 'latest' && dkb.version !== options.selector) {
    throw new DkbError(`Collection requires ${dkbIdentity}@${options.selector}, but the Library has ${dkb.version}`);
  }

  const candidate = {
    ...collection.manifest,
    members: {
      ...(collection.manifest.members ?? {}),
      [dkbIdentity]: options.selector,
    },
  };
  const synced = await replaceCollectionManifest(options.libraryRoot, collection.path, collection.source, candidate);
  return { ...synced, collectionIdentity, dkbIdentity, selector: options.selector };
}

export async function removeCollectionMember(options: {
  libraryRoot: string;
  collectionIdentity: string;
  dkbIdentity: string;
}): Promise<SyncLibraryResult & { collectionIdentity: string; dkbIdentity: string }> {
  const collectionIdentity = parseDkbIdentity(options.collectionIdentity, 'Collection identity').identity;
  const dkbIdentity = parseDkbIdentity(options.dkbIdentity, 'DKB identity').identity;
  const collection = await editableCollection(options.libraryRoot, collectionIdentity);
  const members = { ...(collection.manifest.members ?? {}) };

  if (!(dkbIdentity in members)) {
    throw new DkbError(`${dkbIdentity} is not a member of ${collectionIdentity}`);
  }
  delete members[dkbIdentity];

  const synced = await replaceCollectionManifest(options.libraryRoot, collection.path, collection.source, {
    ...collection.manifest,
    members,
  });
  return { ...synced, collectionIdentity, dkbIdentity };
}

export async function collectionOverview(libraryRoot: string, identity: string): Promise<{
  identity: string;
  displayName: string;
  active: boolean;
  members: Array<{ identity: string; selector: string }>;
}> {
  const parsed = parseDkbIdentity(identity, 'Collection identity').identity;
  const manifest = (await discoverLibraryEntries(libraryRoot)).find((entry) => entry.manifest.name === parsed)?.manifest
    ?? await loadManifest(registryPackagePath(libraryRoot, parsed));
  if (manifest.type !== 'collection') throw new DkbError(`${parsed} is not a Collection`);
  const library = await loadManifest(libraryRoot);

  return {
    identity: parsed,
    displayName: manifest.displayName ?? identityDisplayName(parsed),
    active: Boolean(library.roots?.[parsed]),
    members: Object.entries(manifest.members ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([memberIdentity, selector]) => ({ identity: memberIdentity, selector })),
  };
}

async function editableCollection(libraryRoot: string, identity: string): Promise<{
  path: string;
  source: string;
  manifest: DkbSourceManifest;
}> {
  const entry = (await discoverLibraryEntries(libraryRoot)).find((candidate) => candidate.manifest.name === identity);
  if (!entry || entry.manifest.type !== 'collection') {
    throw new DkbError(`Editable local Collection not found: ${identity}`);
  }
  return { path: entry.root, source: path.join(entry.root, 'dkb.json'), manifest: entry.manifest };
}

async function availableDkbManifest(libraryRoot: string, identity: string): Promise<DkbSourceManifest> {
  const local = (await discoverLibraryEntries(libraryRoot)).find((entry) => entry.manifest.name === identity);
  const manifest = local?.manifest ?? await loadManifest(registryPackagePath(libraryRoot, identity));
  if (manifest.type !== 'dkb') throw new DkbError(`Collection member must be a DKB: ${identity}`);
  return manifest;
}

async function replaceCollectionManifest(
  libraryRoot: string,
  collectionRoot: string,
  source: string,
  candidate: DkbSourceManifest,
): Promise<SyncLibraryResult> {
  validateDkbManifest(candidate, `${source}#candidate`);
  const previous = await fs.readFile(source, 'utf8');

  try {
    await writeJsonAtomic(source, candidate);
    return await syncLibrary(libraryRoot);
  } catch (error) {
    await fs.writeFile(source, previous, 'utf8');
    throw error;
  }
}

function validateSelector(selector: string): void {
  const probe = {
    type: 'collection',
    name: '@validation/collection',
    members: { '@validation/member': selector },
  };
  validateDkbManifest(probe, 'Collection member selector');
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const temp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
  const backup = `${target}.replace-${process.pid}-${Date.now().toString(36)}`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(target, backup);
  try {
    await fs.rename(temp, target);
    await fs.rm(backup, { force: true });
  } catch (error) {
    await fs.rm(target, { force: true });
    await fs.rename(backup, target);
    throw error;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
