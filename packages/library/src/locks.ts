import fs from 'node:fs/promises';
import path from 'node:path';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

export async function withDkbFileLock<T>(
  root: string,
  name: 'library-mutation' | 'build-promotion',
  operation: () => Promise<T>,
  options: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  const lockRoot = path.join(path.resolve(root), '.dkb', 'locks');
  const lockPath = path.join(lockRoot, `${name}.lock`);
  const timeoutMs = options.timeoutMs ?? 120_000;
  const staleMs = options.staleMs ?? 15 * 60_000;
  const started = Date.now();
  await fs.mkdir(lockRoot, { recursive: true });

  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, 'utf8');
        return await operation();
      } finally {
        await handle.close();
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > staleMs) {
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() - started >= timeoutMs) {
        throw new DkbError(
          `Timed out waiting for DKB ${name.replace('-', ' ')} lock at ${lockPath}. `
          + 'Another DKB process may still be changing this Library; wait for it to finish and retry.',
          'library_busy',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
  }
}
