import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertDkbFileLock, withDkbFileLock } from '@sjshovan/dkb-library/locks.js';
import { withLibraryMutation } from '@sjshovan/dkb-library/mutation.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-library-lock-authority-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('shared read ownership cannot assert or inherit exclusive mutation authority', async (t) => {
  const root = await fixture(t);
  let mutations = 0;
  await withDkbFileLock(root, 'library-state', async () => {
    assertDkbFileLock(root, 'library-state', 'read');
    assert.throws(() => assertDkbFileLock(root, 'library-state'), { code: 'library_mutation_required' });
    await withDkbFileLock(root, 'library-state', async () => {
      assertDkbFileLock(root, 'library-state', 'read');
    }, { purpose: 'read' });
    await assert.rejects(withDkbFileLock(root, 'library-state', async () => { mutations++; }), { code: 'library_mutation_required' });
    await assert.rejects(withLibraryMutation(root, async () => { mutations++; }), { code: 'library_mutation_required' });
    await assert.rejects(fs.access(path.join(root, '.dkb', 'state.sqlite')), { code: 'ENOENT' });
  }, { purpose: 'read' });
  assert.equal(mutations, 0);
  await withDkbFileLock(root, 'library-state', async () => { mutations++; });
  assert.equal(mutations, 1, 'rejecting the upgrade releases ownership normally');
});

test('exclusive ownership admits nested reads without losing exclusive authority', async (t) => {
  const root = await fixture(t);
  await withDkbFileLock(root, 'library-state', async () => {
    await withDkbFileLock(root, 'library-state', async () => {
      assertDkbFileLock(root, 'library-state', 'read');
      assertDkbFileLock(root, 'library-state');
    }, { purpose: 'read' });
    assertDkbFileLock(root, 'library-state');
  });
});
