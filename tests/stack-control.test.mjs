import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withStackControl } from '../apps/cli/dist/stack/control.js';
import { stackControlRoot } from '../apps/cli/dist/stack/paths.js';
import { dkbFileLockPath } from '@sjshovan/dkb-library/locks.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-stack-control-'));
  const previous = process.env.DKB_STACK_STATE_ROOT;
  process.env.DKB_STACK_STATE_ROOT = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.DKB_STACK_STATE_ROOT; else process.env.DKB_STACK_STATE_ROOT = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test('host Stack ownership never creates Runtime state and survives Stack directory replacement', async t => {
  const root = await fixture(t), stack = path.join(root, 'local');
  await withStackControl('local', async () => {
    await assert.rejects(fs.access(stack), { code: 'ENOENT' });
    await fs.mkdir(stack);
    await fs.writeFile(path.join(stack, 'saved.txt'), 'preserve');
    await fs.rename(stack, path.join(root, 'previous'));
    await fs.mkdir(stack);
    assert.equal(await withStackControl('local', async () => 'nested'), 'nested');
  });
  assert.equal(await fs.readFile(path.join(root, 'previous', 'saved.txt'), 'utf8'), 'preserve');
  await assert.rejects(fs.access(path.join(stack, 'runtime')), { code: 'ENOENT' });
  assert.ok((await fs.stat(dkbFileLockPath(stackControlRoot('local'), 'stack-control'))).isFile());
});

test('same Stack contenders reject without affecting another Stack or the admitted operation', async t => {
  await fixture(t);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const first = withStackControl('same', async () => { entered.resolve(); await release.promise; return 'first'; });
  try {
    await entered.promise;
    await assert.rejects(withStackControl('same', async () => assert.fail('second admitted')), { code: 'stack_busy' });
    assert.equal(await withStackControl('other', async () => 'independent'), 'independent');
  } finally { release.resolve(); }
  assert.equal(await first, 'first');
  assert.equal(await withStackControl('same', async () => 'next'), 'next');
});

test('admission cancellation does not release another Stack owner and operation errors are retained', async t => {
  await fixture(t);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const owner = withStackControl('cancel', async () => { entered.resolve(); await release.promise; });
  try {
    await entered.promise;
    const cancellation = new AbortController(), reason = new Error('cancel admission');
    const waiter = withStackControl('cancel', async () => assert.fail('cancelled admission'), { timeoutMs: 5000, signal: cancellation.signal });
    cancellation.abort(reason);
    await assert.rejects(waiter, error => error === reason);
    await assert.rejects(withStackControl('cancel', async () => {}), { code: 'stack_busy' });
  } finally { release.resolve(); await owner; }
  const primary = new Error('keep primary failure');
  await assert.rejects(withStackControl('cancel', async () => { throw primary; }), error => error === primary);
  await withStackControl('cancel', async () => {});
});

test('confirmed process death releases Stack ownership without deleting a lease or opening Runtime state', { timeout: 20000 }, async t => {
  const root = await fixture(t);
  const moduleUrl = new URL('../apps/cli/dist/stack/control.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {withStackControl} from ${JSON.stringify(moduleUrl)};
    await withStackControl('crash', async () => {
      process.stdout.write('owned\\n');
      await new Promise(() => setInterval(() => {}, 1000));
    });
  `], { shell: false, windowsHide: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'exit');
  try {
    const ready = await Promise.race([once(child.stdout, 'data'), closed.then(() => { throw new Error('owner exited early'); })]);
    assert.match(ready[0].toString(), /owned/u);
    const lease = dkbFileLockPath(stackControlRoot('crash'), 'stack-control');
    const before = await fs.stat(lease, { bigint: true });
    await assert.rejects(withStackControl('crash', async () => assert.fail('live owner bypassed')), { code: 'stack_busy' });
    child.kill('SIGKILL');
    await closed;
    assert.equal(await withStackControl('crash', async () => 'reacquired'), 'reacquired');
    assert.equal((await fs.stat(lease, { bigint: true })).ino, before.ino);
    await assert.rejects(fs.access(path.join(root, 'crash')), { code: 'ENOENT' });
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; } }
});
