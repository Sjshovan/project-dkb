import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import { runDockerOwnerWorker } from '../host/dockerOwnerWorker.js';
import { validateStackOwnerInspection, validateStackOwnerConfigurationResult, type DockerStackOwner, type StackOwnerInspectRequest,
  type StackOwnerInitializeRequest, type StackOwnerConfigureRequest, type StackOwnerSettleRequest, type StackOwnerCancelRequest, type StackOwnerConfigurationResult } from './ownerContract.js';
import type { StackOwnerInspection } from './ownerInspection.js';

/** Only offline observation is admitted here; activation remains Runtime-owned. */
export async function inspectDockerStackOwner(distribution: DkbDistribution, owner: DockerStackOwner, request: StackOwnerInspectRequest, signal?: AbortSignal): Promise<StackOwnerInspection> {
  return observeDockerStackOwner(distribution, owner, request, signal);
}

/** Initialize only the first binding in Linux; never replace a selection or create an activation. */
export async function initializeDockerStackOwner(distribution: DkbDistribution, owner: DockerStackOwner, request: StackOwnerInitializeRequest, signal?: AbortSignal): Promise<StackOwnerInspection> {
  const result = await observeDockerStackOwner(distribution, owner, request, signal);
  if (result.runtime.id !== request.input.runtimeId || result.runtime.state === 'unbound') {
    throw new DkbError('Stack owner did not confirm the requested Runtime identity. Inspect owner state before retrying.', 'stack_owner_protocol_failed');
  }
  return result;
}

async function observeDockerStackOwner(distribution: DkbDistribution, owner: DockerStackOwner, request: StackOwnerInspectRequest | StackOwnerInitializeRequest, signal?: AbortSignal): Promise<StackOwnerInspection> {
  const result = await runDockerOwnerWorker('stack', owner, request, { signal });
  let response: { ok?: boolean; value?: StackOwnerInspection; error?: { code?: string } };
  try { response = JSON.parse(result.stdout); } catch {
    throw new DkbError('Stack owner returned an invalid inspection response. Install a matching CLI image.', 'stack_owner_protocol_failed');
  }
  if (result.code !== 0 || response?.ok !== true || response.value?.format !== 'dkb.stack-owner-inspection.v1') {
    const code = typeof response?.error?.code === 'string' && /^[a-z_]{1,80}$/u.test(response.error.code)
      ? response.error.code : 'stack_owner_inspection_failed';
    throw new DkbError('Stack owner operation failed. Check the selected Library, Runtime recovery state and trusted Pipeline configuration. No activation or Library was changed.', code);
  }
  try { return validateStackOwnerInspection(response.value, distribution); } catch {
    throw new DkbError('Stack owner returned an incomplete or inconsistent observation. Install a matching CLI image; inspect the binding before retrying initialization.', 'stack_owner_protocol_failed');
  }
}

/** Configuration receipts contain no config bytes. The journal stays with the Linux Runtime. */
export async function configureDockerStackOwner(owner: DockerStackOwner, request: StackOwnerConfigureRequest | StackOwnerSettleRequest | StackOwnerCancelRequest,
  signal?: AbortSignal): Promise<StackOwnerConfigurationResult> {
  const result = await runDockerOwnerWorker('stack', owner, request, { signal });
  let response;
  try { response = JSON.parse(result.stdout); } catch {
    throw new DkbError('Stack owner returned an invalid configuration response. Inspect the pending operation before retrying.', 'stack_owner_protocol_failed');
  }
  if (result.code !== 0 || response?.ok !== true) {
    const code = typeof response?.error?.code === 'string' && /^[a-z_]{1,80}$/u.test(response.error.code)
      ? response.error.code : 'stack_owner_configuration_failed';
    throw new DkbError('Stack configuration was not confirmed. Inspect its owner-side recovery journal before retrying; no activation was written by this operation.', code);
  }
  const value = validateStackOwnerConfigurationResult(response.value);
  if (value.id !== request.input.id || (request.command === 'configure' ? value.status !== 'prepared'
    : request.command === 'configuration.commit' ? value.status !== 'committed' : value.status === 'prepared')) {
    throw new DkbError('Stack owner returned a mismatched configuration receipt.', 'stack_owner_protocol_failed');
  }
  return value;
}
