import path from 'node:path';
import { DkbError } from './errors.js';

const IDENTITY_PATTERN = /^@([a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)\/([a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?)$/;

export interface DkbIdentityParts {
  identity: string;
  namespace: string;
  name: string;
}

export function parseDkbIdentity(value: string, label = 'DKB identity'): DkbIdentityParts {
  const identity = value.trim();
  const match = IDENTITY_PATTERN.exec(identity);

  if (!match) {
    throw new DkbError(`${label} must use the lowercase @namespace/name form: ${value}`);
  }

  return {
    identity,
    namespace: match[1]!,
    name: match[2]!,
  };
}

export function isDkbIdentity(value: unknown): value is string {
  return typeof value === 'string' && IDENTITY_PATTERN.test(value);
}

export function dkbIdentity(namespace: string, name: string): string {
  return parseDkbIdentity(`@${namespace}/${name}`).identity;
}

export function registryPackageRelativePath(identity: string): string {
  const parsed = parseDkbIdentity(identity);

  return path.join(`@${parsed.namespace}`, parsed.name);
}

export function registryPackagePath(libraryRoot: string, identity: string): string {
  return path.join(path.resolve(libraryRoot), 'vendor', registryPackageRelativePath(identity));
}

export function identityDisplayName(identity: string): string {
  return parseDkbIdentity(identity).name
    .split(/[-_.]+/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}
