import fs from 'node:fs/promises';
import path from 'node:path';
import { stableHash } from '../contracts/hash.js';
import { DkbError } from './errors.js';
import { identityDisplayName, parseDkbIdentity, registryPackagePath } from './identity.js';
import { manifestPath, resolveContainedPath } from './paths.js';
import { validateDkbManifest } from './validation.js';
import type {
  DiscoveredLibraryEntry,
  DkbManifest,
  DkbSourceManifest,
  DkbStore,
  DkcManifest,
  DkrManifest,
  DkbVersionSelector,
  LoadedCollection,
  LoadedDkb,
  LoadedLibrary,
} from './types.js';

const DKB_MANIFEST_FILENAME = 'dkb.json';
const LOCAL_LIBRARY_VERSION = '0.0.0-local';
const DIRECT_ENTRY_IGNORES = new Set([
  '.dkb',
  '.git',
  '.idea',
  'node_modules',
  'dist',
  'archives',
  'vendor',
]);
const SYSTEM_ARTIFACT_FILENAMES = new Set([
  'dkb-lock.json',
  'dkb-profile.lock.json',
  'dkb-release.json',
  '.dkb-package.json',
]);
const SQLITE_EXTENSIONS = new Set(['.sqlite', '.sqlite3', '.db']);

export async function loadDkb(root: string): Promise<LoadedDkb> {
  const resolvedRoot = path.resolve(root);
  const source = manifestPath(resolvedRoot, DKB_MANIFEST_FILENAME);
  const manifest = validateDkbManifest(await readJson(source), source);

  if (manifest.type !== 'dkb') {
    throw new DkbError(`${entryKindLabel(manifest.type)} manifests cannot be loaded as DKBs: ${source}`);
  }

  await assertNoNestedDkbManifest(resolvedRoot, source);

  return normalizeDkb(resolvedRoot, manifest, source);
}

export async function loadDkbPackage(root: string, identityOverride?: string): Promise<LoadedDkb> {
  const dkb = await loadDkb(root);

  if (identityOverride && identityOverride !== dkb.manifest.id) {
    parseDkbIdentity(identityOverride, 'Installed DKB identity');
    throw new DkbError(`Installed DKB identity mismatch: expected ${identityOverride}, manifest declares ${dkb.manifest.id}`);
  }

  return dkb;
}

export async function loadCollection(root: string, collectionId?: string): Promise<LoadedCollection> {
  const resolvedRoot = path.resolve(root);
  const source = manifestPath(resolvedRoot, DKB_MANIFEST_FILENAME);

  if (await exists(source)) {
    const manifest = validateDkbManifest(await readJson(source), source);

    if (manifest.type === 'collection') {
      const libraryRoot = path.dirname(resolvedRoot);
      const library = await loadLibrary(libraryRoot);
      const selected = library.collections.find((candidate) => candidate.manifest.id === manifest.name);

      if (!selected) {
        throw new DkbError(`Collection ${manifest.name} is present but is not an active Library root`);
      }

      return selected;
    }
  }

  const library = await loadLibrary(resolvedRoot);

  if (collectionId) {
    parseDkbIdentity(collectionId, 'Collection identity');
    const collection = library.collections.find((candidate) => candidate.manifest.id === collectionId);

    if (!collection) {
      throw new DkbError(`Unknown active Collection: ${collectionId}`);
    }

    return collection;
  }

  if (library.collections.length === 1 && library.dkbs.length === 0) {
    return library.collections[0]!;
  }

  throw new DkbError('A Collection identity is required when the Library has more than one active root');
}

export async function loadLibrary(root: string): Promise<LoadedLibrary> {
  const resolvedRoot = path.resolve(root);
  const source = manifestPath(resolvedRoot, DKB_MANIFEST_FILENAME);

  if (!(await exists(source))) {
    throw new DkbError(`No Library ${DKB_MANIFEST_FILENAME} manifest found at ${resolvedRoot}`);
  }

  const sourceManifest = validateDkbManifest(await readJson(source), source);

  if (sourceManifest.type !== 'library') {
    throw new DkbError(`Expected a Library manifest at ${source}; found ${sourceManifest.type}`);
  }

  const directEntries = await discoverLibraryEntries(resolvedRoot);
  const entriesByIdentity = new Map(directEntries.map((entry) => [entry.manifest.name, entry]));
  const libraryManifest = normalizeLibraryManifest(resolvedRoot, sourceManifest);
  const activeCollections: LoadedCollection[] = [];
  const standaloneDkbs: LoadedDkb[] = [];
  const collectionMemberIds = new Set<string>();

  for (const [identity, requirement] of Object.entries(sourceManifest.roots ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    parseDkbIdentity(identity, 'Library root identity');
    const entry = await resolveLibraryEntry(resolvedRoot, identity, requirement, entriesByIdentity);

    if (entry.manifest.type === 'dkb') {
      assertDkbSelector(identity, entry.manifest.version!, requirement.version);
      standaloneDkbs.push(await loadDkb(entry.root));
      continue;
    }

    if (entry.manifest.type !== 'collection') {
      throw new DkbError(`Library root ${identity} resolves to a ${entry.manifest.type} manifest`);
    }

    const collection = await resolveCollection(resolvedRoot, entry, sourceManifest, entriesByIdentity);
    activeCollections.push(collection);
    for (const dkb of collection.dkbs) {
      collectionMemberIds.add(dkb.manifest.id);
    }
  }

  return {
    root: resolvedRoot,
    manifest: libraryManifest,
    collections: activeCollections,
    dkbs: uniqueLoadedDkbs(standaloneDkbs).filter((dkb) => !collectionMemberIds.has(dkb.manifest.id)),
  };
}

export async function loadCompose(root: string): Promise<LoadedLibrary> {
  const resolvedRoot = path.resolve(root);
  const sourceManifest = await loadManifest(resolvedRoot);

  if (sourceManifest.type === 'library') {
    return loadLibrary(resolvedRoot);
  }
  if (sourceManifest.type === 'collection') {
    const collection = await loadCollection(resolvedRoot);
    return {
      root: resolvedRoot,
      manifest: {
        id: safeId(sourceManifest.name),
        name: sourceManifest.displayName ?? identityDisplayName(sourceManifest.name),
        version: LOCAL_LIBRARY_VERSION,
        roots: { [sourceManifest.name]: { path: '.' } },
      },
      collections: [collection],
      dkbs: [],
    };
  }

  const dkb = await loadDkb(resolvedRoot);
  return {
    root: resolvedRoot,
    manifest: {
      id: safeId(dkb.manifest.id),
      name: dkb.manifest.name,
      version: LOCAL_LIBRARY_VERSION,
      roots: { [dkb.manifest.id]: { path: '.' } },
    },
    collections: [],
    dkbs: [dkb],
  };
}

export async function loadManifest(root: string): Promise<DkbSourceManifest> {
  const resolvedRoot = path.resolve(root);
  const source = manifestPath(resolvedRoot, DKB_MANIFEST_FILENAME);

  if (await exists(source)) {
    return validateDkbManifest(await readJson(source), source);
  }

  throw new DkbError(`No ${DKB_MANIFEST_FILENAME} manifest found at ${resolvedRoot}`);
}

export async function discoverLibraryEntries(root: string): Promise<DiscoveredLibraryEntry[]> {
  const resolvedRoot = path.resolve(root);
  const entries = await safeReadDir(resolvedRoot);
  const discovered: DiscoveredLibraryEntry[] = [];
  const seen = new Map<string, string>();

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || DIRECT_ENTRY_IGNORES.has(entry.name) || entry.name.includes('.replace-')) {
      continue;
    }

    const entryRoot = path.join(resolvedRoot, entry.name);
    const source = manifestPath(entryRoot, DKB_MANIFEST_FILENAME);

    if (!(await exists(source))) {
      continue;
    }

    const manifest = validateDkbManifest(await readJson(source), source);

    if (manifest.type === 'library') {
      throw new DkbError(`Libraries cannot be nested: ${source}`);
    }

    const previous = seen.get(manifest.name);
    if (previous) {
      throw new DkbError(`Duplicate Library identity ${manifest.name}: ${previous} and ${source}`);
    }

    seen.set(manifest.name, source);
    discovered.push({ root: entryRoot, source: 'local', manifest });
  }

  return discovered;
}

async function resolveLibraryEntry(
  libraryRoot: string,
  identity: string,
  requirement: NonNullable<DkbSourceManifest['roots']>[string],
  directEntries: Map<string, DiscoveredLibraryEntry>,
): Promise<DiscoveredLibraryEntry> {
  if (requirement.path) {
    const entryRoot = resolveContainedPath(libraryRoot, requirement.path, `Library root ${identity} path`);
    const source = manifestPath(entryRoot, DKB_MANIFEST_FILENAME);
    const manifest = validateDkbManifest(await readJson(source), source);

    if (manifest.type === 'library') {
      throw new DkbError(`Library root ${identity} cannot point to another Library`);
    }
    if (manifest.name !== identity) {
      throw new DkbError(`Library root identity mismatch: ${identity} points to ${manifest.name} at ${source}`);
    }

    return { root: entryRoot, source: 'local', manifest };
  }

  const local = directEntries.get(identity);
  if (local) {
    throw new DkbError(`Library root ${identity} is local; declare it with { "path": "${path.basename(local.root)}" }`);
  }

  const entryRoot = registryPackagePath(libraryRoot, identity);
  const source = manifestPath(entryRoot, DKB_MANIFEST_FILENAME);

  if (!(await exists(source))) {
    throw new DkbError(`Installed Registry entry is missing for ${identity}: ${entryRoot}`);
  }

  const manifest = validateDkbManifest(await readJson(source), source);
  if (manifest.type === 'library' || manifest.name !== identity) {
    throw new DkbError(`Installed Registry entry identity mismatch for ${identity}: ${source}`);
  }

  if (requirement.revision !== undefined && manifest.type !== 'collection') {
    throw new DkbError(`Library root ${identity} requests a Collection revision but resolves to a DKB`);
  }
  if (requirement.version !== undefined && manifest.type !== 'dkb') {
    throw new DkbError(`Library root ${identity} requests a DKB version but resolves to a Collection`);
  }

  return { root: entryRoot, source: 'registry', manifest };
}

async function resolveCollection(
  libraryRoot: string,
  entry: DiscoveredLibraryEntry,
  library: DkbSourceManifest,
  directEntries: Map<string, DiscoveredLibraryEntry>,
): Promise<LoadedCollection> {
  const manifest = entry.manifest;
  const override = library.collectionOverrides?.[manifest.name];
  const members = { ...(manifest.members ?? {}), ...(override?.include ?? {}) };
  for (const excluded of override?.exclude ?? []) {
    delete members[excluded];
  }

  const dkbs: LoadedDkb[] = [];
  for (const [identity, selector] of Object.entries(members).sort(([left], [right]) => left.localeCompare(right))) {
    parseDkbIdentity(identity, `Collection ${manifest.name} member identity`);
    const local = directEntries.get(identity);
    const memberRoot = local?.root ?? registryPackagePath(libraryRoot, identity);
    const source = manifestPath(memberRoot, DKB_MANIFEST_FILENAME);

    if (!(await exists(source))) {
      throw new DkbError(`Collection ${manifest.name} member ${identity} is not available in the Library`);
    }

    const memberManifest = validateDkbManifest(await readJson(source), source);
    if (memberManifest.type !== 'dkb') {
      throw new DkbError(`Collection ${manifest.name} member ${identity} must resolve to a DKB`);
    }
    if (memberManifest.name !== identity) {
      throw new DkbError(`Collection member identity mismatch: ${identity} resolves to ${memberManifest.name}`);
    }

    assertDkbSelector(identity, memberManifest.version!, selector);
    dkbs.push(await loadDkb(memberRoot));
  }

  const revision = collectionRevision(manifest);
  const collectionManifest: DkcManifest = {
    id: manifest.name,
    name: manifest.displayName ?? identityDisplayName(manifest.name),
    version: revision ? `r${revision}` : LOCAL_LIBRARY_VERSION,
    ...(revision ? { revision } : {}),
    ...(typeof manifest.meta?.digest === 'string' ? { digest: manifest.meta.digest } : {}),
    description: manifest.description,
    namespace: manifest.namespace,
    appId: manifest.appId,
    roles: manifest.roles,
    members,
    meta: manifest.meta,
    extensions: manifest.extensions,
  };

  return {
    root: entry.root,
    manifest: collectionManifest,
    dkbs: uniqueLoadedDkbs(dkbs),
  };
}

function collectionRevision(manifest: DkbSourceManifest): number | undefined {
  const revision = manifest.meta?.revision;
  return typeof revision === 'number' && Number.isInteger(revision) && revision > 0 ? revision : undefined;
}

function assertDkbSelector(identity: string, installedVersion: string, selector: DkbVersionSelector | undefined): void {
  if (selector && selector !== 'latest' && selector !== installedVersion) {
    throw new DkbError(`Version conflict for ${identity}: Library requires ${selector}, installed manifest is ${installedVersion}`);
  }
}

async function normalizeDkb(root: string, manifest: DkbSourceManifest, source: string): Promise<LoadedDkb> {
  assertDkbRuntimeRules(manifest, source);
  parseDkbIdentity(manifest.name);

  const stores = await discoverStores(root);
  const singleStore = stores.length === 1 ? stores[0] : null;
  const adapter = singleStore ? adapterForStore(singleStore) : 'compose';
  const entrypoint = singleStore?.path ?? singleStore?.connectionRef ?? '.';

  return {
    root,
    manifest: {
      id: manifest.name,
      name: manifest.displayName ?? identityDisplayName(manifest.name),
      version: manifest.version!,
      description: manifest.description,
      namespace: manifest.namespace ?? parseDkbIdentity(manifest.name).namespace,
      appId: manifest.appId,
      owner: manifest.owner ?? manifest.author,
      permissions: {
        read: manifest.permissions?.read ?? true,
        write: manifest.permissions?.write ?? false,
      },
      adapter,
      entrypoint,
      stores,
      domains: manifest.domains ?? [manifest.name],
      roles: manifest.roles,
      write: manifest.write,
      meta: manifest.meta,
      extensions: manifest.extensions,
    },
    packagePath: source,
    manifestHash: stableHash(manifest),
    identityKey: `dkb:${manifest.name}`,
  };
}

function normalizeLibraryManifest(root: string, manifest: DkbSourceManifest): DkrManifest {
  return {
    id: safeId(manifest.name || path.basename(root) || 'local-library'),
    name: manifest.displayName ?? manifest.name,
    version: LOCAL_LIBRARY_VERSION,
    namespace: manifest.namespace,
    appId: manifest.appId,
    owner: manifest.owner ?? manifest.author,
    roots: manifest.roots ?? {},
    collectionOverrides: manifest.collectionOverrides,
    registry: manifest.registry,
    retrievalProfile: manifest.retrievalProfile,
    meta: manifest.meta,
    extensions: manifest.extensions,
  };
}

function assertDkbRuntimeRules(manifest: DkbSourceManifest, source: string): void {
  if (manifest.permissions?.read === false) {
    throw new DkbError(`Invalid manifest at ${source}: permissions.read must be true for queryable DKBs`);
  }
  if (manifest.permissions?.write === true && !manifest.write) {
    throw new DkbError(`Invalid manifest at ${source}: permissions.write requires a write block`);
  }
  if (manifest.write && manifest.permissions?.write === false) {
    throw new DkbError(`Invalid manifest at ${source}: write block cannot be declared when permissions.write is false`);
  }
}

function adapterForStore(store: DkbStore): 'folder' | 'sqlite' | 'postgres' {
  if (store.type === 'filesystem') return 'folder';
  if (store.type === 'sqlite') return 'sqlite';
  if (store.type === 'postgres') return 'postgres';
  throw new DkbError(`Unsupported store type: ${store.type}`);
}

async function discoverStores(root: string): Promise<DkbStore[]> {
  const sqliteFiles = (await listDkbSourceFiles(root)).filter((file) => SQLITE_EXTENSIONS.has(path.extname(file).toLowerCase()));
  const sqliteRelativePaths = sqliteFiles.map((file) => path.relative(root, file).replace(/\\/g, '/'));
  const writable = await writableStoreMode(root);

  return [
    {
      id: 'root',
      type: 'filesystem',
      path: '.',
      mode: writable === 'filesystem' ? 'readwrite' : 'read',
      meta: sqliteRelativePaths.length > 0 ? { claimedByAdapters: sqliteRelativePaths } : undefined,
    },
    ...sqliteFiles.map((file) => {
      const relative = path.relative(root, file).replace(/\\/g, '/');
      return {
        id: `sqlite-${stableHash(relative).replace(/^sha256:/, '').slice(0, 12)}`,
        type: 'sqlite' as const,
        path: relative,
        mode: writable === 'sqlite' ? 'readwrite' as const : 'read' as const,
      };
    }),
  ];
}

async function writableStoreMode(root: string): Promise<'filesystem' | 'sqlite' | null> {
  const source = manifestPath(root, DKB_MANIFEST_FILENAME);
  const manifest = validateDkbManifest(await readJson(source), source);
  if (manifest.permissions?.write !== true) return null;
  const sqliteFiles = (await listDkbSourceFiles(root)).filter((file) => SQLITE_EXTENSIONS.has(path.extname(file).toLowerCase()));
  return sqliteFiles.length === 1 ? 'sqlite' : 'filesystem';
}

async function listDkbSourceFiles(root: string): Promise<string[]> {
  const entries = await safeReadDir(root);
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isSymbolicLink() || entry.name === '.dkb' || SYSTEM_ARTIFACT_FILENAMES.has(entry.name)) continue;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listDkbSourceFiles(target));
    else if (entry.isFile()) files.push(target);
  }

  return files.sort((left, right) => left.localeCompare(right));
}

async function assertNoNestedDkbManifest(root: string, topManifest: string): Promise<void> {
  const nested = (await listDkbSourceFiles(root))
    .filter((file) => path.basename(file) === DKB_MANIFEST_FILENAME && path.resolve(file) !== path.resolve(topManifest));
  if (nested.length > 0) {
    throw new DkbError(`Nested ${DKB_MANIFEST_FILENAME} manifests are not allowed inside a DKB: ${path.relative(root, nested[0]!).replace(/\\/g, '/')}`);
  }
}

async function safeReadDir(root: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new DkbError(`Unable to read DKB Library at ${root}: ${reason}`);
  }
}

async function readJson(source: string): Promise<unknown> {
  try {
    return JSON.parse((await fs.readFile(source, 'utf8')).replace(/^\uFEFF/, '')) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new DkbError(`Unable to read JSON at ${source}: ${reason}`);
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

export function uniqueLoadedDkbs(dkbs: LoadedDkb[]): LoadedDkb[] {
  const seen = new Set<string>();
  return dkbs.filter((dkb) => {
    if (seen.has(dkb.manifest.id)) return false;
    seen.add(dkb.manifest.id);
    return true;
  });
}

function safeId(value: string): string {
  const id = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return id || 'local-library';
}

function entryKindLabel(type: DkbSourceManifest['type']): string {
  if (type === 'library') return 'Library';
  if (type === 'collection') return 'Collection';
  return 'DKB';
}
