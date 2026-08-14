import { canCompileRegions, canCompileSourceUnits } from '../adapters/adapter.js';
import { adapterFor, adapterForStore } from '../adapters/index.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stableHash } from '../contracts/hash.js';
import {
  KR_GRAPH_PATH,
  KR_INDEX_PATH,
  KR_VECTOR_LANCE_PATH,
  KR_VECTOR_PATH,
  recordForHash,
  writeGraphArtifacts,
  writeKrIndex,
  writeVectorArtifacts,
  type IndexedKnowledgeRegion,
} from '../indexes/knowledgeIndex.js';
import { DkbError } from '../protocol/errors.js';
import { loadCompose } from '../protocol/manifest.js';
import { DKB_CACHE_DIR, DKB_LOCKS_DIR, manifestPath, resolveFrom } from '../protocol/paths.js';
import { validateDkbLockManifest } from '../protocol/validation.js';
import type { DkbLockArtifact, DkbLockManifest, DkbStore, LoadedCollection, LoadedDkb, LoadedRegistry } from '../protocol/types.js';
import { SOURCE_GRAPH_PATH, SOURCE_INDEX_PATH, SOURCE_VECTOR_PATH, sourceUnitsFromKnowledgeRegion, type IndexedSourceUnit } from '../indexes/sourceIndex.js';
import { analyzeSourceUnits, writeSourceAnalysisArtifacts } from './sourceAnalysis.js';

export const COMPILE_LOCK_PATH = `${DKB_LOCKS_DIR}/compile.lock`;
export const COMPILE_CACHE_PATH = `${DKB_CACHE_DIR}/compile-cache.json`;
const COMPILE_CACHE_VERSION = 1;
const COMPILE_LOCK_TIMEOUT_MS = 30_000;
const COMPILE_LOCK_STALE_MS = 10 * 60_000;
const COMPILE_LOCK_RETRY_MS = 100;
const QUICK_ARTIFACT_PATHS = [
  KR_INDEX_PATH,
  KR_GRAPH_PATH,
  KR_VECTOR_PATH,
  KR_VECTOR_LANCE_PATH,
  SOURCE_INDEX_PATH,
  SOURCE_GRAPH_PATH,
  SOURCE_VECTOR_PATH,
];

export interface CompiledCollection {
  id: string;
  name: string;
  version: string;
  dkbs: Array<{
    id: string;
    name: string;
    version: string;
    adapter: string;
    records: number;
  }>;
  recordCount: number;
}

export interface CompiledComposeProject {
  registryId: string;
  recordCount: number;
  databasePath: string;
  krIndexPath: string;
  lockPath: string;
  lock: DkbLockManifest;
  cacheHit: boolean;
}

export interface CompileComposeProjectOptions {
  force?: boolean;
}

export interface VerifyComposeProjectResult {
  ok: boolean;
  lockPath: string;
  checks: Array<{
    name: string;
    ok: boolean;
    detail: string;
  }>;
}

interface CompileCacheManifest {
  version: typeof COMPILE_CACHE_VERSION;
  registryId: string;
  lockHash: string;
  sourceSnapshotHash: string;
  artifactSnapshotHash: string;
  sources: QuickStoreSnapshot[];
  artifacts: QuickPathSnapshot[];
  createdAt: string;
  platform: {
    os: NodeJS.Platform;
    node: string;
  };
}

interface QuickSourceSnapshot {
  cacheable: boolean;
  hash: string;
  sources: QuickStoreSnapshot[];
}

interface QuickArtifactSnapshot {
  hash: string;
  artifacts: QuickPathSnapshot[];
  requiredArtifactsReady: boolean;
}

interface QuickStoreSnapshot {
  dkbId: string;
  storeId: string;
  type: DkbStore['type'];
  path?: string;
  connectionRef?: string;
  cacheable: boolean;
  reason?: string;
  hash: string;
  entries: QuickPathSnapshot[];
}

interface QuickPathSnapshot {
  path: string;
  exists: boolean;
  type?: 'file' | 'directory';
  size?: number;
  mtimeMs?: number;
  entries?: Array<{
    path: string;
    size: number;
    mtimeMs: number;
  }>;
}

export async function compileCollection(collection: LoadedCollection): Promise<CompiledCollection> {
  const dkbs = await Promise.all(
    collection.dkbs.map(async (dkb) => {
      const adapter = await adapterFor(dkb.manifest.adapter);
      const records = await adapter.readRecords(dkb);

      return {
        id: dkb.manifest.id,
        name: dkb.manifest.name,
        version: dkb.manifest.version,
        adapter: dkb.manifest.adapter,
        records: records.length,
      };
    }),
  );

  return {
    id: collection.manifest.id,
    name: collection.manifest.name,
    version: collection.manifest.version,
    dkbs,
    recordCount: dkbs.reduce((total, dkb) => total + dkb.records, 0),
  };
}

export async function compileComposeProject(root: string, options: CompileComposeProjectOptions = {}): Promise<CompiledComposeProject> {
  const resolvedRoot = path.resolve(root);

  return withCompileLock(resolvedRoot, async () => {
    const registry = await loadCompose(resolvedRoot);
    const krIndexPath = resolveFrom(resolvedRoot, KR_INDEX_PATH);
    const lockPath = manifestPath(resolvedRoot, 'dkb-lock.json');
    const sourceSnapshot = await quickSourceSnapshotForRegistry(registry);
    const cached = options.force
      ? null
      : await cachedCompileResultFor(resolvedRoot, registry, sourceSnapshot, krIndexPath, lockPath);

    if (cached) {
      return cached;
    }

    const state = await collectRegistryState(registry);
    const allDkbs = uniqueDkbs([
      ...registry.collections.flatMap((collection) => collection.dkbs),
      ...registry.dkbs,
    ]);

    await writeSourceAnalysisArtifacts(resolvedRoot, registry.manifest.id, state.sourceAnalysis);
    await writeKrIndex(resolvedRoot, state.records);
    const vectorArtifacts = await writeVectorArtifacts(resolvedRoot, registry.manifest.id, state.records);
    await writeGraphArtifacts(resolvedRoot, allDkbs, state.records, vectorArtifacts.semanticNeighbors);

    const lock = await lockForState(resolvedRoot, registry, state, new Date().toISOString());

    await fs.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
    await writeCompileCache(resolvedRoot, registry, sourceSnapshot, lockPath);

    return {
      registryId: registry.manifest.id,
      recordCount: state.records.length,
      databasePath: krIndexPath,
      krIndexPath,
      lockPath,
      lock,
      cacheHit: false,
    };
  });
}

export async function verifyComposeProject(root: string): Promise<VerifyComposeProjectResult> {
  const resolvedRoot = path.resolve(root);
  const lockPath = manifestPath(resolvedRoot, 'dkb-lock.json');
  const registry = await loadCompose(resolvedRoot);
  const current = await collectRegistryState(registry);
  const lock = validateDkbLockManifest(parseLock(await fs.readFile(lockPath, 'utf8'), lockPath), lockPath);
  const expected = await lockForState(resolvedRoot, registry, current, lock.compiled?.compiledAt ?? new Date().toISOString());
  const checks = [
    {
      name: 'registry',
      ok: lock.registry.id === expected.registry.id,
      detail: `${lock.registry.id} expected ${expected.registry.id}`,
    },
    {
      name: 'packages',
      ok: stableHash(lock.packages) === stableHash(expected.packages),
      detail: 'package manifest, source, and KR hashes match lockfile',
    },
    {
      name: 'artifacts.krIndex',
      ok: sameArtifact(lock.artifacts.krIndex, expected.artifacts.krIndex),
      detail: `${lock.artifacts.krIndex.hash ?? 'null'} expected ${expected.artifacts.krIndex.hash ?? 'null'}`,
    },
    {
      name: 'artifacts.krGraph',
      ok: sameArtifact(lock.artifacts.krGraph, expected.artifacts.krGraph),
      detail: `${lock.artifacts.krGraph.hash ?? 'null'} expected ${expected.artifacts.krGraph.hash ?? 'null'}`,
    },
    {
      name: 'artifacts.krVector',
      ok: sameArtifact(lock.artifacts.krVector, expected.artifacts.krVector),
      detail: `${lock.artifacts.krVector.hash ?? 'null'} expected ${expected.artifacts.krVector.hash ?? 'null'}`,
    },
    {
      name: 'artifacts.sourceIndex',
      ok: lock.artifacts.sourceIndex !== undefined
        && expected.artifacts.sourceIndex !== undefined
        && sameArtifact(lock.artifacts.sourceIndex, expected.artifacts.sourceIndex),
      detail: `${lock.artifacts.sourceIndex?.hash ?? 'null'} expected ${expected.artifacts.sourceIndex?.hash ?? 'null'}`,
    },
  ];

  return {
    ok: checks.every((check) => check.ok),
    lockPath,
    checks,
  };
}

async function cachedCompileResultFor(
  root: string,
  registry: LoadedRegistry,
  sourceSnapshot: QuickSourceSnapshot,
  krIndexPath: string,
  lockPath: string,
): Promise<CompiledComposeProject | null> {
  if (!sourceSnapshot.cacheable) {
    return null;
  }

  const [lockSource, cache] = await Promise.all([
    maybeReadFile(lockPath),
    readCompileCache(root),
  ]);

  if (!lockSource || !cache || cache.version !== COMPILE_CACHE_VERSION || cache.registryId !== registry.manifest.id) {
    return null;
  }

  const lockHash = hashString(lockSource);

  if (cache.lockHash !== lockHash || cache.sourceSnapshotHash !== sourceSnapshot.hash) {
    return null;
  }

  const artifactSnapshot = await quickArtifactSnapshotFor(root);

  if (!artifactSnapshot.requiredArtifactsReady || cache.artifactSnapshotHash !== artifactSnapshot.hash) {
    return null;
  }

  const lock = validateDkbLockManifest(parseLock(lockSource, lockPath), lockPath);

  return {
    registryId: lock.registry.id,
    recordCount: lock.compiled?.recordCount ?? Object.values(lock.packages).reduce((total, item) => total + item.recordCount, 0),
    databasePath: krIndexPath,
    krIndexPath,
    lockPath,
    lock,
    cacheHit: true,
  };
}

async function readCompileCache(root: string): Promise<CompileCacheManifest | null> {
  const cachePath = resolveFrom(root, COMPILE_CACHE_PATH);

  try {
    const parsed = JSON.parse(await fs.readFile(cachePath, 'utf8')) as unknown;

    return isCompileCacheManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isCompileCacheManifest(value: unknown): value is CompileCacheManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<CompileCacheManifest>;

  return candidate.version === COMPILE_CACHE_VERSION
    && typeof candidate.registryId === 'string'
    && typeof candidate.lockHash === 'string'
    && typeof candidate.sourceSnapshotHash === 'string'
    && typeof candidate.artifactSnapshotHash === 'string'
    && Array.isArray(candidate.sources)
    && Array.isArray(candidate.artifacts);
}

async function writeCompileCache(
  root: string,
  registry: LoadedRegistry,
  sourceSnapshot: QuickSourceSnapshot,
  lockPath: string,
): Promise<void> {
  if (!sourceSnapshot.cacheable) {
    await fs.rm(resolveFrom(root, COMPILE_CACHE_PATH), { force: true });

    return;
  }

  const lockSource = await fs.readFile(lockPath, 'utf8');
  const artifactSnapshot = await quickArtifactSnapshotFor(root);
  const cache: CompileCacheManifest = {
    version: COMPILE_CACHE_VERSION,
    registryId: registry.manifest.id,
    lockHash: hashString(lockSource),
    sourceSnapshotHash: sourceSnapshot.hash,
    artifactSnapshotHash: artifactSnapshot.hash,
    sources: sourceSnapshot.sources,
    artifacts: artifactSnapshot.artifacts,
    createdAt: new Date().toISOString(),
    platform: {
      os: process.platform,
      node: process.version,
    },
  };

  const cachePath = resolveFrom(root, COMPILE_CACHE_PATH);

  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

async function quickSourceSnapshotForRegistry(registry: LoadedRegistry): Promise<QuickSourceSnapshot> {
  const dkbs = uniqueDkbs([
    ...registry.collections.flatMap((collection) => collection.dkbs),
    ...registry.dkbs,
  ]);
  const sources = (await Promise.all(dkbs.map((dkb) => quickStoreSnapshotsForDkb(dkb)))).flat()
    .sort((left, right) => left.dkbId.localeCompare(right.dkbId) || left.storeId.localeCompare(right.storeId));
  const cacheable = sources.every((source) => source.cacheable);
  const hash = stableHash({
    version: COMPILE_CACHE_VERSION,
    registry: registry.manifest,
    dkbs: dkbs.map((dkb) => ({
      id: dkb.manifest.id,
      manifestHash: dkb.manifestHash ?? stableHash(dkb.manifest),
      packagePath: dkb.packagePath ?? null,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    sources,
  });

  return {
    cacheable,
    hash,
    sources,
  };
}

async function quickStoreSnapshotsForDkb(dkb: LoadedDkb): Promise<QuickStoreSnapshot[]> {
  return Promise.all(storesForDkb(dkb).map(async (store) => quickStoreSnapshotFor(dkb, store)));
}

async function quickStoreSnapshotFor(dkb: LoadedDkb, store: DkbStore): Promise<QuickStoreSnapshot> {
  if (store.permissions?.read === false) {
    return quickNonPathStoreSnapshot(dkb, store, 'read_disabled');
  }

  if (!store.path) {
    return quickNonPathStoreSnapshot(dkb, store, 'store_has_no_local_path');
  }

  const absolutePath = resolveFrom(dkb.root, store.path);
  const relativePath = path.relative(dkb.root, absolutePath).replace(/\\/g, '/') || '.';
  const snapshot = await quickPathSnapshot(absolutePath, relativePath);
  const cacheable = snapshot.exists;

  return {
    dkbId: dkb.manifest.id,
    storeId: store.id,
    type: store.type,
    path: relativePath,
    connectionRef: store.connectionRef,
    cacheable,
    reason: cacheable ? undefined : 'local_path_missing',
    hash: stableHash({ store, snapshot }),
    entries: [snapshot],
  };
}

function quickNonPathStoreSnapshot(dkb: LoadedDkb, store: DkbStore, reason: string): QuickStoreSnapshot {
  return {
    dkbId: dkb.manifest.id,
    storeId: store.id,
    type: store.type,
    path: store.path,
    connectionRef: store.connectionRef,
    cacheable: reason === 'read_disabled',
    reason,
    hash: stableHash({ store, reason }),
    entries: [],
  };
}

async function quickArtifactSnapshotFor(root: string): Promise<QuickArtifactSnapshot> {
  const artifacts = await Promise.all(QUICK_ARTIFACT_PATHS.map(async (artifactPath) => quickPathSnapshot(resolveFrom(root, artifactPath), artifactPath)));
  const requiredArtifactsReady = artifacts
    .filter((artifact) => artifact.path !== KR_VECTOR_LANCE_PATH)
    .every((artifact) => artifact.exists);

  return {
    hash: stableHash({
      version: COMPILE_CACHE_VERSION,
      artifacts,
    }),
    artifacts,
    requiredArtifactsReady,
  };
}

async function quickPathSnapshot(target: string, relativePath: string): Promise<QuickPathSnapshot> {
  try {
    const stat = await fs.stat(target);

    if (stat.isFile()) {
      return {
        path: relativePath,
        exists: true,
        type: 'file',
        size: stat.size,
        mtimeMs: normalizeMtime(stat.mtimeMs),
      };
    }

    if (stat.isDirectory()) {
      return {
        path: relativePath,
        exists: true,
        type: 'directory',
        entries: await listFileSnapshots(target, target),
      };
    }

    return {
      path: relativePath,
      exists: false,
    };
  } catch {
    return {
      path: relativePath,
      exists: false,
    };
  }
}

async function listFileSnapshots(root: string, base: string): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const snapshots = await Promise.all(entries
    .filter((entry) => !isDkbSystemArtifact(entry.name))
    .map(async (entry) => {
      const target = path.join(root, entry.name);

      if (entry.isDirectory()) {
        return listFileSnapshots(target, base);
      }

      if (!entry.isFile()) {
        return [];
      }

      const stat = await fs.stat(target);

      return [{
        path: path.relative(base, target).replace(/\\/g, '/'),
        size: stat.size,
        mtimeMs: normalizeMtime(stat.mtimeMs),
      }];
    }));

  return snapshots.flat().sort((left, right) => left.path.localeCompare(right.path));
}

function storesForDkb(dkb: LoadedDkb): DkbStore[] {
  return dkb.manifest.stores ?? [{
    id: dkb.manifest.adapter,
    type: dkb.manifest.adapter === 'folder' ? 'filesystem' as const : 'sqlite' as const,
    path: dkb.manifest.entrypoint,
  }];
}

function normalizeMtime(value: number): number {
  return Math.trunc(value);
}

async function maybeReadFile(target: string): Promise<string | null> {
  try {
    return await fs.readFile(target, 'utf8');
  } catch {
    return null;
  }
}

function hashString(value: string): string {
  const hash = createHash('sha256');

  hash.update(value);

  return `sha256:${hash.digest('hex')}`;
}

async function collectRegistryState(registry: LoadedRegistry): Promise<{
  records: IndexedKnowledgeRegion[];
  packages: DkbLockManifest['packages'];
  krRepositoryHash: string;
  sourceAnalysis: ReturnType<typeof analyzeSourceUnits>;
}> {
  const allDkbs = uniqueDkbs([
    ...registry.collections.flatMap((collection) => collection.dkbs),
    ...registry.dkbs,
  ]);
  const packageEntries = await Promise.all(allDkbs.map(async (dkb) => collectDkbState(dkb)));
  const records = packageEntries.flatMap((entry) => entry.records);
  const packages = Object.fromEntries(packageEntries.map((entry) => [entry.package.id, entry.package]));
  const sourceAnalysis = {
    sourceUnits: packageEntries.flatMap((entry) => entry.sourceAnalysis.sourceUnits),
    sourceEdges: packageEntries.flatMap((entry) => entry.sourceAnalysis.sourceEdges),
    records,
  };

  return {
    records,
    packages,
    krRepositoryHash: stableHash(records.map((record) => recordForHash(record))),
    sourceAnalysis,
  };
}

async function collectDkbState(dkb: LoadedDkb): Promise<{
  package: DkbLockManifest['packages'][string];
  records: IndexedKnowledgeRegion[];
  sourceAnalysis: ReturnType<typeof analyzeSourceUnits>;
}> {
  const rawSourceUnits = await buildSourceUnitsForDkb(dkb);
  const sourceAnalysis = analyzeSourceUnits(rawSourceUnits);
  const records = sourceAnalysis.records;
  const sourceUnitsByStore = countSourceUnitsByStore(sourceAnalysis.sourceUnits);
  const stores = await Promise.all(storesForDkb(dkb).map(async (store) => {
    const storePath = store.path ? resolveFrom(dkb.root, store.path) : null;

    return {
      id: store.id,
      type: store.type,
      path: storePath ? path.relative(dkb.root, storePath).replace(/\\/g, '/') || '.' : undefined,
      connectionRef: store.connectionRef,
      hash: storePath ? await hashStore(storePath) : stableHash({ connectionRef: store.connectionRef, type: store.type }),
      recordCount: sourceUnitsByStore.get(store.id) ?? 0,
    };
  }));

  return {
    package: {
      id: dkb.manifest.id,
      name: dkb.manifest.name,
      version: dkb.manifest.version,
      path: dkb.packagePath ? path.relative(process.cwd(), dkb.packagePath).replace(/\\/g, '/') : null,
      manifestHash: dkb.manifestHash ?? stableHash(dkb.manifest),
      sourceInventoryHash: stableHash(stores),
      krRepositoryHash: stableHash(records.map((record) => recordForHash(record))),
      recordCount: records.length,
      stores,
    },
    records,
    sourceAnalysis,
  };
}

async function buildSourceUnitsForDkb(dkb: LoadedDkb): Promise<IndexedSourceUnit[]> {
  const batches = await Promise.all(storesForDkb(dkb).map((store) => buildSourceUnitsForStore(dkb, store)));

  return batches.flat().sort((a, b) => a.id.localeCompare(b.id));
}

async function buildSourceUnitsForStore(dkb: LoadedDkb, store: DkbStore): Promise<IndexedSourceUnit[]> {
  if (store.permissions?.read === false) {
    return [];
  }

  const adapter = await adapterForStore(store.type);

  if (canCompileSourceUnits(adapter)) {
    return adapter.compileSourceUnits({ dkb, store });
  }

  if (!canCompileRegions(adapter)) {
    throw new DkbError(`Store type ${store.type} does not support source unit compilation`);
  }

  const regions = await adapter.compileRegions({ dkb, store });

  return regions.flatMap(sourceUnitsFromKnowledgeRegion);
}

function countSourceUnitsByStore(units: IndexedSourceUnit[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const unit of units) {
    counts.set(unit.storeId, (counts.get(unit.storeId) ?? 0) + 1);
  }

  return counts;
}

async function lockForState(root: string, registry: LoadedRegistry, state: Awaited<ReturnType<typeof collectRegistryState>>, compiledAt: string): Promise<DkbLockManifest> {
  const krIndexHash = await maybeHashFile(resolveFrom(root, KR_INDEX_PATH));
  const krGraphHash = await maybeHashFile(resolveFrom(root, KR_GRAPH_PATH));
  const krVectorHash = await maybeHashArtifact(resolveFrom(root, KR_VECTOR_PATH));
  const sourceIndexHash = await maybeHashFile(resolveFrom(root, SOURCE_INDEX_PATH));

  return {
    registry: {
      id: registry.manifest.id,
      name: registry.manifest.name,
      version: registry.manifest.version,
    },
    packages: state.packages,
    artifacts: {
      krIndex: artifact(KR_INDEX_PATH, krIndexHash),
      krGraph: artifact(KR_GRAPH_PATH, krGraphHash),
      krVector: artifact(KR_VECTOR_PATH, krVectorHash),
      sourceIndex: artifact(SOURCE_INDEX_PATH, sourceIndexHash),
    },
    compiled: {
      path: KR_INDEX_PATH,
      artifactHash: krIndexHash,
      krRepositoryHash: state.krRepositoryHash,
      indexHash: stableHash({ krIndexHash, krGraphHash, krVectorHash, sourceIndexHash }),
      recordCount: state.records.length,
      compiledAt,
    },
  };
}

async function withCompileLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const lock = await acquireCompileLock(root);

  try {
    return await fn();
  } finally {
    await releaseCompileLock(lock);
  }
}

async function acquireCompileLock(root: string): Promise<{ path: string; token: string }> {
  const lockPath = resolveFrom(root, COMPILE_LOCK_PATH);
  const token = stableHash({
    pid: process.pid,
    host: os.hostname(),
    root,
    startedAt: new Date().toISOString(),
    random: Math.random(),
  });
  const started = Date.now();

  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      await fs.mkdir(lockPath);
      await fs.writeFile(path.join(lockPath, 'owner.json'), `${JSON.stringify({
        token,
        pid: process.pid,
        host: os.hostname(),
        createdAt: new Date().toISOString(),
      }, null, 2)}\n`, 'utf8');

      return { path: lockPath, token };
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : '';

      if (code !== 'EEXIST') {
        throw error;
      }

      if (await removeStaleCompileLock(lockPath)) {
        continue;
      }

      if (Date.now() - started >= COMPILE_LOCK_TIMEOUT_MS) {
        throw new DkbError(`Timed out waiting for compile lock at ${lockPath}`);
      }

      await delay(COMPILE_LOCK_RETRY_MS);
    }
  }
}

async function removeStaleCompileLock(lockPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(lockPath);

    if (Date.now() - stat.mtimeMs < COMPILE_LOCK_STALE_MS) {
      return false;
    }

    await fs.rm(lockPath, { recursive: true, force: true });

    return true;
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : '';

    if (code === 'ENOENT') {
      return true;
    }

    throw error;
  }
}

async function releaseCompileLock(lock: { path: string; token: string }): Promise<void> {
  try {
    const owner = JSON.parse(await fs.readFile(path.join(lock.path, 'owner.json'), 'utf8')) as { token?: unknown };

    if (owner.token !== lock.token) {
      return;
    }
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : '';

    if (code !== 'ENOENT') {
      throw error;
    }
  }

  await fs.rm(lock.path, { recursive: true, force: true });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function hashStore(storePath: string): Promise<string> {
  const stats = await fs.stat(storePath);

  if (stats.isFile()) {
    return hashFile(storePath);
  }

  if (!stats.isDirectory()) {
    throw new DkbError(`Unsupported store path for hashing: ${storePath}`);
  }

  const entries = await listFiles(storePath);
  const hashed = await Promise.all(entries.map(async (file) => ({
    path: path.relative(storePath, file).replace(/\\/g, '/'),
    hash: await hashFile(file),
  })));

  return stableHash(hashed);
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries
    .filter((entry) => !isDkbSystemArtifact(entry.name))
    .map(async (entry) => {
    const target = path.join(root, entry.name);

    if (entry.isDirectory()) {
      return listFiles(target);
    }

    return entry.isFile() ? [target] : [];
  }));

  return nested.flat().sort((a, b) => a.localeCompare(b));
}

function isDkbSystemArtifact(name: string): boolean {
  return name === '.dkb' || name === 'dkb-lock.json' || name === 'dkb-release.json' || name === '.dkb-package.json';
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');

  hash.update(await fs.readFile(file));

  return `sha256:${hash.digest('hex')}`;
}

async function maybeHashFile(file: string): Promise<string | null> {
  try {
    return await hashFile(file);
  } catch {
    return null;
  }
}

async function maybeHashArtifact(target: string): Promise<string | null> {
  try {
    const stats = await fs.stat(target);

    if (stats.isDirectory()) {
      return await hashStore(target);
    }

    return await hashFile(target);
  } catch {
    return null;
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

function parseLock(source: string, lockPath: string): unknown {
  try {
    return JSON.parse(source);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    throw new DkbError(`Unable to read lockfile at ${lockPath}: ${reason}`);
  }
}

function artifact(pathValue: string, hash: string | null): DkbLockArtifact {
  return {
    path: pathValue,
    hash,
    status: hash ? 'built' : 'not_built',
  };
}

function sameArtifact(left: DkbLockArtifact, right: DkbLockArtifact): boolean {
  return left.path === right.path && left.hash === right.hash && left.status === right.status;
}
