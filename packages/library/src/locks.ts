import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { assertLocalLibraryStorage } from './storageAccess.js';

type LockName = 'library-mutation' | 'library-state' | 'build-promotion' | 'runtime-mutation' | 'compile' | 'stack-control';
type Purpose = 'read' | 'mutation';
interface Owner { active: boolean; purpose: Purpose; }
interface LockOptions {
  timeoutMs?: number; staleMs?: number; recoveryRequiredOnBusy?: boolean; purpose?: Purpose;
  /** Overlap native shared leases, but never overtake an already queued writer. */
  concurrentReads?: boolean;
  /** Bootstrap an owner state root only after validating its existing ancestors. */
  createRoot?: boolean;
  /** Cancel admission only; an admitted callback retains ownership through cleanup. */
  signal?: AbortSignal;
}
interface LocalWaiter { purpose: Purpose; concurrent: boolean; resolve: (release: () => void) => void; dispose: () => void; }
interface LocalQueue { purpose: Purpose; concurrent: boolean; active: number; waiters: LocalWaiter[]; databases: Set<DatabaseSync>; }
const owners = new AsyncLocalStorage<Map<string, Owner>>();
const localQueues = new Map<string, LocalQueue>();

/** Persistent native lease database. Existence is not evidence of a live owner. */
export function dkbFileLockPath(root: string, name: LockName): string {
  return path.join(path.resolve(root), '.dkb', 'locks', name + '.lease.sqlite');
}
function key(root: string, name: LockName): string {
  const target = dkbFileLockPath(root, name);
  return process.platform === 'win32' ? target.toLowerCase() : target;
}
export function isDkbFileLockHeld(root: string, name: LockName): boolean {
  return owners.getStore()?.get(key(root, name))?.active === true;
}
export function assertDkbFileLock(root: string, name: LockName, purpose: Purpose = 'mutation'): void {
  const owner = owners.getStore()?.get(key(root, name));
  if (!owner?.active || (purpose === 'mutation' && owner.purpose !== 'mutation')) {
    throw new DkbError('DKB ' + name + ' requires active ' + (purpose === 'mutation' ? 'exclusive' : 'read')
      + ' ownership of this Library.', 'library_mutation_required');
  }
}

export async function assertNoPreviousDkbLock(root: string, name: LockName): Promise<void> {
  const previousGuard = previousDkbFileLockPath(root, name);
  try {
    await fs.lstat(previousGuard);
    throw previousDkbLockError(root, name);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

export function previousDkbFileLockPath(root: string, name: LockName): string {
  return path.join(path.dirname(dkbFileLockPath(root, name)), name + '.lock');
}
export function previousDkbLockError(root: string, name: LockName): DkbError {
  return new DkbError('An earlier DKB ownership guard remains at ' + previousDkbFileLockPath(root, name)
    + '. Stop all earlier DKB processes and recover with their matching version before changing locking protocols. '
    + 'The guard and Library were preserved.', 'library_recovery_required');
}

/** One OS/storage environment owns SQLite locking. No PID/age-based takeover. */
export async function withDkbFileLock<T>(root: string, name: LockName,
  operation: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  options.signal?.throwIfAborted();
  const resolved = path.resolve(root);
  if (isDkbFileLockHeld(resolved, name)) {
    // A nested mutation cannot silently promote a native shared lease.
    assertDkbFileLock(resolved, name, options.purpose ?? 'mutation');
    return operation();
  }
  // Enqueue before any asynchronous validation so invocation order remains FIFO.
  const release = await acquireLocal(resolved, name, options);
  try { return await withNativeLease(resolved, name, operation, options); }
  finally { release(); }
}

async function withNativeLease<T>(root: string, name: LockName,
  operation: () => Promise<T>, options: LockOptions): Promise<T> {
  options.signal?.throwIfAborted();
  if (options.createRoot) {
    if (options.purpose === 'read') throw new DkbError('Read ownership cannot initialize a state root.', 'library_mutation_required');
    await prepareStateRoot(root);
  }
  const lease = dkbFileLockPath(root, name);
  const previousGuard = path.join(path.dirname(lease), name + '.lock');
  await assertLocalLibraryStorage(root, [lease, ...['-journal', '-wal', '-shm'].map((suffix) => lease + suffix),
    previousGuard, path.join(root, '.dkb', 'state.sqlite')]);
  await assertNoPreviousDkbLock(root, name);
  options.signal?.throwIfAborted();
  await fs.mkdir(path.dirname(lease), { recursive: true, mode: 0o700 });
  options.signal?.throwIfAborted();
  const db = new DatabaseSync(path.toNamespacedPath(lease));
  // Root native ownership explicitly even when an idle callback has no reachable continuation.
  const queue = localQueues.get(key(root, name))!;
  queue.databases.add(db);
  const started = Date.now();
  const owner: Owner = { active: true, purpose: options.purpose ?? 'mutation' };
  let locked = false;
  let failed = false;
  try {
    db.exec('PRAGMA busy_timeout=0');
    while (!locked) {
      options.signal?.throwIfAborted();
      try {
        // Initialized databases have real SQLite lock semantics; an empty file is insufficient.
        db.exec('CREATE TABLE IF NOT EXISTS dkb_lease (id INTEGER PRIMARY KEY)');
        db.exec(options.purpose === 'read' ? 'BEGIN' : 'BEGIN EXCLUSIVE');
        locked = true;
        if (options.purpose === 'read') db.exec('SELECT id FROM dkb_lease LIMIT 1');
      } catch (error) {
        if (locked) { db.exec('ROLLBACK'); locked = false; }
        if (![5, 6].includes((error as { errcode?: number }).errcode ?? -1)) throw error;
        if (Date.now() - started >= (options.timeoutMs ?? 120_000)) throw busyError(root, name, options);
        await delay(25, undefined, { signal: options.signal }).catch((error: unknown) => {
          options.signal?.throwIfAborted();
          throw error;
        });
      }
    }
    const scope = new Map(owners.getStore());
    scope.set(key(root, name), owner);
    options.signal?.throwIfAborted();
    return await owners.run(scope, operation);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    owner.active = false;
    try {
      try { if (locked) db.exec('ROLLBACK'); }
      finally { db.close(); }
    } catch (error) {
      // Preserve primary errors, notably worker-stop uncertainty used by staging cleanup.
      if (!failed) throw error;
    } finally { queue.databases.delete(db); }
  }
}

async function prepareStateRoot(root: string): Promise<void> {
  let ancestor = root;
  while (true) {
    try { await fs.lstat(ancestor); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  if (ancestor === root) return; // Full fresh path/storage admission follows below.
  await assertLocalLibraryStorage(ancestor, [root]);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
}

function acquireLocal(root: string, name: LockName, options: LockOptions): Promise<() => void> {
  const queueKey = key(root, name), purpose = options.purpose ?? 'mutation';
  const concurrent = purpose === 'read' && options.concurrentReads === true;
  const existing = localQueues.get(queueKey);
  if (!existing) {
    const queue: LocalQueue = { purpose, concurrent, active: 1, waiters: [], databases: new Set() };
    localQueues.set(queueKey, queue);
    return Promise.resolve(releaseLocal(queueKey, queue));
  }
  if (concurrent && existing.concurrent && existing.purpose === 'read' && !existing.waiters.length) {
    existing.active++;
    return Promise.resolve(releaseLocal(queueKey, existing));
  }
  const readQueue = purpose === 'read' && existing.purpose === 'read';
  const timeout = readQueue ? 5000 : options.timeoutMs ?? 120_000;
  const failureOptions = readQueue ? { ...options, recoveryRequiredOnBusy: false } : options;
  if (timeout <= 0) return Promise.reject(busyError(root, name, options));
  return new Promise((resolve, reject) => {
    const remove = (error: unknown) => {
      const index = existing.waiters.indexOf(waiter);
      if (index < 0) return;
      existing.waiters.splice(index, 1);
      waiter.dispose();
      reject(error);
    };
    const abort = () => remove(options.signal!.reason);
    const timer = setTimeout(() => remove(busyError(root, name, failureOptions)), timeout);
    const waiter: LocalWaiter = { purpose, concurrent, resolve, dispose: () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    } };
    existing.waiters.push(waiter);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
function releaseLocal(queueKey: string, queue: LocalQueue): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--queue.active > 0) return;
    const next = queue.waiters.shift();
    if (!next) { localQueues.delete(queueKey); return; }
    next.dispose();
    queue.purpose = next.purpose;
    queue.concurrent = next.concurrent;
    queue.active = 1;
    next.resolve(releaseLocal(queueKey, queue));
    while (queue.concurrent && queue.waiters[0]?.concurrent) {
      const reader = queue.waiters.shift()!;
      reader.dispose();
      queue.active++;
      reader.resolve(releaseLocal(queueKey, queue));
    }
  };
}
function busyError(root: string, name: LockName, options: LockOptions): DkbError {
  if (!options.recoveryRequiredOnBusy) return new DkbError('DKB ' + name.replace('-', ' ') + ' is busy at ' + root
    + '. Wait for current operations to finish, then retry this command.', 'library_busy');
  return new DkbError('DKB Library state is currently owned by another operation at ' + root
    + '. Wait for it to finish. If it was interrupted, run dkb library recover --library "' + root + '".', 'library_recovery_required');
}
