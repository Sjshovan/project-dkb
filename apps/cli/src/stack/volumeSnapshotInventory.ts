import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { validateStackStorage, type StackStorage } from './ownedStorage.js';

export const SNAPSHOT_MANIFEST = 'snapshot.json';
export const SNAPSHOT_MANIFEST_LIMIT = 32 * 1024 * 1024;
export interface SnapshotEntry {
  path: string; type: 'file' | 'directory' | 'symlink'; size: number;
  mode: number; uid: number; gid: number; mtime: number;
  sha256?: string; link?: string;
}
export interface VolumeSnapshot {
  format: 'dkb.stack-volume-snapshot.v1'; storage: StackStorage;
  entries: SnapshotEntry[]; bytes: number;
}
export interface SnapshotLimits { maxBytes: number; maxArchiveBytes: number; maxEntries: number; }
export interface SnapshotScan { entries: SnapshotEntry[]; fingerprints: Map<string, string>; bytes: number; }

export function snapshotError(message: string, code = 'stack_snapshot_invalid'): DkbError {
  return new DkbError(message, code);
}
export function validateSnapshotLimits(limits: SnapshotLimits): void {
  if (!limits || ![limits.maxBytes, limits.maxArchiveBytes, limits.maxEntries].every(value => Number.isSafeInteger(value) && value > 0)
    || Object.keys(limits).sort().join(',') !== 'maxArchiveBytes,maxBytes,maxEntries' || limits.maxEntries > 1_000_000
    || !Number.isSafeInteger(limits.maxBytes + SNAPSHOT_MANIFEST_LIMIT + (limits.maxEntries + 1) * 32_768)) throw snapshotError('Snapshot requires explicit positive byte and entry budgets.');
}
export function snapshotRoots(storage: StackStorage): string[] {
  return ['host', ...Object.keys(storage.volumes).sort().map(role => `volumes/${role}`)];
}
export function safeSnapshotPath(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !/[\\\x00-\x1f:]/u.test(value) && !value.startsWith('/')
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
export function entryRoot(value: string, storage: StackStorage): string | undefined {
  return snapshotRoots(storage).find(root => value === root || value.startsWith(`${root}/`));
}
export function safeSnapshotLink(entry: string, link: string, storage: StackStorage): boolean {
  if (typeof link !== 'string' || !link || link.length > 4096 || /[\\\x00-\x1f:]/u.test(link) || path.posix.isAbsolute(link)) return false;
  // Permit ordinary cache links (../../blobs/hash), not symlink/../ traversal.
  if (!safeSnapshotPath(link.replace(/^(\.\.\/)+/u, ''))) return false;
  const root = entryRoot(entry, storage);
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry), link));
  return Boolean(root && (resolved === root || resolved.startsWith(`${root}/`)));
}

/** Metadata only discovery is also used to find every nested native build lease. */
export async function scanSnapshot(root: string, storage: StackStorage, limits: SnapshotLimits,
  signal?: AbortSignal, hashFiles = true): Promise<SnapshotScan> {
  validateSnapshotLimits(limits);
  const entries: SnapshotEntry[] = [], fingerprints = new Map<string, string>();
  let bytes = 0, manifestBytes = 0;
  for (const base of snapshotRoots(storage)) {
    const basePath = path.join(root, base), baseStat = await fs.lstat(basePath);
    if (!baseStat.isDirectory() || baseStat.isSymbolicLink() || await fs.realpath(basePath) !== path.resolve(basePath)) {
      throw snapshotError('Snapshot roots must be real directories, never linked mount aliases.');
    }
    const visit = async (relative: string, depth: number): Promise<void> => {
      signal?.throwIfAborted();
      if (depth > 100 || !safeSnapshotPath(relative) || entries.length >= limits.maxEntries) throw snapshotError('Snapshot path or entry budget exceeded.');
      const absolute = path.join(root, relative), stat = await fs.lstat(absolute);
      if (stat.dev !== baseStat.dev || (stat.mode & 0o6000) !== 0) throw snapshotError('Snapshot cannot contain nested devices or set-user/group-ID files.');
      const type = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : undefined;
      if (!type) throw snapshotError('Snapshot contains a socket, device, or other unsupported special file.');
      const entry: SnapshotEntry = { path: relative, type, size: type === 'file' ? stat.size : 0,
        // Windows does not expose directory traversal bits; node-tar adds them.
        mode: (stat.mode & 0o1777) | (process.platform === 'win32' && type === 'directory' ? 0o111 : 0),
        // Match node-tar's Date timestamp, including submillisecond rounding.
        uid: stat.uid, gid: stat.gid, mtime: Math.floor(stat.mtime.getTime() / 1000) };
      bytes += entry.size;
      if (!Number.isSafeInteger(bytes) || bytes > limits.maxBytes) throw snapshotError('Snapshot exceeds its uncompressed byte budget.', 'stack_snapshot_capacity');
      if (type === 'symlink') {
        entry.link = await fs.readlink(absolute);
        if (!safeSnapshotLink(relative, entry.link, storage)) throw snapshotError('Snapshot link escapes its volume.');
        // Resolve the entire chain as well, not just its first relative hop.
        const target = await fs.realpath(absolute).catch(() => { throw snapshotError('Snapshot link is broken or cyclic.'); });
        const nested = path.relative(basePath, target);
        if (nested === '..' || nested.startsWith(`..${path.sep}`) || path.isAbsolute(nested)) throw snapshotError('Snapshot link chain escapes its volume.');
      }
      if (type === 'file' && hashFiles) entry.sha256 = await hashSnapshotFile(absolute, stat, signal);
      const after = await fs.lstat(absolute);
      if (fingerprint(stat) !== fingerprint(after)) throw snapshotError('Snapshot changed while being read. Stop writers and retry.', 'stack_snapshot_changed');
      fingerprints.set(relative, fingerprint(after));
      entries.push(entry);
      manifestBytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (manifestBytes > SNAPSHOT_MANIFEST_LIMIT - 65_536) throw snapshotError('Snapshot file inventory exceeds its metadata budget.');
      if (type === 'directory') for (const name of (await fs.readdir(absolute)).sort()) await visit(`${relative}/${name}`, depth + 1);
    };
    await visit(base, 0);
  }
  return { entries, fingerprints, bytes };
}

export async function hashSnapshotFile(file: string, expected?: Stats, signal?: AbortSignal): Promise<string> {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || (expected && fingerprint(before) !== fingerprint(expected))) throw snapshotError('Snapshot file changed before reading.', 'stack_snapshot_changed');
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) { signal?.throwIfAborted(); hash.update(chunk); }
    if (fingerprint(before) !== fingerprint(await handle.stat())) throw snapshotError('Snapshot file changed during reading.', 'stack_snapshot_changed');
    return hash.digest('hex');
  } finally { await handle.close(); }
}
function fingerprint(stat: Stats): string {
  // libuv reports dev=0 for path lstat on this Windows runtime, but the real
  // device for fstat. Inode, type, ownership, size and timestamps still agree.
  // Linux volume ownership continues to include the actual device identity.
  return [process.platform === 'win32' ? 0 : stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

export function validateVolumeSnapshot(value: unknown, limits: SnapshotLimits): VolumeSnapshot {
  validateSnapshotLimits(limits);
  const snapshot = value as VolumeSnapshot;
  if (!snapshot || Object.keys(snapshot).sort().join(',') !== 'bytes,entries,format,storage'
    || snapshot.format !== 'dkb.stack-volume-snapshot.v1') throw snapshotError('Unrecognized volume snapshot format.');
  const storage = validateStackStorage(snapshot.storage, snapshot.storage?.name);
  if (storage.phase !== 'ready' || !Array.isArray(snapshot.entries) || snapshot.entries.length > limits.maxEntries) throw snapshotError('Invalid snapshot storage or file inventory.');
  const seen = new Map<string, SnapshotEntry>(); let bytes = 0;
  for (const entry of snapshot.entries) {
    if (!entry || !safeSnapshotPath(entry.path) || !entryRoot(entry.path, storage) || seen.has(entry.path)
      || !['file', 'directory', 'symlink'].includes(entry.type)
      || ![entry.size, entry.mode, entry.uid, entry.gid, entry.mtime].every(Number.isSafeInteger)
      || entry.size < 0 || entry.mode < 0 || entry.mode > 0o1777 || entry.uid < 0 || entry.uid > 0xffffffff || entry.gid < 0 || entry.gid > 0xffffffff
      || entry.mtime < 0 || entry.mtime > 253402300799) throw snapshotError('Invalid or duplicate snapshot entry.');
    const fields = ['path', 'type', 'size', 'mode', 'uid', 'gid', 'mtime', ...(entry.type === 'file' ? ['sha256'] : entry.type === 'symlink' ? ['link'] : [])];
    if (Object.keys(entry).sort().join(',') !== fields.sort().join(',')
      || (entry.type === 'file' && !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? ''))
      || (entry.type !== 'file' && entry.size !== 0)
      || (entry.type === 'symlink' && !safeSnapshotLink(entry.path, entry.link!, storage))) throw snapshotError('Invalid snapshot file or link metadata.');
    const base = entryRoot(entry.path, storage)!;
    if (entry.path === base ? entry.type !== 'directory' : seen.get(path.posix.dirname(entry.path))?.type !== 'directory') throw snapshotError('Snapshot entries require preceding directory parents.');
    seen.set(entry.path, entry); bytes += entry.size;
    if (!Number.isSafeInteger(bytes) || bytes > limits.maxBytes) throw snapshotError('Snapshot exceeds its uncompressed byte budget.', 'stack_snapshot_capacity');
  }
  if (snapshot.bytes !== bytes || snapshotRoots(storage).some(root => seen.get(root)?.type !== 'directory')) throw snapshotError('Incomplete snapshot volume inventory.');
  for (const entry of snapshot.entries.filter(item => item.type === 'symlink')) {
    let current = entry; const visited = new Set<string>();
    while (current.type === 'symlink') {
      if (visited.has(current.path) || visited.size >= 64) throw snapshotError('Snapshot link is cyclic or too deeply nested.');
      visited.add(current.path);
      const destination = path.posix.normalize(path.posix.join(path.posix.dirname(current.path), current.link!));
      const next = seen.get(destination);
      if (!next) throw snapshotError('Snapshot link target is absent from its volume inventory.');
      current = next;
    }
  }
  return structuredClone(snapshot);
}
