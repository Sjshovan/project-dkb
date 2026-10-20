import fs from 'node:fs/promises';
import path from 'node:path';
import { type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { c as createTar } from 'tar';
import { withDkbFileLock } from '@sjshovan/dkb-library/locks.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { validateStackStorage, type StackStorage } from './ownedStorage.js';
import { SNAPSHOT_MANIFEST, SNAPSHOT_MANIFEST_LIMIT, scanSnapshot, snapshotError,
  type SnapshotLimits, type VolumeSnapshot, type SnapshotScan } from './volumeSnapshotInventory.js';
import { VolumeSnapshotVerifier } from './volumeSnapshotStream.js';

type LockName = Parameters<typeof withDkbFileLock>[1];
const names = new Set<LockName>(['library-mutation', 'library-state', 'build-promotion', 'runtime-mutation', 'compile', 'stack-control']);

/**
 * Runs inside the storage-owning environment with host/ and volumes/<role>/ mounted.
 * Caller holds Stack control and proves every consumer stopped. Destination is temporary;
 * only successful completion permits host-side archive promotion.
 */
export async function createStackVolumeSnapshot(root: string, value: StackStorage, output: Writable,
  limits: SnapshotLimits, signal?: AbortSignal): Promise<VolumeSnapshot> {
  const storage = validateStackStorage(value, value?.name);
  if (storage.phase !== 'ready') throw snapshotError('Only ready recorded storage can be snapshotted.');
  const resolved = path.resolve(root);
  const leases: Array<[string, LockName]> = [
    ['volumes/compiler', 'stack-control'], ['volumes/compiler', 'compile'],
    ['volumes/runtime', 'runtime-mutation'], ['volumes/library', 'library-mutation'], ['volumes/library', 'library-state'],
  ];
  const admit = async <T>(items: Array<[string, LockName]>, operation: () => Promise<T>): Promise<T> => {
    const first = items[0];
    if (!first) return operation();
    return withDkbFileLock(path.join(resolved, first[0]), first[1], () => admit(items.slice(1), operation),
      { timeoutMs: 0, purpose: 'mutation', signal });
  };
  return admit(leases, async () => {
    const discovered = await scanSnapshot(resolved, storage, limits, signal, false);
    const nested = nestedLeases(discovered).filter(item => !leases.some(outer => outer[0] === item[0] && outer[1] === item[1]));
    return admit(nested, async () => {
      const before = await scanSnapshot(resolved, storage, limits, signal);
      if (stableHash(nestedLeases(discovered)) !== stableHash(nestedLeases(before))) throw snapshotError('Build ownership changed during snapshot admission. Retry after operations stop.', 'stack_snapshot_changed');
      const manifest: VolumeSnapshot = { format: 'dkb.stack-volume-snapshot.v1', storage, entries: before.entries, bytes: before.bytes };
      const content = JSON.stringify(manifest);
      if (Buffer.byteLength(content) > SNAPSHOT_MANIFEST_LIMIT) throw snapshotError('Snapshot inventory exceeds its metadata budget.');
      const file = path.join(resolved, SNAPSHOT_MANIFEST);
      // This file belongs only to the fresh worker scratch root, never a mounted volume.
      await fs.writeFile(file, content, { flag: 'wx', mode: 0o600 });
      try {
        const verifier = new VolumeSnapshotVerifier(limits);
        const archive = createTar({ cwd: resolved, gzip: true, strict: true, follow: false, noDirRecurse: true,
          onWriteEntry: entry => {
            // The generated inventory is always private, including Windows where
            // filesystem chmod cannot encode Unix owner-only permission bits.
            if (entry.path === SNAPSHOT_MANIFEST && entry.stat) entry.stat.mode = (entry.stat.mode & ~0o7777) | 0o600;
          } },
          [SNAPSHOT_MANIFEST, ...before.entries.map(entry => entry.path)]);
        await pipeline(archive, verifier, output, { signal });
        if (stableHash(verifier.result()) !== stableHash(manifest)) throw snapshotError('Snapshot receipt changed during streaming.');
        const after = await scanSnapshot(resolved, storage, limits, signal, false);
        if (before.fingerprints.size !== after.fingerprints.size
          || [...before.fingerprints].some(([name, fingerprint]) => after.fingerprints.get(name) !== fingerprint)) {
          throw snapshotError('Storage changed during snapshot streaming. No archive may be promoted; stop writers and retry.', 'stack_snapshot_changed');
        }
        return manifest;
      } finally { await fs.rm(file, { force: true }); }
    });
  });
}

function nestedLeases(scan: SnapshotScan): Array<[string, LockName]> {
  const found: Array<[string, LockName]> = [];
  for (const entry of scan.entries) {
    const match = /^(volumes\/[^/]+(?:\/.*)?)\/\.dkb\/locks\/([^/]+)\.lease\.sqlite$/u.exec(entry.path);
    if (!match) continue;
    if (entry.type !== 'file' || !names.has(match[2] as LockName)) throw snapshotError('Unsupported nested ownership file prevents a consistent backup.');
    found.push([match[1]!, match[2] as LockName]);
  }
  return found.sort(([a, an], [b, bn]) => `${a}/${an}`.localeCompare(`${b}/${bn}`, 'en'));
}
