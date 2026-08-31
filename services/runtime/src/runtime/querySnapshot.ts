import path from 'node:path';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { libraryStateIdentity } from '@sjshovan/dkb-library/state.js';
import {
  closeQueryContext,
  getQueryContext,
  invalidateQueryContext,
  queryArtifactHash,
  type QueryContext,
} from '../indexes/queryContext.js';
import type { DkbRuntimeContext } from './context.js';
import type { DkbRuntimeInstance } from './activation.js';

const runtimeQueryContexts = new Map<string, QueryContext>();

export async function getOrOpenRuntimeQueryContext(
  instance: DkbRuntimeInstance,
  libraryId: string,
  runtime: DkbRuntimeContext,
): Promise<QueryContext | undefined> {
  const snapshotKey = path.resolve(instance.stateRoot);
  const activation = instance.activation;
  if (!activation) return undefined;

  const identity = await libraryStateIdentity(instance.libraryRoot);
  if (activation.library.id !== identity.id
    || activation.library.generation !== identity.generation
    || activation.library.stateDigest !== identity.stateDigest) {
    throw new DkbError(
      `Runtime ${instance.runtimeId} is stale because Library ${identity.id} changed after activation. `
      + `Run dkb runtime refresh ${instance.runtimeId} before querying.`,
      'runtime_refresh_required',
    );
  }
  const existing = runtimeQueryContexts.get(snapshotKey);
  if (existing && existing.artifactHash === activationHash(activation)) return existing;
  if (existing) await closeRuntimeQuerySnapshot(instance.stateRoot);

  try {
    const context = await getQueryContext(instance.libraryRoot, libraryId, runtime, {
      runtimeStateRoot: instance.stateRoot,
      activation,
    });
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

function activationHash(activation: DkbRuntimeInstance['activation']): string {
  if (!activation) return '';
  return queryArtifactHash(activation);
}

function isMissingCompiledArtifactError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unable to open database file|no such file or directory|ENOENT/i.test(message);
}
