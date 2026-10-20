import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { validateDockerLibraryOwner, type DockerLibraryOwner } from './libraryOwner.js';

export type DockerLibraryStorage = DockerLibraryOwner & { kind: 'docker' };
export type HostLibraryLocation = { path: string; storage?: never } | { path?: never; storage: DockerLibraryStorage };

export function validateDockerLibraryStorage(value: unknown): DockerLibraryStorage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DkbError('Docker Library storage must be an owner descriptor.', 'invalid_library_owner');
  }
  const { kind, ...owner } = value as Record<string, unknown>;
  if (kind !== 'docker') throw new DkbError('Unsupported Library storage kind.', 'invalid_library_owner');
  return { kind, ...validateDockerLibraryOwner(owner as unknown as DockerLibraryOwner) };
}

/** Display only. A Docker location must never be passed to filesystem APIs. */
export function hostLibraryLocation(value: HostLibraryLocation): string {
  return value.storage ? `docker://${value.storage.context}/${value.storage.volume}` : value.path;
}

export function localHostLibraryPath(value: HostLibraryLocation): string {
  if (value.storage) {
    throw new DkbError(`This operation requires owner-side execution for ${hostLibraryLocation(value)}. It cannot use a host filesystem path. No Library data was changed.`, 'unsupported_capability');
  }
  return value.path;
}

export function dockerLibraryOwner(storage: DockerLibraryStorage): DockerLibraryOwner {
  const { kind: _kind, ...owner } = storage;
  return validateDockerLibraryOwner(owner);
}
