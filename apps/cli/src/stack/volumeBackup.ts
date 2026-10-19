import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { runDockerOwnerWorker } from '../host/dockerOwnerWorker.js';
import { STACK_SNAPSHOT_FORMAT } from './snapshotContract.js';
import { VolumeSnapshotVerifier } from './volumeSnapshotStream.js';
import type { StackStorage } from './ownedStorage.js';

/** Caller holds host Stack control and has proved all recorded consumers stopped. */
export async function writeStackVolumeBackup(storage: StackStorage, temporary: string, signal?: AbortSignal): Promise<void> {
  const capacity = await fs.statfs(path.dirname(temporary));
  const available = Math.floor(capacity.bavail * capacity.bsize - 512 * 1024 * 1024);
  if (!Number.isSafeInteger(available) || available < 1024 * 1024) {
    throw new DkbError('Backup destination needs at least 512 MiB free reserve plus archive space. Free space or choose another --output location.', 'stack_snapshot_capacity');
  }
  const limits = { maxBytes: 256 * 1024 ** 3, maxArchiveBytes: Math.min(available, 256 * 1024 ** 3), maxEntries: 1_000_000 };
  const verifier = new VolumeSnapshotVerifier(limits);
  const destination = createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
  // Catch immediately: a destination failure can occur while Docker preflight is
  // still running. Always settle both streams and the worker before returning.
  const writing = pipeline(verifier, destination).then(() => undefined, error => error as Error);
  try {
    const result = await runDockerOwnerWorker('snapshot', storage.owner,
      { format: STACK_SNAPSHOT_FORMAT, command: 'snapshot', storage, limits }, { signal, stdout: verifier });
    if (result.code !== 0) {
      throw new DkbError(`Stack ${storage.name} snapshot failed. Keep every consumer stopped, check free disk space and pending Library recovery, then retry: dkb stack backup ${storage.name}. No archive was promoted.`, 'stack_snapshot_failed');
    }
    const failed = await writing;
    if (failed) throw failed;
    if (stableHash(verifier.result().storage) !== stableHash(storage)) {
      throw new DkbError('Snapshot storage identity differs from the requested Stack. No archive was promoted.', 'stack_snapshot_invalid');
    }
  } finally {
    verifier.destroy();
    await writing;
  }
}
