import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { withDkbFileLock, dkbFileLockPath } from '@sjshovan/dkb-library/locks.js';
import { compileComposeProject, COMPILE_LOCK_PATH } from '@sjshovan/dkb-compiler/compile.js';
import { createCompilerOwnershipFixture, waitForCompilerMarker } from './compiler-ownership-fixture.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-compiler-ownership-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return createCompilerOwnershipFixture(root);
}

test('compiler preserves an aged previous-protocol guard and caller source', async t => {
  const { source } = await fixture(t);
  const guard = path.join(source, '.dkb', 'locks', 'compile.lock');
  await fs.mkdir(guard, { recursive: true });
  const bytes = JSON.stringify({ pid: 1, host: 'another-container', token: 'previous-owner' });
  await fs.writeFile(path.join(guard, 'owner.json'), bytes);
  await fs.utimes(guard, new Date(0), new Date(0));
  await assert.rejects(compileComposeProject(source), { code: 'compile_recovery_required' });
  assert.equal(await fs.readFile(path.join(guard, 'owner.json'), 'utf8'), bytes);
  assert.equal(await fs.readFile(path.join(source, 'knowledge.md'), 'utf8'), 'Preserve this source.\n');
  await assert.rejects(fs.access(path.join(source, COMPILE_LOCK_PATH)), { code: 'ENOENT' });
});

test('pre-aborted compiler admission creates no lease database', async t => {
  const { source } = await fixture(t), reason = new Error('cancel before admission');
  await assert.rejects(compileComposeProject(source, { signal: AbortSignal.abort(reason) }), error => error === reason);
  await assert.rejects(fs.access(path.join(source, COMPILE_LOCK_PATH)), { code: 'ENOENT' });
});

test('cancelled same-process compiler waiter cannot enter or strand the queue', { timeout: 15_000 }, async t => {
  const { source } = await fixture(t), held = Promise.withResolvers(), release = Promise.withResolvers();
  const first = withDkbFileLock(source, 'compile', async () => { held.resolve(); await release.promise; });
  await held.promise;
  const controller = new AbortController(), reason = new Error('cancel queued compiler');
  const cancelled = assert.rejects(withDkbFileLock(source, 'compile', async () => assert.fail('cancelled waiter entered'),
    { signal: controller.signal }), error => error === reason);
  const next = withDkbFileLock(source, 'compile', async () => 'next');
  try { controller.abort(reason); await cancelled; }
  finally { release.resolve(); await first; }
  assert.equal(await next, 'next');
});

test('compiler waiting for another native owner cancels without stealing or deleting its lease', { timeout: 15_000 }, async t => {
  const { source } = await fixture(t);
  await withDkbFileLock(source, 'compile', async () => {});
  const lease = dkbFileLockPath(source, 'compile'), db = new DatabaseSync(path.toNamespacedPath(lease));
  db.exec('BEGIN EXCLUSIVE');
  const controller = new AbortController(), reason = new Error('cancel native wait');
  const timer = setTimeout(() => controller.abort(reason), 75);
  try {
    await assert.rejects(compileComposeProject(source, { signal: controller.signal }), error => error === reason);
    assert.ok((await fs.stat(lease)).isFile());
    const other = new DatabaseSync(path.toNamespacedPath(lease));
    try { assert.throws(() => other.exec('BEGIN EXCLUSIVE'), error => error.errcode === 5); }
    finally { other.close(); }
  } finally { clearTimeout(timer); db.exec('ROLLBACK'); db.close(); }
  await withDkbFileLock(source, 'compile', async () => {});
});

test('actual provider cancellation keeps compiler ownership until provider cleanup has settled', { timeout: 20_000 }, async t => {
  const fixture = await createRunning(t);
  const { source, control, controller, running, rejected } = fixture;
  try {
    controller.abort(new Error('stop actual provider'));
    await waitForCompilerMarker(control, 'cleanup');
    await assert.rejects(withDkbFileLock(source, 'compile', async () => assert.fail('cleanup ownership bypassed'), { timeoutMs: 0 }), { code: 'library_busy' });
    // Other packages still compile independently.
    const other = await fixtureRoot(t);
    await withDkbFileLock(other, 'compile', async () => {});
  } finally {
    await fs.writeFile(path.join(control, 'cleanup-confirmed'), 'yes');
    await rejected;
  }
  await assert.rejects(running, /abort|stop actual provider/i);
  await withDkbFileLock(source, 'compile', async () => {});
});

test('native cleanup cannot replace worker-stop uncertainty with a secondary lease error', async t => {
  const root = await fixtureRoot(t), uncertainty = new Error('provider_termination_unconfirmed');
  const original = DatabaseSync.prototype.exec;
  try {
    await assert.rejects(withDkbFileLock(root, 'compile', async () => {
      DatabaseSync.prototype.exec = function(sql) {
        if (sql === 'ROLLBACK') throw new Error('secondary rollback error');
        return original.call(this, sql);
      };
      throw uncertainty;
    }), error => error === uncertainty);
  } finally { DatabaseSync.prototype.exec = original; }
  await withDkbFileLock(root, 'compile', async () => {});
});

async function fixtureRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-compiler-ownership-root-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function createRunning(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-compiler-ownership-running-'));
  let controller, rejected;
  t.after(async () => {
    controller?.abort(new Error('stop actual provider'));
    if (rejected) {
      await fs.writeFile(path.join(root, 'control', 'cleanup-confirmed'), 'yes');
      await rejected;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const fixture = await createCompilerOwnershipFixture(root);
  controller = new AbortController();
  const running = compileComposeProject(fixture.source, { target: 'ownership', contextRoot: fixture.root, signal: controller.signal });
  rejected = assert.rejects(running, /abort|stop actual provider/i);
  await waitForCompilerMarker(fixture.control, 'started');
  return { ...fixture, controller, running, rejected };
}
