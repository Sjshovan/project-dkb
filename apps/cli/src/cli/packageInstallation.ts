import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { parseDkbIdentity } from '@sjshovan/dkb-protocol/identity.js';
import { progressStart, progressUpdate, progressFinish, type DkbProgressReporter } from '@sjshovan/dkb-protocol/progress.js';
import type { DkbRuntimeClient } from '@sjshovan/dkb-runtime/runtime/client.js';
import { DkbRegistryClient } from '@sjshovan/dkb-registry-client/client.js';
import type { CollectionMemberGrant } from '@sjshovan/dkb-protocol/registryCollections.js';
import type { CliLibraryReference } from './context.js';
import { configuredRegistry } from './registryConfig.js';
import { refreshCliLibraryMutation } from './libraryOperation.js';
import { dockerLibraryOwner } from '../host/libraryLocation.js';
import { installDockerLibraryPackage } from '../host/libraryInstall.js';
import { LIBRARY_COLLECTION_INSTALL_FORMAT, LIBRARY_INSTALL_FORMAT, dockerRegistryTransportUrl } from '../host/libraryInstallContract.js';

/** Host credentials mint a scoped grant; knowledge and live databases stay in Linux. */
export async function installCliDockerPackage(reference: Extract<CliLibraryReference, { kind: 'docker' }>, options: {
  identity: string; version?: string; revision?: number; target?: string; url?: string; force?: boolean;
  runtimeUrl?: string; progress?: DkbProgressReporter;
  expectedLibraryGeneration?: number;
  runtimeClient(url: string): Promise<Pick<DkbRuntimeClient, 'reload'>>;
}) {
  const identity = parseDkbIdentity(options.identity, 'Package identity').identity;
  const registry = await configuredRegistry({ url: options.url, library: reference });
  const client = new DkbRegistryClient({ baseUrl: registry.url });
  if (await client.entryKind(identity) === 'collection') {
    if (options.version) throw new DkbError('--version applies to DKBs; use --revision for a Collection.');
    if (options.target) throw new DkbError('--target applies to DKBs. Install the Collection, then run dkb pipeline use <target>.');
    return installCliCollection(reference, { ...options, identity }, client);
  }
  if (options.revision) throw new DkbError('--revision applies to Collections; use --version for a DKB.');
  const version = options.version ?? await client.latestPackageVersion(identity);
  const grant = await client.createInstallGrant(identity, version, options.target);
  const result = await installDockerLibraryPackage(dockerLibraryOwner(reference.storage), {
    format: LIBRARY_INSTALL_FORMAT, registryUrl: registry.url, registryTransportUrl: dockerRegistryTransportUrl(registry.url),
    installGrant: grant.installGrant, plan: grant.plan, force: Boolean(options.force),
    ...(options.expectedLibraryGeneration === undefined ? {} : { expectedLibraryGeneration: options.expectedLibraryGeneration }),
  }, { libraryName: reference.name, progress: options.progress });
  return refreshCliLibraryMutation(result, reference, options.runtimeClient, options.runtimeUrl);
}

/** Top-level and Collection-specific commands keep the same install and refresh semantics. */
export async function installCliCollection(reference: CliLibraryReference, options: {
  identity: string; revision?: number; update?: boolean; url?: string; runtimeUrl?: string; progress?: DkbProgressReporter;
  runtimeClient(url: string): Promise<Pick<DkbRuntimeClient, 'reload'>>;
}, selectedClient?: DkbRegistryClient) {
  const identity = parseDkbIdentity(options.identity, 'Collection identity').identity;
  const client = selectedClient ?? new DkbRegistryClient({ baseUrl: (await configuredRegistry({ url: options.url, library: reference })).url });
  let result;
  if (reference.kind === 'docker') {
    const collection = await client.collectionRevision(identity, options.revision);
    const stage = { phase: 'collection-grants', label: 'Authorize Collection members', total: collection.manifest.members.length, unit: 'steps' as const };
    options.progress?.(progressStart(stage));
    const members: CollectionMemberGrant[] = [];
    for (const member of collection.manifest.members) {
      const grant = await client.createInstallGrant(member.id, member.version);
      members.push({ plan: grant.plan, installGrant: grant.installGrant });
      options.progress?.(progressUpdate({ ...stage, value: members.length }));
    }
    options.progress?.(progressFinish(stage));
    result = await installDockerLibraryPackage(dockerLibraryOwner(reference.storage), {
      format: LIBRARY_COLLECTION_INSTALL_FORMAT, registryUrl: client.baseUrl, registryTransportUrl: dockerRegistryTransportUrl(client.baseUrl),
      collection, members, update: Boolean(options.update),
    }, { libraryName: reference.name, progress: options.progress });
  } else {
    const { installRegistryCollection } = await import('@sjshovan/dkb-runtime/runtime/collections.js');
    result = await installRegistryCollection({ client, collectionId: identity, revision: options.revision,
      libraryRoot: reference.path, update: options.update, progress: options.progress });
  }
  return refreshCliLibraryMutation(result, reference, options.runtimeClient, options.runtimeUrl);
}
