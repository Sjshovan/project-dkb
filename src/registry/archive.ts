import fs from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';
import { DkbError } from '../protocol/errors.js';

export const DKB_PACKAGE_EXTENSION = '.dkbpkg';
export const DKB_PACKAGE_MEDIA_TYPE = 'application/vnd.dkb.package+gzip';
export const DKB_SOURCE_ARCHIVE_MEDIA_TYPE = 'application/vnd.dkb.source+gzip';

export async function createDkbPackageArchive(sourceRoot: string, archivePath: string): Promise<void> {
  const root = path.resolve(sourceRoot);
  const target = path.resolve(archivePath);

  await fs.mkdir(path.dirname(target), { recursive: true });
  await tar.c({
    cwd: root,
    file: target,
    gzip: true,
    portable: true,
    noMtime: true,
  }, ['.']);
}

export async function extractDkbPackageArchive(archivePath: string, targetRoot: string): Promise<void> {
  const target = path.resolve(targetRoot);

  await fs.mkdir(target, { recursive: true });
  await tar.x({
    cwd: target,
    file: path.resolve(archivePath),
    preserveOwner: false,
    unlink: true,
    filter: (entryPath, entry) => isSafeTarEntry(entryPath, entry as unknown),
  });
}

function isSafeTarEntry(entryPath: string, entry: unknown): boolean {
  const normalized = entryPath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  const entryType = typeof entry === 'object' && entry !== null && 'type' in entry
    ? String((entry as { type: unknown }).type)
    : 'File';

  if (path.posix.isAbsolute(normalized) || parts.includes('..')) {
    throw new DkbError(`Package archive contains an unsafe path: ${entryPath}`);
  }

  if (entryType === 'SymbolicLink' || entryType === 'Link') {
    throw new DkbError(`Package archive contains a link entry: ${entryPath}`);
  }

  if (entryType !== 'Directory' && entryType !== 'File' && entryType !== 'OldFile') {
    throw new DkbError(`Package archive contains an unsupported entry type: ${entryPath}`);
  }

  return true;
}
