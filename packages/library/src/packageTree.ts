import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stableHash } from '@dkb/protocol/contracts/hash.js';
import { DkbError } from '@dkb/protocol/errors.js';
import { DKB_PACKAGE_RECEIPT_PATH } from './signing.js';

const EXCLUDED_ROOT_FILES = new Set([
  'dkb-lock.json',
  'dkb-release.json',
  DKB_PACKAGE_RECEIPT_PATH,
]);

export async function hashPortablePackageTree(root: string): Promise<{ hash: string; files: string[] }> {
  const resolvedRoot = path.resolve(root);
  const files = (await sourceFiles(resolvedRoot))
    .map((file) => path.relative(resolvedRoot, file).replace(/\\/gu, '/'))
    .sort((left, right) => left.localeCompare(right));
  const entries: Array<{ path: string; hash: string }> = [];

  for (const relative of files) {
    entries.push({
      path: relative,
      hash: `sha256:${await hashFile(path.join(resolvedRoot, relative))}`,
    });
  }

  return { hash: stableHash(entries), files };
}

async function sourceFiles(root: string): Promise<string[]> {
  let entries;

  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    throw new DkbError(`Unable to read package tree at ${root}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const nested = await Promise.all(entries.map(async (entry) => {
    if (entry.name === '.dkb' || EXCLUDED_ROOT_FILES.has(entry.name)) return [];
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return entry.isFile() ? [target] : [];
  }));

  return nested.flat();
}

async function hashFile(target: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest('hex');
}
