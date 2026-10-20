import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { DKB_RETRIEVAL_PROFILE_LOCK_PATH } from '@sjshovan/dkb-pipeline/profile.js';
import { resolveFrom } from '@sjshovan/dkb-protocol/paths.js';
import type { DkbStore, LoadedDkb } from '@sjshovan/dkb-protocol/types.js';

export async function hashStoreForDkb(dkb: LoadedDkb, store: DkbStore, storePath: string): Promise<string> {
  const includedPaths = includedSourcePathsForStore(store);

  if (!includedPaths) {
    return hashStore(storePath);
  }

  const hashed = await Promise.all(includedPaths.map(async (relativePath) => ({
    path: relativePath,
    hash: await hashFile(resolveFrom(dkb.root, relativePath)),
  })));

  return stableHash(hashed.sort((left, right) => left.path.localeCompare(right.path)));
}

export function includedSourcePathsForStore(store: DkbStore): string[] | null {
  const included = store.meta?.includePaths;

  if (!Array.isArray(included)) {
    return null;
  }

  const paths = included
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.replace(/\\/g, '/'))
    .sort((left, right) => left.localeCompare(right));

  return paths.length > 0 ? paths : null;
}

export function isGeneratedPackagePath(root: string, source: string): boolean {
  const relative = path.relative(root, source);
  if (!relative) return false;
  const [first] = relative.split(path.sep);
  return first === '.dkb';
}

export function isDkbSystemArtifact(name: string): boolean {
  return name.startsWith('.')
    || name === 'dkb.json'
    || name === 'dkb-lock.json'
    || name === 'dkb-release.json'
    || name === '.dkb-package.json'
    || name === DKB_RETRIEVAL_PROFILE_LOCK_PATH;
}

export async function maybeHashFile(file: string): Promise<string | null> {
  try {
    return await hashFile(file);
  } catch {
    return null;
  }
}

export async function maybeHashArtifact(target: string): Promise<string | null> {
  try {
    const stats = await fs.stat(target);

    if (stats.isDirectory()) {
      return await hashStore(target);
    }

    return await hashFile(target);
  } catch {
    return null;
  }
}

export function uniqueDkbs(dkbs: LoadedDkb[]): LoadedDkb[] {
  const seen = new Set<string>();

  return dkbs.filter((dkb) => {
    if (seen.has(dkb.manifest.id)) {
      return false;
    }

    seen.add(dkb.manifest.id);

    return true;
  });
}

export function parseLock(source: string, lockPath: string): unknown {
  try {
    return JSON.parse(source);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    throw new DkbError(`Unable to read lockfile at ${lockPath}: ${reason}`);
  }
}

async function hashStore(storePath: string): Promise<string> {
  const stats = await fs.stat(storePath);

  if (stats.isFile()) {
    return hashFile(storePath);
  }

  if (!stats.isDirectory()) {
    throw new DkbError(`Unsupported store path for hashing: ${storePath}`);
  }

  const entries = await listFiles(storePath);
  const hashed = await Promise.all(entries.map(async (file) => ({
    path: path.relative(storePath, file).replace(/\\/g, '/'),
    hash: await hashFile(file),
  })));

  return stableHash(hashed);
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries
    .filter((entry) => !isDkbSystemArtifact(entry.name))
    .map(async (entry) => {
      const target = path.join(root, entry.name);

      if (entry.isDirectory()) {
        return listFiles(target);
      }

      return entry.isFile() ? [target] : [];
    }));

  return nested.flat().sort((left, right) => left.localeCompare(right));
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');

  hash.update(await fs.readFile(file));

  return `sha256:${hash.digest('hex')}`;
}
