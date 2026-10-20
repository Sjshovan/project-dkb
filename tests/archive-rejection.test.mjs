import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { c as createTar } from 'tar';

const execute = promisify(execFile);

async function fixture(t, linked) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-archive-rejection-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'package'), outside = path.join(root, 'outside');
  await fs.mkdir(source);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(source, 'package.json'), '{"name":"synthetic-archive","version":"1.0.0"}');
  await fs.writeFile(path.join(outside, 'keep.txt'), 'preserve outside state');
  if (linked) await fs.symlink(outside, path.join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const archive = path.join(root, 'archive.tgz');
  await createTar({ cwd: root, file: archive, gzip: true }, ['package']);
  return { root, archive, outside, target: path.join(root, 'extracted') };
}

// Separate processes prove that async tar callbacks reject to the caller rather
// than escaping as an uncaught exception (which bypasses caller cleanup).
async function caughtRejection(source) {
  const result = await execute(process.execPath, ['--input-type=module', '-e', source], {
    cwd: path.resolve('.'), windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.stdout.trim(), 'rejection caught; caller cleanup completed');
}

test('malformed knowledge archive rejects to its caller and permits staging cleanup', async t => {
  const f = await fixture(t, true);
  await caughtRejection(`
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import {extractDkbPackageArchive} from '@sjshovan/dkb-library/archive.js';
    try {
      await assert.rejects(extractDkbPackageArchive(${JSON.stringify(f.archive)}, ${JSON.stringify(f.target)}), /link entry/);
    } finally { await fs.rm(${JSON.stringify(f.target)}, {recursive:true, force:true}); }
    console.log('rejection caught; caller cleanup completed');
  `);
  await assert.rejects(fs.access(f.target), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.outside, 'keep.txt'), 'utf8'), 'preserve outside state');
});

test('malformed npm archive inspection rejects to the release operation without an uncaught exception', async t => {
  const f = await fixture(t, true);
  await caughtRejection(`
    import assert from 'node:assert/strict';
    import {inspectPackageArchive} from ${JSON.stringify(new URL('../scripts/package-distribution.mjs', import.meta.url).href)};
    await assert.rejects(inspectPackageArchive(${JSON.stringify(f.archive)}), /unsupported SymbolicLink/);
    console.log('rejection caught; caller cleanup completed');
  `);
  assert.equal(await fs.readFile(path.join(f.outside, 'keep.txt'), 'utf8'), 'preserve outside state');
});

test('extract progress callback failures settle through the same rejection and cleanup path', async t => {
  const f = await fixture(t, false);
  await caughtRejection(`
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import {extractDkbPackageArchive} from '@sjshovan/dkb-library/archive.js';
    const failure = new Error('synthetic progress failure'); let events = 0;
    try {
      await assert.rejects(extractDkbPackageArchive(${JSON.stringify(f.archive)}, ${JSON.stringify(f.target)}, {
        progress() { if (++events === 2) throw failure; },
      }), error => error === failure);
    } finally { await fs.rm(${JSON.stringify(f.target)}, {recursive:true, force:true}); }
    console.log('rejection caught; caller cleanup completed');
  `);
  await assert.rejects(fs.access(f.target), { code: 'ENOENT' });
});

test('expanded archive bytes are bounded before an oversized file is written', async t => {
  const f = await fixture(t, false);
  const source = path.join(f.root, 'payload');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'first.txt'), 'small');
  await fs.writeFile(path.join(source, 'large.txt'), Buffer.alloc(128 * 1024, 1));
  await createTar({ cwd: source, file: f.archive, gzip: true }, ['first.txt', 'large.txt']);
  await caughtRejection(`
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import {extractDkbPackageArchive} from '@sjshovan/dkb-library/archive.js';
    const target = ${JSON.stringify(f.target)};
    try {
      await assert.rejects(extractDkbPackageArchive(${JSON.stringify(f.archive)}, target, {
        limits: { maxExpandedBytes: 1024 },
      }), {code: 'archive_size_limit'});
      assert.equal(await fs.readFile(target + '/first.txt', 'utf8'), 'small');
      await assert.rejects(fs.access(target + '/large.txt'), {code: 'ENOENT'});
    } finally { await fs.rm(target, {recursive:true, force:true}); }
    console.log('rejection caught; caller cleanup completed');
  `);
  await assert.rejects(fs.access(f.target), { code: 'ENOENT' });
});

test('aggregate expansion and entry limits cannot be evaded by many small files', async t => {
  const f = await fixture(t, false);
  const source = path.join(f.root, 'payload');
  await fs.mkdir(source);
  for (const name of ['one', 'two', 'three']) await fs.writeFile(path.join(source, name), '123456');
  await createTar({ cwd: source, file: f.archive, gzip: true }, ['one', 'two', 'three']);
  const { extractDkbPackageArchive } = await import('@sjshovan/dkb-library/archive.js');
  await assert.rejects(extractDkbPackageArchive(f.archive, f.target, { limits: { maxExpandedBytes: 10 } }), { code: 'archive_size_limit' });
  await assert.rejects(fs.access(path.join(f.target, 'two')), { code: 'ENOENT' });
  await assert.rejects(extractDkbPackageArchive(f.archive, path.join(f.root, 'entries'), { limits: { maxEntries: 1 } }), { code: 'archive_entry_limit' });
  await assert.rejects(fs.access(path.join(f.root, 'entries', 'two')), { code: 'ENOENT' });
  const exact = path.join(f.root, 'exact');
  await extractDkbPackageArchive(f.archive, exact, { limits: { maxExpandedBytes: 18, maxEntries: 3 } });
  assert.equal(await fs.readFile(path.join(exact, 'three'), 'utf8'), '123456');
});

test('invalid extraction limits fail before making a destination', async t => {
  const f = await fixture(t, false);
  const { extractDkbPackageArchive } = await import('@sjshovan/dkb-library/archive.js');
  for (const limits of [null, { maxExpandedBytes: -1 }, { maxExpandedBytes: Infinity }, { maxEntries: 0 },
    { maxEntries: 1.5 }, { maxEntries: null }, { maxExpandedBytes: null }, { bypass: true }]) {
    await assert.rejects(extractDkbPackageArchive(f.archive, f.target, { limits }), { code: 'invalid_archive_limits' });
    await assert.rejects(fs.access(f.target), { code: 'ENOENT' });
  }
});

test('free-space budget rejects archive allocation and unknown capacity before writing payloads', async t => {
  const f = await fixture(t, false);
  const { extractDkbPackageArchive } = await import('@sjshovan/dkb-library/archive.js');
  // Capacity is an OS observation, not a caller-provided bypass. Inject it only
  // in this isolated test process; the extractor still uses its production guard.
  const capacity = t.mock.method(fs, 'statfs', async () => ({ bsize: 4096n, bavail: 1n }));
  await assert.rejects(extractDkbPackageArchive(f.archive, f.target), { code: 'archive_capacity_exceeded' });
  await assert.rejects(fs.access(path.join(f.target, 'package', 'package.json')), { code: 'ENOENT' });
  capacity.mock.mockImplementation(async () => { throw new Error('synthetic storage probe failed'); });
  await assert.rejects(extractDkbPackageArchive(f.archive, f.target), { code: 'archive_capacity_unavailable' });
});

test('duplicate entries spend the expansion budget again and implied directories spend capacity', async t => {
  const f = await fixture(t, false);
  const source = path.join(f.root, 'payload');
  await fs.mkdir(path.join(source, 'nested/deep'), { recursive: true });
  await fs.writeFile(path.join(source, 'same'), '123456');
  await fs.writeFile(path.join(source, 'nested/deep/empty'), '');
  await createTar({ cwd: source, file: f.archive, gzip: true }, ['same', 'same']);
  const { extractDkbPackageArchive } = await import('@sjshovan/dkb-library/archive.js');
  await assert.rejects(extractDkbPackageArchive(f.archive, f.target, { limits: { maxExpandedBytes: 10 } }), { code: 'archive_size_limit' });
  assert.equal(await fs.readFile(path.join(f.target, 'same'), 'utf8'), '123456');
  await createTar({ cwd: source, file: f.archive, gzip: true }, ['nested/deep/empty']);
  t.mock.method(fs, 'statfs', async () => ({ bsize: 4096n, bavail: 4n }));
  const emptyTarget = path.join(f.root, 'empty-target');
  await assert.rejects(extractDkbPackageArchive(f.archive, emptyTarget), { code: 'archive_capacity_exceeded' });
  await assert.rejects(fs.access(path.join(emptyTarget, 'nested')), { code: 'ENOENT' });
});
