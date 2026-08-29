import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DKB_CACHE_DIR, DKB_RUNTIME_LOCK_PATH, resolveFrom } from '@sjshovan/dkb-protocol/paths.js';

const RECEIPT_PATHS = [
  `${DKB_CACHE_DIR}/compile-cache.json`,
  DKB_RUNTIME_LOCK_PATH,
];

export interface RuntimeReceiptSnapshot {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/** Preserve only mutable Runtime receipts around an atomic Library mutation. */
export async function snapshotRuntimeReceipts(libraryRoot: string): Promise<RuntimeReceiptSnapshot> {
  const resolvedRoot = path.resolve(libraryRoot);
  const snapshotRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-runtime-receipts-'));
  const entries: Array<{ relative: string; snapshot: string; existed: boolean }> = [];

  try {
    for (const relative of RECEIPT_PATHS) {
      const source = resolveFrom(resolvedRoot, relative);
      const snapshot = path.join(snapshotRoot, ...relative.split('/'));
      const existed = await fs.stat(source).then((stat) => stat.isFile()).catch(() => false);
      if (existed) {
        await fs.mkdir(path.dirname(snapshot), { recursive: true });
        await fs.copyFile(source, snapshot);
      }
      entries.push({ relative, snapshot, existed });
    }
  } catch (error) {
    await fs.rm(snapshotRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    commit: async () => {
      await fs.rm(snapshotRoot, { recursive: true, force: true }).catch(() => undefined);
    },
    rollback: async () => {
      for (const entry of entries) {
        const target = resolveFrom(resolvedRoot, entry.relative);
        await fs.rm(target, { force: true });
        if (!entry.existed) continue;
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(entry.snapshot, target);
      }
      await fs.rm(snapshotRoot, { recursive: true, force: true });
    },
  };
}
