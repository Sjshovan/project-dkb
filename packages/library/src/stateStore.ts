import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DkbEntryStatus, DkbLibraryLockEntry, DkbLibraryLockManifest } from '@sjshovan/dkb-protocol/types.js';
import { assertDkbFileLock, previousDkbFileLockPath, previousDkbLockError } from './locks.js';
import { assertLocalLibraryStorage } from './storageAccess.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';

export function statePath(root: string): string { return path.join(root, '.dkb', 'state.sqlite'); }

export interface StateRow {
  identity: string; kind: DkbLibraryLockEntry['kind']; source: DkbLibraryLockEntry['source'];
  version: string | null; revision: number | null; digest: string | null; path: string;
  registry_url: string | null; required_by: string; installed_at: string; status: DkbEntryStatus; generation: number;
}
interface StateSnapshot {
  readonly generation: number; readonly fence: string; readonly rows: readonly Readonly<StateRow>[];
}
interface ReadPhase {
  accepting: boolean;
  views: Map<string, { root: string; value: Promise<StateSnapshot> }>;
  poisoned: Map<string, string>;
  poisonChecks: Set<Promise<never>>;
}
interface ReadScope { active: boolean; phase: ReadPhase; parent?: ReadScope; }
const reads = new AsyncLocalStorage<ReadScope>();
function rootKey(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function readScope(): ReadScope | undefined {
  const current = reads.getStore();
  return current?.active && current.phase.accepting ? current : undefined;
}
function changedDuringRead(root: string): DkbError {
  return new DkbError(`The Library changed during this read (${root}). Retry the operation.`, 'library_busy');
}

/** Mutation authority never inherits an earlier clean read view, even after rollback. */
export function poisonLibraryReadSnapshot(root: string): void {
  for (let frame = reads.getStore(); frame; frame = frame.parent) {
    if (frame.active && frame.phase.accepting) frame.phase.poisoned.set(rootKey(root), path.resolve(root));
  }
}

/**
 * A phase may share immutable SQL values, never a connection or ownership lease.
 * Each explicit invocation owns a fresh phase, including nested invocations, so
 * a caller cannot defer an audit boundary's final check to its enclosing scope.
 * Before returning, the phase closes admission, drains its SQL reads, and
 * checks every Library again without consulting the phase cache.
 */
export async function withLibraryReadSnapshot<T>(operation: () => Promise<T>): Promise<T> {
  const parent = readScope();
  const phase: ReadPhase = { accepting: true, views: new Map(), poisoned: new Map(), poisonChecks: new Set() };
  const frame: ReadScope = { active: true, phase, ...(parent ? { parent } : {}) };
  let result: T | undefined, failure: unknown, failed = false;
  try { result = await reads.run(frame, operation); }
  catch (error) { failure = error; failed = true; }
  finally { frame.active = false; }
  phase.accepting = false;
  const views = [...phase.views.values()];
  phase.views.clear();
  const poisonChecks = [...phase.poisonChecks];
  phase.poisonChecks.clear();
  const loaded = await Promise.allSettled(views.map((view) => view.value));
  if (poisonChecks.length) await Promise.allSettled(poisonChecks);
  const poisonedOnly = [...phase.poisoned.values()].filter((root) => !views.some((view) => rootKey(view.root) === rootKey(root)));
  const barriers = await Promise.allSettled([
    ...views.map(async (view, index) => {
      const fresh = await freshStateFence(view.root);
      const previous = loaded[index]!;
      if (phase.poisoned.has(rootKey(view.root)) || (previous.status === 'fulfilled' && previous.value.fence !== fresh)) {
        throw changedDuringRead(view.root);
      }
    }),
    ...poisonedOnly.map(async (root) => {
      // A mutation may precede every read, including a rollback that left a journal.
      await freshStateFence(root);
      throw changedDuringRead(root);
    }),
  ]);
  phase.poisoned.clear();
  const barrierFailure = barriers.find((barrier) => barrier.status === 'rejected'
    && barrier.reason instanceof DkbError && barrier.reason.code === 'library_recovery_required')
    ?? barriers.find((barrier) => barrier.status === 'rejected');
  if (barrierFailure?.status === 'rejected') throw barrierFailure.reason;
  const loadFailure = loaded.find((view) => view.status === 'rejected');
  if (loadFailure?.status === 'rejected') throw loadFailure.reason;
  if (failed) throw failure;
  return result as T;
}

function phaseSnapshot(root: string): Promise<StateSnapshot> | undefined {
  const current = readScope();
  if (!current) return undefined;
  const key = rootKey(root);
  if (current.phase.poisoned.has(key)) {
    // Poison proves this view is unusable, not that the mutation needs recovery.
    const check = freshStateFence(root).then(() => { throw changedDuringRead(root); });
    current.phase.poisonChecks.add(check);
    void check.catch(() => undefined);
    return check;
  }
  let view = current.phase.views.get(key);
  if (!view) {
    view = { root, value: freshStateSnapshot(root) };
    current.phase.views.set(key, view);
    // The outer scope drains rejected loads even when a callback catches one.
    void view.value.catch(() => undefined);
  }
  return view.value;
}

export async function readStateStore(root: string): Promise<StateSnapshot> {
  const resolved = path.resolve(root);
  return phaseSnapshot(resolved) ?? freshStateSnapshot(resolved);
}

/** Standalone fences remain metadata-only; opted-in phases share their full SQL view. */
export async function readStateFence(root: string): Promise<string> {
  const resolved = path.resolve(root), view = phaseSnapshot(resolved);
  return view ? (await view).fence : freshStateFence(resolved);
}

function validatedFence(raw: string | null): string {
  const value = raw ?? '0';
  if (!/^(0|[1-9][0-9]*)$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new DkbError('Invalid Library mutation fence.', 'library_recovery_required');
  }
  return value;
}
function freshStateFence(root: string): Promise<string> {
  return withStateStore(root, (db) => {
    if (!db) return '0';
    return readHeader(db, root).fence;
  });
}
function freshStateSnapshot(root: string): Promise<StateSnapshot> {
  return withStateStore(root, (db) => {
    if (!db) return Object.freeze({ generation: 0, rows: Object.freeze([]), fence: '0' });
    const { generation, fence } = readHeader(db, root);
    const rows = db.prepare('SELECT * FROM entries ORDER BY identity').all();
    // SQLite fields are scalar. Reject unexpected blobs rather than exposing mutable buffers.
    if (rows.some((row) => Object.values(row).some((value) => value !== null && typeof value !== 'string' && typeof value !== 'number'))) {
      throw new DkbError('Invalid applied Library state fields.');
    }
    return Object.freeze({ generation, fence,
      rows: Object.freeze(rows.map((row) => Object.freeze({ ...row }) as unknown as Readonly<StateRow>)),
    });
  });
}

function readHeader(db: DatabaseSync, root: string): { generation: number; fence: string } {
  // A pending journal can be large. Read only its existence, never its payload,
  // when rejecting an ordinary query or inspection.
  const row = db.prepare(`SELECT
    EXISTS(SELECT 1 FROM metadata WHERE key='libraryMutation') AS pending,
    (SELECT value FROM metadata WHERE key='libraryMutationFence') AS fence,
    (SELECT value FROM metadata WHERE key='generation') AS generation`).get();
  if (row?.pending === 1) throw pendingStateError(root);
  if (!row || [row.fence, row.generation].some((value) => value !== null && typeof value !== 'string')) {
    throw new DkbError('Invalid Library state metadata.', 'library_recovery_required');
  }
  const generation = Number(row.generation ?? 0);
  if (!Number.isSafeInteger(generation) || generation < 0) throw new DkbError('Invalid Library state generation.');
  return { generation, fence: validatedFence(row.fence as string | null) };
}

export async function openState(root: string, readOnly = false): Promise<DatabaseSync | null> {
  if (!readOnly) assertDkbFileLock(root, 'library-state');
  const target = statePath(root);
  const priorNames = ['library-state', 'library-mutation'] as const;
  const paths = [target, ...['-wal', '-shm', '-journal'].map((suffix) => `${target}${suffix}`),
    ...priorNames.map((name) => previousDkbFileLockPath(root, name))];
  const facts = await assertLocalLibraryStorage(root, paths);
  for (const name of priorNames) {
    if (facts.get(previousDkbFileLockPath(root, name))) throw previousDkbLockError(root, name);
  }
  // This one fresh path inspection covers existence, links, ancestors, storage,
  // sidecars and old guards. Do not repeat it or retain it after this opening.
  if (readOnly && !facts.get(target)) return null;
  if (!readOnly) await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.toNamespacedPath(target), { readOnly });
  try {
    db.exec(readOnly ? 'PRAGMA busy_timeout=0' : 'PRAGMA busy_timeout=5000');
    if (!readOnly) db.exec(`
      PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entries (
        identity TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('dkb','collection')),
        source TEXT NOT NULL CHECK(source IN ('local','registry')), version TEXT, revision INTEGER,
        digest TEXT, path TEXT NOT NULL, registry_url TEXT, required_by TEXT NOT NULL,
        installed_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('installed','broken')),
        generation INTEGER NOT NULL,
        CHECK ((kind='dkb' AND version IS NOT NULL AND revision IS NULL) OR (kind='collection' AND version IS NULL))
      );
    `);
    return db;
  } catch (error) { db.close(); throw error; }
}

/**
 * On verified local storage, a short SQL read transaction is the native read
 * lease. The durable pending marker precedes every filesystem mutation, and a
 * fresh transaction at phase end rejects intervening work. A second lease
 * database adds no isolation to these synchronous, closed-before-await reads.
 * Writers still own the exclusive mutation/state leases across file changes.
 */
async function withStateStore<T>(root: string, operation: (db: DatabaseSync | null) => T): Promise<T> {
  const db = await openState(root, true);
  try {
    if (db) db.exec('BEGIN');
    return operation(db);
  } catch (error) {
    if ([5, 6].includes((error as { errcode?: number }).errcode ?? -1)) {
      throw new DkbError(`Library database is busy at ${root}. Wait for the current operation, then retry.`, 'library_busy');
    }
    throw error;
  } finally { db?.close(); }
}

export function assertStateNotPending(db: DatabaseSync, root: string): void {
  if (db.prepare('SELECT 1 FROM metadata WHERE key=?').get('libraryMutation')) {
    throw pendingStateError(root);
  }
}
function pendingStateError(root: string): DkbError {
  return new DkbError(`Library recovery required. Run dkb library recover --library "${root}".`, 'library_recovery_required');
}

export function assertLedgerMatchesLock(db: DatabaseSync, lock: DkbLibraryLockManifest | null): void {
  const rows = db.prepare('SELECT * FROM entries ORDER BY identity').all();
  const generation = Number(metadata(db, 'generation') ?? 0);
  if (!lock) {
    if (generation !== 0 || rows.length) throw new DkbError('Applied Library state has no matching resolved lock.', 'library_recovery_required');
    return;
  }
  const expected = Object.values(lock.entries).sort((a, b) => a.identity.localeCompare(b.identity)).map((entry) => ({
    identity: entry.identity, kind: entry.kind, source: entry.source, version: entry.version ?? null,
    revision: entry.revision ?? null, digest: entry.digest ?? null, path: entry.path.replace(/\\/gu, '/'),
    registry_url: entry.registryUrl ?? null, required_by: JSON.stringify([...entry.requiredBy].sort()),
    installed_at: entry.installedAt, status: 'installed', generation: lock.generation,
  }));
  if (generation !== lock.generation || stableHash(rows) !== stableHash(expected)) {
    throw new DkbError('Resolved Library lock and applied state differ; preserve both for explicit repair.', 'library_recovery_required');
  }
}

export function metadata(db: DatabaseSync, key: string): string | null {
  return (db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as { value: string } | undefined)?.value ?? null;
}
export function setMetadata(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}

/** Caller owns the surrounding SQLite transaction and the Library mutation lease. */
export function persistLock(db: DatabaseSync, lock: DkbLibraryLockManifest): void {
  db.exec('DELETE FROM entries');
  const insert = db.prepare(`INSERT INTO entries(identity,kind,source,version,revision,digest,path,registry_url,required_by,installed_at,status,generation)
    VALUES (?,?,?,?,?,?,?,?,?,?,'installed',?)`);
  for (const entry of Object.values(lock.entries).sort((a, b) => a.identity.localeCompare(b.identity))) {
    insert.run(entry.identity, entry.kind, entry.source, entry.version ?? null, entry.revision ?? null,
      entry.digest ?? null, entry.path.replace(/\\/gu, '/'), entry.registryUrl ?? null,
      JSON.stringify([...entry.requiredBy].sort()), entry.installedAt, lock.generation);
  }
  setMetadata(db, 'generation', String(lock.generation));
}
