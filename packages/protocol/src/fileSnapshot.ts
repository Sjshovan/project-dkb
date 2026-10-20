import fs from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import { DkbError } from './errors.js';

export interface FileSnapshot {
  readonly entries: readonly Readonly<{ path: string; observation: string }>[];
}

interface FileObservation {
  fingerprint: string;
  directory: boolean;
  resolvedPath?: string;
  children: string[];
}

/**
 * Observe already selected filesystem inputs; this does not verify their content.
 * Capture before authoritative validation and assert again after loading. Directory
 * observations are shallow by default, so callers control their dependency scope.
 */
export async function captureFileSnapshot(
  paths: readonly string[],
  options: { recursive?: boolean } = {},
): Promise<FileSnapshot> {
  const entries = new Map<string, string>();
  const visitedDirectories = new Set<string>();
  let pending = [...new Set(paths.map((value) => path.resolve(value)))];
  while (pending.length) {
    const next: string[] = [];
    await forEachConcurrent(pending, async (source) => {
      if (entries.has(source)) return;
      const observation = await observeFile(source);
      entries.set(source, observation.fingerprint);
      if (options.recursive && observation.directory && observation.resolvedPath
        && !visitedDirectories.has(observation.resolvedPath)) {
        visitedDirectories.add(observation.resolvedPath);
        next.push(...observation.children.map((name) => path.join(source, name)));
      }
    });
    pending = next;
  }
  return Object.freeze({
    entries: Object.freeze([...entries].sort(([left], [right]) => left.localeCompare(right))
      .map(([source, observation]) => Object.freeze({ path: source, observation }))),
  });
}

/** Fail closed on changed inputs, including additions to observed directories. */
export async function assertFileSnapshotCurrent(snapshot: FileSnapshot): Promise<void> {
  await forEachConcurrent(snapshot.entries, async (entry) => {
    const current = await observeFile(entry.path);
    if (current.fingerprint !== entry.observation) {
      throw new DkbError(
        `Validated input changed on disk: ${entry.path}. Refresh the owning context before reuse.`,
        'validated_input_changed',
      );
    }
  });
}

async function observeFile(source: string): Promise<FileObservation> {
  try {
    const link = await fs.lstat(source, { bigint: true });
    const resolvedPath = link.isSymbolicLink() || link.isDirectory() ? await fs.realpath(source) : source;
    const target = link.isSymbolicLink() ? await fs.stat(source, { bigint: true }) : link;
    const children = target.isDirectory() ? (await fs.readdir(source)).sort() : [];
    return {
      fingerprint: JSON.stringify({ link: fingerprint(link), target: fingerprint(target), resolvedPath, children }),
      directory: target.isDirectory(),
      resolvedPath,
      children,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { fingerprint: 'missing', directory: false, children: [] };
    }
    throw new DkbError(`Cannot validate filesystem input ${source}: ${(error as Error).message}`, 'validated_input_unavailable');
  }
}

function fingerprint(stat: BigIntStats): string[] {
  // atime is deliberately excluded: reading a validated input is not a mutation.
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs]
    .map((value) => value.toString());
}

async function forEachConcurrent<T>(values: readonly T[], action: (value: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  await Promise.all(Array.from({ length: Math.min(32, values.length) }, async () => {
    while (!failed && next < values.length) {
      const value = values[next++]!;
      try {
        await action(value);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }));
}
