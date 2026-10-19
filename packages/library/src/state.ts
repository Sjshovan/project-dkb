import fs from 'node:fs/promises';
import path from 'node:path';
import { readStateStore } from './stateStore.js';
import { assertLibraryReadFence, captureLibraryReadFence, pendingLibraryLock, stageLibraryLock, withLibraryMutation } from './mutation.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { loadLibraryManifest } from '@sjshovan/dkb-protocol/manifest.js';
import { resolveContainedPath } from '@sjshovan/dkb-protocol/paths.js';
import { validateDkbLibraryLockManifest } from '@sjshovan/dkb-protocol/validation.js';
import type { DkbEntryStatus, DkbLibraryLockEntry, DkbLibraryLockManifest } from '@sjshovan/dkb-protocol/types.js';

export const DKB_LIBRARY_LOCK_FILENAME = 'dkb-lock.json';
export const DKB_LIBRARY_STATE_PATH = '.dkb/state.sqlite';

export interface DkbLibraryStateEntry extends DkbLibraryLockEntry {
  status: DkbEntryStatus;
  generation: number;
}

export interface DkbLibraryStateSnapshot {
  generation: number;
  entries: Record<string, DkbLibraryStateEntry>;
}

export interface DkbLibraryStateIdentity {
  id: string;
  generation: number;
  stateDigest: string;
}

export function libraryLockPath(libraryRoot: string): string {
  return path.join(path.resolve(libraryRoot), DKB_LIBRARY_LOCK_FILENAME);
}

export function libraryStatePath(libraryRoot: string): string {
  return path.join(path.resolve(libraryRoot), ...DKB_LIBRARY_STATE_PATH.split('/'));
}

export async function maybeReadLibraryLock(libraryRoot: string): Promise<DkbLibraryLockManifest | null> {
  const pending = pendingLibraryLock(libraryRoot);
  if (pending) return pending.lock;
  const fence = await captureLibraryReadFence(libraryRoot);
  const source = libraryLockPath(libraryRoot);

  try {
    const lock = validateDkbLibraryLockManifest(JSON.parse(await fs.readFile(source, 'utf8')) as unknown, source);
    await assertLibraryReadFence(libraryRoot, fence);
    return lock;
  } catch (error) {
    await assertLibraryReadFence(libraryRoot, fence);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;

    // A compiler artifact lock from before the hard cutover is not a Library
    // lock. Callers can still rebuild it, but must not infer installation state
    // from its package map.
    const value = await maybeReadJson(source);
    await assertLibraryReadFence(libraryRoot, fence);
    if (isRecord(value) && 'artifacts' in value && 'packages' in value) return null;
    throw error;
  }
}

export async function readLibraryState(libraryRoot: string): Promise<DkbLibraryStateSnapshot> {
  const root = path.resolve(libraryRoot);
  const pending = pendingLibraryLock(root);
  if (pending) return snapshotFromLock(root, pending.lock);
  const { generation, rows, fence } = await readStateStore(root);
  try {
    const entries: Record<string, DkbLibraryStateEntry> = {};
    for (const row of rows) {
      if (row.generation !== generation || !['installed', 'broken'].includes(row.status)) throw new DkbError('Invalid applied entry generation or status.');
      entries[row.identity] = {
        identity: row.identity, kind: row.kind, source: row.source,
        ...(row.version !== null ? { version: row.version } : {}),
        ...(row.revision !== null ? { revision: row.revision } : {}),
        ...(row.digest !== null ? { digest: row.digest } : {}),
        path: row.path, ...(row.registry_url !== null ? { registryUrl: row.registry_url } : {}),
        requiredBy: parseRequiredBy(row.required_by, row.identity), installedAt: row.installed_at,
        status: row.status, generation: row.generation,
      };
    }
    if (rows.length || generation > 0) validateDkbLibraryLockManifest({
      library: { name: 'Applied state validation' }, generation,
      entries: Object.fromEntries(Object.entries(entries).map(([key, { status, generation: entryGeneration, ...entry }]) => [key, entry])),
      resolvedAt: new Date().toISOString(),
    }, 'Applied Library state');
    if (rows.length || generation > 0) {
      const lock = validateDkbLibraryLockManifest(JSON.parse(await fs.readFile(libraryLockPath(root), 'utf8')), 'Resolved Library state');
      const normalized = (value: DkbLibraryLockEntry) => ({ ...value, path: value.path.replace(/\\/gu, '/'), requiredBy: [...value.requiredBy].sort() });
      const applied = Object.fromEntries(Object.entries(entries).map(([key, { status, generation: entryGeneration, ...entry }]) => [key, normalized(entry)]));
      const resolved = Object.fromEntries(Object.entries(lock.entries).map(([key, entry]) => [key, normalized(entry)]));
      if (lock.generation !== generation || stableHash(applied) !== stableHash(resolved)) {
        throw new DkbError(`Resolved Library lock differs from applied state. Run dkb library recover --library "${root}".`, 'library_recovery_required');
      }
    }
    for (const entry of Object.values(entries)) {
      const target = resolveContainedPath(root, entry.path, `Installed entry ${entry.identity} path`);
      if (!(await exists(path.join(target, 'dkb.json')))) entry.status = 'broken';
    }
    await assertLibraryReadFence(root, fence);
    return { generation, entries };
  } catch (error) {
    await assertLibraryReadFence(root, fence);
    throw error;
  }
}

async function snapshotFromLock(root: string, lock: DkbLibraryLockManifest | null): Promise<DkbLibraryStateSnapshot> {
  if (!lock) return { generation: 0, entries: {} };
  const entries: Record<string, DkbLibraryStateEntry> = {};
  for (const [identity, entry] of Object.entries(lock.entries)) {
    const target = resolveContainedPath(root, entry.path, `Installed entry ${identity} path`);
    entries[identity] = { ...entry, generation: lock.generation, status: await exists(path.join(target, 'dkb.json')) ? 'installed' : 'broken' };
  }
  return { generation: lock.generation, entries };
}

export async function libraryStateIdentity(libraryRoot: string): Promise<DkbLibraryStateIdentity> {
  const root = path.resolve(libraryRoot);
  const fence = await captureLibraryReadFence(root);
  // Identity belongs to the canonical root manifest and applied ledger, not a
  // fresh traversal of editable source folders. Activation validates the full
  // package graph; query contexts separately fence its exact immutable inputs.
  const reads = await Promise.allSettled([loadLibraryManifest(root), readLibraryState(root)]);
  await assertLibraryReadFence(root, fence);
  if (reads[0].status === 'rejected') throw reads[0].reason;
  if (reads[1].status === 'rejected') throw reads[1].reason;
  const library = reads[0].value, state = reads[1].value;
  const entries = Object.fromEntries(Object.entries(state.entries)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([identity, entry]) => [identity, {
      identity: entry.identity,
      kind: entry.kind,
      source: entry.source,
      version: entry.version ?? null,
      revision: entry.revision ?? null,
      digest: entry.digest ?? null,
      path: entry.path.replace(/\\/gu, '/'),
      registryUrl: entry.registryUrl ?? null,
      requiredBy: [...entry.requiredBy].sort(),
      status: entry.status,
      generation: entry.generation,
    }]));

  await assertLibraryReadFence(root, fence);
  return {
    id: library.id,
    generation: state.generation,
    stateDigest: stableHash({
      libraryId: library.id,
      generation: state.generation,
      entries,
    }),
  };
}

export async function applyLibraryLock(libraryRoot: string, input: DkbLibraryLockManifest): Promise<DkbLibraryStateSnapshot> {
  const root = path.resolve(libraryRoot);
  return withLibraryMutation(root, async () => {
    const lock = validateDkbLibraryLockManifest(input, `${libraryLockPath(root)}#candidate`);
    await assertLockPaths(root, lock);
    stageLibraryLock(root, lock);
    return readLibraryState(root);
  });
}

export async function assertLibraryStateConsistent(libraryRoot: string): Promise<void> {
  const lock = await maybeReadLibraryLock(libraryRoot);
  const state = await readLibraryState(libraryRoot);

  if (!lock) {
    if (Object.keys(state.entries).length > 0) {
      throw new DkbError('Library state exists without a valid dkb-lock.json; run dkb library repair');
    }
    return;
  }

  if (lock.generation !== state.generation) {
    throw new DkbError(`Library state generation mismatch: lock=${lock.generation}, state=${state.generation}`);
  }

  const lockIdentities = Object.keys(lock.entries).sort();
  const stateIdentities = Object.keys(state.entries).sort();
  if (JSON.stringify(lockIdentities) !== JSON.stringify(stateIdentities)) {
    throw new DkbError('Library lock and applied-state ledger contain different entries');
  }

  for (const [identity, entry] of Object.entries(lock.entries)) {
    const { status, generation, ...applied } = state.entries[identity]!;
    if (stableHash(entry) !== stableHash(applied)) throw new DkbError(`Library lock differs from applied state for ${identity}.`);
  }
  const broken = Object.values(state.entries).filter((entry) => entry.status === 'broken');
  if (broken.length > 0) {
    throw new DkbError(`Library has missing installed content: ${broken.map((entry) => entry.identity).join(', ')}`);
  }
}

async function assertLockPaths(root: string, lock: DkbLibraryLockManifest): Promise<void> {
  for (const entry of Object.values(lock.entries)) {
    const target = resolveContainedPath(root, entry.path, `Installed entry ${entry.identity} path`);
    if (!(await exists(path.join(target, 'dkb.json')))) {
      throw new DkbError(`Cannot activate ${entry.identity}; manifest is missing at ${target}`);
    }
  }
}

function parseRequiredBy(value: string, identity: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed;
  } catch {
    // Report a deterministic corruption error below.
  }
  throw new DkbError(`Invalid requiredBy state for ${identity}`);
}

async function maybeReadJson(source: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(source, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
