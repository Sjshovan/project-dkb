import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv';
import dkbSchema from '../../schemas/dkb.schema.json' with { type: 'json' };
import dkbReadRequestSchema from '../../schemas/dkb-read-request.schema.json' with { type: 'json' };
import lockSchema from '../../schemas/dkb-lock.schema.json' with { type: 'json' };
import { DkbError } from './errors.js';
import type { DkbLockManifest, DkbReadRequest, DkbSourceManifest } from './types.js';

const ajv = new Ajv2020({ allErrors: true });
const validateDkbManifestSchema = ajv.compile<DkbSourceManifest>(dkbSchema);
const validateDkbLockManifestSchema = ajv.compile<DkbLockManifest>(lockSchema);
const validateDkbReadRequestSchema = ajv.compile<DkbReadRequest>(dkbReadRequestSchema);

export function validateDkbManifest(value: unknown, source: string): DkbSourceManifest {
  if (validateDkbManifestSchema(value)) {
    return normalizeExtensions(value as DkbSourceManifest) as DkbSourceManifest;
  }

  throw new DkbError(formatValidationError(source, validateDkbManifestSchema.errors));
}

export function validateDkbLockManifest(value: unknown, source: string): DkbLockManifest {
  if (validateDkbLockManifestSchema(value)) {
    return value as DkbLockManifest;
  }

  throw new DkbError(formatValidationError(source, validateDkbLockManifestSchema.errors));
}

export function validateDkbReadRequest(value: unknown, source: string): DkbReadRequest {
  if (validateDkbReadRequestSchema(value)) {
    return value as DkbReadRequest;
  }

  throw new DkbError(formatValidationError(source, validateDkbReadRequestSchema.errors));
}

function formatValidationError(source: string, errors: typeof validateDkbManifestSchema.errors): string {
  const detail = errors?.map((error: ErrorObject) => `${error.instancePath || '/'} ${error.message}`).join('; ');

  return `Invalid manifest at ${source}: ${detail || 'schema validation failed'}`;
}

function normalizeExtensions(value: object): object {
  const entries = Object.entries(value as Record<string, unknown>);
  const extensions = Object.fromEntries(entries.filter(([key]) => key.startsWith('x-')));

  return Object.keys(extensions).length > 0
    ? { ...value, extensions }
    : value;
}
