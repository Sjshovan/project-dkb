import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import {
  DKB_CACHE_DIR,
  DKB_EVIDENCE_BUILDS_DIR,
  DKB_RETRIEVAL_BUILDS_DIR,
  DKB_RUNTIME_LOCK_PATH,
  resolveFrom,
} from '@sjshovan/dkb-protocol/paths.js';
import type { DkbStore, LoadedDkb, LoadedLibrary } from '@sjshovan/dkb-protocol/types.js';
import type { DkbSourceStatistics } from './buildStatistics.js';
import {
  includedSourcePathsForStore,
  isDkbSystemArtifact,
  uniqueDkbs,
} from './sourceHashing.js';

export const COMPILE_CACHE_PATH = `${DKB_CACHE_DIR}/compile-cache.json`;
export const COMPILE_CACHE_VERSION = 1;

const QUICK_ARTIFACT_PATHS = [
  DKB_RUNTIME_LOCK_PATH,
  DKB_EVIDENCE_BUILDS_DIR,
  DKB_RETRIEVAL_BUILDS_DIR,
];

export interface CompileCacheManifest {
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

export interface QuickSourceSnapshot {
  cacheable: boolean;
  hash: string;
  sources: QuickStoreSnapshot[];
}

export interface QuickArtifactSnapshot {
  hash: string;
  artifacts: QuickPathSnapshot[];
  requiredArtifactsReady: boolean;
}

export interface QuickStoreSnapshot {
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

export interface QuickPathSnapshot {
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

export async function readCompileCache(root: string): Promise<CompileCacheManifest | null> {
  const cachePath = resolveFrom(root, COMPILE_CACHE_PATH);

  try {
    const parsed = JSON.parse(await fs.readFile(cachePath, 'utf8')) as unknown;

    return isCompileCacheManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeCompileCache(
  root: string,
  registry: LoadedLibrary,
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

export async function quickSourceSnapshotForRegistry(registry: LoadedLibrary): Promise<QuickSourceSnapshot> {
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

export function sourceStatisticsForSnapshot(snapshot: QuickSourceSnapshot): DkbSourceStatistics {
  return sourceStatisticsForStores(snapshot.sources);
}

export function sourceStatisticsForStores(sources: readonly QuickStoreSnapshot[]): DkbSourceStatistics {
  let files = 0;
  let bytes = 0;

  for (const source of sources) {
    for (const entry of source.entries) {
      if (entry.type === 'file' && typeof entry.size === 'number') {
        files += 1;
        bytes += entry.size;
      }
      for (const file of entry.entries ?? []) {
        files += 1;
        bytes += file.size;
      }
    }
  }

  return { files, bytes };
}

export async function quickArtifactSnapshotFor(root: string): Promise<QuickArtifactSnapshot> {
  const artifacts = await Promise.all(QUICK_ARTIFACT_PATHS.map(async (artifactPath) => {
    return quickPathSnapshot(resolveFrom(root, artifactPath), artifactPath);
  }));
  const requiredArtifactsReady = artifacts.every((artifact) => artifact.exists);

  return {
    hash: stableHash({ version: COMPILE_CACHE_VERSION, artifacts }),
    artifacts,
    requiredArtifactsReady,
  };
}

export async function maybeReadFile(target: string): Promise<string | null> {
  try {
    return await fs.readFile(target, 'utf8');
  } catch {
    return null;
  }
}

export function hashString(value: string): string {
  const hash = createHash('sha256');

  hash.update(value);

  return `sha256:${hash.digest('hex')}`;
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

export async function quickStoreSnapshotsForDkb(dkb: LoadedDkb): Promise<QuickStoreSnapshot[]> {
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
  const includedPaths = includedSourcePathsForStore(store);

  if (includedPaths) {
    const entries = await Promise.all(includedPaths.map((item) => quickPathSnapshot(resolveFrom(dkb.root, item), item)));
    const cacheable = entries.every((entry) => entry.exists);

    return {
      dkbId: dkb.manifest.id,
      storeId: store.id,
      type: store.type,
      path: relativePath,
      connectionRef: store.connectionRef,
      cacheable,
      reason: cacheable ? undefined : 'included_local_source_missing',
      hash: stableHash({ store, entries }),
      entries,
    };
  }

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

    return { path: relativePath, exists: false };
  } catch {
    return { path: relativePath, exists: false };
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

export function storesForDkb(dkb: LoadedDkb): DkbStore[] {
  return dkb.manifest.stores ?? [{
    id: dkb.manifest.adapter,
    type: dkb.manifest.adapter === 'folder' ? 'filesystem' as const : 'sqlite' as const,
    path: dkb.manifest.entrypoint,
  }];
}

function normalizeMtime(value: number): number {
  return Math.trunc(value);
}
