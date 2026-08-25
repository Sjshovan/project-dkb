import fs from 'node:fs/promises';
import path from 'node:path';
import { stableHash } from '../contracts/hash.js';
import { DkbError } from './errors.js';
import { manifestPath, resolveContainedPath } from './paths.js';
import { validateDkbManifest } from './validation.js';
import type {
  DkbManifest,
  DkbSourceManifest,
  DkbStore,
  DkcManifest,
  DkrManifest,
  LoadedCollection,
  LoadedDkb,
  LoadedRegistry,
} from './types.js';

const DKB_MANIFEST_FILENAME = 'dkb.json';
const LOCAL_VERSION = '0.0.0-local';
const DISCOVERY_IGNORES = new Set([
  '.dkb',
  '.git',
  '.idea',
  'node_modules',
  'dist',
  'archives',
]);
const SYSTEM_ARTIFACT_FILENAMES = new Set([
  'dkb-lock.json',
  'dkb-profile.lock.json',
  'dkb-release.json',
  '.dkb-package.json',
]);
const REGISTRY_LOCAL_SOURCE_IGNORES = new Set([
  ...DISCOVERY_IGNORES,
  'vendor',
  DKB_MANIFEST_FILENAME,
  ...SYSTEM_ARTIFACT_FILENAMES,
]);
const SQLITE_EXTENSIONS = new Set(['.sqlite', '.sqlite3', '.db']);
const LOCAL_TEXT_SOURCE_EXTENSIONS = new Set([
  '.adoc',
  '.csv',
  '.htm',
  '.html',
  '.ini',
  '.json',
  '.jsonl',
  '.log',
  '.md',
  '.rst',
  '.sql',
  '.toml',
  '.tsv',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

export async function loadDkb(root: string): Promise<LoadedDkb> {
  const resolvedRoot = path.resolve(root);
  const source = manifestPath(resolvedRoot, DKB_MANIFEST_FILENAME);
  const manifest = validateDkbManifest(await readJson(source), source);

  if (isRegistryProjectManifest(manifest)) {
    throw new DkbError(`Registry project manifests cannot be loaded as DKB packages: ${source}`);
  }

  await assertNoNestedDkbManifest(resolvedRoot, source);

  return normalizeDkb(resolvedRoot, manifest, dkbIdForRoot(resolvedRoot, manifest), source);
}

export async function loadDkbPackage(root: string, idOverride?: string): Promise<LoadedDkb> {
  const dkb = await loadDkb(root);

  return idOverride && idOverride !== dkb.manifest.id
    ? {
        ...dkb,
        manifest: {
          ...dkb.manifest,
          id: idOverride,
          domains: dkb.manifest.domains.length > 0 ? dkb.manifest.domains : [idOverride],
        },
      }
    : dkb;
}

export async function loadCollection(root: string, collectionId?: string): Promise<LoadedCollection> {
  const registry = await loadRegistry(root);

  if (collectionId) {
    const collection = registry.collections.find((candidate) => candidate.manifest.id === collectionId);

    if (!collection) {
      throw new DkbError(`Unknown DKB collection id: ${collectionId}`);
    }

    return collection;
  }

  return defaultCollectionFromRegistry(registry);
}

export async function loadRegistry(root: string): Promise<LoadedRegistry> {
  const resolvedRoot = path.resolve(root);
  const roots = await discoverDkbRoots(resolvedRoot);
  const rootManifest = await maybeReadRegistryProjectManifest(resolvedRoot);

  const packageDkbs = await Promise.all(roots.map((dkbRoot) => loadDkb(dkbRoot)));
  const uniquePackages = uniqueDkbs(packageDkbs);
  const registryManifest = registryManifestFor(resolvedRoot, uniquePackages, rootManifest);
  const implicitLocalDkb = await maybeLoadImplicitLocalDkb(resolvedRoot, registryManifest, rootManifest, uniquePackages);
  const unique = uniqueDkbs([
    ...uniquePackages,
    ...(implicitLocalDkb ? [implicitLocalDkb] : []),
  ]);

  if (unique.length === 0 && !rootManifest) {
    throw new DkbError(`No ${DKB_MANIFEST_FILENAME} manifest or eligible registry-local sources found at ${resolvedRoot}`);
  }

  const collections = collectionsFromDkbs(resolvedRoot, registryManifest, unique);
  const collectionDkbIds = new Set(collections.flatMap((collection) => collection.dkbs.map((dkb) => dkb.manifest.id)));

  return {
    root: resolvedRoot,
    manifest: registryManifest,
    collections,
    dkbs: unique.filter((dkb) => !collectionDkbIds.has(dkb.manifest.id)),
  };
}

export const loadCompose = loadRegistry;

export async function loadManifest(root: string): Promise<DkbSourceManifest> {
  const resolvedRoot = path.resolve(root);
  const source = manifestPath(resolvedRoot, DKB_MANIFEST_FILENAME);

  if (await exists(source)) {
    return validateDkbManifest(await readJson(source), source);
  }

  throw new DkbError(`No ${DKB_MANIFEST_FILENAME} manifest found at ${resolvedRoot}`);
}

async function discoverDkbRoots(root: string): Promise<string[]> {
  const rootManifestPath = manifestPath(root, DKB_MANIFEST_FILENAME);

  if (await exists(rootManifestPath) && !isRegistryProjectManifest(await readJson(rootManifestPath))) {
    return [root];
  }

  const entries = await safeReadDir(root);
  const nested = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !DISCOVERY_IGNORES.has(entry.name) && !entry.name.includes('.replace-'))
    .map((entry) => discoverDkbRoots(path.join(root, entry.name))));

  return nested.flat().sort((left, right) => left.localeCompare(right));
}

function isRegistryProjectManifest(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const manifest = value as DkbSourceManifest;

  return manifest.type === 'registry'
    || (manifest.dependencies !== undefined && typeof manifest.dependencies === 'object' && !Array.isArray(manifest.dependencies));
}

async function safeReadDir(root: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    throw new DkbError(`Unable to read DKB registry root at ${root}: ${reason}`);
  }
}

async function maybeReadRegistryProjectManifest(root: string): Promise<DkbSourceManifest | null> {
  const source = manifestPath(root, DKB_MANIFEST_FILENAME);

  if (!(await exists(source))) {
    return null;
  }

  const raw = await readJson(source);

  return isRegistryProjectManifest(raw) ? validateDkbManifest(raw, source) : null;
}

async function normalizeDkb(root: string, manifest: DkbSourceManifest, id: string, source: string): Promise<LoadedDkb> {
  assertDkbRuntimeRules(manifest, source);

  const stores = await discoverStores(root);
  const singleStore = stores.length === 1 ? stores[0] : null;
  const adapter = singleStore ? adapterForStore(singleStore) : 'compose';
  const entrypoint = singleStore?.path ?? singleStore?.connectionRef ?? '.';
  const collection = normalizeCollection(manifest.collection);

  return {
    root,
    manifest: {
      id,
      name: manifest.name,
      version: manifest.version ?? LOCAL_VERSION,
      description: manifest.description,
      namespace: manifest.namespace,
      appId: manifest.appId,
      owner: manifest.owner ?? manifest.author,
      collection,
      permissions: {
        read: manifest.permissions?.read ?? true,
        write: manifest.permissions?.write ?? false,
      },
      adapter,
      entrypoint,
      stores,
      domains: manifest.domains ?? [id],
      roles: manifest.roles,
      write: manifest.write,
      meta: manifest.meta,
      extensions: manifest.extensions,
    },
    packagePath: source,
    manifestHash: stableHash(manifest),
    identityKey: `dkb:${root}`,
  };
}

function registryManifestFor(root: string, dkbs: LoadedDkb[], rootManifest: DkbSourceManifest | null): DkrManifest {
  const owner = dkbs.find((dkb) => dkb.manifest.owner)?.manifest.owner;
  const namespace = commonValue(dkbs.map((dkb) => dkb.manifest.namespace));
  const appId = commonValue(dkbs.map((dkb) => dkb.manifest.appId));
  const registryName = rootManifest?.name ?? titleFromId(path.basename(root) || 'Local Registry');

  return {
    id: safeId(rootManifest?.package ?? rootManifest?.name ?? (path.basename(root) || 'local-registry')),
    name: registryName,
    version: rootManifest?.version ?? LOCAL_VERSION,
    namespace: rootManifest?.namespace ?? namespace,
    appId: rootManifest?.appId ?? appId,
    owner: rootManifest?.owner ?? rootManifest?.author ?? owner,
    dkbs: dkbs.map((dkb) => ({ path: dkb.root })),
    retrievalProfile: rootManifest?.retrievalProfile,
  };
}

async function maybeLoadImplicitLocalDkb(
  root: string,
  registry: DkrManifest,
  rootManifest: DkbSourceManifest | null,
  existing: LoadedDkb[],
): Promise<LoadedDkb | null> {
  if (!rootManifest || rootManifest.localSources?.enabled === false) {
    return null;
  }

  const stores = await discoverRegistryLocalStores(root, rootManifest);

  if (stores.length === 0) {
    return null;
  }

  const id = implicitLocalDkbIdFor(registry.id, existing.map((dkb) => dkb.manifest.id), root);
  const manifest = {
    id,
    name: `${registry.name} Local Sources`,
    version: LOCAL_VERSION,
    description: 'Implicit registry-local sources compiled from eligible raw files.',
    namespace: registry.namespace,
    appId: registry.appId,
    owner: registry.owner,
    permissions: {
      read: true,
      write: false,
    },
    adapter: stores.length === 1 && stores[0]!.type === 'filesystem' ? 'folder' as const : 'compose' as const,
    entrypoint: '.',
    stores,
    domains: [id, registry.id],
    meta: {
      registryId: registry.id,
      sourceOrigin: 'registry-local',
      implicit: true,
    },
  };

  return {
    root,
    origin: 'local',
    manifest,
    packagePath: null,
    manifestHash: stableHash({
      registry: registry.id,
      localSources: rootManifest.localSources ?? {},
      stores,
    }),
    identityKey: `dkb:${root}:registry-local`,
  };
}

async function discoverRegistryLocalStores(root: string, manifest: DkbSourceManifest): Promise<DkbStore[]> {
  const sourceRoot = resolveContainedPath(root, manifest.localSources?.root ?? '.', 'localSources.root');
  const policyExcludes = new Set((manifest.localSources?.excludes ?? [])
    .map((item) => item.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/g, ''))
    .filter(Boolean));
  const entries = await safeReadDir(sourceRoot);
  const files = entries
    .filter((entry) => isEligibleRegistryLocalSourceEntry(entry, policyExcludes))
    .map((entry) => path.join(sourceRoot, entry.name))
    .sort((left, right) => left.localeCompare(right));
  const textFiles = files
    .filter((file) => LOCAL_TEXT_SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()))
    .map((file) => path.relative(root, file).replace(/\\/g, '/'));
  const sqliteFiles = files
    .filter((file) => SQLITE_EXTENSIONS.has(path.extname(file).toLowerCase()))
    .map((file) => path.relative(root, file).replace(/\\/g, '/'));
  const stores: DkbStore[] = [];

  if (textFiles.length > 0) {
    stores.push({
      id: 'registry-local-files',
      type: 'filesystem',
      path: path.relative(root, sourceRoot).replace(/\\/g, '/') || '.',
      mode: 'read',
      meta: {
        includePaths: textFiles,
        sourceOrigin: 'registry-local',
      },
    });
  }

  stores.push(...sqliteFiles.map((relative) => ({
    id: `registry-local-sqlite-${stableHash(relative).replace(/^sha256:/, '').slice(0, 12)}`,
    type: 'sqlite' as const,
    path: relative,
    mode: 'read' as const,
    meta: {
      sourceOrigin: 'registry-local',
    },
  })));

  return stores;
}

function isEligibleRegistryLocalSourceEntry(entry: import('node:fs').Dirent, excludes: Set<string>): boolean {
  if (!entry.isFile() || entry.isSymbolicLink()) {
    return false;
  }

  if (entry.name.startsWith('.') || REGISTRY_LOCAL_SOURCE_IGNORES.has(entry.name) || excludes.has(entry.name)) {
    return false;
  }

  const extension = path.extname(entry.name).toLowerCase();

  return LOCAL_TEXT_SOURCE_EXTENSIONS.has(extension) || SQLITE_EXTENSIONS.has(extension);
}

function implicitLocalDkbIdFor(registryId: string, existingIds: string[], root: string): string {
  const base = `${registryId}.local`;

  if (!existingIds.includes(base)) {
    return base;
  }

  return `${base}-${stableHash(root).replace(/^sha256:/, '').slice(0, 8)}`;
}

function collectionsFromDkbs(root: string, registry: DkrManifest, dkbs: LoadedDkb[]): LoadedCollection[] {
  const byCollection = new Map<string, LoadedDkb[]>();

  for (const dkb of dkbs) {
    const collectionId = dkb.manifest.collection?.id;

    if (!collectionId) {
      continue;
    }

    byCollection.set(collectionId, [...(byCollection.get(collectionId) ?? []), dkb]);
  }

  return [...byCollection.entries()]
    .filter(([, collectionDkbs]) => collectionDkbs.length >= 2)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, collectionDkbs]) => {
      const first = collectionDkbs.find((dkb) => dkb.manifest.collection?.id === id);
      const manifest: DkcManifest = {
        id,
        name: first?.manifest.collection?.name ?? titleFromId(id),
        version: registry.version,
        description: first?.manifest.collection?.description,
        namespace: registry.namespace,
        appId: registry.appId,
        dkbs: collectionDkbs.map((dkb) => ({ path: dkb.root })),
      };

      return {
        root,
        manifest,
        dkbs: collectionDkbs,
      };
    });
}

function defaultCollectionFromRegistry(registry: LoadedRegistry): LoadedCollection {
  if (registry.collections.length === 1 && registry.dkbs.length === 0) {
    return registry.collections[0];
  }

  const allDkbs = uniqueDkbs([
    ...registry.collections.flatMap((collection) => collection.dkbs),
    ...registry.dkbs,
  ]);

  return {
    root: registry.root,
    manifest: {
      id: `${registry.manifest.id}-all`,
      name: `${registry.manifest.name} All DKBs`,
      version: registry.manifest.version,
      namespace: registry.manifest.namespace,
      appId: registry.manifest.appId,
      dkbs: allDkbs.map((dkb) => ({ path: dkb.root })),
    },
    dkbs: allDkbs,
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
  if (store.type === 'filesystem') {
    return 'folder';
  }

  if (store.type === 'sqlite') {
    return 'sqlite';
  }

  if (store.type === 'postgres') {
    return 'postgres';
  }

  throw new DkbError(`Unsupported store type: ${store.type}`);
}

async function discoverStores(root: string): Promise<DkbStore[]> {
  const sqliteFiles = (await listDkbSourceFiles(root))
    .filter((file) => SQLITE_EXTENSIONS.has(path.extname(file).toLowerCase()));
  const sqliteRelativePaths = sqliteFiles.map((file) => path.relative(root, file).replace(/\\/g, '/'));
  const writable = await writableStoreMode(root);

  return [
    {
      id: 'root',
      type: 'filesystem',
      path: '.',
      mode: writable === 'filesystem' ? 'readwrite' : 'read',
      meta: sqliteRelativePaths.length > 0
        ? {
            claimedByAdapters: sqliteRelativePaths,
          }
        : undefined,
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
  const manifest = validateDkbManifest(await readJson(manifestPath(root, DKB_MANIFEST_FILENAME)), manifestPath(root, DKB_MANIFEST_FILENAME));

  if (manifest.permissions?.write !== true) {
    return null;
  }

  const sqliteFiles = (await listDkbSourceFiles(root))
    .filter((file) => SQLITE_EXTENSIONS.has(path.extname(file).toLowerCase()));

  return sqliteFiles.length === 1 ? 'sqlite' : 'filesystem';
}

async function listDkbSourceFiles(root: string): Promise<string[]> {
  const entries = await safeReadDir(root);
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === '.dkb' || SYSTEM_ARTIFACT_FILENAMES.has(entry.name)) {
      continue;
    }

    const target = path.join(root, entry.name);

    if (entry.isDirectory()) {
      files.push(...await listDkbSourceFiles(target));
    } else if (entry.isFile()) {
      files.push(target);
    }
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

function normalizeCollection(collection: DkbSourceManifest['collection']): DkbManifest['collection'] {
  if (!collection) {
    return undefined;
  }

  if (typeof collection === 'string') {
    return {
      id: safeId(collection),
      name: collection,
    };
  }

  const name = collection.name ?? collection.id;
  const id = collection.id ?? safeId(name ?? 'collection');

  return {
    id,
    name,
    description: collection.description,
  };
}

function dkbIdForRoot(root: string, manifest: DkbSourceManifest): string {
  return safeId(path.basename(root) || manifest.name);
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

function uniqueDkbs(dkbs: LoadedDkb[]): LoadedDkb[] {
  const seen = new Set<string>();

  return dkbs.filter((dkb) => {
    if (seen.has(dkb.manifest.id)) {
      return false;
    }

    seen.add(dkb.manifest.id);

    return true;
  });
}

function safeId(value: string): string {
  const id = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

  return id || 'local-registry';
}

function titleFromId(value: string): string {
  return value
    .split(/[-_.]+/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ') || value;
}

function commonValue(values: Array<string | undefined>): string | undefined {
  const present = [...new Set(values.filter((value): value is string => Boolean(value)))];

  return present.length === 1 ? present[0] : undefined;
}
