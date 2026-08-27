import fs from 'node:fs/promises';
import path from 'node:path';
import { DkbError } from '@dkb/protocol/errors.js';

export async function nearestLibraryRoot(start = process.cwd()): Promise<string | null> {
  let current = path.resolve(start);

  while (true) {
    if (await isLibraryRoot(current)) return current;
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
