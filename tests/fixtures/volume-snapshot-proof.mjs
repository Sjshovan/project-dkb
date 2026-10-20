import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { withDkbFileLock } from '@sjshovan/dkb-library/locks.js';

const root = '/snapshot';
if (process.argv[2] === 'diagnose-restore') {
  const { createReadStream } = await import('node:fs');
  const { Writable } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');
  const { VolumeSnapshotVerifier } = await import('/workspace/apps/cli/dist/stack/volumeSnapshotStream.js');
  const { scanSnapshot } = await import('/workspace/apps/cli/dist/stack/volumeSnapshotInventory.js');
  const limits = { maxBytes: 8 * 1024 * 1024, maxArchiveBytes: 10 * 1024 * 1024, maxEntries: 2000 };
  const verifier = new VolumeSnapshotVerifier(limits);
  await pipeline(createReadStream('/input/archive'), verifier, new Writable({ write(_bytes, _encoding, done) { done(); } }));
  const expected = verifier.result(), actual = await scanSnapshot(root, expected.storage, limits);
  console.log(JSON.stringify({ differences: expected.entries.flatMap(entry => {
    const restored = actual.entries.find(item => item.path === entry.path);
    return JSON.stringify(restored) === JSON.stringify(entry) ? [] : [{ expected: entry, restored }];
  }).slice(0, 20) }));
  process.exit(0);
}
if (process.argv[2] === 'seed') {
  await fs.mkdir(`${root}/volumes/library/.dkb`, { recursive: true });
  const db = new DatabaseSync(`${root}/volumes/library/.dkb/state.sqlite`);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('WHALE-BUBBLE-73')"); db.close();
  await fs.writeFile(`${root}/volumes/library/source.txt`, 'SAFE-SOURCE-91\n');
  await fs.writeFile(`${root}/volumes/runtime/activation-fixture.json`, JSON.stringify({ marker: 'RUNTIME-MOUNT-28' }));
  await fs.writeFile(`${root}/host/stack.env`, 'SYNTHETIC_SECRET=only-a-fixture\n', { mode: 0o600 });
  await fs.mkdir(`${root}/volumes/cache/blobs`); await fs.mkdir(`${root}/volumes/cache/snapshots`);
  await fs.writeFile(`${root}/volumes/cache/blobs/data`, 'cached fixture', { mode: 0o640 });
  await fs.chown(`${root}/volumes/cache/blobs/data`, 33, 33);
  await fs.symlink('../blobs/data', `${root}/volumes/cache/snapshots/model`);
  await fs.lchown(`${root}/volumes/cache/snapshots/model`, 33, 33);
  await fs.link(`${root}/volumes/cache/blobs/data`, `${root}/volumes/cache/blobs/data-alias`);
} else if (process.argv[2] === 'hold') {
  await withDkbFileLock(`${root}/volumes/library`, 'library-mutation', () => new Promise(resolve => {
    const timer = setInterval(() => {}, 1000);
    process.once('SIGTERM', () => { clearInterval(timer); resolve(); });
    console.log(JSON.stringify({ ownership: 'held' }));
  }));
} else if (process.argv[2] !== 'inspect') throw new Error('Unknown fixture action');
const db = new DatabaseSync(`${root}/volumes/library/.dkb/state.sqlite`, { readOnly: true });
try {
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(db.prepare('SELECT value FROM proof').get().value, 'WHALE-BUBBLE-73');
} finally { db.close(); }
assert.equal(await fs.readFile(`${root}/volumes/library/source.txt`, 'utf8'), 'SAFE-SOURCE-91\n');
assert.equal(JSON.parse(await fs.readFile(`${root}/volumes/runtime/activation-fixture.json`, 'utf8')).marker, 'RUNTIME-MOUNT-28');
assert.equal(await fs.readFile(`${root}/volumes/cache/snapshots/model`, 'utf8'), 'cached fixture');
assert.equal((await fs.lstat(`${root}/volumes/cache/snapshots/model`)).uid, 33);
assert.equal((await fs.stat(`${root}/volumes/cache/blobs/data`)).ino, (await fs.stat(`${root}/volumes/cache/blobs/data-alias`)).ino);
console.log(JSON.stringify({ sqlite: 'ok', source: 'ok', runtimeFixture: 'ok', cacheLinks: 'ok', serviceOwnership: 'ok' }));
