import { createHash } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

export function relativeOwned(root: string, target: string): string {
  const relative = path.relative(root, path.resolve(target));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new DkbError('Library mutation paths must be strictly inside their Library.', 'library_recovery_required');
  }
  const segments = relative.split(path.sep);
  for (const segment of segments) {
    if (/[\\<>:"|?*\u0000-\u001f]/u.test(segment) || /[. ]$/u.test(segment)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)) {
      throw new DkbError('Library mutation paths must use portable, unambiguous names.', 'library_recovery_required');
    }
  }
  return segments.join('/');
}

export async function assertSafePath(root: string, target: string): Promise<void> {
  return assertSafePaths(root, [target]);
}

/** Validate shared ancestors once for one immediate operation, never across operations. */
export async function assertSafePaths(root: string, targets: readonly string[]): Promise<void> {
  await inspectSafePaths(root, targets);
}

/** Fresh path facts for one immediate validation; callers must never cache them. */
export async function inspectSafePaths(root: string, targets: readonly string[]): Promise<ReadonlyMap<string, Stats | null>> {
  const resolved = path.resolve(root);
  const [real, rootStat] = await Promise.all([fs.realpath(resolved), fs.lstat(resolved)]);
  const equal = process.platform === 'win32' ? real.toLowerCase() === resolved.toLowerCase() : real === resolved;
  if (!equal || rootStat.isSymbolicLink()) throw new DkbError('Symlinked Library roots are not safe mutation targets.', 'library_recovery_required');
  const key = (target: string) => process.platform === 'win32' ? target.toLowerCase() : target;
  const checked = new Map<string, boolean>([[key(resolved), true]]);
  const facts = new Map<string, Stats | null>([[resolved, rootStat]]);
  const levels: Map<string, string>[] = [];
  for (const target of targets) {
    const relative = relativeOwned(resolved, target);
    let current = resolved;
    for (const [depth, segment] of relative.split('/').entries()) {
      current = path.join(current, segment);
      (levels[depth] ??= new Map()).set(key(current), current);
    }
  }
  for (const level of levels) {
    // Validate parents before descendants, but independent siblings need not
    // pay serial filesystem latency. Drain all reads before returning a failure.
    const results = await Promise.allSettled([...level.values()].map(async (current) => {
      if (!checked.get(key(path.dirname(current)))) { checked.set(key(current), false); facts.set(current, null); return; }
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw new DkbError(`Symlinked Library path is unsafe: ${current}`, 'library_recovery_required');
        checked.set(key(current), true);
        facts.set(current, stat);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { checked.set(key(current), false); facts.set(current, null); return; }
        throw error;
      }
    }));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
  return facts;
}

/** Byte identity, not mtime. Never follows links, and never reads unrelated Library trees. */
export async function pathReceipt(target: string): Promise<string | null> {
  let stat;
  try { stat = await fs.lstat(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new DkbError(`Symlink in Library mutation path: ${target}`, 'library_recovery_required');
  if (stat.isFile()) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(target)) hash.update(chunk);
    return `file:${hash.digest('hex')}`;
  }
  if (!stat.isDirectory()) throw new DkbError(`Unsupported Library mutation path: ${target}`, 'library_recovery_required');
  const entries: Array<[string, string | null]> = [];
  for (const name of (await fs.readdir(target)).sort()) entries.push([name, await pathReceipt(path.join(target, name))]);
  return `tree:${createHash('sha256').update(JSON.stringify(entries)).digest('hex')}`;
}

export async function syncDirectory(target: string): Promise<void> {
  // Windows does not support opening directories for fsync; SQLite still flushes its decision.
  if (process.platform === 'win32') return;
  const handle = await fs.open(target, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
