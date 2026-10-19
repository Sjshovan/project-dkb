import fs from 'node:fs/promises';
import path from 'node:path';
import { withDkbFileLock } from '@sjshovan/dkb-library/locks.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { stackControlRoot, stackName, stackStateRoot } from './paths.js';

/** Serialize host topology/configuration, not Runtime queries or Library writes. */
export async function withStackControl<T>(name: string, action: () => Promise<T>, options: {
  signal?: AbortSignal;
  timeoutMs?: number;
} = {}): Promise<T> {
  const normalized = stackName(name);
  let entered = false;
  try {
    return await withDkbFileLock(stackControlRoot(normalized), 'stack-control', async () => {
      const previous = path.join(stackStateRoot(), normalized, 'startup.lock');
      try {
        await fs.lstat(previous);
        throw new DkbError(`An earlier Stack startup guard remains at ${previous}. Stop earlier DKB processes and recover with their matching version before changing locking protocols. No guard or Stack data was removed.`, 'stack_recovery_required');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      entered = true;
      return action();
    }, { createRoot: true, timeoutMs: options.timeoutMs ?? 0, signal: options.signal });
  } catch (error) {
    if (entered || !(error instanceof DkbError)) throw error;
    if (error.code === 'library_busy') {
      throw new DkbError(`Stack ${normalized} is busy with another start, stop, backup, restore, or upgrade. Wait for it to finish, then retry.`, 'stack_busy');
    }
    if (error.code === 'library_storage_unsupported') {
      throw new DkbError(`Host control state for Stack ${normalized} requires verified local storage. No Runtime or Library was opened.`, 'stack_storage_unsupported');
    }
    throw error;
  }
}
