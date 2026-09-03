import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

interface RuntimeGate {
  activeReaders: number;
  pendingWriters: number;
  writerActive: boolean;
  writerTail: Promise<void>;
  readersDrained: Promise<void> | null;
  releaseReaders: (() => void) | null;
}

const gates = new Map<string, RuntimeGate>();
const mutationContext = new AsyncLocalStorage<ReadonlySet<string>>();
const RUNTIME_LOCK_TIMEOUT_MS = 120_000;
const RUNTIME_LOCK_STALE_MS = 4 * 60 * 60_000;

/**
 * Serialize mutations for one Runtime and wait for every in-flight query to
 * release its snapshot before package files or managed indexes are changed.
 */
export async function withRuntimeMutation<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(root);
  if (mutationContext.getStore()?.has(key)) return operation();
  const gate = runtimeGate(root);
  gate.pendingWriters += 1;
  const previous = gate.writerTail;
  let releaseWriter!: () => void;
  const writer = new Promise<void>((resolve) => {
    releaseWriter = resolve;
  });
  gate.writerTail = previous.then(() => writer, () => writer);
  await previous;
  gate.pendingWriters -= 1;
  gate.writerActive = true;

  try {
    if (gate.activeReaders > 0) {
      gate.readersDrained ??= new Promise<void>((resolve) => {
        gate.releaseReaders = resolve;
      });
      await gate.readersDrained;
    }
    return await withRuntimeFileLock(key, () => mutationContext.run(
      new Set([...(mutationContext.getStore() ?? []), key]),
      operation,
    ));
  } finally {
    gate.writerActive = false;
    releaseWriter();
  }
}

/** Hold a stable Runtime snapshot for the complete query operation. */
export async function withRuntimeQuery<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const gate = runtimeGate(root);

  while (gate.writerActive || gate.pendingWriters > 0) {
    await gate.writerTail;
  }
  gate.activeReaders += 1;

  try {
    return await operation();
  } finally {
    gate.activeReaders -= 1;
    if (gate.activeReaders === 0 && gate.releaseReaders) {
      const release = gate.releaseReaders;
      gate.releaseReaders = null;
      gate.readersDrained = null;
      release();
    }
  }
}

/** Keep direct snapshot consumers outside an active or queued mutation. */
export async function waitForRuntimeMutation(root: string): Promise<void> {
  const gate = runtimeGate(root);
  while (gate.writerActive || gate.pendingWriters > 0) {
    await gate.writerTail;
  }
}

function runtimeGate(root: string): RuntimeGate {
  const key = path.resolve(root);
  const existing = gates.get(key);
  if (existing) return existing;
  const created: RuntimeGate = {
    activeReaders: 0,
    pendingWriters: 0,
    writerActive: false,
    writerTail: Promise.resolve(),
    readersDrained: null,
    releaseReaders: null,
  };
  gates.set(key, created);
  return created;
}

async function withRuntimeFileLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const lockRoot = path.join(root, '.dkb', 'locks');
  const lockPath = path.join(lockRoot, 'runtime-mutation.lock');
  const token = randomUUID();
  const started = Date.now();
  await fs.mkdir(lockRoot, { recursive: true });

  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, host: os.hostname(), createdAt: new Date().toISOString() })}\n`, 'utf8');
        return await operation();
      } finally {
        await handle.close();
        await releaseRuntimeFileLock(lockPath, token);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await removeAbandonedRuntimeLock(lockPath)) continue;
      if (Date.now() - started >= RUNTIME_LOCK_TIMEOUT_MS) {
        throw new DkbError(
          `Timed out waiting for Runtime mutation lock at ${lockPath}. `
          + 'Another DKB process is changing this Runtime; wait for it to finish and retry.',
          'runtime_busy',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
  }
}

async function removeAbandonedRuntimeLock(lockPath: string): Promise<boolean> {
  const stat = await fs.stat(lockPath).catch(() => null);
  if (!stat) return true;
  const owner = await fs.readFile(lockPath, 'utf8').then((value) => JSON.parse(value) as { pid?: unknown; host?: unknown }, () => null);
  if (owner && owner.host === os.hostname() && Number.isInteger(owner.pid) && Number(owner.pid) > 0) {
    try {
      process.kill(Number(owner.pid), 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
      await fs.rm(lockPath, { force: true }).catch(() => undefined);
      return true;
    }
  }
  if (Date.now() - stat.mtimeMs < RUNTIME_LOCK_STALE_MS) return false;
  await fs.rm(lockPath, { force: true }).catch(() => undefined);
  return true;
}

async function releaseRuntimeFileLock(lockPath: string, token: string): Promise<void> {
  const owner = await fs.readFile(lockPath, 'utf8').then((value) => JSON.parse(value) as { token?: unknown }, () => null);
  if (owner?.token === token) await fs.rm(lockPath, { force: true });
}
