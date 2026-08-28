import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveContainedPath } from '@sjshovan/dkb-protocol/paths.js';
import { readLibraryState } from './state.js';

export interface DkbLibraryStorageReport {
  libraryRoot: string;
  packages: Array<{
    id: string;
    kind: 'dkb' | 'collection';
    source: 'local' | 'registry';
    status: 'installed' | 'broken';
    sourceBytes: number;
    buildBytes: number;
    otherGeneratedBytes: number;
    totalBytes: number;
  }>;
  libraryStateBytes: number;
  rootFileBytes: number;
  totalBytes: number;
}

/** Measures only authoritative Library entries and Library-owned state. */
export async function inspectLibraryStorage(libraryRoot: string): Promise<DkbLibraryStorageReport> {
  const root = path.resolve(libraryRoot);
  const state = await readLibraryState(root);
  const packages = await Promise.all(Object.values(state.entries)
    .sort((left, right) => left.identity.localeCompare(right.identity))
    .map(async (entry) => {
      const packageRoot = resolveContainedPath(root, entry.path, `Installed entry ${entry.identity} path`);
      const generatedRoot = path.join(packageRoot, '.dkb');
      const [sourceBytes, buildBytes, generatedBytes] = await Promise.all([
        directoryBytes(packageRoot, (relative) => relative !== '.dkb' && !relative.startsWith('.dkb/')),
        directoryBytes(path.join(generatedRoot, 'builds')),
        directoryBytes(generatedRoot),
      ]);
      const otherGeneratedBytes = Math.max(0, generatedBytes - buildBytes);

      return {
        id: entry.identity,
        kind: entry.kind,
        source: entry.source,
        status: entry.status,
        sourceBytes,
        buildBytes,
        otherGeneratedBytes,
        totalBytes: sourceBytes + generatedBytes,
      };
    }));
  const [libraryStateBytes, rootFileBytes] = await Promise.all([
    directoryBytes(path.join(root, '.dkb')),
    directFileBytes(root),
  ]);

  return {
    libraryRoot: root,
    packages,
    libraryStateBytes,
    rootFileBytes,
    totalBytes: packages.reduce((total, entry) => total + entry.totalBytes, 0) + libraryStateBytes + rootFileBytes,
  };
}

async function directoryBytes(
  root: string,
  include: (relativePath: string) => boolean = () => true,
): Promise<number> {
  let total = 0;

  async function visit(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(current, entry.name);
      const relative = path.relative(root, target).replace(/\\/g, '/');
      if (!include(relative)) continue;
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) total += (await fs.stat(target)).size;
    }
  }

  await visit(root);
  return total;
}

async function directFileBytes(root: string): Promise<number> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  return (await Promise.all(files.map((entry) => fs.stat(path.join(root, entry.name))))).reduce((total, stat) => total + stat.size, 0);
}
