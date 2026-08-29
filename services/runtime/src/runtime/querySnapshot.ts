import path from 'node:path';
import {
  closeQueryContext,
  getQueryContext,
  invalidateQueryContext,
  type QueryContext,
} from '../indexes/queryContext.js';
import type { DkbRuntimeContext } from './context.js';

// Runtime snapshots are invalidated by managed mutations, not revalidated on
// every request. This keeps the hot MCP path independent of artifact I/O.
const runtimeQueryContexts = new Map<string, QueryContext>();

export async function getOrOpenRuntimeQueryContext(
  stateRoot: string,
  registryId: string,
  runtime: DkbRuntimeContext,
): Promise<QueryContext | undefined> {
  const snapshotKey = path.resolve(stateRoot);
  const existing = runtimeQueryContexts.get(snapshotKey);
  if (existing) return existing;

  try {
    const context = await getQueryContext(stateRoot, registryId, runtime);
    runtimeQueryContexts.set(snapshotKey, context);
    return context;
  } catch (error) {
    if (!isMissingCompiledArtifactError(error)) throw error;
    return undefined;
  }
}

export function invalidateRuntimeQuerySnapshot(stateRoot?: string): number {
  if (!stateRoot) {
    const count = runtimeQueryContexts.size;
    runtimeQueryContexts.clear();
    invalidateQueryContext();

    return count;
  }

  const root = path.resolve(stateRoot);
  const removed = runtimeQueryContexts.delete(root) ? 1 : 0;
  invalidateQueryContext(root);

  return removed;
}

export async function closeRuntimeQuerySnapshot(stateRoot: string): Promise<number> {
  const root = path.resolve(stateRoot);
  const context = runtimeQueryContexts.get(root);
  const removed = runtimeQueryContexts.delete(root) ? 1 : 0;
  const residentClosed = await closeQueryContext(root);

  if (context && residentClosed === 0) {
    await context.retrieval.close();
    await context.index?.close();
    await context.providerHost.dispose();
  }

  return removed;
}

function isMissingCompiledArtifactError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return /unable to open database file|no such file or directory|ENOENT/i.test(message);
}
