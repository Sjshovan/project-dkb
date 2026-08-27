import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DkbError } from '@dkb/protocol/errors.js';
import type { DkbDiscoveryDocument, DkbDiscoveryPackage, DkbRemoteEndpointAttestation, DkbRemoteEndpointType } from './types.js';

export type DkbRemoteCatalogStatus = 'verified' | 'behind' | 'mismatch' | 'unavailable' | 'unregistered';
export type DkbRemoteOfferState = 'presented' | 'accepted' | 'declined' | 'installed';

export interface DkbPersistentRemote {
  id: string;
  origin: 'registry' | 'direct';
  trust: 'registry-verified' | 'unverified';
  registryUrl?: string;
  packageId?: string;
  version?: string;
  packageTreeHash?: string;
  discoveryUrl: string;
  endpointUrl: string;
  endpointType: DkbRemoteEndpointType;
  status: DkbRemoteCatalogStatus;
  verificationLeaseExpiresAt?: string;
  attestation?: DkbRemoteEndpointAttestation;
  offerId?: string;
  offerState?: DkbRemoteOfferState;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

interface RemoteCatalogFile {
  version: 1;
  remotes: DkbPersistentRemote[];
}

export function remoteCatalogPath(stateRoot: string): string {
  return path.join(path.resolve(stateRoot), 'remotes.json');
}

export async function loadRemoteCatalog(stateRoot: string): Promise<DkbPersistentRemote[]> {
  try {
    const raw = JSON.parse(await fs.readFile(remoteCatalogPath(stateRoot), 'utf8')) as Partial<RemoteCatalogFile>;

    return raw.version === 1 && Array.isArray(raw.remotes) ? raw.remotes : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw new DkbError(`Invalid DKB remote catalog: ${remoteCatalogPath(stateRoot)}`);
  }
}

export async function saveRemoteCatalog(stateRoot: string, remotes: DkbPersistentRemote[]): Promise<void> {
  const filePath = remoteCatalogPath(stateRoot);
  const temporaryPath = `${filePath}.${process.pid}.tmp`;

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(temporaryPath, `${JSON.stringify({ version: 1, remotes }, null, 2)}\n`, 'utf8');
  await fs.rename(temporaryPath, filePath);
}

export async function registerRemoteInCatalog(
  stateRoot: string,
  input: {
    discoveryUrl: string;
    discovery: DkbDiscoveryDocument;
    package?: DkbDiscoveryPackage;
    registryUrl?: string;
    trust?: 'registry-verified' | 'unverified';
    status?: DkbRemoteCatalogStatus;
    verificationLeaseExpiresAt?: string;
    attestation?: DkbRemoteEndpointAttestation;
  },
): Promise<DkbPersistentRemote> {
  const now = new Date().toISOString();
  const packageId = input.package?.id;
  const endpoint = input.discovery.endpoints[0];

  if (!endpoint) {
    throw new DkbError('Remote discovery did not expose an endpoint.');
  }

  const id = remoteId(input.registryUrl, packageId, input.package?.version, endpoint.url);
  const remotes = await loadRemoteCatalog(stateRoot);
  const previous = remotes.find((remote) => remote.id === id);
  const offerId = packageId && input.package?.version && input.package.packageTreeHash
    ? remoteOfferId(input.registryUrl ?? input.discovery.site, packageId, input.package.version, input.package.packageTreeHash)
    : undefined;
  const next: DkbPersistentRemote = {
    id,
    origin: input.registryUrl ? 'registry' : 'direct',
    trust: input.trust ?? (input.registryUrl ? 'registry-verified' : 'unverified'),
    ...(input.registryUrl ? { registryUrl: input.registryUrl } : {}),
    ...(packageId ? { packageId } : {}),
    ...(input.package?.version ? { version: input.package.version } : {}),
    ...(input.package?.packageTreeHash ? { packageTreeHash: input.package.packageTreeHash } : {}),
    discoveryUrl: input.discoveryUrl,
    endpointUrl: endpoint.url,
    endpointType: endpoint.type,
    status: input.status ?? (input.registryUrl ? 'verified' : 'unregistered'),
    ...(input.verificationLeaseExpiresAt ? { verificationLeaseExpiresAt: input.verificationLeaseExpiresAt } : {}),
    ...(input.attestation ? { attestation: input.attestation } : {}),
    ...(offerId ? { offerId, offerState: previous?.offerState } : {}),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };

  await saveRemoteCatalog(stateRoot, [...remotes.filter((remote) => remote.id !== id), next]);

  return next;
}

export async function removeRemoteFromCatalog(stateRoot: string, id: string): Promise<void> {
  const remotes = await loadRemoteCatalog(stateRoot);

  if (!remotes.some((remote) => remote.id === id)) {
    throw new DkbError(`Unknown remote DKB: ${id}`);
  }

  await saveRemoteCatalog(stateRoot, remotes.filter((remote) => remote.id !== id));
}

export async function markRemoteOfferPresented(stateRoot: string, id: string): Promise<DkbPersistentRemote> {
  return updateRemoteOfferState(stateRoot, id, 'presented');
}

export async function updateRemoteOfferState(stateRoot: string, id: string, state: DkbRemoteOfferState): Promise<DkbPersistentRemote> {
  const remotes = await loadRemoteCatalog(stateRoot);
  const remote = remotes.find((candidate) => candidate.id === id);

  if (!remote) {
    throw new DkbError(`Unknown remote DKB: ${id}`);
  }

  const next = { ...remote, offerState: state, updatedAt: new Date().toISOString() };
  await saveRemoteCatalog(stateRoot, remotes.map((candidate) => candidate.id === id ? next : candidate));

  return next;
}

export function packageFromDiscovery(discovery: DkbDiscoveryDocument, packageId?: string): DkbDiscoveryPackage | undefined {
  return discovery.packages?.find((item) => !packageId || item.id === packageId);
}

export function remoteId(registryUrl: string | undefined, packageId: string | undefined, version: string | undefined, endpointUrl: string): string {
  const value = [registryUrl ?? 'direct', packageId ?? 'remote', version ?? 'latest', endpointUrl].join('|');

  return `remote_${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

export function remoteOfferId(registryUrl: string, packageId: string, version: string, packageTreeHash: string): string {
  return `offer_${createHash('sha256').update([registryUrl, packageId, version, packageTreeHash].join('|')).digest('hex').slice(0, 24)}`;
}
