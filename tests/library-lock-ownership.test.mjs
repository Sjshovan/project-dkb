import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertDkbFileLock, dkbFileLockPath, isDkbFileLockHeld, withDkbFileLock } from '@sjshovan/dkb-library/locks.js';

import { DatabaseSync } from 'node:sqlite';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Library ownership serializes real concurrent operations without timestamp takeover', async (t) => {
  const root = await fixture(t);
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 8 }, () => withDkbFileLock(root, 'library-mutation', async () => {
    active += 1; peak = Math.max(peak, active);
    assertDkbFileLock(root, 'library-mutation');
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
  }, { staleMs: 1, timeoutMs: 2000 })));
  assert.equal(peak, 1);
  assert.equal(isDkbFileLockHeld(root, 'library-mutation'), false);
  assert.equal(await fs.stat(dkbFileLockPath(root, 'library-mutation')).then(() => true, () => false), true);
});

test('an escaped async ownership context cannot retain authority after release', async (t) => {
  const root = await fixture(t);
  let resume;
  let escaped;
  const wait = new Promise((resolve) => { resume = resolve; });
  await withDkbFileLock(root, 'library-mutation', async () => {
    escaped = wait.then(() => {
      assert.equal(isDkbFileLockHeld(root, 'library-mutation'), false);
      assert.throws(() => assertDkbFileLock(root, 'library-mutation'), { code: 'library_mutation_required' });
    });
    await withDkbFileLock(root, 'library-mutation', async () => assertDkbFileLock(root, 'library-mutation'));
  });
  resume();
  await escaped;
});

test('a timed-out local waiter cannot strand or jump the remaining FIFO queue', async (t) => {
  const root = await fixture(t);
  let entered, release;
  const ready = new Promise((resolve) => { entered = resolve; });
  const hold = new Promise((resolve) => { release = resolve; });
  const order = [];
  const first = withDkbFileLock(root, 'library-mutation', async () => { entered(); await hold; order.push('first'); });
  await ready;
  const expired = assert.rejects(withDkbFileLock(root, 'library-mutation', async () => assert.fail('expired waiter ran'),
    { timeoutMs: 20 }), { code: 'library_busy' });
  const second = withDkbFileLock(root, 'library-mutation', async () => order.push('second'), { timeoutMs: 1000 });
  const third = withDkbFileLock(root, 'library-mutation', async () => order.push('third'), { timeoutMs: 1000 });
  await expired;
  release();
  await Promise.all([first, second, third]);
  assert.deepEqual(order, ['first', 'second', 'third']);
  await withDkbFileLock(root, 'library-mutation', async () => assertDkbFileLock(root, 'library-mutation'));
});

test('a same-process state reader fails closed while a mutation owns state', async (t) => {
  const root = await fixture(t);
  let entered, release;
  const ready = new Promise((resolve) => { entered = resolve; });
  const hold = new Promise((resolve) => { release = resolve; });
  const first = withDkbFileLock(root, 'library-state', async () => { entered(); await hold; });
  await ready;
  try {
    await assert.rejects(withDkbFileLock(root, 'library-state', async () => assert.fail('reader admitted'),
      { purpose: 'read', timeoutMs: 0, recoveryRequiredOnBusy: true }), { code: 'library_recovery_required' });
  } finally { release(); await first; }
  await withDkbFileLock(root, 'library-state', async () => assertDkbFileLock(root, 'library-state', 'read'),
    { purpose: 'read', timeoutMs: 0, recoveryRequiredOnBusy: true });
});

test('clean read queue saturation reports retry, not Library repair', async (t) => {
  const root = await fixture(t);
  let entered, release;
  const ready = new Promise((resolve) => { entered = resolve; });
  const hold = new Promise((resolve) => { release = resolve; });
  const reader = withDkbFileLock(root, 'library-state', async () => { entered(); await hold; }, { purpose: 'read' });
  await ready;
  try {
    await assert.rejects(withDkbFileLock(root, 'library-state', async () => assert.fail('queued read ran early'),
      { purpose: 'read', timeoutMs: 0, recoveryRequiredOnBusy: true }), (error) => {
      assert.equal(error.code, 'library_busy');
      assert.match(error.message, /Wait for current operations.*retry/u);
      assert.doesNotMatch(error.message, /recover|repair/iu);
      return true;
    });
  } finally { release(); await reader; }
});

test('a real owner death allows same-domain acquisition without an age delay', async (t) => {
  const root = await fixture(t);
  const source = `import {withDkbFileLock} from '@sjshovan/dkb-library/locks.js';
    await withDkbFileLock(process.argv[1], 'library-mutation', async()=> {
      process.send('ready'); setInterval(()=>global.gc?.(),10); await new Promise(()=>{});
    });`;
  const child = spawn(process.execPath, ['--expose-gc', '--input-type=module', '-e', source, root], {
    cwd: repository, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
  });
  const closed = once(child, 'close');
  let error = '';
  child.stderr.on('data', (data) => { error += data; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
  await Promise.race([
    once(child, 'message').then(([message]) => assert.equal(message, 'ready')),
    closed.then(() => { throw new Error('Lease child exited before readiness: ' + error); }),
  ]);
  await assert.rejects(withDkbFileLock(root, 'library-mutation', async () => assert.fail('live owner was stolen'),
    { timeoutMs: 0, staleMs: 1 }), { code: 'library_busy' });
  child.kill('SIGKILL');
  await closed;
  let entered = false;
  await withDkbFileLock(root, 'library-mutation', async () => { entered = true; }, { timeoutMs: 500 });
  assert.equal(entered, true);
  assert.deepEqual((await fs.readdir(path.dirname(dkbFileLockPath(root, 'library-mutation')))).filter((name) => name.endsWith('.owner')), []);
});


test('earlier locking-protocol guards are preserved and never guessed away', async (t) => {
  const root = await fixture(t);
  const guard = path.join(root, '.dkb', 'locks', 'library-mutation.lock');
  await fs.mkdir(path.dirname(guard), { recursive: true });
  for (const bytes of ['{"pid":1}', 'unreadable old format', '']) {
    await fs.writeFile(guard, bytes);
    await fs.utimes(guard, new Date(0), new Date(0));
    await assert.rejects(withDkbFileLock(root, 'library-mutation', async () => assert.fail('old protocol admitted'),
      { timeoutMs: 0, staleMs: 1 }), { code: 'library_recovery_required' });
    assert.equal(await fs.readFile(guard, 'utf8'), bytes);
  }
  assert.equal(await fs.stat(dkbFileLockPath(root, 'library-mutation')).then(() => true, () => false), false);
});

test('an operation error releases native ownership for the next caller', async (t) => {
  const root = await fixture(t);
  await assert.rejects(withDkbFileLock(root, 'library-mutation', async () => { throw new Error('operation failed'); }), /operation failed/u);
  await withDkbFileLock(root, 'library-mutation', async () => assertDkbFileLock(root, 'library-mutation'));
});

test('a corrupted lease is rejected without replacement or callback execution', async (t) => {
  const root = await fixture(t);
  const lease = dkbFileLockPath(root, 'library-mutation');
  await fs.mkdir(path.dirname(lease), { recursive: true });
  const bytes = Buffer.from('not a SQLite lease'.repeat(32));
  await fs.writeFile(lease, bytes);
  await assert.rejects(withDkbFileLock(root, 'library-mutation', async () => assert.fail('corrupt lease admitted')));
  assert.deepEqual(await fs.readFile(lease), bytes);
});

test('schema initialization failure closes the database and releases the local queue', async (t) => {
  const root = await fixture(t);
  const original = DatabaseSync.prototype.exec;
  let failed = false;
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql, ...args) {
    if (!failed && sql.startsWith('CREATE TABLE')) { failed = true; throw new Error('synthetic schema error'); }
    return original.call(this, sql, ...args);
  });
  await assert.rejects(withDkbFileLock(root, 'library-mutation', async () => assert.fail('failed lease admitted')), /synthetic schema error/u);
  await withDkbFileLock(root, 'library-mutation', async () => assertDkbFileLock(root, 'library-mutation'));
});

test('a shared native read lease excludes writers but admits another process reader', async (t) => {
  const root = await fixture(t);
  const lease = dkbFileLockPath(root, 'library-state');
  await withDkbFileLock(root, 'library-state', async () => {});
  const external = new DatabaseSync(path.toNamespacedPath(lease));
  try {
    external.exec('PRAGMA busy_timeout=0; BEGIN; SELECT id FROM dkb_lease LIMIT 1');
    await withDkbFileLock(root, 'library-state', async () => assertDkbFileLock(root, 'library-state', 'read'), { purpose: 'read', timeoutMs: 0 });
    await assert.rejects(withDkbFileLock(root, 'library-state', async () => assert.fail('writer admitted'), { timeoutMs: 0 }), { code: 'library_busy' });
    external.exec('ROLLBACK');
  } finally { external.close(); }
  await withDkbFileLock(root, 'library-state', async () => assertDkbFileLock(root, 'library-state'), { timeoutMs: 0 });
});

test('a prior guard without a ledger cannot appear as empty readable or recovered state', async (t) => {
  const { readLibraryState } = await import('@sjshovan/dkb-library/state.js');
  const { recoverLibraryMutation } = await import('@sjshovan/dkb-library/mutation.js');
  const root = await fixture(t), guard = path.join(root, '.dkb', 'locks', 'library-state.lock');
  await fs.mkdir(path.dirname(guard), { recursive: true });
  await fs.writeFile(guard, 'prior owner');
  await assert.rejects(readLibraryState(root), { code: 'library_recovery_required' });
  await assert.rejects(recoverLibraryMutation(root), { code: 'library_recovery_required' });
  assert.equal(await fs.readFile(guard, 'utf8'), 'prior owner');
});

test('a paused external owner is not stolen after a stale interval', async (t) => {
  const root = await fixture(t), lease = dkbFileLockPath(root, 'library-mutation');
  await withDkbFileLock(root, 'library-mutation', async () => {});
  const external = new DatabaseSync(path.toNamespacedPath(lease));
  try {
    external.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    await assert.rejects(withDkbFileLock(root, 'library-mutation', async () => assert.fail('live lease stolen'), { timeoutMs: 60, staleMs: 1 }), { code: 'library_busy' });
  } finally { external.close(); }
  await withDkbFileLock(root, 'library-mutation', async () => assertDkbFileLock(root, 'library-mutation'), { timeoutMs: 0 });
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-library-owner-proof-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
