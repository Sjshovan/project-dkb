import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { assertNoSymlinkPath, readInertTextFile } from '@sjshovan/dkb-protocol/security/sourceContent.js';
import { DKB_PACKAGE_RECEIPT_PATH } from './signing.js';

export const DKB_PACKAGE_PREVIEW_MAX_BYTES = 256 * 1024;

export interface DkbPortablePackageEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  bytes?: number;
  contentKind?: 'text' | 'code' | 'config' | 'image' | 'binary' | 'other';
  previewable: boolean;
}

const EXCLUDED_ROOT_FILES = new Set([
  'dkb-lock.json',
  'dkb-profile.lock.json',
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

export async function summarizePortablePackageTree(root: string): Promise<{ files: number; bytes: number }> {
  const resolvedRoot = path.resolve(root);
  const files = await sourceFiles(resolvedRoot);
  const sizes = await Promise.all(files.map((file) => fs.stat(file).then((stat) => stat.size)));

  return { files: files.length, bytes: sizes.reduce((total, size) => total + size, 0) };
}

export async function listPortablePackageDirectory(input: {
  root: string;
  directory?: string;
  cursor?: string;
  limit?: number;
}): Promise<{ directory: string; entries: DkbPortablePackageEntry[]; nextCursor?: string }> {
  const root = path.resolve(input.root);
  const directory = normalizePortableRelativePath(input.directory ?? '.');
  const target = resolvePortableTarget(root, directory);
  await assertNoSymlinkPath(root, target);
  const stat = await fs.stat(target).catch((error: NodeJS.ErrnoException) => {
    throw new DkbError(error.code === 'ENOENT'
      ? `Package directory does not exist: ${directory || '.'}`
      : `Unable to inspect package directory ${directory || '.'}: ${error.message}`);
  });
  if (!stat.isDirectory()) throw new DkbError(`Package content path is not a directory: ${directory || '.'}`);

  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DkbError('Package contents limit must be between 1 and 100.');
  const rows = await fs.readdir(target, { withFileTypes: true });
  const entries = (await Promise.all(rows
    .filter((entry) => !entry.isSymbolicLink() && !isExcludedPortableName(entry.name))
    .map(async (entry): Promise<DkbPortablePackageEntry | null> => {
      if (!entry.isDirectory() && !entry.isFile()) return null;
      const relative = toPortablePath(path.posix.join(directory, entry.name));
      if (entry.isDirectory()) {
        return { name: entry.name, path: relative, kind: 'directory', previewable: false };
      }
      const fileStat = await fs.stat(path.join(target, entry.name));
      const contentKind = contentKindFor(entry.name);
      return {
        name: entry.name,
        path: relative,
        kind: 'file',
        bytes: fileStat.size,
        contentKind,
        previewable: contentKind !== 'binary' && contentKind !== 'image',
      };
    })))
    .filter((entry): entry is DkbPortablePackageEntry => entry !== null)
    .sort((left, right) => left.path.localeCompare(right.path));
  const afterCursor = input.cursor
    ? entries.filter((entry) => entry.path.localeCompare(input.cursor!) > 0)
    : entries;
  const page = afterCursor.slice(0, limit);
  const nextCursor = afterCursor.length > page.length ? page.at(-1)?.path : undefined;

  return { directory: directory || '.', entries: page, ...(nextCursor ? { nextCursor } : {}) };
}

export async function previewPortablePackageFile(input: {
  root: string;
  file: string;
}): Promise<{
  path: string;
  bytes: number;
  sha256: string;
  mediaType: string;
  previewable: boolean;
  truncated: boolean;
  bytesRead: number;
  content?: string;
}> {
  const root = path.resolve(input.root);
  const relative = normalizePortableRelativePath(input.file);
  if (!relative) throw new DkbError('Package preview requires a file path.');
  const target = resolvePortableTarget(root, relative);
  await assertNoSymlinkPath(root, target);
  const stat = await fs.stat(target).catch((error: NodeJS.ErrnoException) => {
    throw new DkbError(error.code === 'ENOENT'
      ? `Package file does not exist: ${relative}`
      : `Unable to inspect package file ${relative}: ${error.message}`);
  });
  if (!stat.isFile()) throw new DkbError(`Package content path is not a file: ${relative}`);
  const contentKind = contentKindFor(relative);
  const inert = contentKind === 'binary' || contentKind === 'image'
    ? null
    : await readInertTextFile(target, DKB_PACKAGE_PREVIEW_MAX_BYTES);

  return {
    path: relative,
    bytes: stat.size,
    sha256: `sha256:${await hashFile(target)}`,
    mediaType: mediaTypeFor(relative),
    previewable: inert !== null,
    truncated: inert?.truncated ?? false,
    bytesRead: inert?.bytesRead ?? 0,
    ...(inert ? { content: inert.raw } : {}),
  };
}

async function sourceFiles(root: string): Promise<string[]> {
  let entries;

  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    throw new DkbError(`Unable to read package tree at ${root}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const nested = await Promise.all(entries.map(async (entry) => {
    if (isExcludedPortableName(entry.name) || entry.isSymbolicLink()) return [];
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return entry.isFile() ? [target] : [];
  }));

  return nested.flat();
}

function normalizePortableRelativePath(value: string): string {
  const portable = value.trim().replace(/\\/gu, '/');
  if (path.posix.isAbsolute(portable) || path.win32.isAbsolute(portable)) {
    throw new DkbError(`Package content path must be relative: ${value}`);
  }
  const parts = portable.split('/').filter((part) => part.length > 0 && part !== '.');
  if (parts.some((part) => part === '..' || isExcludedPortableName(part))) {
    throw new DkbError(`Package content path is not part of the portable package tree: ${value}`);
  }
  return parts.join('/');
}

function resolvePortableTarget(root: string, relative: string): string {
  const target = path.resolve(root, ...relative.split('/').filter(Boolean));
  const escaped = path.relative(root, target);
  if (escaped.startsWith('..') || path.isAbsolute(escaped)) throw new DkbError(`Package content path escapes its root: ${relative}`);
  return target;
}

function isExcludedPortableName(name: string): boolean {
  return name === '.dkb' || EXCLUDED_ROOT_FILES.has(name);
}

function toPortablePath(value: string): string {
  return value.replace(/^\.\//u, '').replace(/\\/gu, '/');
}

function contentKindFor(file: string): DkbPortablePackageEntry['contentKind'] {
  const extension = path.extname(file).toLowerCase();
  if (['.md', '.mdx', '.txt', '.rst', '.csv', '.log'].includes(extension)) return 'text';
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.php', '.py', '.rb', '.go', '.rs', '.java', '.cs', '.css', '.html', '.vue', '.sql', '.sh', '.ps1'].includes(extension)) return 'code';
  if (['.json', '.yaml', '.yml', '.toml', '.ini', '.xml'].includes(extension)) return 'config';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico'].includes(extension)) return 'image';
  if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.tar', '.gz', '.7z', '.exe', '.dll', '.bin', '.db', '.sqlite'].includes(extension)) return 'binary';
  return 'other';
}

function mediaTypeFor(file: string): string {
  const extension = path.extname(file).toLowerCase();
  return ({
    '.md': 'text/markdown', '.mdx': 'text/markdown', '.txt': 'text/plain', '.rst': 'text/plain', '.csv': 'text/csv',
    '.json': 'application/json', '.yaml': 'application/yaml', '.yml': 'application/yaml', '.toml': 'application/toml',
    '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/typescript',
    '.xml': 'application/xml', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.pdf': 'application/pdf', '.sqlite': 'application/vnd.sqlite3', '.db': 'application/octet-stream',
  } as Record<string, string>)[extension] ?? 'application/octet-stream';
}

async function hashFile(target: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest('hex');
}
