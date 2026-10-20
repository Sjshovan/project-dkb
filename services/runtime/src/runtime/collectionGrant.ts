import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { validateCollectionGrants, type CollectionMemberGrant, type DkbRegistryCollectionRevision } from '@sjshovan/dkb-protocol/registryCollections.js';
import type { DkbProgressReporter } from '@sjshovan/dkb-protocol/progress.js';
import { DkbRegistryClient } from '@sjshovan/dkb-registry-client/client.js';
import { installRegistryCollection, type CollectionRegistrySource } from './collections.js';
import { validateGrantedInstallOptions } from './registryInstall.js';

/** A grant-only transport adapter, not a second Collection installer or Runtime activation path. */
export async function installCollectionFromLibraryGrants(options: {
  libraryRoot: string; registryUrl: string; registryTransportUrl?: string;
  collection: DkbRegistryCollectionRevision; members: CollectionMemberGrant[];
  update: boolean; progress?: DkbProgressReporter;
}) {
  const { collection, members } = validateCollectionGrants(options.collection, options.members);
  if (typeof options.update !== 'boolean') throw new DkbError('Collection update must be explicit.', 'invalid_collection_grant');
  const requests = members.map(member => validateGrantedInstallOptions({ ...member,
    registryUrl: options.registryUrl, registryTransportUrl: options.registryTransportUrl }));
  const clients = requests.map(request => new DkbRegistryClient({ baseUrl: request.registryTransportUrl ?? request.registryUrl,
    installGrant: request.installGrant, token: '' }));
  const plans = new Map(requests.map(request => [request.plan.package.id, request.plan]));
  const downloads = new Map(requests.flatMap((request, index) => request.plan.artifacts.map(artifact => [stableHash(artifact), clients[index]!] as const)));
  const client: CollectionRegistrySource = {
    baseUrl: requests[0]!.registryUrl,
    collectionRevision: async () => collection,
    publicKeys: () => clients[0]!.publicKeys(),
    async installPlan(id, version) {
      const plan = plans.get(id);
      if (!plan || plan.package.version !== version) throw new DkbError('Requested member is outside the Collection grant.', 'invalid_collection_grant');
      return plan;
    },
    async writeInstallLayer(artifact, destination, progress) {
      const transport = downloads.get(stableHash(artifact));
      if (!transport) throw new DkbError('Requested artifact is outside the Collection grants.', 'invalid_collection_grant');
      return transport.writeInstallLayer(artifact, destination, progress);
    },
  };
  return installRegistryCollection({ client, collectionId: collection.collectionId, revision: collection.revision,
    libraryRoot: options.libraryRoot, update: options.update, progress: options.progress });
}
