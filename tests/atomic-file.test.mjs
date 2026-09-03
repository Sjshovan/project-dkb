import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { replaceFileAtomically } from '@sjshovan/dkb-protocol/atomicFile.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-atomic-file-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'config.json');
  await fs.writeFile(destination, 'old complete document');
  const stages = await Promise.all(['first', 'second'].map(async (name) => {
    const staged = path.join(root, `${name}.tmp`);
    await fs.writeFile(staged, `${name} complete document`);
    return staged;
  }));
  return { root, destination, stages };
}

test('atomic promotions serialize one destination without blocking other destinations', async (t) => {
  const { destination, stages } = await fixture(t);
  const otherDestination = path.join(path.dirname(destination), 'other.json');
  const otherStage = path.join(path.dirname(destination), 'other.tmp');
  await fs.writeFile(otherStage, 'other complete document');
  const rename = fs.rename.bind(fs);
  let enteredFirst;
  const firstEntered = new Promise((resolve) => { enteredFirst = resolve; });
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const entered = [];
  t.mock.method(fs, 'rename', async (from, to) => {
    entered.push(from);
    if (from === stages[0]) {
      enteredFirst();
      await firstGate;
    }
    return rename(from, to);
  });
  const first = replaceFileAtomically(stages[0], destination);
  await firstEntered;
  const second = replaceFileAtomically(stages[1], destination);
  try {
    await replaceFileAtomically(otherStage, otherDestination);
    assert.deepEqual(entered, [stages[0], otherStage]);
    assert.equal(await fs.readFile(destination, 'utf8'), 'old complete document');
  } finally {
    releaseFirst();
    await Promise.all([first, second]);
  }
  assert.deepEqual(entered, [stages[0], otherStage, stages[1]]);
  assert.equal(await fs.readFile(destination, 'utf8'), 'second complete document');
});

test('a failed atomic promotion releases its queue and never deletes caller-owned staging', async (t) => {
  const { destination, stages } = await fixture(t);
  const rename = fs.rename.bind(fs);
  const failure = Object.assign(new Error('permanent fixture failure'), { code: 'EINVAL' });
  t.mock.method(fs, 'rename', async (from, to) => {
    if (from === stages[0]) throw failure;
    return rename(from, to);
  });
  const results = await Promise.allSettled(stages.map((staged) => replaceFileAtomically(staged, destination)));
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[0].reason, failure);
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(await fs.readFile(stages[0], 'utf8'), 'first complete document');
  assert.equal(await fs.readFile(destination, 'utf8'), 'second complete document');
});

test('Windows promotion survives a reader denial beyond the old retry window', { skip: process.platform !== 'win32' }, async (t) => {
  const { destination, stages } = await fixture(t);
  const rename = fs.rename.bind(fs);
  const started = performance.now();
  let attempts = 0;
  t.mock.method(fs, 'rename', async (from, to) => {
    attempts++;
    if (performance.now() - started < 350) {
      assert.equal(await fs.readFile(destination, 'utf8'), 'old complete document');
      throw Object.assign(new Error('fixture reader holds destination'), { code: 'EPERM' });
    }
    return rename(from, to);
  });
  await replaceFileAtomically(stages[0], destination);
  assert.ok(attempts > 8);
  assert.equal(await fs.readFile(destination, 'utf8'), 'first complete document');
});

test('permanent Windows denial is bounded and leaves both complete files recoverable', { skip: process.platform !== 'win32' }, async (t) => {
  const { destination, stages } = await fixture(t);
  const failure = Object.assign(new Error('fixture permission denied'), { code: 'EACCES' });
  let attempts = 0;
  t.mock.method(fs, 'rename', async () => { attempts++; throw failure; });
  const started = performance.now();
  await assert.rejects(replaceFileAtomically(stages[0], destination), (error) => error === failure);
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 1_900 && elapsed < 5_000, `denial remained bounded: ${elapsed} ms`);
  assert.ok(attempts > 8);
  assert.equal(await fs.readFile(destination, 'utf8'), 'old complete document');
  assert.equal(await fs.readFile(stages[0], 'utf8'), 'first complete document');
  const settledAttempts = attempts;
  await sleep(30);
  assert.equal(attempts, settledAttempts, 'no retry continues after rejection');
});

test('atomic promotion rejects an identical target or a non-sibling stage without moving files', async (t) => {
  const { destination, stages } = await fixture(t);
  await assert.rejects(replaceFileAtomically(destination, destination), /distinct sibling paths/);
  await assert.rejects(replaceFileAtomically(path.join(path.dirname(stages[0]), 'nested', 'stage.tmp'), destination), /distinct sibling paths/);
  assert.equal(await fs.readFile(destination, 'utf8'), 'old complete document');
  assert.equal(await fs.readFile(stages[0], 'utf8'), 'first complete document');
});
