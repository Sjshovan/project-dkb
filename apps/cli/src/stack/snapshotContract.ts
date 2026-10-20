import { validateSnapshotLimits, snapshotError, type SnapshotLimits } from './volumeSnapshotInventory.js';
import { validateStackStorage, type StackStorage } from './ownedStorage.js';

export const STACK_SNAPSHOT_FORMAT = 'dkb.stack-snapshot-worker.v1';
export const STACK_SNAPSHOT_WORKER = '/workspace/apps/cli/dist/stack/volumeSnapshotWorker.js';
export interface SnapshotRequest {
  format: typeof STACK_SNAPSHOT_FORMAT;
  command: 'snapshot' | 'restore-stage';
  storage: StackStorage;
  limits: SnapshotLimits;
  sha256?: string;
}

/** The host and Linux worker admit exactly the same bounded private protocol. */
export function validateSnapshotRequest(value: unknown): SnapshotRequest {
  const request = value as SnapshotRequest;
  if (!request || request.format !== STACK_SNAPSHOT_FORMAT || !['snapshot', 'restore-stage'].includes(request.command)
    || Object.keys(request).sort().join(',') !== (request.command === 'snapshot' ? 'command,format,limits,storage' : 'command,format,limits,sha256,storage')) {
    throw snapshotError('Invalid snapshot worker request.');
  }
  const storage = validateStackStorage(request.storage, request.storage?.name);
  if (storage.phase !== 'ready') throw snapshotError('Snapshot requires ready recorded storage.');
  validateSnapshotLimits(request.limits);
  if (request.command === 'restore-stage' && (typeof request.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(request.sha256))) {
    throw snapshotError('Restore requires an exact archive checksum.');
  }
  return { ...request, storage, limits: { ...request.limits } };
}
