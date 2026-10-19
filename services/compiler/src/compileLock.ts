import { withDkbFileLock } from '@sjshovan/dkb-library/locks.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { DKB_LOCKS_DIR } from '@sjshovan/dkb-protocol/paths.js';

/** Persistent native lease; its presence never means another compiler owns it. */
export const COMPILE_LOCK_PATH = `${DKB_LOCKS_DIR}/compile.lease.sqlite`;

export async function withCompileLock<T>(root: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let entered = false;
  try {
    return await withDkbFileLock(root, 'compile', () => {
      entered = true;
      // Do not race the callback against abort: worker-confirmed cleanup owns this lease too.
      return operation();
    }, { timeoutMs: 30_000, signal });
  } catch (error) {
    if (entered || !(error instanceof DkbError)) throw error;
    if (error.code === 'library_busy') {
      throw new DkbError(`Compilation at ${root} is busy. Wait for its current compiler and worker cleanup, then retry.`, 'compile_busy');
    }
    if (error.code === 'library_recovery_required' && error.message.startsWith('An earlier DKB ownership guard remains')) {
      throw new DkbError(`An earlier compiler ownership guard remains at ${root}. Stop earlier compilers and confirm their workers have stopped; recover with the matching version before changing locking protocols. Source and the guard were preserved.`, 'compile_recovery_required');
    }
    if (error.code === 'library_storage_unsupported') {
      throw new DkbError(`Compilation at ${root} requires local Windows storage or Linux-local storage in Docker. Shared or unknown mounts are unsupported; run the compiler in the Library's owning environment. No compiler database was opened.`, 'compile_storage_unsupported');
    }
    throw error;
  }
}
