import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { packDistribution } from '../scripts/package-distribution.mjs';
import { executePackageCommand } from '../scripts/lib/package-command.mjs';

test('already-aborted packaging neither creates output nor starts a subprocess', async (t) => {
  const root = await scratch(t);
  const marker = path.join(root, 'must-not-exist');
  const reason = new Error('Cancelled before packaging');
  const signal = AbortSignal.abort(reason);
  const operation = executePackageCommand(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected');`], { signal });
  await assert.rejects(operation, (error) => error === reason);
  assert.equal(operation.child, undefined);
  const output = path.join(root, 'candidates');
  await assert.rejects(packDistribution({ outputDirectory: output, signal }), (error) => error === reason);
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
  await assert.rejects(fs.access(output), { code: 'ENOENT' });
});

test('mid-child cancellation settles only after close, before cleanup and any delayed writes', { timeout: 10_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-package-cancel-'));
  const ready = path.join(root, 'ready');
  const controller = new AbortController();
  const signal = AbortSignal.any([t.signal, controller.signal]);
  let operation;
  t.after(async () => {
    controller.abort();
    await operation?.catch(() => {});
    await removeScratch(root);
  });
  operation = executePackageCommand(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const root = ${JSON.stringify(root)};
    const late = setTimeout(() => {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(root + '/late-write', 'unexpected');
    }, 1000);
    process.on('SIGTERM', () => setTimeout(() => {
      clearTimeout(late);
      fs.writeFileSync(root + '/drained', 'process finished before cleanup');
      process.exit(0);
    }, 100));
    fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
    setInterval(() => {}, 1000);
  `], { cwd: root, windowsHide: true, signal, timeout: 5_000 });
  let closed = false;
  operation.child.once('close', () => { closed = true; });
  // Handle rejection immediately; capture close at settlement rather than at a
  // later assertion that could hide the callback/close race.
  const settled = operation.then(
    () => ({ succeeded: true, closed }),
    (error) => ({ succeeded: false, error, closed }),
  );
  await waitForFile(ready, signal);
  controller.abort(new Error('Cancel active native package work'));
  const result = await settled;
  assert.equal(result.succeeded, false);
  assert.equal(result.error.code, 'ABORT_ERR');
  assert.equal(result.closed, true, 'the aborted execFile callback is not the child close boundary');
  assert.equal(closed, true);
  assert.ok(operation.child.exitCode !== null || operation.child.signalCode);
  await removeScratch(root);
  await delay(150);
  await assert.rejects(fs.access(root), { code: 'ENOENT' }, 'no child can recreate its removed fixture');
});

test('per-command timeout and failure output remain bounded and close-safe', { timeout: 10_000 }, async () => {
  const timeout = executePackageCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { windowsHide: true, timeout: 250 });
  let closed = false;
  timeout.child.once('close', () => { closed = true; });
  await assert.rejects(timeout, (error) => { assert.equal(error.killed, true); assert.equal(closed, true); return true; });
  await assert.rejects(executePackageCommand(process.execPath, ['-e', 'process.stdout.write("output"); process.stderr.write("failure"); process.exitCode = 3;'], { windowsHide: true, timeout: 5_000 }), (error) => {
    assert.equal(error.code, 3);
    assert.equal(error.stdout, 'output');
    assert.equal(error.stderr, 'failure');
    return true;
  });
});

async function scratch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-package-cancel-'));
  t.after(() => removeScratch(root));
  return root;
}

async function removeScratch(root) {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('dkb-package-cancel-'));
  await fs.rm(root, { recursive: true, force: true });
}

async function waitForFile(filename, signal) {
  const deadline = performance.now() + 4_000;
  while (performance.now() < deadline) {
    signal.throwIfAborted();
    try { await fs.access(filename); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(10, undefined, { signal });
  }
  throw new Error('Synthetic package child did not become ready before its deadline.');
}
