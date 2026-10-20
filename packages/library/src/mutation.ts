import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { validateDkbLibraryLockManifest } from '@sjshovan/dkb-protocol/validation.js';
import type { DkbLibraryLockManifest } from '@sjshovan/dkb-protocol/types.js';
import { assertNoPreviousDkbLock, dkbFileLockPath, withDkbFileLock } from './locks.js';
import { assertSafePath, pathReceipt, relativeOwned, syncDirectory } from './mutationPaths.js';
import { assertLedgerMatchesLock, assertStateNotPending, metadata, openState, persistLock, poisonLibraryReadSnapshot, readStateFence, setMetadata } from './stateStore.js';

export { withLibraryReadSnapshot } from './stateStore.js';

interface PathChange {
  target: string; before: string | null; after: string | null; index: number;
  metadata?: { bytes: string; ready: boolean };
  configuration?: true;
}
interface Journal {
  format: 'dkb.library.mutation.v1'; id: string; ledgerId: string; root: string; decision: 'pending' | 'committed';
  beforeLock: DkbLibraryLockManifest | null; nextLock: DkbLibraryLockManifest | null;
  beforeState: string; nextState: string | null;
  changes: PathChange[]; final: Record<string, string | null>;
}
interface Mutation {
  root: string; db: DatabaseSync; journal: Journal; active: boolean; accepting: boolean;
  tail: Promise<unknown>; failure?: unknown;
}
const scope = new AsyncLocalStorage<Mutation>();
const journalKey = 'libraryMutation';
const fenceKey = 'libraryMutationFence';
export type LibraryReadFence = string;

function recoveryError(root: string, detail = 'An unfinished Library mutation requires recovery.'): DkbError {
  return new DkbError(`${detail} Run dkb library recover --library "${root}".`, 'library_recovery_required');
}
function owner(root: string): Mutation | undefined {
  const current = scope.getStore();
  const key = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return current?.active && key(current.root) === key(root) ? current : undefined;
}
export function assertLibraryMutation(root: string): void {
  if (!owner(root)?.accepting) throw new DkbError('This operation requires an active Library mutation.', 'library_mutation_required');
}
/** Internal state readers join only the still-active owning async context. */
export function pendingLibraryLock(root: string): { lock: DkbLibraryLockManifest | null } | undefined {
  const current = owner(root);
  return current ? { lock: structuredClone(current.journal.nextLock) } : undefined;
}
export function stageLibraryLock(root: string, lock: DkbLibraryLockManifest): void {
  assertLibraryMutation(root);
  const current = owner(root)!;
  const before = current.journal.beforeLock;
  const same = before && lock.generation <= before.generation
    && stableHash({ library: before.library, entries: before.entries }) === stableHash({ library: lock.library, entries: lock.entries });
  current.journal.nextLock = { ...structuredClone(lock), generation: same ? before.generation : (before?.generation ?? 0) + 1 };
  save(current);
}
function save(current: Mutation): void {
  const { root, ...portable } = current.journal;
  const value = JSON.stringify(portable);
  try {
    if (Buffer.byteLength(value) > 32 * 1024 * 1024) throw new DkbError('Library mutation metadata exceeds its 32 MiB journal budget.');
    validateJournal(value, root, metadata(current.db, 'libraryLedgerId'));
    setMetadata(current.db, journalKey, value);
  } catch (error) {
    // Failed intent persistence cannot leave a fabricated in-memory operation for rollback.
    const durable = metadata(current.db, journalKey);
    if (durable) Object.assign(current.journal, validateJournal(durable, root, metadata(current.db, 'libraryLedgerId')));
    throw error;
  }
}
function stateReceipt(db: DatabaseSync): string {
  return stableHash({ generation: metadata(db, 'generation'), entries: db.prepare('SELECT * FROM entries ORDER BY identity').all() });
}
function transactionRoot(journal: Journal): string { return path.join(journal.root, '.dkb', 'transactions', journal.id); }
function ownedPath(journal: Journal, change: PathChange, kind: 'stage' | 'backup'): string {
  return path.join(transactionRoot(journal), `${change.index}.${kind}`);
}
function epoch(db: DatabaseSync): number {
  const raw = metadata(db, fenceKey) ?? '0';
  if (!/^(0|[1-9][0-9]*)$/u.test(raw) || !Number.isSafeInteger(Number(raw))) throw new DkbError('Invalid Library mutation fence.', 'library_recovery_required');
  return Number(raw);
}
function bump(db: DatabaseSync): void { setMetadata(db, fenceKey, String(epoch(db) + 1)); }

export async function captureLibraryReadFence(root: string): Promise<LibraryReadFence> {
  return readStateFence(root);
}
export async function assertLibraryReadFence(root: string, fence: LibraryReadFence): Promise<void> {
  if (await captureLibraryReadFence(root) !== fence) {
    throw new DkbError(`The Library changed during this read (${path.resolve(root)}). Retry the operation.`, 'library_busy');
  }
}

function withMutationOwnership<T>(root: string, operation: () => Promise<T>): Promise<T> {
  return withDkbFileLock(root, 'library-mutation', () => withDkbFileLock(root, 'library-state', operation));
}

/** One outer decision; nested operations cannot publish intermediate Collection state. */
export async function withLibraryMutation<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(root);
  poisonLibraryReadSnapshot(resolved);
  const current = owner(resolved);
  if (current) {
    assertLibraryMutation(resolved);
    try { return await operation(); } catch (error) { current.failure = error; throw error; }
  }
  return withMutationOwnership(resolved, async () => {
    const db = (await openState(resolved))!;
    let mutation: Mutation | undefined;
    try {
      if (metadata(db, journalKey) !== null) throw recoveryError(resolved);
      let beforeLock: DkbLibraryLockManifest | null = null;
      try {
        beforeLock = validateDkbLibraryLockManifest(JSON.parse(await fs.readFile(path.join(resolved, 'dkb-lock.json'), 'utf8')), 'prior Library lock');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      assertLedgerMatchesLock(db, beforeLock);
      const ledgerId = metadata(db, 'libraryLedgerId') ?? randomUUID();
      const journal: Journal = { format: 'dkb.library.mutation.v1', id: randomUUID(), ledgerId, root: resolved,
        decision: 'pending', beforeLock, nextLock: beforeLock, beforeState: stateReceipt(db), nextState: null, changes: [], final: Object.create(null) as Record<string, string | null> };
      mutation = { root: resolved, db, journal, active: true, accepting: true, tail: Promise.resolve() };
      db.exec('BEGIN IMMEDIATE');
      try { setMetadata(db, 'libraryLedgerId', ledgerId); bump(db); save(mutation); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
      await fs.mkdir(transactionRoot(journal), { recursive: true, mode: 0o700 });
      const active = mutation;
      return await scope.run(active, async () => {
        try {
          const result = await operation();
          await active.tail;
          if (active.failure) throw active.failure;
          if (journal.nextLock) await writeLibraryMutationFile(resolved, path.join(resolved, 'dkb-lock.json'), `${JSON.stringify(journal.nextLock, null, 2)}\n`);
          active.accepting = false;
          await active.tail;
          // Only the last registered replacement of an exact target may become current.
          for (const change of journal.changes) {
            journal.final[change.target] = change.after;
          }
          for (const [target, expected] of Object.entries(journal.final)) {
            if (await pathReceipt(path.join(resolved, target)) !== expected) throw recoveryError(resolved, `Library target changed before commit: ${target}.`);
          }
          db.exec('BEGIN IMMEDIATE');
          try {
            journal.decision = 'committed';
            if (journal.nextLock) persistLock(db, journal.nextLock);
            journal.nextState = stateReceipt(db);
            save(active); db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); journal.decision = 'pending'; throw error; }
          await settle(active);
          return result;
        } catch (error) {
          active.accepting = false;
          await active.tail.catch(() => undefined);
          if (journal.decision === 'committed') {
            const pending = recoveryError(resolved, 'The Library committed, but verified cleanup remains unfinished.');
            pending.cause = error;
            throw pending;
          }
          try { await settle(active); }
          catch (recovery) {
            const pending = recoveryError(resolved);
            pending.cause = new AggregateError([error, recovery]);
            throw pending;
          }
          throw error;
        } finally { active.active = false; }
      });
    } finally { if (mutation) mutation.active = false; db.close(); }
  });
}

function enqueue<T>(root: string, action: (current: Mutation) => Promise<T>): Promise<T> {
  assertLibraryMutation(root);
  const current = owner(root)!;
  const result = current.tail.then(() => action(current));
  current.tail = result.catch((error: unknown) => { current.failure = error; });
  return result;
}

function targetPath(root: string, absolute: string, configuration = false): string {
  const relative = relativeOwned(root, absolute);
  if (configuration) {
    if (relative !== '.dkb/config.json') throw recoveryError(root, 'Invalid Library configuration target.');
    return relative;
  }
  const control = relative.toLowerCase();
  if (control === '.dkb' || control.startsWith('.dkb/')) throw recoveryError(root, 'Mutation targets cannot replace Library control state.');
  return relative;
}
function targetKey(value: string): string { return process.platform === 'win32' ? value.toLowerCase() : value; }
export async function promoteLibraryPath(root: string, stagedAbsolutePath: string, targetAbsolutePath: string): Promise<void> {
  return enqueue(root, async (current) => changePath(current, stagedAbsolutePath, targetAbsolutePath));
}
export async function removeLibraryPath(root: string, targetAbsolutePath: string): Promise<void> {
  return enqueue(root, async (current) => changePath(current, null, targetAbsolutePath));
}
export async function writeLibraryMutationFile(root: string, targetAbsolutePath: string, bytes: string | Uint8Array): Promise<void> {
  return enqueue(root, async (current) => {
    if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw new DkbError('Library metadata writes are limited to 16 MiB.');
    await changePath(current, null, targetAbsolutePath, bytes);
  });
}
/** The sole control-file exception: callers validate configuration before joining the transaction. */
export async function writeLibraryConfigurationFile(root: string, bytes: string | Uint8Array): Promise<void> {
  return enqueue(root, async (current) => {
    if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw new DkbError('Library metadata writes are limited to 16 MiB.');
    await changePath(current, null, path.join(current.root, '.dkb', 'config.json'), bytes, true);
  });
}
async function changePath(current: Mutation, source: string | null, target: string, bytes?: string | Uint8Array, configuration = false): Promise<void> {
  const relative = targetPath(current.root, target, configuration);
  for (const previous of current.journal.changes) {
    const left = targetKey(previous.target), right = targetKey(relative);
    if ((left === right && previous.target !== relative) || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)) {
      throw recoveryError(current.root, 'Overlapping parent/child mutation targets must be staged together before promotion.');
    }
  }
  await assertSafePath(current.root, target);
  if (source) {
    const stagedRelative = relativeOwned(current.root, source);
    if (!stagedRelative.startsWith('.dkb/tmp/')) throw recoveryError(current.root, 'Promoted content must be staged under the Library .dkb/tmp directory.');
    await assertSafePath(current.root, source);
    if (path.resolve(source) === path.resolve(target) || path.resolve(source).startsWith(`${path.resolve(target)}${path.sep}`)
      || path.resolve(target).startsWith(`${path.resolve(source)}${path.sep}`)) throw recoveryError(current.root, 'Staging and target paths must not overlap.');
  }
  const change: PathChange = { target: relative, before: await pathReceipt(target),
    after: bytes !== undefined ? `file:${createHash('sha256').update(bytes).digest('hex')}` : source ? await pathReceipt(source) : null,
    index: current.journal.changes.length,
    ...(configuration ? { configuration: true as const } : {}),
    ...(bytes !== undefined ? { metadata: { bytes: Buffer.from(bytes).toString('base64'), ready: false } } : {}) };
  if (source && change.after === null) throw new DkbError('Library staging path is missing.');
  current.journal.changes.push(change);
  save(current); // Durable intent precedes every live rename.
  const staged = ownedPath(current.journal, change, 'stage');
  const backup = ownedPath(current.journal, change, 'backup');
  if (bytes !== undefined) {
    await assertSafePath(current.root, staged);
    const handle = await fs.open(staged, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(transactionRoot(current.journal));
    change.metadata!.ready = true;
    save(current); // A flushed complete stage is required before any live rename.
  }
  if (source && path.resolve(source) !== staged) await fs.rename(source, staged);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await assertSafePath(current.root, target);
  if (await pathReceipt(target) !== change.before) throw recoveryError(current.root, 'Library target changed before promotion.');
  if (change.before !== null) await fs.rename(target, backup);
  await syncDirectory(path.dirname(target));
  if (source || bytes !== undefined) await fs.rename(staged, target);
  await syncDirectory(path.dirname(target));
  await syncDirectory(transactionRoot(current.journal));
}

async function knownIncompleteMetadata(current: Mutation, journal: Journal, change: PathChange): Promise<boolean> {
  if (!change.metadata || change.metadata.ready) return false;
  const staged = ownedPath(journal, change, 'stage');
  const expected = Buffer.from(change.metadata.bytes, 'base64');
  const stat = await fs.lstat(staged);
  if (!stat.isFile() || stat.size > expected.length) return false;
  if (await pathReceipt(path.join(current.root, change.target)) !== change.before
    || await pathReceipt(ownedPath(journal, change, 'backup')) !== null) return false;
  const actual = await fs.readFile(staged);
  // Only a prefix of the registered next metadata bytes is a known interrupted write.
  return actual.equals(expected.subarray(0, actual.length));
}

export async function recoverLibraryMutation(root: string): Promise<{ status: 'unchanged' | 'rolled_back' | 'committed'; libraryPath: string; transactionId?: string }> {
  const resolved = path.resolve(root);
  if (owner(resolved)) throw new DkbError('Recovery cannot run inside an active Library mutation.', 'library_busy');
  const present = async (target: string) => {
    try { await fs.lstat(target); return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  if (!(await present(path.join(resolved, '.dkb', 'state.sqlite')))
    && !(await present(dkbFileLockPath(resolved, 'library-mutation')))
    && !(await present(dkbFileLockPath(resolved, 'library-state')))) {
    await assertNoPreviousDkbLock(resolved, 'library-state');
    await assertNoPreviousDkbLock(resolved, 'library-mutation');
    return { status: 'unchanged', libraryPath: resolved };
  }
  return withMutationOwnership(resolved, async () => {
    const db = (await openState(resolved))!;
    try {
      const raw = metadata(db, journalKey);
      if (!raw) return { status: 'unchanged', libraryPath: resolved };
      poisonLibraryReadSnapshot(resolved);
      const journal = validateJournal(raw, resolved, metadata(db, 'libraryLedgerId'));
      const status = journal.decision === 'committed' ? 'committed' : 'rolled_back';
      const current: Mutation = { root: resolved, db, journal, active: true, accepting: false, tail: Promise.resolve() };
      await settle(current);
      return { status, libraryPath: resolved, transactionId: journal.id };
    } finally { db.close(); }
  });
}

async function settle(current: Mutation): Promise<void> {
  const journal = validateJournal(JSON.stringify(current.journal), current.root, metadata(current.db, 'libraryLedgerId'));
  await assertSafePath(current.root, transactionRoot(journal));
  if (stateReceipt(current.db) !== (journal.decision === 'committed' ? journal.nextState : journal.beforeState)) {
    throw recoveryError(current.root, 'The applied Library ledger was externally changed.');
  }
  // Validate all recovery-owned content before removing or restoring any target.
  for (const change of journal.changes) {
    for (const [kind, expected] of [['backup', change.before], ['stage', change.after]] as const) {
      const target = ownedPath(journal, change, kind);
      await assertSafePath(current.root, target);
      const actual = await pathReceipt(target);
      if (actual !== null && actual !== expected
        && !(kind === 'stage' && await knownIncompleteMetadata(current, journal, change))) {
        throw recoveryError(current.root, 'Recovery-owned Library data was externally changed.');
      }
    }
  }
  if (journal.decision === 'committed') {
    for (const [target, receipt] of Object.entries(journal.final)) {
      const absolute = path.join(current.root, target);
      await assertSafePath(current.root, absolute);
      if (await pathReceipt(absolute) !== receipt) throw recoveryError(current.root, `Committed Library path was externally changed: ${target}.`);
    }
  } else {
    // Simulate reverse receipts first. No target changes until every step is recoverable.
    const virtual = new Map<string, string | null>();
    for (const change of [...journal.changes].reverse()) {
      const target = path.join(current.root, change.target);
      await assertSafePath(current.root, target);
      const actual = virtual.has(change.target) ? virtual.get(change.target)! : await pathReceipt(target);
      const saved = await pathReceipt(ownedPath(journal, change, 'backup'));
      if (!(actual === change.before && saved === null)
        && !((actual === change.after || actual === null) && saved === change.before)) {
        throw recoveryError(current.root, `Cannot safely restore changed path or missing backup: ${change.target}.`);
      }
      virtual.set(change.target, change.before);
    }
    while (journal.changes.length) {
      const change = journal.changes.at(-1)!;
      const target = path.join(current.root, change.target);
      const backup = ownedPath(journal, change, 'backup');
      const staged = ownedPath(journal, change, 'stage');
      await assertSafePath(current.root, target);
      await assertSafePath(current.root, backup);
      const [actual, saved, next] = await Promise.all([pathReceipt(target), pathReceipt(backup), pathReceipt(staged)]);
      if (next !== null && next !== change.after && !(await knownIncompleteMetadata(current, journal, change))) throw recoveryError(current.root, 'Staged Library path changed.');
      if (saved !== null && saved !== change.before) throw recoveryError(current.root, 'Library backup changed.');
      if (actual === change.before && saved === null) {
        // Intent was not applied, or a previous recovery already restored this step.
      } else if ((actual === change.after || actual === null) && saved === change.before) {
        if (actual !== null) await fs.rm(target, { recursive: true, force: false });
        if (saved !== null) await fs.rename(backup, target);
        await syncDirectory(path.dirname(target));
      } else throw recoveryError(current.root, `Cannot safely restore changed path or missing backup: ${change.target}.`);
      if (next !== null) await fs.rm(staged, { recursive: true, force: false });
      journal.changes.pop(); current.journal = journal; save(current);
    }
  }
  // Clean only explicitly recorded backups; absent backups are valid after committed cleanup.
  for (const change of journal.changes) {
    for (const [kind, expected] of [['backup', change.before], ['stage', change.after]] as const) {
      const target = ownedPath(journal, change, kind);
      const actual = await pathReceipt(target);
      if (actual !== null) {
        if (actual !== expected) throw recoveryError(current.root, 'Owned recovery data was externally changed.');
        await fs.rm(target, { recursive: true, force: false });
      }
    }
  }
  try { await fs.rmdir(transactionRoot(journal)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw recoveryError(current.root, 'Unexpected files remain in the owned recovery directory.'); }
  current.db.exec('BEGIN IMMEDIATE');
  try {
    current.db.prepare('DELETE FROM metadata WHERE key=?').run(journalKey);
    bump(current.db); current.db.exec('COMMIT');
  } catch (error) { current.db.exec('ROLLBACK'); throw error; }
}

function validateJournal(raw: string, root: string, ledgerId: string | null): Journal {
  try {
    if (Buffer.byteLength(raw) > 32 * 1024 * 1024) throw new Error('oversized');
    const value = JSON.parse(raw) as Journal;
    if (value.format !== 'dkb.library.mutation.v1' || value.ledgerId !== ledgerId || !ledgerId || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/u.test(value.id)
      || !['pending', 'committed'].includes(value.decision) || !Array.isArray(value.changes)
      || !value.final || typeof value.final !== 'object' || Array.isArray(value.final)) throw new Error('shape');
    if (!/^sha256:[0-9a-f]{64}$/u.test(value.beforeState) || (value.nextState !== null && !/^sha256:[0-9a-f]{64}$/u.test(value.nextState))) throw new Error('state receipt');
    for (const lock of [value.beforeLock, value.nextLock]) if (lock !== null) validateDkbLibraryLockManifest(lock, 'Library recovery lock');
    const receipt = (v: unknown) => v === null || (typeof v === 'string' && /^(file|tree):[0-9a-f]{64}$/u.test(v));
    for (const [index, change] of value.changes.entries()) {
      if (change.configuration !== undefined && change.configuration !== true) throw new Error('configuration marker');
      if (change.configuration && (!change.metadata || !change.after?.startsWith('file:')
        || (change.before !== null && !change.before?.startsWith('file:')))) throw new Error('configuration file');
      if (change.index !== index || typeof change.target !== 'string' || targetPath(root, path.join(root, change.target), change.configuration) !== change.target
        || !receipt(change.before) || !receipt(change.after)) throw new Error('path change');
      if (change.metadata) {
        if (typeof change.metadata.bytes !== 'string' || typeof change.metadata.ready !== 'boolean') throw new Error('metadata stage');
        const bytes = Buffer.from(change.metadata.bytes, 'base64');
        if (bytes.length > 16 * 1024 * 1024 || bytes.toString('base64') !== change.metadata.bytes
          || `file:${createHash('sha256').update(bytes).digest('hex')}` !== change.after
          || (value.decision === 'committed' && !change.metadata.ready)) throw new Error('metadata bytes');
      }
      for (const previous of value.changes.slice(0, index)) {
        const left = targetKey(previous.target), right = targetKey(change.target);
        if ((left === right && previous.target !== change.target) || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)) throw new Error('overlapping paths');
      }
    }
    for (const [target, hash] of Object.entries(value.final)) {
      const registered = value.changes.find((change) => change.target === target);
      if (!registered || targetPath(root, path.join(root, target), registered.configuration) !== target || !receipt(hash)) throw new Error('final path');
    }
    if (value.decision === 'committed' && value.changes.some((change) => !Object.hasOwn(value.final, change.target))) throw new Error('missing final receipt');
    if (value.decision === 'committed') {
      const expected = Object.fromEntries(value.changes.map((change) => [change.target, change.after]));
      if (stableHash(expected) !== stableHash(value.final)) throw new Error('unexpected final receipt');
    }
    return { ...value, root };
  } catch { throw recoveryError(root, 'Invalid Library recovery journal; preserve it for explicit repair.'); }
}
