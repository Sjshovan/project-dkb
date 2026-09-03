import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readDkbContextConfig, writeDkbContextConfig } from '@sjshovan/dkb-pipeline/config.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-pipeline-config-atomic-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, file: path.join(root, 'config.json') };
}

test('a failed Pipeline config promotion retains the exact old document and removes only its staged file', async (t) => {
  const { root, file } = await fixture(t);
  const original = { format: 'dkb.config.v2', activeTarget: 'operator-recipe' };
  await writeDkbContextConfig(file, original);
  const bytes = await fs.readFile(file);
  t.mock.method(fs, 'rename', async (_from, to) => {
    assert.equal(to, file);
    assert.deepEqual(await fs.readFile(file), bytes, 'old config remains present up to promotion');
    throw Object.assign(new Error('fixture promotion refused'), { code: 'EACCES' });
  });
  await assert.rejects(writeDkbContextConfig(file, { ...original, activeTarget: 'next' }), /fixture promotion refused/);
  assert.deepEqual(await fs.readFile(file), bytes);
  assert.deepEqual(await fs.readdir(root), ['config.json']);
});

test('concurrent complete Pipeline config replacements never expose an absent document or collide on staging names', async (t) => {
  const { root, file } = await fixture(t);
  const config = (index) => ({ format: 'dkb.config.v2', activeTarget: `recipe-${index}` });
  await writeDkbContextConfig(file, config(0));
  let finished = false;
  let reads = 0;
  const observe = (async () => {
    while (!finished) {
      const value = await readDkbContextConfig(file);
      assert.match(value.activeTarget, /^recipe-\d+$/, 'reader never resolves the empty fallback config');
      reads++;
    }
  })();
  try {
    await Promise.all(Array.from({ length: 32 }, (_, index) => writeDkbContextConfig(file, config(index + 1))));
  } finally {
    finished = true;
    await observe;
  }
  assert.ok(reads > 0);
  assert.deepEqual(await fs.readdir(root), ['config.json']);
  assert.match((await readDkbContextConfig(file)).activeTarget, /^recipe-\d+$/);
});
