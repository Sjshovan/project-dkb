import fs from 'node:fs/promises';
import path from 'node:path';
import { withDkbFileLock } from '@sjshovan/dkb-library/locks.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import { withRuntimeMutation } from '@sjshovan/dkb-runtime/runtime/mutation.js';
import { initializeRuntimeBinding } from '@sjshovan/dkb-runtime/runtime/state.js';
import { planStackOwnerRequest, STACK_OWNER_FORMAT } from './ownerContract.js';
import { STACK_CONFIGURATION_JOURNAL } from './ownerConfiguration.js';
import { inspectStackOwnerState } from './ownerInspection.js';
import type { StackRecipePaths } from './recipes.js';

/** First binding only. Runtime owns the atomic writer; this cannot switch or activate it. */
export async function initializeStackOwner(distribution: DkbDistribution, paths: StackRecipePaths, value: unknown) {
  const request = planStackOwnerRequest(value);
  if (request.command !== 'binding.initialize') throw new DkbError('Expected first-binding operation.', 'invalid_stack_owner_request');
  const { runtimeId, compilerTarget, runtimeTarget, allowedTargets } = request.input;
  // Match configuration preparation's lock order, without holding ownership across service startup.
  return withDkbFileLock(paths.compilerRoot, 'stack-control', () => withRuntimeMutation(paths.runtimeRoot, async () => {
    try {
      await fs.lstat(path.join(paths.runtimeRoot, STACK_CONFIGURATION_JOURNAL));
      throw new DkbError('Settle pending Stack configuration before initializing its Runtime.', 'stack_owner_recovery_required');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const inspection = { format: STACK_OWNER_FORMAT, command: 'inspect' as const,
      input: { ...(compilerTarget ? { compilerTarget } : {}), ...(runtimeTarget ? { runtimeTarget } : {}),
        ...(allowedTargets ? { allowedTargets } : {}) } };
    // Observation fails closed on pending activation/Library recovery, wrong mounts and broken recipes.
    const before = await inspectStackOwnerState(distribution, paths, inspection);
    if (before.runtime.id !== null) {
      if (before.runtime.id !== runtimeId) throw new DkbError('Runtime volume belongs to another Runtime. Select its existing binding; no state was changed.', 'stack_owner_runtime_mismatch');
      return before;
    }
    await initializeRuntimeBinding(paths.runtimeRoot, {
      runtimeId, libraryRoot: paths.libraryRoot, target: before.plan.runtimeTarget,
    });
    // A lost response is retry-safe: a matching existing binding is returned unchanged above.
    return inspectStackOwnerState(distribution, paths, inspection);
  }));
}
