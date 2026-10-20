import { stableHash } from './contracts/hash.js';
import { DkbError } from './errors.js';

export const DKB_RUNTIME_BINDING_FORMAT = 'dkb.runtime-binding.v1';
export const DKB_RUNTIME_ACTIVATION_FORMAT = 'dkb.runtime-activation.v1';

export interface DkbLocalRuntimeLibraryBinding {
  kind: 'local';
  path: string;
  name?: string;
}

export interface DkbRemoteRuntimeLibraryBinding {
  kind: 'remote';
  handle: string;
}

export type DkbRuntimeLibraryBinding = DkbLocalRuntimeLibraryBinding | DkbRemoteRuntimeLibraryBinding;

export interface DkbRuntimeBinding {
  format: typeof DKB_RUNTIME_BINDING_FORMAT;
  runtimeId: string;
  library: DkbRuntimeLibraryBinding;
  target: string;
  updatedAt: string;
}

export interface DkbRuntimeActivationEntry {
  version: string;
  evidenceProfileDigest: string;
  evidenceDigest: string;
  retrievalProfileDigest: string;
  retrievalBuildDigest: string;
}

export interface DkbRuntimeActivation {
  format: typeof DKB_RUNTIME_ACTIVATION_FORMAT;
  runtimeId: string;
  library: {
    id: string;
    generation: number;
    stateDigest: string;
  };
  target: string;
  evidenceProfileDigest: string;
  retrievalProfileDigest: string;
  compatibilityDigest: string;
  packages: Record<string, DkbRuntimeActivationEntry>;
  generation: number;
  generatedAt: string;
}

export function validateRuntimeBinding(value: unknown, source = 'Runtime binding'): DkbRuntimeBinding {
  if (!isRecord(value) || value.format !== DKB_RUNTIME_BINDING_FORMAT || !isRecord(value.library)) {
    throw new DkbError(`Invalid ${source}: expected ${DKB_RUNTIME_BINDING_FORMAT}`);
  }
  const candidate = value as unknown as DkbRuntimeBinding;
  assertRuntimeId(candidate.runtimeId, `${source} runtimeId`);
  assertTarget(candidate.target, `${source} target`);
  assertTimestamp(candidate.updatedAt, `${source} updatedAt`);
  if (candidate.library.kind === 'local') {
    if (typeof candidate.library.path !== 'string' || candidate.library.path.trim().length === 0) {
      throw new DkbError(`Invalid ${source}: local Library path is required`);
    }
    if (candidate.library.name !== undefined && (typeof candidate.library.name !== 'string' || candidate.library.name.trim().length === 0)) {
      throw new DkbError(`Invalid ${source}: local Library name must be non-empty`);
    }
  } else if (candidate.library.kind === 'remote') {
    if (typeof candidate.library.handle !== 'string' || candidate.library.handle.trim().length === 0) {
      throw new DkbError(`Invalid ${source}: remote Library handle is required`);
    }
  } else {
    throw new DkbError(`Invalid ${source}: Library kind must be local or remote`);
  }
  return candidate;
}

export function validateRuntimeActivation(value: unknown, source = 'Runtime activation'): DkbRuntimeActivation {
  if (!isRecord(value) || value.format !== DKB_RUNTIME_ACTIVATION_FORMAT || !isRecord(value.library) || !isRecord(value.packages)) {
    throw new DkbError(`Invalid ${source}: expected ${DKB_RUNTIME_ACTIVATION_FORMAT}`);
  }
  const candidate = value as unknown as DkbRuntimeActivation;
  assertRuntimeId(candidate.runtimeId, `${source} runtimeId`);
  assertTarget(candidate.target, `${source} target`);
  if (typeof candidate.library.id !== 'string' || candidate.library.id.trim().length === 0) {
    throw new DkbError(`Invalid ${source}: Library identity is required`);
  }
  assertNonNegativeInteger(candidate.library.generation, `${source} Library generation`);
  assertDigest(candidate.library.stateDigest, `${source} Library stateDigest`);
  for (const [label, digest] of Object.entries({
    evidenceProfileDigest: candidate.evidenceProfileDigest,
    retrievalProfileDigest: candidate.retrievalProfileDigest,
    compatibilityDigest: candidate.compatibilityDigest,
  })) assertDigest(digest, `${source} ${label}`);
  assertNonNegativeInteger(candidate.generation, `${source} generation`);
  assertTimestamp(candidate.generatedAt, `${source} generatedAt`);

  for (const [id, entry] of Object.entries(candidate.packages)) {
    if (!isRecord(entry) || typeof entry.version !== 'string' || entry.version.trim().length === 0) {
      throw new DkbError(`Invalid ${source}: package ${id} is incomplete`);
    }
    for (const [label, digest] of Object.entries({
      evidenceProfileDigest: entry.evidenceProfileDigest,
      evidenceDigest: entry.evidenceDigest,
      retrievalProfileDigest: entry.retrievalProfileDigest,
      retrievalBuildDigest: entry.retrievalBuildDigest,
    })) assertDigest(digest, `${source} package ${id} ${label}`);
    if (entry.evidenceProfileDigest !== candidate.evidenceProfileDigest
      || entry.retrievalProfileDigest !== candidate.retrievalProfileDigest) {
      throw new DkbError(`Invalid ${source}: package ${id} does not match the active profiles`);
    }
  }
  return candidate;
}

export function runtimeActivationDigest(value: DkbRuntimeActivation): string {
  return stableHash(validateRuntimeActivation(value));
}

function assertRuntimeId(value: unknown, source: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u.test(value)) {
    throw new DkbError(`Invalid ${source}: use 1-64 lowercase letters, numbers, dots, dashes, or underscores`);
  }
}

function assertTarget(value: unknown, source: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/u.test(value)) {
    throw new DkbError(`Invalid ${source}: use lowercase letters, numbers, dots, dashes, or underscores`);
  }
}

function assertDigest(value: unknown, source: string): asserts value is string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new DkbError(`Invalid ${source}: expected a sha256 digest`);
  }
}

function assertNonNegativeInteger(value: unknown, source: string): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new DkbError(`Invalid ${source}: expected a non-negative integer`);
}

function assertTimestamp(value: unknown, source: string): asserts value is string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new DkbError(`Invalid ${source}: expected an ISO timestamp`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
