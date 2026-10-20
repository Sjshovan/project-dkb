import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { withRuntimeMutation, withRuntimeQuery } from '@sjshovan/dkb-runtime/runtime/mutation.js';

const deferred = () => Promise.withResolvers();
const turn = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-runtime-native-ownership-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('Runtime preserves earlier ownership guards regardless of their age or recorded PID', async t => {
  const root = await fixture(t);
  const guard = path.join(root, '.dkb', 'locks', 'runtime-mutation.lock');
  await fs.mkdir(path.dirname(guard), { recursive: true });
  const bytes = JSON.stringify({ pid: 1, host: 'another-container', token: 'older-protocol' });
  await fs.writeFile(guard, bytes);
  await fs.utimes(guard, new Date(0), new Date(0));
  await assert.rejects(withRuntimeMutation(root, async () => assert.fail('Prior guard was guessed away')),
    { code: 'runtime_recovery_required' });
  await assert.rejects(withRuntimeQuery(root, async () => assert.fail('Prior writer was bypassed')),
    { code: 'runtime_recovery_required' });
  assert.equal(await fs.readFile(guard, 'utf8'), bytes);
});

test('Runtime readers overlap while queued mutations precede later readers', { timeout: 15_000 }, async t => {
  const root = await fixture(t), ready = deferred(), release = deferred();
  const events = [];
  let readers = 0, peak = 0;
  const reader = label => withRuntimeQuery(root, async () => {
    events.push(label); peak = Math.max(peak, ++readers);
    if (readers === 2) ready.resolve();
    await release.promise; readers--;
  });
  const first = reader('first'), second = reader('second');
  let writer, last;
  try {
    await ready.promise;
    writer = withRuntimeMutation(root, async () => { events.push('writer'); });
    last = withRuntimeQuery(root, async () => { events.push('last'); });
    await turn();
    assert.equal(peak, 2);
    assert.equal(events.length, 2);
  } finally { release.resolve(); await Promise.all([first, second, writer, last]); }
  assert.deepEqual(events.slice(2), ['writer', 'last']);
});

test('Runtime query cannot upgrade its read authority and nested mutation reads remain reentrant', async t => {
  const root = await fixture(t);
  await withRuntimeQuery(root, async () => {
    await withRuntimeQuery(root, async () => {});
    await assert.rejects(withRuntimeMutation(root, async () => assert.fail('read authority upgraded')),
      { code: 'runtime_mutation_required' });
  });
  await withRuntimeMutation(root, async () => {
    await withRuntimeQuery(root, async () => {});
    await withRuntimeMutation(root, async () => {});
  });
});

test('only Runtime mutation bootstraps a missing state root', async t => {
  const parent = await fixture(t), root = path.join(parent, 'new', 'runtime');
  await assert.rejects(withRuntimeQuery(root, async () => assert.fail('Query initialized Runtime')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(parent, 'new')), { code: 'ENOENT' });
  await withRuntimeMutation(root, async () => {});
  await withRuntimeQuery(root, async () => {});
});

test('Library errors inside an admitted Runtime operation retain their original resource and code', async t => {
  const root = await fixture(t);
  const { DkbError } = await import('@sjshovan/dkb-protocol/errors.js');
  const failure = new DkbError('Library has a live writer.', 'library_busy');
  await assert.rejects(withRuntimeMutation(root, async () => { throw failure; }), error => error === failure);
});

test('detached Runtime continuations cannot reuse expired mutation authority', { timeout: 15_000 }, async t => {
  const root = await fixture(t), trigger = deferred(), held = deferred(), release = deferred();
  let detached, entered = false;
  await withRuntimeMutation(root, async () => {
    detached = trigger.promise.then(() => withRuntimeMutation(root, async () => { entered = true; }));
  });
  const owner = withRuntimeMutation(root, async () => { held.resolve(); await release.promise; });
  await held.promise;
  try {
    trigger.resolve(); await turn();
    assert.equal(entered, false, 'expired async scope bypassed the live owner');
  } finally { release.resolve(); await Promise.all([owner, detached]); }
  assert.equal(entered, true);
});

test('Runtime native read lease excludes an external writer until every query finishes', { timeout: 15_000 }, async t => {
  const root = await fixture(t), ready = deferred(), release = deferred();
  const reader = withRuntimeQuery(root, async () => { ready.resolve(); await release.promise; });
  await ready.promise;
  const external = new DatabaseSync(path.toNamespacedPath(path.join(root, '.dkb', 'locks', 'runtime-mutation.lease.sqlite')));
  try {
    external.exec('PRAGMA busy_timeout=0');
    assert.throws(() => external.exec('BEGIN EXCLUSIVE'), error => error.errcode === 5);
    external.exec('BEGIN; SELECT id FROM dkb_lease LIMIT 1; ROLLBACK');
  } finally { external.close(); release.resolve(); await reader; }
  await withRuntimeMutation(root, async () => {});
});

test('killing an independent Runtime owner releases native ownership without PID or age takeover', { timeout: 20_000 }, async t => {
  const root = await fixture(t);
  const child = spawn(process.execPath, ['--expose-gc', '--input-type=module', '-e', `
    import {withRuntimeMutation} from '@sjshovan/dkb-runtime/runtime/mutation.js';
    await withRuntimeMutation(process.argv[1], async()=> {
      process.send('ready'); setInterval(()=>global.gc?.(),10); await new Promise(()=>{});
    });`, root], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', chunk => stderr += chunk);
  const closed = once(child, 'close');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
  await Promise.race([once(child, 'message'), closed.then(() => { throw new Error(`Runtime owner exited: ${stderr}`); })]);
  const lease = path.join(root, '.dkb', 'locks', 'runtime-mutation.lease.sqlite');
  const external = new DatabaseSync(path.toNamespacedPath(lease));
  try {
    external.exec('PRAGMA busy_timeout=0');
    assert.throws(() => external.exec('BEGIN EXCLUSIVE'), error => error.errcode === 5);
  } finally { external.close(); }
  child.kill('SIGKILL'); await closed;
  await withRuntimeMutation(root, async () => {});
});
