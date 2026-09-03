import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureFileSnapshot, assertFileSnapshotCurrent } from '@sjshovan/dkb-protocol/fileSnapshot.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-file-snapshot-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('file snapshots preserve unchanged reads and reject same-size edits with restored mtime', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'input.txt');
  await fs.writeFile(file, 'before');
  const stat = await fs.stat(file);
  const snapshot = await captureFileSnapshot([file]);
  await fs.readFile(file);
  await assertFileSnapshotCurrent(snapshot);
  await fs.writeFile(file, 'after!');
  await fs.utimes(file, stat.atime, stat.mtime);
  await assert.rejects(assertFileSnapshotCurrent(snapshot), { code: 'validated_input_changed' });
});

test('file snapshots detect missing override appearance, deletion, replacement, and directory additions', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'override.mjs');
  const absent = await captureFileSnapshot([file]);
  await assertFileSnapshotCurrent(absent);
  await fs.writeFile(file, 'version 1');
  await assert.rejects(assertFileSnapshotCurrent(absent), { code: 'validated_input_changed' });
  const present = await captureFileSnapshot([file]);
  await fs.unlink(file);
  await assert.rejects(assertFileSnapshotCurrent(present), { code: 'validated_input_changed' });
  await fs.writeFile(file, 'version 1');
  await assert.rejects(assertFileSnapshotCurrent(present), { code: 'validated_input_changed' });
  const directory = await captureFileSnapshot([root]);
  await fs.writeFile(path.join(root, 'new.mjs'), 'new');
  await assert.rejects(assertFileSnapshotCurrent(directory), { code: 'validated_input_changed' });
});

test('directory snapshots are shallow unless exact recursive build inputs are requested', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'nested'));
  const file = path.join(root, 'nested', 'index.bin');
  await fs.writeFile(file, 'index');
  const shallow = await captureFileSnapshot([root]);
  const recursive = await captureFileSnapshot([root], { recursive: true });
  await fs.writeFile(file, 'changed index');
  await assertFileSnapshotCurrent(shallow);
  await assert.rejects(assertFileSnapshotCurrent(recursive), { code: 'validated_input_changed' });
});

test('snapshot validation keeps bounded workers busy behind one slow filesystem observation', async (t) => {
  const root = await fixture(t);
  const files = Array.from({ length: 96 }, (_, index) => path.join(root, `input-${String(index).padStart(3, '0')}.txt`));
  await Promise.all(files.map((file) => fs.writeFile(file, 'evidence')));
  const snapshot = await captureFileSnapshot(files);
  const original = fs.lstat.bind(fs);
  const blocked = Promise.withResolvers();
  const progressed = Promise.withResolvers();
  let active = 0;
  let maximum = 0;
  let count = 0;
  t.mock.method(fs, 'lstat', async (file, options) => {
    if (!files.includes(file)) return original(file, options);
    active += 1;
    maximum = Math.max(maximum, active);
    count += 1;
    if (count === 64) progressed.resolve();
    try {
      if (file === files[0]) await blocked.promise;
      return await original(file, options);
    } finally { active -= 1; }
  });
  const validating = assertFileSnapshotCurrent(snapshot);
  let timer;
  try {
    await Promise.race([
      progressed.promise,
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Snapshot workers stopped behind a batch barrier')), 2_000); }),
    ]);
    assert.ok(maximum <= 32);
    assert.ok(count >= 64);
  } finally {
    clearTimeout(timer);
    blocked.resolve();
    await validating;
  }
  assert.equal(count, files.length);
});
