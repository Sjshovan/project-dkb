import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DKB_ARTIFACTS_DIR, DKB_CACHE_DIR, resolveFrom } from '@dkb/protocol/paths.js';
import { DKB_RETRIEVAL_PROFILE_LOCK_PATH } from '@dkb/pipeline/profile.js';

const SNAPSHOT_PATHS = [
  DKB_ARTIFACTS_DIR,
  `${DKB_CACHE_DIR}/compile-cache.json`,
  DKB_RETRIEVAL_PROFILE_LOCK_PATH,
];

export interface LibraryArtifactSnapshot {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/** Preserve the exact aggregate retrieval state around an atomic Library mutation. */
export async function snapshotLibraryArtifacts(libraryRoot: string): Promise<LibraryArtifactSnapshot> {
  const resolvedRoot = path.resolve(libraryRoot);
  const snapshotRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-library-artifacts-'));
  const entries: Array<{ relative: string; snapshot: string; existed: boolean; directory: boolean }> = [];

  try {
    for (const relative of SNAPSHOT_PATHS) {
      const source = resolveFrom(resolvedRoot, relative);
      const snapshot = path.join(snapshotRoot, ...relative.split('/'));
      const stat = await fs.stat(source).catch(() => null);
      const existed = Boolean(stat);
      const directory = Boolean(stat?.isDirectory());

      if (stat) {
        await fs.mkdir(path.dirname(snapshot), { recursive: true });
        if (directory) await fs.cp(source, snapshot, { recursive: true });
        else await fs.copyFile(source, snapshot);
      }

      entries.push({ relative, snapshot, existed, directory });
    }
  } catch (error) {
    await fs.rm(snapshotRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    // Cleanup is best-effort once the mutation is committed. A temporary-file
    // removal failure must not turn a successful Library transaction into a
    // rollback attempt after its package backup has already been released.
    commit: async () => {
      await fs.rm(snapshotRoot, { recursive: true, force: true }).catch(() => undefined);
    },
    rollback: async () => {
      for (const entry of entries) {
        const target = resolveFrom(resolvedRoot, entry.relative);
        await fs.rm(target, { recursive: true, force: true });

        if (!entry.existed) continue;
        await fs.mkdir(path.dirname(target), { recursive: true });
        if (entry.directory) await fs.cp(entry.snapshot, target, { recursive: true });
        else await fs.copyFile(entry.snapshot, target);
      }

      await fs.rm(snapshotRoot, { recursive: true, force: true });
    },
  };
}
