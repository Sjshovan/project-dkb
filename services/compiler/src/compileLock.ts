import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { DKB_LOCKS_DIR, resolveFrom } from '@sjshovan/dkb-protocol/paths.js';

export const COMPILE_LOCK_PATH = `${DKB_LOCKS_DIR}/compile.lock`;

const COMPILE_LOCK_TIMEOUT_MS = 30_000;
const COMPILE_LOCK_STALE_MS = 10 * 60_000;
const COMPILE_LOCK_RETRY_MS = 100;

export async function withCompileLock<T>(root: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const lock = await acquireCompileLock(root, signal);
  let failed = false;

  try {
    signal?.throwIfAborted();
    return await operation();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // Keep worker-stop uncertainty visible to every enclosing staging cleanup.
    if (failed) await releaseCompileLock(lock).catch(() => undefined);
    else await releaseCompileLock(lock);
  }
}

async function acquireCompileLock(root: string, signal?: AbortSignal): Promise<{ path: string; token: string }> {
  const lockPath = resolveFrom(root, COMPILE_LOCK_PATH);
  const token = stableHash({
    pid: process.pid,
    host: os.hostname(),
    root,
    startedAt: new Date().toISOString(),
    random: Math.random(),
  });
  const started = Date.now();

  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    signal?.throwIfAborted();
    try {
      await fs.mkdir(lockPath);
      await fs.writeFile(path.join(lockPath, 'owner.json'), `${JSON.stringify({
        token,
        pid: process.pid,
        host: os.hostname(),
        createdAt: new Date().toISOString(),
      }, null, 2)}\n`, 'utf8');

      return { path: lockPath, token };
    } catch (error) {
      const code = errorCode(error);

      if (code !== 'EEXIST') {
        throw error;
      }

      if (await removeStaleCompileLock(lockPath)) {
        continue;
      }

      if (Date.now() - started >= COMPILE_LOCK_TIMEOUT_MS) {
        throw new DkbError(`Timed out waiting for compile lock at ${lockPath}`);
      }

      await delay(COMPILE_LOCK_RETRY_MS, undefined, { signal });
    }
  }
}

async function removeStaleCompileLock(lockPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(lockPath);

    if (Date.now() - stat.mtimeMs < COMPILE_LOCK_STALE_MS) {
      return false;
    }

    await fs.rm(lockPath, { recursive: true, force: true });

    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return true;
    }

    throw error;
  }
}

async function releaseCompileLock(lock: { path: string; token: string }): Promise<void> {
  try {
    const owner = JSON.parse(await fs.readFile(path.join(lock.path, 'owner.json'), 'utf8')) as { token?: unknown };

    if (owner.token !== lock.token) {
      return;
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw error;
    }
  }

  await fs.rm(lock.path, { recursive: true, force: true });
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error && 'code' in error
    ? String((error as { code: unknown }).code)
    : '';
}
