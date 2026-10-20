import path from 'node:path';
import { libraryStateIdentity } from '@sjshovan/dkb-library/state.js';
import { captureLibraryReadFence, assertLibraryReadFence } from '@sjshovan/dkb-library/mutation.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { canonicalJson, stableHash as digest } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DKB_CONFIG_PATH, readDkbContextConfig } from '@sjshovan/dkb-pipeline/config.js';
import type { DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import { withRuntimeQuery } from '@sjshovan/dkb-runtime/runtime/mutation.js';
import { inspectRuntimeSelection } from '@sjshovan/dkb-runtime/runtime/state.js';
import { planStackOwnerRequest } from './ownerContract.js';
import { resolveStackSelection, selectedServiceEnvironment, stackSelectionDigest, type StackRecipePaths } from './recipes.js';

/** Inspect real owner state, not a host copy. Planning does not assert provider health or activate a Runtime. */
export async function inspectStackOwnerState(distribution: DkbDistribution, paths: StackRecipePaths, request: unknown) {
  const planned = planStackOwnerRequest(request);
  if (planned.command !== 'inspect') throw new DkbError('Stack observation requires an inspection request.', 'invalid_stack_owner_request');
  const { input } = planned;
  return withRuntimeQuery(paths.runtimeRoot, async () => {
    const fence = await captureLibraryReadFence(paths.libraryRoot);
    try {
      const configs = await readConfigDigests(paths);
      const library = await libraryStateIdentity(paths.libraryRoot);
      const { binding, activation } = await inspectRuntimeSelection(paths.runtimeRoot);
      // A mount change is not a binding change. The existing activation gate owns that operation.
      if (binding && (binding.library.kind !== 'local' || path.resolve(binding.library.path) !== path.resolve(paths.libraryRoot))) {
        throw new DkbError('Runtime is bound to a different Library handle. Use the Runtime Library switch operation; no selection was changed.', 'stack_owner_library_mismatch');
      }
      const selection = await resolveStackSelection(distribution, paths, {
        compilerTarget: input.compilerTarget,
        runtimeTarget: input.runtimeTarget ?? activation?.target ?? binding?.target,
        allowedTargets: input.allowedTargets?.join(',') ?? '',
      });
      const current = activation !== null && activation.library.id === library.id
        && activation.library.generation === library.generation && activation.library.stateDigest === library.stateDigest;
      if (canonicalJson(configs) !== canonicalJson(await readConfigDigests(paths))) {
        throw new DkbError('Pipeline configuration changed during Stack inspection. Retry without changing the existing Runtime.', 'stack_owner_config_drift');
      }
      return {
        format: 'dkb.stack-owner-inspection.v1' as const,
        library,
        runtime: {
          id: binding?.runtimeId ?? null,
          target: activation?.target ?? binding?.target ?? null,
          state: !binding ? 'unbound' as const : !activation ? 'inactive' as const : current ? 'current' as const : 'stale' as const,
          selectionDigest: digest({ binding, activation }),
          activationDigest: activation ? digest(activation) : null,
        },
        configDigests: configs,
        plan: {
          recipeDigest: stackSelectionDigest(distribution, selection),
          serviceEnvironment: selectedServiceEnvironment(selection),
          compilerTarget: selection.target, runtimeTarget: selection.runtimeTarget,
          compilerTargets: selection.compilerTargets,
          requiredServices: selection.requiredServices.map(service => service.id),
          compilerServices: selection.compilerServices[selection.target] ?? [],
          runtimeServices: selection.runtimeServices[selection.runtimeTarget] ?? [],
        },
      };
    } finally { await assertLibraryReadFence(paths.libraryRoot, fence); }
  });
}

export type StackOwnerInspection = Awaited<ReturnType<typeof inspectStackOwnerState>>;

async function readConfigDigests(paths: StackRecipePaths) {
  const values: string[] = [];
  for (const root of [paths.compilerRoot, paths.runtimeRoot, paths.libraryRoot]) {
    values.push(digest(await readDkbContextConfig(path.join(root, DKB_CONFIG_PATH))));
  }
  return { compiler: values[0]!, runtime: values[1]!, library: values[2]! };
}
