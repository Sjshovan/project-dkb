import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { validateInstallPlan, type DkbInstallPlan } from '@sjshovan/dkb-protocol/builds.js';
import { normalizeRegistryUrl, dockerRegistryTransportUrl } from '@sjshovan/dkb-registry-client/config.js';
export { dockerRegistryTransportUrl } from '@sjshovan/dkb-registry-client/config.js';
import { validateCollectionGrants } from '@sjshovan/dkb-protocol/registryCollections.js';

export const LIBRARY_INSTALL_FORMAT = 'dkb.library-install.v2';
export const LIBRARY_COLLECTION_INSTALL_FORMAT = 'dkb.library-collection-install.v1';
export const LIBRARY_INSTALL_WORKER = '/workspace/apps/cli/dist/host/libraryInstallWorker.js';
export const LIBRARY_INSTALL_INPUT_LIMIT = 2 * 1024 * 1024;

export interface LibraryInstallRequest {
  format: typeof LIBRARY_INSTALL_FORMAT;
  registryUrl: string;
  registryTransportUrl: string;
  installGrant: string;
  plan: DkbInstallPlan;
  force: boolean;
  expectedLibraryGeneration?: number;
}

export interface LibraryCollectionInstallRequest extends ReturnType<typeof validateCollectionGrants> {
  format: typeof LIBRARY_COLLECTION_INSTALL_FORMAT;
  registryUrl: string;
  registryTransportUrl: string;
  update: boolean;
}
export type LibraryGrantRequest = LibraryInstallRequest | LibraryCollectionInstallRequest;

/** Private grant-only input, validated on both sides; never accept host credentials or paths. */
export function validateLibraryInstallRequest(value: unknown): LibraryGrantRequest {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const request = value as Record<string, unknown>;
    if (Buffer.byteLength(JSON.stringify(value)) > LIBRARY_INSTALL_INPUT_LIMIT) throw new Error();
    const registryUrl = endpoint(request.registryUrl);
    const registryTransportUrl = endpoint(request.registryTransportUrl);
    // The host may translate loopback for Docker only. It cannot send a grant to
    // an arbitrary alternate origin, change the port/path, or downgrade HTTPS.
    if (registryTransportUrl !== dockerRegistryTransportUrl(registryUrl)) throw new Error();
    if (request.format === LIBRARY_COLLECTION_INSTALL_FORMAT) {
      if (Object.keys(request).some(key => !['format', 'registryUrl', 'registryTransportUrl', 'collection', 'members', 'update'].includes(key))
        || typeof request.update !== 'boolean') throw new Error();
      return { format: LIBRARY_COLLECTION_INSTALL_FORMAT, registryUrl, registryTransportUrl, update: request.update,
        ...validateCollectionGrants(request.collection, request.members) };
    }
    if (Object.keys(request).some(key => !['format', 'registryUrl', 'registryTransportUrl', 'installGrant', 'plan', 'force', 'expectedLibraryGeneration'].includes(key))
      || request.format !== LIBRARY_INSTALL_FORMAT || typeof request.force !== 'boolean'
      || (request.expectedLibraryGeneration !== undefined && (!Number.isSafeInteger(request.expectedLibraryGeneration) || (request.expectedLibraryGeneration as number) < 0))
      || typeof request.installGrant !== 'string' || !/^[\x21-\x7e]{1,4096}$/u.test(request.installGrant)) throw new Error();
    return { format: LIBRARY_INSTALL_FORMAT, registryUrl, registryTransportUrl,
      installGrant: request.installGrant, force: request.force,
      ...(request.expectedLibraryGeneration === undefined ? {} : { expectedLibraryGeneration: request.expectedLibraryGeneration as number }),
      plan: validateInstallPlan(request.plan, 'Owner install plan') };
  } catch {
    throw new DkbError('Invalid signed Library install request. Request a fresh exact Registry grant with the matching CLI; no package was changed.', 'invalid_library_install_request');
  }
}

function endpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/u.test(value)) throw new Error('Invalid endpoint');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid endpoint');
  return normalizeRegistryUrl(url.toString());
}
