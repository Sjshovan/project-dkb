import { withDkbFileLock } from '@sjshovan/dkb-library/locks.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

/** One native writer per Runtime, excluding in-flight queries in every process. */
export function withRuntimeMutation<T>(root: string, operation: () => Promise<T>): Promise<T> {
  return withRuntimeOwnership(root, 'mutation', operation);
}

/** Concurrent readers share a stable Runtime; queued writers precede later readers. */
export function withRuntimeQuery<T>(root: string, operation: () => Promise<T>): Promise<T> {
  return withRuntimeOwnership(root, 'read', operation);
}

async function withRuntimeOwnership<T>(root: string, purpose: 'read' | 'mutation', operation: () => Promise<T>): Promise<T> {
  let entered = false;
  try {
    return await withDkbFileLock(root, 'runtime-mutation', () => { entered = true; return operation(); },
      { purpose, concurrentReads: true, createRoot: purpose === 'mutation' });
  } catch (error) {
    if (entered || !(error instanceof DkbError)) throw error;
    if (error.code === 'library_busy') {
      throw new DkbError(`Runtime at ${root} is busy. Wait for its current queries or activation change, then retry.`, 'runtime_busy');
    }
    if (error.code === 'library_mutation_required') {
      throw new DkbError('Runtime mutation requires live exclusive ownership; a query cannot upgrade its read authority.', 'runtime_mutation_required');
    }
    if (error.code === 'library_recovery_required' && error.message.startsWith('An earlier DKB ownership guard remains')) {
      throw new DkbError(`An earlier Runtime ownership guard remains at ${root}. Stop earlier DKB processes and recover with their matching version before changing locking protocols. The guard and Runtime were preserved.`, 'runtime_recovery_required');
    }
    if (error.code === 'library_storage_unsupported') {
      throw new DkbError(`Runtime state at ${root} requires verified local Windows storage or a Linux-local Docker volume. Shared or unknown mounts are unsupported; no Runtime database was opened.`, 'runtime_storage_unsupported');
    }
    throw error;
  }
}
