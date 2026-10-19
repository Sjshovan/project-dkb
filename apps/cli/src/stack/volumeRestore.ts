import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { x as extractTar } from 'tar';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { admitSnapshotEntry, assertSnapshotManifestEntry, VolumeSnapshotVerifier } from './volumeSnapshotStream.js';
import { SNAPSHOT_MANIFEST, snapshotRoots, scanSnapshot, snapshotError, type SnapshotLimits, type VolumeSnapshot } from './volumeSnapshotInventory.js';

/**
 * Verify into empty owner-local staging only. Does not change bindings, inventory,
 * active volumes or original data. Caller retains unsuccessful staging until the
 * worker is confirmed stopped; promotion is a separate host control transaction.
 */
export async function stageStackVolumeRestore(archive: string, destination: string, expectedSha256: string,
  limits: SnapshotLimits, signal?: AbortSignal): Promise<VolumeSnapshot> {
  signal?.throwIfAborted();
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) throw snapshotError('Restore requires the exact archive checksum.');
  const source = path.resolve(archive), root = path.resolve(destination);
  const nested = path.relative(root, source);
  if (!nested || (!nested.startsWith(`..${path.sep}`) && nested !== '..' && !path.isAbsolute(nested))) throw snapshotError('Restore input must be outside its staging tree.');
  const handle = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limits.maxArchiveBytes) throw snapshotError('Restore input is not a bounded regular archive.');
    const hash = createHash('sha256'), verifier = new VolumeSnapshotVerifier(limits);
    await pipeline(handle.createReadStream({ autoClose: false }), verifier,
      new Writable({ write(bytes, _encoding, done) { hash.update(bytes); done(); } }), { signal });
    const snapshot = verifier.result();
    if (hash.digest('hex') !== expectedSha256) throw snapshotError('Restore archive checksum mismatch. No staging file was written.');
    await assertEmptySnapshotStage(root, snapshot);
    // tar owns extraction mechanics. Cancellation stops admission of new entries
    // but drains pending writes before returning, so no in-process writer escapes.
    let cancelled = signal?.aborted ?? false, rejection: unknown;
    const expectedEntries = new Map(snapshot.entries.map(entry => [entry.path, entry])), seen = new Set<string>();
    let manifestSeen = false;
    const abort = () => { cancelled = true; };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const extractor = extractTar({ cwd: root, strict: true, preservePaths: false, unlink: false,
        maxMetaEntrySize: 16 * 1024, maxDecompressionRatio: Infinity,
        preserveOwner: process.platform === 'linux', chmod: true,
        filter: (_name, entry) => {
          if (cancelled || rejection) return false;
          try {
            if (!('type' in entry)) throw snapshotError('Restore requires archive entry metadata.');
            if (!manifestSeen) { assertSnapshotManifestEntry(entry); manifestSeen = true; }
            else {
              const admitted = admitSnapshotEntry(entry, expectedEntries, seen, snapshot.storage); seen.add(admitted.path);
              // Materialize validated relative links last. node-tar deliberately
              // refuses links targeting another link, even a contained chain.
              if (admitted.type === 'symlink') return false;
            }
            return true;
          } catch (error) { rejection = error; return false; }
        } });
      // Reuse the same file descriptor and verify the second stream too. A path
      // replacement cannot redirect extraction, nor can repeated compressed
      // metadata bypass the expanded-byte limit after the first pass.
      const secondPass = new VolumeSnapshotVerifier(limits);
      await pipeline(handle.createReadStream({ autoClose: false, start: 0, end: before.size - 1 }), secondPass, extractor);
      if (stableHash(secondPass.result()) !== stableHash(snapshot)) throw snapshotError('Snapshot inventory changed between verification and extraction.');
      signal?.throwIfAborted();
      if (rejection) throw rejection;
      if (seen.size !== expectedEntries.size) throw snapshotError('Restore omitted expected files. Staging was not activated.');
    } finally { signal?.removeEventListener('abort', abort); }
    const after = await handle.stat(), current = await fs.lstat(source);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || current.isSymbolicLink() || current.ino !== before.ino || current.size !== before.size
      || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) throw snapshotError('Restore archive changed while being read.', 'stack_snapshot_changed');
    // tar creates regular files through the process umask even with chmod:true
    // (that option governs directories). Restore exact admitted Linux mode bits
    // through a no-follow descriptor; otherwise a 0777 source becomes 0755.
    if (process.platform === 'linux') for (const entry of snapshot.entries.filter(item => item.type === 'file')) {
      signal?.throwIfAborted();
      const file = await fs.open(path.join(root, entry.path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== entry.size) throw snapshotError('Restored file disagrees with the inventory.');
        if ((stat.mode & 0o1777) !== entry.mode) await file.chmod(entry.mode);
      } finally { await file.close(); }
    }
    for (const entry of snapshot.entries.filter(item => item.type === 'symlink')) {
      signal?.throwIfAborted();
      // Parents were admitted only as real directories; no links exist until
      // this phase, and manifest validation forbids children beneath a link.
      await fs.symlink(entry.link!, path.join(root, entry.path));
    }
    // node-tar does not restore symlink ownership/timestamps, and adding children
    // changes directory times. These operations never follow a symbolic link.
    for (const entry of snapshot.entries.filter(item => item.type !== 'file').reverse()) {
      const file = path.join(root, entry.path), stat = await fs.lstat(file);
      if (entry.type === 'symlink') {
        if (!stat.isSymbolicLink() || await fs.readlink(file) !== entry.link) throw snapshotError('Restored link disagrees with the inventory.');
        if (process.platform === 'linux' && (stat.uid !== entry.uid || stat.gid !== entry.gid)) await fs.lchown(file, entry.uid, entry.gid);
        await fs.lutimes(file, entry.mtime, entry.mtime);
      } else {
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw snapshotError('Restored directory disagrees with the inventory.');
        await fs.utimes(file, entry.mtime, entry.mtime);
      }
    }
    const restored = await scanSnapshot(root, snapshot.storage, limits, signal);
    if (restored.bytes !== snapshot.bytes || stableHash(restored.entries) !== stableHash(snapshot.entries)) throw snapshotError('Restored bytes, permissions or ownership do not match the archive. Staging was not activated.');
    if (await fs.readFile(path.join(root, SNAPSHOT_MANIFEST), 'utf8').then(JSON.parse).then(stableHash) !== stableHash(snapshot)) throw snapshotError('Restored snapshot inventory changed.');
    return snapshot;
  } finally { await handle.close(); }
}

async function assertEmptySnapshotStage(root: string, snapshot: VolumeSnapshot): Promise<void> {
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await fs.realpath(root) !== root) throw snapshotError('Restore staging must be an existing real directory.');
  const allowed = new Set(['host', 'volumes']);
  if ((await fs.readdir(root)).some(name => !allowed.has(name))) throw snapshotError('Restore staging contains existing data. Nothing was replaced.');
  const volumes = path.join(root, 'volumes'), stat = await fs.lstat(volumes);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw snapshotError('Restore volume staging must not be a link.');
  const roles = Object.keys(snapshot.storage.volumes).sort();
  if ((await fs.readdir(volumes)).sort().join(',') !== roles.join(',')) throw snapshotError('Restore requires one empty staging mount for every recorded volume.');
  for (const base of snapshotRoots(snapshot.storage)) {
    const file = path.join(root, base), stat = await fs.lstat(file);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(file) !== file || (await fs.readdir(file)).length) throw snapshotError('Restore staging contains existing data or linked storage. Nothing was replaced.');
  }
}
