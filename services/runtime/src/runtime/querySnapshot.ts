import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { libraryStateIdentity } from '@sjshovan/dkb-library/state.js';
import {
  closeQueryContext,
  getQueryContext,
  invalidateQueryContext,
  type QueryContext,
} from '../indexes/queryContext.js';
import type { DkbRuntimeContext } from './context.js';
import type { DkbRuntimeInstance } from './activation.js';

export async function getOrOpenRuntimeQueryContext(
  instance: DkbRuntimeInstance,
  libraryId: string,
  runtime: DkbRuntimeContext,
): Promise<QueryContext | undefined> {
  const activation = instance.activation;
  if (!activation) return undefined;

  await assertRuntimeLibraryCurrent(instance);
  try {
    return await getQueryContext(instance.libraryRoot, libraryId, runtime, {
      runtimeStateRoot: instance.stateRoot,
      activation,
    });
  } catch (error) {
    if (!isMissingCompiledArtifactError(error)) throw error;
    return undefined;
  }
}

export async function assertRuntimeLibraryCurrent(instance: DkbRuntimeInstance): Promise<void> {
  const activation = instance.activation;
  if (!activation) throw new DkbError('Runtime has no validated activation. Run dkb runtime refresh.', 'runtime_activation_required');
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
}

export function invalidateRuntimeQuerySnapshot(stateRoot?: string): number {
  return invalidateQueryContext(stateRoot);
}

export async function closeRuntimeQuerySnapshot(stateRoot: string): Promise<number> {
  return closeQueryContext(stateRoot);
}

function isMissingCompiledArtifactError(error: unknown): boolean {
  // Missing trust/receipts are security failures with their own recovery, not a refresh hint.
  if (error instanceof DkbError && error.code.startsWith('registry_')) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /unable to open database file|no such file or directory|ENOENT/i.test(message);
}
