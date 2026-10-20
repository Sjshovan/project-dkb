import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withRuntimeMutation, withRuntimeQuery } from '@sjshovan/dkb-runtime/runtime/mutation.js';

test('Runtime mutation waits for an in-flight query and blocks later queries', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-runtime-gate-proof-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const events = [];
  let releaseFirstQuery;
  let reportFirstQuery;
  const firstStarted = new Promise(resolve => { reportFirstQuery = resolve; });
  const firstQuery = withRuntimeQuery(root, async () => {
    events.push('query-1-start');
    await new Promise((resolve) => { releaseFirstQuery = resolve; reportFirstQuery(); });
    events.push('query-1-end');
  });
  await firstStarted;
  const mutation = withRuntimeMutation(root, async () => {
    events.push('mutation-start');
    await nextTurn();
    events.push('mutation-end');
  });
  await nextTurn();
  const secondQuery = withRuntimeQuery(root, async () => {
    events.push('query-2');
  });
  await nextTurn();

  assert.deepEqual(events, ['query-1-start']);
  releaseFirstQuery();
  await Promise.all([firstQuery, mutation, secondQuery]);
  assert.deepEqual(events, ['query-1-start', 'query-1-end', 'mutation-start', 'mutation-end', 'query-2']);
});

test('independent Runtime roots do not share a mutation gate', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-runtime-gate-independent-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const left = path.join(root, 'left');
  const right = path.join(root, 'right');
  await fs.mkdir(right);
  let releaseMutation;
  let markMutationStarted;
  const mutationStarted = new Promise((resolve) => { markMutationStarted = resolve; });
  const mutation = withRuntimeMutation(left, () => {
    markMutationStarted();
    return new Promise((resolve) => { releaseMutation = resolve; });
  });
  await mutationStarted;
  let rightCompleted = false;
  await withRuntimeQuery(right, async () => { rightCompleted = true; });
  assert.equal(rightCompleted, true);
  releaseMutation();
  await mutation;
});

test('Runtime mutation is reentrant and releases its persistent native lease', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-runtime-gate-reentrant-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const events = [];

  await withRuntimeMutation(root, async () => {
    events.push('outer');
    await withRuntimeMutation(root, async () => { events.push('inner'); });
  });

  assert.deepEqual(events, ['outer', 'inner']);
  await assert.rejects(fs.access(path.join(root, '.dkb', 'locks', 'runtime-mutation.lock')), (error) => error?.code === 'ENOENT');
  assert.equal((await fs.stat(path.join(root, '.dkb', 'locks', 'runtime-mutation.lease.sqlite'))).isFile(), true);
});

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}
