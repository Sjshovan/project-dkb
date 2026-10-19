import fs from 'node:fs/promises';
import path from 'node:path';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

export async function nearestLibraryRoot(start = process.cwd(), options: { includeInterrupted?: boolean } = {}): Promise<string | null> {
  let current = path.resolve(start);

  while (true) {
    if (await isLibraryRoot(current)) return current;
    // A durable ledger locates an interrupted Library; it does not validate or
    // activate it. Recovery/write callers must acquire ownership and validate
    // the manifest and ledger before operating on this candidate.
    if (options.includeInterrupted) {
      try { if ((await fs.lstat(path.join(current, '.dkb', 'state.sqlite'))).isFile()) return current; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function requireLibraryRoot(start = process.cwd()): Promise<string> {
  const root = await nearestLibraryRoot(start);
  if (!root) {
    throw new DkbError(`No DKB Library found from ${path.resolve(start)}. Run dkb init to create one.`);
  }
  return root;
}

export async function isLibraryRoot(root: string): Promise<boolean> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(path.resolve(root), 'dkb.json'), 'utf8')) as unknown;
    return isRecord(value) && value.type === 'library';
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
