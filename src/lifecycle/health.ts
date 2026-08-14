import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { COMPILE_CACHE_PATH, compileComposeProject, verifyComposeProject } from '../compiler/compile.js';
import { KR_GRAPH_PATH, KR_INDEX_PATH, KR_VECTOR_LANCE_PATH, KR_VECTOR_PATH } from '../indexes/knowledgeIndex.js';
import { invalidateQueryContext } from '../indexes/queryContext.js';
import { loadManifest, loadRegistry } from '../protocol/manifest.js';
import { manifestPath, resolveFrom } from '../protocol/paths.js';
import { deriveKnowledgeSpace } from '../protocol/space.js';
import type { DkbSourceManifest, DkbStore, DkrManifest, LoadedDkb } from '../protocol/types.js';
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
  KR_INDEX_PATH,
  KR_GRAPH_PATH,
  KR_VECTOR_PATH,
  KR_VECTOR_LANCE_PATH,
  'dkb-lock.json',
  COMPILE_CACHE_PATH,
];

export async function healthReport(root: string, queueRoot?: string): Promise<DkbHealthReport> {
  const resolvedRoot = path.resolve(root);
  const checks: DkbHealthReport['checks'] = [];
  const type = await exists(manifestPath(resolvedRoot, 'dkb.json')) ? 'dkb' : 'dkr';
  const registry = await loadRegistry(resolvedRoot);
  const manifest = registry?.manifest ?? await loadManifest(resolvedRoot);
  const effectiveId = registry?.manifest.id ?? idFor(manifest);
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
  const lockExists = artifacts.find((artifact) => artifact.path === 'dkb-lock.json')?.exists ?? false;

  if (registry) {
    const composeDkbs = registry
      ? [...registry.collections.flatMap((collection) => collection.dkbs), ...registry.dkbs]
      : [];

    checks.push(...await sourceChecks(composeDkbs));

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
        detail: 'dkb-lock.json is missing; run dkb restore or dkb compile',
      });
    }
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
  const unique = uniqueDkbs(dkbs);
  const checks = await Promise.all(unique.flatMap((dkb) => storesFor(dkb).map(async (store) => {
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
  const target = artifact === 'dkb-lock.json' ? manifestPath(root, artifact) : resolveFrom(root, artifact);

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

type HealthManifest = DkbSourceManifest | DkrManifest;

function idFor(manifest: HealthManifest): string {
  return 'id' in manifest ? manifest.id : safeId(manifest.name);
}

function safeId(value: string): string {
  const id = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

  return id || 'dkb';
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
