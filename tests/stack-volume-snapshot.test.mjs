import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream, createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import { c as createTar } from 'tar';
import { withDkbFileLock } from '@sjshovan/dkb-library/locks.js';
import { createStackVolumeSnapshot } from '../apps/cli/dist/stack/volumeSnapshot.js';
import { stageStackVolumeRestore } from '../apps/cli/dist/stack/volumeRestore.js';
import { VolumeSnapshotVerifier } from '../apps/cli/dist/stack/volumeSnapshotStream.js';
import { validateVolumeSnapshot } from '../apps/cli/dist/stack/volumeSnapshotInventory.js';

const limits = { maxBytes: 32 * 1024 * 1024, maxArchiveBytes: 40 * 1024 * 1024, maxEntries: 2000 };
const storage = { format: 'dkb.stack-storage.v1', name: 'test', id: '12345678-1234-1234-1234-123456789abc', phase: 'ready',
  owner: { context: 'desktop-linux', image: `sha256:${'a'.repeat(64)}`, libraryVolume: 'test-library', runtimeVolume: 'test-runtime', compilerVolume: 'test-compiler' },
  volumes: { library: 'test-library', runtime: 'test-runtime', compiler: 'test-compiler', cache: 'test-cache' },
  volumeEnvironment: { library: 'DKB_LIBRARY_VOLUME', runtime: 'DKB_RUNTIME_VOLUME', compiler: 'DKB_COMPILER_CONTEXT_VOLUME', cache: 'DKB_CACHE_VOLUME' },
  sharedLibrary: false };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-volume-snapshot-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), archive = path.join(root, 'backup.tgz');
  for (const name of ['host', ...Object.keys(storage.volumes).map(role => `volumes/${role}`)]) await fs.mkdir(path.join(source, name), { recursive: true });
  await fs.writeFile(path.join(source, 'host', 'stack.env'), 'LOCAL_SECRET=private-fixture\n', { mode: 0o600 });
  await fs.writeFile(path.join(source, 'volumes/library', 'source.txt'), 'Original knowledge\n');
  return { root, source, archive };
}
const discard = () => new Writable({ write(_chunk, _encoding, next) { next(); } });
async function verify(archive, budget = limits) {
  const verifier = new VolumeSnapshotVerifier(budget);
  await pipeline(createReadStream(archive), verifier, discard());
  return verifier.result();
}
async function snapshot(f, output = createWriteStream(f.archive, { flags: 'wx', mode: 0o600 }), budget = limits, signal) {
  return createStackVolumeSnapshot(f.source, storage, output, budget, signal);
}
async function customArchive(f, manifest, names) {
  await fs.writeFile(path.join(f.source, 'snapshot.json'), JSON.stringify(manifest));
  await createTar({ cwd: f.source, file: f.archive, gzip: true, noDirRecurse: true,
    onWriteEntry: entry => { if (entry.path === 'snapshot.json') entry.stat.mode = 0o100600; } }, ['snapshot.json', ...(names ?? manifest.entries.map(entry => entry.path))]);
}
async function restoreStage(f, archive = f.archive) {
  const destination = path.join(f.root, 'restored');
  for (const name of ['host', ...Object.keys(storage.volumes).map(role => `volumes/${role}`)]) await fs.mkdir(path.join(destination, name), { recursive: true });
  const digest = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  return { destination, digest };
}

test('snapshot streams exact source, secret, empty directory and native lease bytes; permissions round-trip', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.source, 'volumes/library/empty'));
  const result = await snapshot(f);
  assert.deepEqual(await verify(f.archive), result);
  assert(result.entries.some(item => item.path === 'volumes/library/empty' && item.type === 'directory'));
  assert(result.entries.some(item => item.path.endsWith('/library-mutation.lease.sqlite')));
  assert.equal(await fs.readFile(path.join(f.source, 'volumes/library/source.txt'), 'utf8'), 'Original knowledge\n');
  await assert.rejects(fs.access(path.join(f.source, 'snapshot.json')), { code: 'ENOENT' });
  const { destination, digest } = await restoreStage(f);
  assert.deepEqual(await stageStackVolumeRestore(f.archive, destination, digest, limits), result);
  for (const entry of result.entries.filter(item => item.type === 'file')) {
    const content = await fs.readFile(path.join(destination, entry.path));
    assert.equal(createHash('sha256').update(content).digest('hex'), entry.sha256);
    if (process.platform === 'linux') assert.equal((await fs.stat(path.join(destination, entry.path))).mode & 0o1777, entry.mode);
  }
});

test('snapshot refuses a concurrent Runtime or nested package compile lease', async t => {
  const f = await fixture(t), packageRoot = path.join(f.source, 'volumes/library/vendor/acme/package');
  await fs.mkdir(packageRoot, { recursive: true });
  for (const [root, lock] of [[path.join(f.source, 'volumes/runtime'), 'runtime-mutation'], [packageRoot, 'compile'], [packageRoot, 'build-promotion']]) {
    // Distinct async ownership scope: re-entrant calls in the lock callback are intentionally permitted.
    let release, admitted;
    const ready = new Promise(resolve => { admitted = resolve; });
    const owned = withDkbFileLock(root, lock, () => new Promise(resolve => { release = resolve; admitted(); }));
    await ready;
    try { await assert.rejects(snapshot(f, discard()), { code: 'library_busy' }); }
    finally { release(); await owned; }
  }
});

test('snapshot verifies streamed content, respects backpressure, and rejects out-of-band mutation before completion', async t => {
  const f = await fixture(t), file = path.join(f.source, 'volumes/library/source.txt');
  let writes = 0;
  const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, next) {
    writes++;
    fs.writeFile(file, 'changed by an unsupported writer\n').then(() => setTimeout(next, 2), next);
  } });
  await assert.rejects(snapshot(f, output), error => ['stack_snapshot_changed', 'stack_snapshot_invalid'].includes(error.code));
  assert(writes > 0);
  await assert.rejects(fs.access(path.join(f.source, 'snapshot.json')), { code: 'ENOENT' });
});

test('snapshot cancellation and destination failure release ownership and remove only scratch metadata', async t => {
  const f = await fixture(t), controller = new AbortController();
  const output = new Writable({ write(_chunk, _encoding, next) { controller.abort(); next(); } });
  await assert.rejects(snapshot(f, output, limits, controller.signal), { name: 'AbortError' });
  const failed = new Writable({ write(_chunk, _encoding, next) { next(new Error('fixture output unavailable')); } });
  await assert.rejects(snapshot(f, failed), /fixture output unavailable/u);
  await assert.rejects(fs.access(path.join(f.source, 'snapshot.json')), { code: 'ENOENT' });
  await snapshot(f, discard());
  assert.equal(await fs.readFile(path.join(f.source, 'volumes/library/source.txt'), 'utf8'), 'Original knowledge\n');
});

test('uncompressed, archive, and inventory entry budgets are enforced', async t => {
  const f = await fixture(t);
  await assert.rejects(snapshot(f, discard(), { ...limits, maxBytes: 1 }), { code: 'stack_snapshot_capacity' });
  await assert.rejects(snapshot(f, discard(), { ...limits, maxEntries: 1 }), { code: 'stack_snapshot_invalid' });
  await assert.rejects(snapshot(f, discard(), { ...limits, maxArchiveBytes: 1 }), { code: 'stack_snapshot_capacity' });
});

test('stream verifier rejects altered contents, extra entries, duplicate entries, missing files and truncation', async t => {
  const f = await fixture(t);
  const manifest = await snapshot(f);
  for (const scenario of ['changed', 'extra', 'duplicate', 'missing']) {
    await fs.writeFile(path.join(f.source, 'volumes/library/source.txt'), scenario === 'changed' ? 'Altered! knowledge\n' : 'Original knowledge\n');
    // Preserve recorded mtime so integrity is proved by the content hash, not timestamps.
    const original = manifest.entries.find(item => item.path.endsWith('/source.txt'));
    await fs.utimes(path.join(f.source, original.path), original.mtime, original.mtime);
    const paths = manifest.entries.map(entry => entry.path);
    if (scenario === 'extra') { await fs.writeFile(path.join(f.source, 'extra.txt'), 'unlisted'); paths.push('extra.txt'); }
    if (scenario === 'duplicate') paths.push(original.path);
    if (scenario === 'missing') paths.splice(paths.indexOf(original.path), 1);
    await customArchive(f, manifest, paths);
    await assert.rejects(verify(f.archive), { code: 'stack_snapshot_invalid' });
  }
  await customArchive(f, manifest);
  const bytes = await fs.readFile(f.archive); await fs.writeFile(f.archive, bytes.subarray(0, bytes.length - 100));
  await assert.rejects(verify(f.archive), { code: 'stack_snapshot_invalid' });
});

test('manifest rejects path traversal, invalid metadata, duplicate roots and configuration drift', async t => {
  const f = await fixture(t), manifest = await snapshot(f);
  for (const change of [m => { m.entries[0].path = '../outside'; }, m => { m.entries[0].path = '/outside'; },
    m => { m.entries[0].mode = 0o4755; }, m => { m.entries[0].uid = -1; }, m => { m.bytes++; },
    m => { m.entries.push(m.entries[0]); }, m => { m.storage.owner.libraryVolume = 'different-volume'; },
    m => { m.entries[0].secret = 'unrecognized field'; }]) {
    const invalid = structuredClone(manifest); change(invalid);
    assert.throws(() => validateVolumeSnapshot(invalid, limits));
  }
});

test('archive handles internal cache symlinks and hard links without following outside a volume', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t), cache = path.join(f.source, 'volumes/cache');
  await fs.mkdir(path.join(cache, 'blobs')); await fs.mkdir(path.join(cache, 'snapshots/revision'), { recursive: true });
  await fs.writeFile(path.join(cache, 'blobs/hash'), 'cached model bytes');
  await fs.symlink('../../blobs/hash', path.join(cache, 'snapshots/revision/model'));
  await fs.symlink('model', path.join(cache, 'snapshots/revision/model-alias'));
  await fs.link(path.join(cache, 'blobs/hash'), path.join(cache, 'blobs/second'));
  const manifest = await snapshot(f); assert.deepEqual(await verify(f.archive), manifest);
  const { destination, digest } = await restoreStage(f);
  assert.deepEqual(await stageStackVolumeRestore(f.archive, destination, digest, limits), manifest);
  assert.equal(await fs.readFile(path.join(destination, 'volumes/cache/snapshots/revision/model'), 'utf8'), 'cached model bytes');
  assert.equal(await fs.readFile(path.join(destination, 'volumes/cache/snapshots/revision/model-alias'), 'utf8'), 'cached model bytes');
  const a = await fs.stat(path.join(destination, 'volumes/cache/blobs/hash')), b = await fs.stat(path.join(destination, 'volumes/cache/blobs/second'));
  assert.equal(a.ino, b.ino);
  await fs.symlink('../../../host/stack.env', path.join(cache, 'snapshots/leak'));
  await assert.rejects(snapshot(f, discard()), { code: 'stack_snapshot_invalid' });
});

test('manifest refuses dangling links and cycles before extraction', async t => {
  const f = await fixture(t), manifest = await snapshot(f);
  const base = manifest.entries.find(item => item.path === 'volumes/cache');
  const link = { ...base, path: 'volumes/cache/link', type: 'symlink', size: 0, link: 'absent' };
  manifest.entries.push(link);
  assert.throws(() => validateVolumeSnapshot(manifest, limits), /absent/u);
  link.link = 'link'; assert.throws(() => validateVolumeSnapshot(manifest, limits), /cyclic/u);
  link.link = 'a/../link'; assert.throws(() => validateVolumeSnapshot(manifest, limits), /metadata/u);
});

test('restore rejects checksum mismatch and nonempty destinations without replacing existing files', async t => {
  const f = await fixture(t); await snapshot(f);
  const { destination, digest } = await restoreStage(f), protectedFile = path.join(destination, 'volumes/library/protected.txt');
  await assert.rejects(stageStackVolumeRestore(f.archive, destination, '0'.repeat(64), limits), /checksum/u);
  assert.deepEqual(await fs.readdir(path.join(destination, 'host')), []);
  await fs.writeFile(protectedFile, 'Never replace this');
  await assert.rejects(stageStackVolumeRestore(f.archive, destination, digest, limits), /existing data/u);
  assert.equal(await fs.readFile(protectedFile, 'utf8'), 'Never replace this');
  assert.equal(await fs.readFile(path.join(f.source, 'volumes/library/source.txt'), 'utf8'), 'Original knowledge\n');
});

test('corrupt archive and cancelled restore never populate a staging volume', async t => {
  const f = await fixture(t); const manifest = await snapshot(f);
  await fs.writeFile(path.join(f.source, 'volumes/library/source.txt'), 'corrupt');
  await customArchive(f, manifest);
  const { destination, digest } = await restoreStage(f);
  await assert.rejects(stageStackVolumeRestore(f.archive, destination, digest, limits), { code: 'stack_snapshot_invalid' });
  assert.deepEqual(await fs.readdir(path.join(destination, 'host')), []);
  const cancelled = AbortSignal.abort();
  await assert.rejects(stageStackVolumeRestore(f.archive, destination, digest, limits, cancelled), { name: 'AbortError' });
  assert.deepEqual(await fs.readdir(path.join(destination, 'volumes/library')), []);
});

test('restore preserves service-owned file and link metadata on Linux', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t), cache = path.join(f.source, 'volumes/cache');
  const file = path.join(cache, 'owned'), link = path.join(cache, 'linked');
  await fs.writeFile(file, 'service data', { mode: 0o640 }); await fs.chown(file, 33, 33);
  // Docker Desktop projects Windows-hosted configuration as 0777. node-tar's
  // regular-file create is umask-filtered; exact restoration must repair it.
  const projected = path.join(f.source, 'host/stack.env');
  await fs.chmod(projected, 0o777);
  await fs.symlink('owned', link); await fs.lchown(link, 33, 33);
  await fs.utimes(file, 1_600_000_000, 1_600_000_000); await fs.lutimes(link, 1_600_000_000, 1_600_000_000);
  const manifest = await snapshot(f), { destination, digest } = await restoreStage(f);
  assert.deepEqual(await stageStackVolumeRestore(f.archive, destination, digest, limits), manifest);
  assert.equal((await fs.stat(path.join(destination, 'host/stack.env'))).mode & 0o777, 0o777);
  for (const name of ['owned', 'linked']) {
    const stat = await fs.lstat(path.join(destination, 'volumes/cache', name));
    assert.equal(stat.uid, 33); assert.equal(stat.gid, 33); assert.equal(stat.mtimeMs / 1000, 1_600_000_000);
  }
});
