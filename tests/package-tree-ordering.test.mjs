import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { hashPortablePackageTree } from '@sjshovan/dkb-library/packageTree.js';

test('portable package trees use byte-order sorting across compiler and installer platforms', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-package-tree-order-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const fixtures = new Map([
    ['README.md', 'upper'],
    ['apps/console.md', 'lower'],
    ['apps/CLI.md', 'mixed'],
  ]);
  for (const [relative, contents] of fixtures) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }

  const entries = [...fixtures.entries()]
    .map(([entryPath, contents]) => ({
      path: entryPath,
      hash: `sha256:${createHash('sha256').update(contents).digest('hex')}`,
    }))
    .sort((left, right) => Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')));

  const tree = await hashPortablePackageTree(root);
  assert.deepEqual(tree.files, entries.map((entry) => entry.path));
  assert.equal(tree.hash, stableHash(entries));
});
