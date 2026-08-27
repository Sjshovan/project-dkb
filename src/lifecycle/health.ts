import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { COMPILE_CACHE_PATH, compileComposeProject, verifyComposeProject } from '@dkb/compiler/compile.js';
import { SOURCE_GRAPH_PATH, SOURCE_INDEX_PATH, SOURCE_VECTOR_PATH } from '@dkb/providers-bundled/sourceIndex.js';
import { invalidateQueryContext } from '../indexes/queryContext.js';
import { loadCollection, loadDkb, loadLibrary, loadManifest, uniqueLoadedDkbs } from '@dkb/protocol/manifest.js';
import { DKB_ARTIFACT_LOCK_PATH, resolveFrom } from '@dkb/protocol/paths.js';
import { deriveKnowledgeSpace } from '@dkb/protocol/space.js';
import type { DkbManifest, DkbSourceManifest, DkbStore, DkcManifest, DkrManifest, LoadedDkb } from '@dkb/protocol/types.js';
import { defaultWriteQueueRoot, listQueuedWrites } from '../writes/queue.js';

export interface DkbHealthReport {
  status: 'ready' | 'degraded' | 'unavailable';
  root: string;
  type: string;
  space: ReturnType<typeof deriveKnowledgeSpace>;
  checks: Array<{
    name: string;
    ok: boolean;
    status: 'ready' | 'degraded' | 'unavailable';
    detail: string;
  }>;
  artifacts: Array<{
    path: string;
    exists: boolean;
    type: 'file' | 'directory' | null;
    size: number | null;
  }>;
  queue: {
    root: string;
    pending: number;
    blocked: number;
    failed: number;
    committed: number;
  };
}

export interface RestoreIndexesResult {
  status: 'restored';
  root: string;
  registryId: string;
  recordCount: number;
  cacheInvalidated: number;
  durationMs: number;
  lockPath: string;
}

const ARTIFACTS = [
  SOURCE_INDEX_PATH,
  SOURCE_GRAPH_PATH,
  SOURCE_VECTOR_PATH,
  DKB_ARTIFACT_LOCK_PATH,
  COMPILE_CACHE_PATH,
];

export async function healthReport(root: string, queueRoot?: string): Promise<DkbHealthReport> {
  const resolvedRoot = path.resolve(root);
  const checks: DkbHealthReport['checks'] = [];
  const sourceManifest = await loadManifest(resolvedRoot);
  let manifest: HealthManifest;
  let dkbs: LoadedDkb[];

  if (sourceManifest.type === 'library') {
    const library = await loadLibrary(resolvedRoot);
    manifest = library.manifest;
    dkbs = uniqueLoadedDkbs([
      ...library.collections.flatMap((collection) => collection.dkbs),
      ...library.dkbs,
    ]);
  } else if (sourceManifest.type === 'collection') {
    const collection = await loadCollection(resolvedRoot);
    manifest = collection.manifest;
    dkbs = collection.dkbs;
  } else {
    const dkb = await loadDkb(resolvedRoot);
    manifest = dkb.manifest;
    dkbs = [dkb];
  }

  const type = sourceManifest.type;
  const effectiveId = idFor(manifest);
  const space = deriveKnowledgeSpace({
    owner: 'owner' in manifest ? manifest.owner : undefined,
    namespace: manifest.namespace,
    appId: manifest.appId,
    registryId: effectiveId,
  });

  checks.push({
    name: 'manifest',
    ok: true,
    status: 'ready',
    detail: `${type}:${effectiveId}`,
  });

  const artifacts = await Promise.all(ARTIFACTS.map((artifact) => artifactStatus(resolvedRoot, artifact)));
  const lockExists = artifacts.find((artifact) => artifact.path === DKB_ARTIFACT_LOCK_PATH)?.exists ?? false;

  checks.push(...await sourceChecks(dkbs));

  if (lockExists) {
    const verification = await verifyComposeProject(resolvedRoot);

    checks.push({
      name: 'verify',
      ok: verification.ok,
      status: verification.ok ? 'ready' : 'degraded',
      detail: verification.ok ? 'lockfile and artifacts verify' : 'lockfile or generated artifacts are stale',
    });
  } else {
    checks.push({
      name: 'verify',
      ok: false,
      status: 'degraded',
      detail: 'compiled artifact lock is missing; run dkb restore or dkb compile',
    });
  }

  const queue = await queueSummary(resolvedRoot, queueRoot);

  return {
    status: summarizeStatus(checks),
    root: resolvedRoot,
    type,
    space,
    checks,
    artifacts,
    queue,
  };
}

export async function restoreIndexes(root: string): Promise<RestoreIndexesResult> {
  const resolvedRoot = path.resolve(root);
  const started = performance.now();
  const compiled = await compileComposeProject(resolvedRoot, { force: true });
  const cacheInvalidated = invalidateQueryContext(resolvedRoot);

  return {
    status: 'restored',
    root: resolvedRoot,
    registryId: compiled.registryId,
    recordCount: compiled.recordCount,
    cacheInvalidated,
    durationMs: Math.round((performance.now() - started) * 1000) / 1000,
    lockPath: compiled.lockPath,
  };
}

async function sourceChecks(dkbs: LoadedDkb[]): Promise<DkbHealthReport['checks']> {
  const checks = await Promise.all(uniqueLoadedDkbs(dkbs).flatMap((dkb) => storesFor(dkb).map(async (store) => {
    const status = await storeStatus(dkb.root, store);

    return {
      name: `source:${dkb.manifest.id}/${store.id}`,
      ok: status.ok,
      status: status.ok ? 'ready' as const : 'unavailable' as const,
      detail: status.detail,
    };
  })));

  return checks;
}

async function storeStatus(dkbRoot: string, store: DkbStore): Promise<{ ok: boolean; detail: string }> {
  if (store.permissions?.read === false) {
    return { ok: true, detail: 'read disabled' };
  }

  if (store.path) {
    const target = resolveFrom(dkbRoot, store.path);

    try {
      await fs.access(target);

      return { ok: true, detail: target };
    } catch {
      return { ok: false, detail: `missing local source: ${target}` };
    }
  }

  if (store.connectionRef?.startsWith('env:')) {
    const envName = store.connectionRef.slice(4);

    return process.env[envName]
      ? { ok: true, detail: `${store.connectionRef} is set` }
      : { ok: false, detail: `${store.connectionRef} is not set` };
  }

  return { ok: false, detail: 'store has no path or connectionRef' };
}

function storesFor(dkb: LoadedDkb): DkbStore[] {
  return dkb.manifest.stores ?? [{
    id: dkb.manifest.adapter,
    type: dkb.manifest.adapter === 'folder' ? 'filesystem' : dkb.manifest.adapter === 'postgres' ? 'postgres' : 'sqlite',
    path: dkb.manifest.entrypoint,
  }];
}

async function artifactStatus(root: string, artifact: string): Promise<DkbHealthReport['artifacts'][number]> {
  const target = resolveFrom(root, artifact);

  try {
    const stat = await fs.stat(target);

    return {
      path: artifact,
      exists: true,
      type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : null,
      size: stat.isDirectory() ? null : stat.size,
    };
  } catch {
    return {
      path: artifact,
      exists: false,
      type: null,
      size: null,
    };
  }
}

async function queueSummary(registryRoot: string, queueRoot?: string): Promise<DkbHealthReport['queue']> {
  const root = path.resolve(queueRoot ?? defaultWriteQueueRoot(registryRoot));
  const writes = await listQueuedWrites(root);

  return {
    root,
    pending: writes.filter((write) => write.status === 'pending').length,
    blocked: writes.filter((write) => write.status === 'blocked').length,
    failed: writes.filter((write) => write.status === 'failed').length,
    committed: writes.filter((write) => write.status === 'committed').length,
  };
}

function summarizeStatus(checks: DkbHealthReport['checks']): DkbHealthReport['status'] {
  if (checks.some((check) => check.status === 'unavailable')) {
    return 'unavailable';
  }

  if (checks.some((check) => !check.ok)) {
    return 'degraded';
  }

  return 'ready';
}

type HealthManifest = DkbManifest | DkbSourceManifest | DkcManifest | DkrManifest;

function idFor(manifest: HealthManifest): string {
  return 'id' in manifest ? manifest.id : safeId(manifest.name);
}

function safeId(value: string): string {
  const id = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

  return id || 'dkb';
}
