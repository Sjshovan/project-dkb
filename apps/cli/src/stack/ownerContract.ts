import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import type { StackOwnerInspection } from './ownerInspection.js';
import type { DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import { validateStackServiceEnvironment } from './serviceEnvironment.js';

export const STACK_OWNER_FORMAT = 'dkb.stack-owner.v1';
export const STACK_OWNER_WORKER = '/workspace/apps/cli/dist/stack/ownerWorker.js';

export interface DockerStackOwner {
  context: string;
  image: string;
  libraryVolume: string;
  runtimeVolume: string;
  compilerVolume: string;
}

export interface StackOwnerInspectRequest {
  format: typeof STACK_OWNER_FORMAT;
  command: 'inspect';
  input: { compilerTarget?: string; runtimeTarget?: string; allowedTargets?: string[] };
}

export interface StackOwnerInitializeRequest {
  format: typeof STACK_OWNER_FORMAT;
  command: 'binding.initialize';
  input: StackOwnerInspectRequest['input'] & { runtimeId: string; scopeDigest: string };
}

export interface StackOwnerConfigureRequest {
  format: typeof STACK_OWNER_FORMAT;
  command: 'configure';
  input: {
    id: string;
    scopeDigest: string;
    expected: StackOwnerInspection;
    images: Record<string, { reference: string; digest: string }>;
  };
}
export interface StackOwnerSettleRequest {
  format: typeof STACK_OWNER_FORMAT;
  command: 'configuration.rollback' | 'configuration.commit';
  input: { id: string; scopeDigest: string };
}
export interface StackOwnerCancelRequest {
  format: typeof STACK_OWNER_FORMAT;
  command: 'configuration.cancel';
  input: { id: string; scopeDigest: string; expected: StackOwnerInspection };
}
export type StackOwnerRequest = StackOwnerInspectRequest | StackOwnerInitializeRequest | StackOwnerConfigureRequest | StackOwnerSettleRequest | StackOwnerCancelRequest;
export interface StackOwnerConfigurationResult {
  format: 'dkb.stack-owner-configuration.v1';
  id: string;
  status: 'prepared' | 'rolled_back' | 'committed';
}

export function validateDockerStackOwner(value: unknown): DockerStackOwner {
  const owner = object(value);
  keys(owner, ['context', 'image', 'libraryVolume', 'runtimeVolume', 'compilerVolume']);
  for (const key of ['context', 'libraryVolume', 'runtimeVolume', 'compilerVolume']) {
    const validName = key === 'context' ? /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u : /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/u;
    if (typeof owner[key] !== 'string' || !validName.test(owner[key])) fail('Stack owner requires named local Docker context and volumes.');
  }
  if (typeof owner.image !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(owner.image)) fail('Stack owner requires an installed immutable CLI image.');
  if (new Set([owner.libraryVolume, owner.runtimeVolume, owner.compilerVolume]).size !== 3) fail('Library, Runtime and compiler context must have separate volumes.');
  return { ...owner } as unknown as DockerStackOwner;
}

/** Image upgrades do not change storage identity; remounting any volume does. */
export function stackOwnerScopeDigest(owner: DockerStackOwner): string {
  const { image: _image, ...storage } = validateDockerStackOwner(owner);
  return stableHash(storage);
}

/** Private, typed operations only. Activation and arbitrary file/command execution are never admitted. */
export function planStackOwnerRequest(value: unknown): StackOwnerRequest {
  const request = object(value);
  keys(request, ['format', 'command', 'input']);
  if (request.format !== STACK_OWNER_FORMAT) fail('Unsupported Stack owner request.');
  const input = object(request.input);
  if (request.command === 'configure' || request.command === 'configuration.rollback' || request.command === 'configuration.commit' || request.command === 'configuration.cancel') {
    keys(input, request.command === 'configure' ? ['id', 'scopeDigest', 'expected', 'images']
      : request.command === 'configuration.cancel' ? ['id', 'scopeDigest', 'expected'] : ['id', 'scopeDigest']);
    transactionId(input.id); digest(input.scopeDigest);
    if (request.command === 'configure' || request.command === 'configuration.cancel') validateStackOwnerInspection(input.expected);
    if (request.command === 'configure') {
      const images = object(input.images);
      if (Object.keys(images).length > 128) fail('Too many Stack service images.');
      for (const [name, definition] of Object.entries(images)) {
        target(name);
        const image = object(definition); keys(image, ['reference', 'digest']); digest(image.digest);
        if (typeof image.reference !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,511}$/u.test(image.reference)) fail('Invalid service image reference.');
      }
    }
    return structuredClone(request) as unknown as StackOwnerConfigureRequest | StackOwnerSettleRequest | StackOwnerCancelRequest;
  }
  if (request.command !== 'inspect' && request.command !== 'binding.initialize') fail('Unsupported Stack owner request.');
  keys(input, ['compilerTarget', 'runtimeTarget', 'allowedTargets', ...(request.command === 'binding.initialize' ? ['runtimeId', 'scopeDigest'] : [])]);
  if (request.command === 'binding.initialize') {
    if (typeof input.runtimeId !== 'string' || !/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9._])?$/u.test(input.runtimeId)) fail('Runtime identity must already be canonical.');
    digest(input.scopeDigest);
  }
  for (const key of ['compilerTarget', 'runtimeTarget']) if (input[key] !== undefined) target(input[key]);
  if (input.allowedTargets !== undefined) {
    if (!Array.isArray(input.allowedTargets) || input.allowedTargets.length > 128) fail('At most 128 allowed Pipeline names may be supplied.');
    for (const name of input.allowedTargets) target(name);
    if (new Set(input.allowedTargets).size !== input.allowedTargets.length) fail('Allowed Pipeline names must be unique.');
  }
  return structuredClone(request) as unknown as StackOwnerInspectRequest | StackOwnerInitializeRequest;
}

export function validateStackOwnerConfigurationResult(value: unknown): StackOwnerConfigurationResult {
  const result = object(value); keys(result, ['format', 'id', 'status']); transactionId(result.id);
  if (result.format !== 'dkb.stack-owner-configuration.v1' || !['prepared', 'rolled_back', 'committed'].includes(String(result.status))) fail('Invalid Stack configuration result.');
  return structuredClone(result) as unknown as StackOwnerConfigurationResult;
}
function transactionId(value: unknown): void {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value)) fail('Invalid Stack operation identity.');
}

function target(value: unknown): void {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value)) fail('Pipeline must be a configured name, not options or a command.');
}

/** A pinned worker still must return the complete observation contract before host orchestration uses it. */
export function validateStackOwnerInspection(value: unknown, distribution?: DkbDistribution): StackOwnerInspection {
  const result = object(value);
  keys(result, ['format', 'library', 'runtime', 'configDigests', 'plan']);
  if (result.format !== 'dkb.stack-owner-inspection.v1') fail('Invalid Stack owner inspection format.');
  const library = object(result.library), runtime = object(result.runtime), configs = object(result.configDigests), plan = object(result.plan);
  keys(library, ['id', 'generation', 'stateDigest']);
  keys(runtime, ['id', 'target', 'state', 'selectionDigest', 'activationDigest']);
  keys(configs, ['compiler', 'runtime', 'library']);
  keys(plan, ['compilerTarget', 'runtimeTarget', 'compilerTargets', 'requiredServices', 'compilerServices', 'runtimeServices', 'recipeDigest', 'serviceEnvironment']);
  digest(plan.recipeDigest);
  if (typeof library.id !== 'string' || !library.id || library.id.length > 2048 || /[\u0000-\u001f]/u.test(library.id)
    || !Number.isSafeInteger(library.generation) || Number(library.generation) < 0) fail('Invalid observed Library identity.');
  for (const field of [library.stateDigest, runtime.selectionDigest, configs.compiler, configs.runtime, configs.library]) digest(field);
  if (!['unbound', 'inactive', 'current', 'stale'].includes(String(runtime.state))) fail('Invalid observed Runtime state.');
  if (runtime.state === 'unbound') {
    if (runtime.id !== null || runtime.target !== null || runtime.activationDigest !== null) fail('Unbound Runtime cannot report an activation.');
  } else {
    target(runtime.id); target(runtime.target);
    if (runtime.state === 'inactive') { if (runtime.activationDigest !== null) fail('Inactive Runtime cannot report an activation.'); }
    else digest(runtime.activationDigest);
  }
  target(plan.compilerTarget); target(plan.runtimeTarget);
  for (const key of ['compilerTargets', 'requiredServices', 'compilerServices', 'runtimeServices']) {
    const values = plan[key];
    if (!Array.isArray(values) || values.length > 128 || new Set(values).size !== values.length) fail('Invalid observed Stack service or target list.');
    values.forEach(target);
  }
  if (!(plan.compilerTargets as string[]).includes(String(plan.compilerTarget))) fail('Compiler default is absent from the allowed target list.');
  for (const service of [...plan.compilerServices as string[], ...plan.runtimeServices as string[]]) {
    if (!(plan.requiredServices as string[]).includes(service)) fail('Selected provider service is absent from the required service list.');
  }
  validateStackServiceEnvironment(plan.serviceEnvironment, distribution?.services,
    [...plan.compilerServices as string[], ...plan.runtimeServices as string[]]);
  if (distribution && (plan.requiredServices as string[]).some(id => !distribution.services.some(service => service.id === id))) {
    fail('Stack owner selected a service absent from the host distribution.');
  }
  return structuredClone(result) as unknown as StackOwnerInspection;
}
function digest(value: unknown): void { if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) fail('Invalid observed Stack digest.'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Stack owner input must contain plain objects.');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('Unexpected Stack owner parameter.');
}
function fail(message: string): never { throw new DkbError(message, 'invalid_stack_owner_request'); }
