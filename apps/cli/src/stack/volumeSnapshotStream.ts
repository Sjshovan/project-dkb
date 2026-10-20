import { createHash } from 'node:crypto';
import path from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { t as listTar, type ReadEntry } from 'tar';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { StackStorage } from './ownedStorage.js';
import { SNAPSHOT_MANIFEST, SNAPSHOT_MANIFEST_LIMIT, entryRoot, safeSnapshotPath, snapshotError,
  validateSnapshotLimits, validateVolumeSnapshot, type SnapshotEntry, type SnapshotLimits, type VolumeSnapshot } from './volumeSnapshotInventory.js';

/** Verifies bytes while forwarding them with backpressure; never buffers the archive. */
export class VolumeSnapshotVerifier extends Transform {
  private readonly parser;
  private readonly unzip = createGunzip();
  private readonly seen = new Set<string>();
  private readonly expected = new Map<string, SnapshotEntry>();
  private manifest?: VolumeSnapshot;
  private compressedBytes = 0;
  private expandedBytes = 0;
  private ended = false;
  private manifestSeen = false;
  private rejection?: DkbError;

  constructor(private readonly limits: SnapshotLimits) {
    super();
    validateSnapshotLimits(limits);
    this.parser = listTar({ strict: true, maxMetaEntrySize: 16 * 1024,
      onReadEntry: entry => {
        try { this.readEntry(entry); } catch (error) { this.rejectEntry(error); }
      } });
    this.parser.on('error', () => this.destroy(this.rejection ?? snapshotError('Snapshot archive is corrupt, incomplete, or does not match its inventory.')));
    this.parser.on('ignoredEntry', () => this.rejectEntry(snapshotError('Snapshot contains an unsupported archive entry.')));
    this.parser.on('end', () => { this.ended = true; });
    this.unzip.on('error', () => this.destroy(snapshotError('Snapshot compression is corrupt or incomplete.')));
    this.unzip.on('data', (bytes: Buffer) => {
      this.expandedBytes += bytes.length;
      // Budget includes bounded inventory, PAX metadata, headers and block padding.
      // Do not impose a compression ratio: zero-filled databases compress heavily.
      if (this.expandedBytes > limits.maxBytes + SNAPSHOT_MANIFEST_LIMIT + (limits.maxEntries + 1) * 32_768) {
        this.destroy(snapshotError('Expanded snapshot exceeds its byte budget.', 'stack_snapshot_capacity')); return;
      }
      if (!this.parser.write(bytes)) { this.unzip.pause(); this.parser.once('drain', () => this.unzip.resume()); }
    });
    this.unzip.on('end', () => this.parser.end());
  }

  result(): VolumeSnapshot {
    if (!this.ended || !this.manifest || this.seen.size !== this.expected.size) throw snapshotError('Snapshot stream did not finish with every expected file.');
    return structuredClone(this.manifest);
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.compressedBytes += chunk.length;
    if (this.compressedBytes > this.limits.maxArchiveBytes) { callback(snapshotError('Snapshot archive exceeds its byte budget.', 'stack_snapshot_capacity')); return; }
    if (this.unzip.write(chunk)) callback(null, chunk);
    else this.unzip.once('drain', () => callback(null, chunk));
  }
  override _flush(callback: TransformCallback): void {
    this.parser.once('end', () => {
      try { this.result(); callback(); } catch (error) { callback(error as Error); }
    });
    this.unzip.end();
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.unzip.destroy(); callback(error);
  }

  private rejectEntry(error: unknown): void {
    // Only our fixed validation messages are safe to expose; tar errors may echo paths.
    if (error instanceof DkbError) this.rejection = error;
    this.parser.abort(error instanceof Error ? error : snapshotError('Invalid snapshot entry.'));
  }

  private readEntry(entry: ReadEntry): void {
    const name = entry.type === 'Directory' ? entry.path.replace(/\/$/u, '') : entry.path;
    if (!safeSnapshotPath(name)) throw snapshotError('Unsafe archive path.');
    if (!this.manifestSeen) {
      assertSnapshotManifestEntry(entry);
      this.manifestSeen = true;
      const chunks: Buffer[] = []; let bytes = 0;
      entry.on('data', (chunk: Buffer) => { bytes += chunk.length; chunks.push(chunk); });
      entry.on('end', () => {
        try {
          if (bytes !== entry.size) throw snapshotError('Incomplete snapshot inventory.');
          this.manifest = validateVolumeSnapshot(JSON.parse(Buffer.concat(chunks).toString('utf8')), this.limits);
          for (const item of this.manifest.entries) this.expected.set(item.path, item);
        } catch (error) { this.rejectEntry(error); }
      });
      return;
    }
    if (!this.manifest) throw snapshotError('Missing snapshot inventory.');
    const expected = admitSnapshotEntry(entry, this.expected, this.seen, this.manifest.storage);
    const hash = createHash('sha256'); let bytes = 0;
    entry.on('data', (chunk: Buffer) => { bytes += chunk.length; hash.update(chunk); });
    entry.on('end', () => {
      if (bytes !== entry.size || (entry.type === 'File' && hash.digest('hex') !== expected.sha256)) {
        this.rejectEntry(snapshotError('Snapshot file hash mismatch.')); return;
      }
      this.seen.add(name);
    });
  }
}

export function assertSnapshotManifestEntry(entry: ReadEntry): void {
  if (entry.path !== SNAPSHOT_MANIFEST || entry.type !== 'File' || entry.size < 1 || entry.size > SNAPSHOT_MANIFEST_LIMIT
    || (entry.mode! & 0o7777) !== 0o600 || !Number.isSafeInteger(entry.uid) || !Number.isSafeInteger(entry.gid)
    || entry.uid! < 0 || entry.gid! < 0 || entry.uid! > 0xffffffff || entry.gid! > 0xffffffff) throw snapshotError('Snapshot must begin with its private bounded inventory.');
}

/** Shared admission for verification and extraction, including a changed-input second pass. */
export function admitSnapshotEntry(entry: ReadEntry, entries: ReadonlyMap<string, SnapshotEntry>, seen: ReadonlySet<string>, storage: StackStorage): SnapshotEntry {
    const name = entry.type === 'Directory' ? entry.path.replace(/\/$/u, '') : entry.path;
    const expected = entries.get(name);
    if (!safeSnapshotPath(name) || !expected || seen.has(name)) throw snapshotError('Unexpected or duplicate archive entry.');
    if ((entry.mode! & 0o7777) !== expected.mode) throw snapshotError('Archive permissions disagree with the inventory.');
    if (entry.uid !== expected.uid || entry.gid !== expected.gid) throw snapshotError('Archive ownership disagrees with the inventory.');
    if (Math.floor((entry.mtime?.getTime() ?? NaN) / 1000) !== expected.mtime) throw snapshotError('Archive timestamps disagree with the inventory.');
    if (entry.type === 'Link') {
      const target = entry.linkpath ?? '', first = entries.get(target);
      if (expected.type !== 'file' || entry.size !== 0 || !safeSnapshotPath(target) || !seen.has(target)
        || entryRoot(target, storage) !== entryRoot(name, storage)
        || first?.type !== 'file' || first.sha256 !== expected.sha256 || first.size !== expected.size
        || first.mode !== expected.mode || first.uid !== expected.uid || first.gid !== expected.gid) throw snapshotError('Unsafe or inconsistent hard link.');
    } else if (entry.type !== ({ file: 'File', directory: 'Directory', symlink: 'SymbolicLink' } as const)[expected.type]
      || entry.size !== expected.size || (expected.type === 'symlink' && entry.linkpath !== expected.link)) {
      throw snapshotError('Archive entry type, size, or link disagrees with the inventory.');
    }
    // A preceding link must never become the parent of an extracted member.
    let parent = path.posix.dirname(name);
    while (parent !== '.') {
      const parentEntry = entries.get(parent);
      if (parentEntry && parentEntry.type !== 'directory') throw snapshotError('Archive parent is not a directory.');
      parent = path.posix.dirname(parent);
    }
    return expected;
}
