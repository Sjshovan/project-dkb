import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { withRuntimeMutation, withRuntimeQuery } from '@sjshovan/dkb-runtime/runtime/mutation.js';

test('Runtime mutation waits for an in-flight query and blocks later queries', async () => {
  const root = path.resolve('runtime-gate-proof');
  const events = [];
  let releaseFirstQuery;
  const firstQuery = withRuntimeQuery(root, async () => {
    events.push('query-1-start');
    await new Promise((resolve) => { releaseFirstQuery = resolve; });
    events.push('query-1-end');
  });
  await nextTurn();
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

test('independent Runtime roots do not share a mutation gate', async () => {
  const left = path.resolve('runtime-gate-left');
  const right = path.resolve('runtime-gate-right');
  let releaseMutation;
  const mutation = withRuntimeMutation(left, () => new Promise((resolve) => { releaseMutation = resolve; }));
  await nextTurn();
  let rightCompleted = false;
  await withRuntimeQuery(right, async () => { rightCompleted = true; });
  assert.equal(rightCompleted, true);
  releaseMutation();
  await mutation;
});

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}
