import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers/promises';

const promotionTails = new Map<string, Promise<void>>();
const WINDOWS_RETRY_TIMEOUT_MS = 2_000;

function comparablePath(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/** Promote a caller-owned sibling file without an absent-destination window. */
export async function replaceFileAtomically(staged: string, destination: string): Promise<void> {
  const resolvedStaged = path.resolve(staged);
  const resolvedDestination = path.resolve(destination);
  const key = comparablePath(resolvedDestination);
  if (comparablePath(path.dirname(resolvedStaged)) !== comparablePath(path.dirname(resolvedDestination)) || comparablePath(resolvedStaged) === key) {
    throw new Error('Atomic file replacement requires distinct sibling paths.');
  }

  // Coordinate only this process's competing promotions. Cross-process safety
  // still comes from rename; callers retain ownership of their staged files.
  const previous = promotionTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  promotionTails.set(key, tail);
  await previous;
  try {
    await promote(resolvedStaged, resolvedDestination);
  } finally {
    release();
    if (promotionTails.get(key) === tail) promotionTails.delete(key);
  }
}

async function promote(staged: string, destination: string): Promise<void> {
  const deadline = performance.now() + WINDOWS_RETRY_TIMEOUT_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(staged, destination);
      return;
    } catch (error) {
      // Windows readers/antivirus can briefly deny replacement. Keep both the
      // existing file and the same staged bytes while retrying; never unlink.
      const code = (error as NodeJS.ErrnoException).code;
      const remaining = deadline - performance.now();
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '') || remaining <= 0) throw error;
      // Frequent early attempts catch the short closed-handle gaps left by
      // readers. A capped delay avoids both a busy loop and lock-step writers.
      await setTimeout(Math.min(attempt + 1, 20, remaining));
    }
  }
}
