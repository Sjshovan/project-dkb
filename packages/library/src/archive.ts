import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import {
  progressFinish,
  progressStart,
  progressUpdate,
  type DkbProgressReporter,
} from '@sjshovan/dkb-protocol/progress.js';
import { validateCompiledPackage, type ValidatePackageBuildResult } from './builds.js';

export const DKB_PACKAGE_EXTENSION = '.dkbpkg';
export const DKB_PACKAGE_MEDIA_TYPE = 'application/vnd.dkb.package+gzip';
export const DKB_SOURCE_ARCHIVE_MEDIA_TYPE = 'application/vnd.dkb.source+gzip';

export interface PackCompiledPackageResult {
  status: 'packed';
  root: string;
  archivePath: string;
  archiveHash: string;
  archiveBytes: number;
  validation: ValidatePackageBuildResult;
}

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
    filter: (entryPath) => !isOperatorControlledPath(entryPath),
  }, ['.']);
}

export async function packCompiledPackage(root: string, archivePath: string): Promise<PackCompiledPackageResult> {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(archivePath);
  const validation = await validateCompiledPackage(resolvedRoot);
  if (!validation.ok) throw new DkbError(`Cannot pack invalid DKB Build graph at ${resolvedRoot}`);

  await createDkbPackageArchive(resolvedRoot, target);
  const stat = await fs.stat(target);
  const archiveHash = await hashFile(target);

  return {
    status: 'packed',
    root: resolvedRoot,
    archivePath: target,
    archiveHash,
    archiveBytes: stat.size,
    validation,
  };
}

export async function extractDkbPackageArchive(
  archivePath: string,
  targetRoot: string,
  options: { progress?: DkbProgressReporter } = {},
): Promise<void> {
  const target = path.resolve(targetRoot);
  let extracted = 0;

  options.progress?.(progressStart({ phase: 'extract', label: 'Extract package', total: 0, unit: 'files' }));
  await fs.mkdir(target, { recursive: true });
  await tar.x({
    cwd: target,
    file: path.resolve(archivePath),
    preserveOwner: false,
    unlink: true,
    filter: (entryPath, entry) => isSafeTarEntry(entryPath, entry as unknown),
    onentry: () => {
      extracted += 1;
      options.progress?.(progressUpdate({
        phase: 'extract',
        label: 'Extract package',
        value: extracted,
        total: 0,
        unit: 'files',
      }));
    },
  });
  options.progress?.(progressFinish({ phase: 'extract', label: 'Extract package', total: extracted, unit: 'files' }));
}

function isOperatorControlledPath(entryPath: string): boolean {
  const normalized = entryPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (normalized !== '.dkb' && !normalized.startsWith('.dkb/')) return false;
  // Keep the container directory traversable so tar can reach the two
  // allowlisted immutable build paths below. Filtering the directory itself
  // prevents tar from visiting any of its descendants.
  if (normalized === '.dkb') return false;
  return normalized !== '.dkb/builds'
    && !normalized.startsWith('.dkb/builds/')
    && normalized !== '.dkb/runtime.lock.json';
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

async function hashFile(target: string): Promise<string> {
  const bytes = await fs.readFile(target);
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
