import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DkbError } from '@dkb/protocol/errors.js';
import { installDkbArchiveIntoRuntime } from '../registry/packageRegistry.js';
import { DkbRegistryClient } from '../registry/client.js';
import { configuredRegistry } from '../registry/config.js';
import { defaultRuntimeStateRoot } from '../runtime/state.js';
import { discoverRemoteDkb } from './discovery.js';
import {
  loadRemoteCatalog,
  markRemoteOfferPresented,
  packageFromDiscovery,
  registerRemoteInCatalog,
  removeRemoteFromCatalog,
  updateRemoteOfferState,
  type DkbPersistentRemote,
} from './catalog.js';
import { retrieveFromRemoteEndpoint } from './sessions.js';
import { assertVerifiedDiscovery, verifyRegistryEndpointAttestation } from './verification.js';
import type {
  DkbDiscoveryDocument,
  DkbDiscoveryEndpoint,
  DkbRemoteEndpointAttestation,
} from './types.js';
import type { DkbRetrieveKnowledgeRequest, DkbRetrieveKnowledgeResponse } from '../read/runtime.js';
import type { DkbSigningKeyRecord } from '@dkb/protocol/types.js';

export async function addDirectRemote(input: {
  url: string;
  stateRoot?: string;
}): Promise<{ remote: DkbPersistentRemote; discovery: DkbDiscoveryDocument }> {
  const discovered = await discoverRemoteDkb(input.url);
  publicReadEndpoint(discovered.discovery);
  const remote = await registerRemoteInCatalog(input.stateRoot ?? defaultRuntimeStateRoot(), {
    discoveryUrl: discovered.discoveryUrl,
    discovery: discovered.discovery,
    package: packageFromDiscovery(discovered.discovery),
    trust: 'unverified',
    status: 'unregistered',
  });

  return { remote, discovery: discovered.discovery };
}

export async function addRegisteredRemote(input: {
  packageId: string;
  version?: string;
  endpointUrl?: string;
  registryUrl?: string;
  token?: string;
  stateRoot?: string;
}): Promise<{
  remote: DkbPersistentRemote;
  discovery: DkbDiscoveryDocument;
  attestation: DkbRemoteEndpointAttestation;
}> {
  const registry = await configuredRegistry({
    url: input.registryUrl,
    root: input.stateRoot ?? defaultRuntimeStateRoot(),
  });
  const client = new DkbRegistryClient({ baseUrl: registry.url, token: input.token });
  const packageResponse = await client.download(input.packageId, input.version);
  const packageData = recordField(packageResponse, 'data');
  const version = input.version ?? stringField(packageData, 'latestVersion');

  if (!version) {
    throw new DkbError('Registry package has no published version: ' + input.packageId);
  }

  const endpoint = await client.verifiedRemoteEndpoint(input.packageId, version, input.endpointUrl);
  const endpointUrl = requiredField(endpoint, 'endpointUrl');
  const discoveryUrl = requiredField(endpoint, 'discoveryUrl');
  const packageTreeHash = requiredField(endpoint, 'packageTreeHash');
  const attestation = parseAttestation(endpoint.attestation);
  const discovered = await discoverRemoteDkb(discoveryUrl);
  const packageEntry = assertVerifiedDiscovery({
    discovery: discovered.discovery,
    packageId: input.packageId,
    version,
    packageTreeHash,
    endpointUrl,
    registryUrl: client.baseUrl,
  });
  const keys = signingKeys(await client.publicKeys());

  verifyRegistryEndpointAttestation({
    attestation,
    trustedKeys: keys,
    registryUrl: client.baseUrl,
    endpointUrl,
    discoveryUrl,
    packageId: input.packageId,
    version,
    packageTreeHash,
  });

  const remote = await registerRemoteInCatalog(input.stateRoot ?? defaultRuntimeStateRoot(), {
    discoveryUrl,
    discovery: discovered.discovery,
    package: packageEntry,
    registryUrl: client.baseUrl,
    trust: 'registry-verified',
    status: endpoint.status === 'behind' ? 'behind' : 'verified',
    verificationLeaseExpiresAt: attestation.expiresAt,
    attestation,
  });

  return { remote, discovery: discovered.discovery, attestation };
}

export async function listRegisteredRemotes(input: {
  stateRoot?: string;
  presentOffers?: boolean;
} = {}): Promise<{ remotes: DkbPersistentRemote[]; offers: DkbPersistentRemote[] }> {
  const stateRoot = input.stateRoot ?? defaultRuntimeStateRoot();
  const remotes = await loadRemoteCatalog(stateRoot);
  const offers: DkbPersistentRemote[] = [];

  if (!input.presentOffers) {
    return { remotes, offers };
  }

  for (const remote of remotes) {
    if (!remote.offerId || remote.offerState) {
      continue;
    }

    offers.push(await markRemoteOfferPresented(stateRoot, remote.id));
  }

  return {
    remotes: await loadRemoteCatalog(stateRoot),
    offers,
  };
}

export async function removeRegisteredRemote(id: string, stateRoot = defaultRuntimeStateRoot()): Promise<void> {
  await removeRemoteFromCatalog(stateRoot, id);
}

export async function queryRegisteredRemote(input: {
  id: string;
  request: DkbRetrieveKnowledgeRequest;
  stateRoot?: string;
}): Promise<{ remote: DkbPersistentRemote; response: DkbRetrieveKnowledgeResponse }> {
  const stateRoot = input.stateRoot ?? defaultRuntimeStateRoot();
  const current = (await loadRemoteCatalog(stateRoot)).find((remote) => remote.id === input.id);

  if (!current) {
    throw new DkbError('Unknown remote DKB: ' + input.id);
  }

  if (current.trust !== 'registry-verified') {
    throw new DkbError('Only registry-verified remotes can be queried through the persistent remote gateway. Use a temporary direct session for unverified development remotes.');
  }

  const remote = await refreshExpiredRemote(current, stateRoot);
  const response = await retrieveFromRemoteEndpoint({
    type: remote.endpointType,
    url: remote.endpointUrl,
    access: 'public-read',
  }, input.request);

  assertRemoteResponseProvenance(remote, response);

  return { remote, response };
}

export async function installRegisteredRemote(input: {
  id: string;
  confirm: true;
  runtimeRoot?: string;
  token?: string;
  stateRoot?: string;
}) {
  const stateRoot = input.stateRoot ?? defaultRuntimeStateRoot();
  const current = (await loadRemoteCatalog(stateRoot)).find((remote) => remote.id === input.id);

  if (!current) {
    throw new DkbError('Unknown remote DKB: ' + input.id);
  }

  if (current.trust !== 'registry-verified' || !current.registryUrl || !current.packageId || !current.version || !current.packageTreeHash) {
    throw new DkbError('Only registry-verified remotes can offer package installation.');
  }

  const remote = await refreshExpiredRemote(current, stateRoot);
  const packageId = remote.packageId;
  const version = remote.version;
  const registryUrl = remote.registryUrl;

  if (!packageId || !version || !registryUrl) {
    throw new DkbError('Verified remote lost its package or registry identity during lease refresh.');
  }

  const client = new DkbRegistryClient({ baseUrl: registryUrl, token: input.token });
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-remote-install-'));
  const archivePath = path.join(tempRoot, packageId.replace(/[^a-zA-Z0-9._-]+/g, '-') + '.dkbpkg');

  try {
    const release = await client.packageRelease(packageId, version);
    await client.writePackageArchive(packageId, archivePath, release.version);
    const publicKeys = signingKeys(await client.publicKeys());
    const result = await installDkbArchiveIntoRuntime({
      archivePath,
      runtimeRoot: input.runtimeRoot,
      trustedKeys: publicKeys,
      expectedArchiveHash: release.archiveHash,
      force: true,
    });

    await updateRemoteOfferState(stateRoot, remote.id, 'installed');

    return {
      status: 'installed',
      remote,
      package: result,
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function refreshExpiredRemote(remote: DkbPersistentRemote, stateRoot: string): Promise<DkbPersistentRemote> {
  if (remote.trust !== 'registry-verified' || !remote.registryUrl || !remote.packageId || !remote.version) {
    return remote;
  }

  if (remote.verificationLeaseExpiresAt && Date.parse(remote.verificationLeaseExpiresAt) > Date.now()) {
    return remote;
  }

  return (await addRegisteredRemote({
    packageId: remote.packageId,
    version: remote.version,
    endpointUrl: remote.endpointUrl,
    registryUrl: remote.registryUrl,
    stateRoot,
  })).remote;
}

function assertRemoteResponseProvenance(remote: DkbPersistentRemote, response: DkbRetrieveKnowledgeResponse): void {
  if (!remote.packageId) {
    return;
  }

  for (const match of response.metadata.sourceUnitMatches) {
    if (match.dkbId !== remote.packageId) {
      throw new DkbError('Remote response provenance mismatch: expected package ' + remote.packageId + ', got ' + match.dkbId + '.');
    }

    const packageVersion = (match as { packageVersion?: unknown }).packageVersion;

    if (typeof packageVersion === 'string' && remote.version && packageVersion !== remote.version) {
      throw new DkbError('Remote response version mismatch: expected ' + remote.version + ', got ' + packageVersion + '.');
    }

    const packageTreeHash = (match as { packageTreeHash?: unknown }).packageTreeHash;

    if (typeof packageTreeHash === 'string' && remote.packageTreeHash && packageTreeHash !== remote.packageTreeHash) {
      throw new DkbError('Remote response package tree hash mismatch.');
    }
  }
}

function publicReadEndpoint(discovery: DkbDiscoveryDocument): DkbDiscoveryEndpoint {
  const endpoint = discovery.endpoints.find((candidate) => candidate.type === 'dkb-runtime-http' && candidate.access === 'public-read');

  if (!endpoint) {
    throw new DkbError('Remote discovery does not expose a public-read DKB runtime endpoint.');
  }

  return endpoint;
}

function parseAttestation(value: unknown): DkbRemoteEndpointAttestation {
  if (!isRecord(value)
    || value.type !== 'dkb.remote.endpoint.attestation'
    || value.version !== 1
    || !isRecord(value.subject)
    || !isRecord(value.registry)) {
    throw new DkbError('Registry returned an invalid remote endpoint attestation.');
  }

  return value as unknown as DkbRemoteEndpointAttestation;
}

function signingKeys(value: unknown): DkbSigningKeyRecord[] {
  const keys = isRecord(value) && Array.isArray(value.keys) ? value.keys : [];

  return keys.filter((key): key is Record<string, unknown> => isRecord(key)
    && typeof key.id === 'string'
    && key.algorithm === 'ed25519'
    && typeof key.publicKeyPem === 'string'
    && typeof key.publicKeyFingerprint === 'string'
    && typeof key.status === 'string')
    .map((key) => ({
      id: key.id as string,
      subjectType: key.subjectType === 'publisher' ? 'publisher' : 'registry',
      subjectId: typeof key.subjectId === 'string' ? key.subjectId : '',
      algorithm: 'ed25519',
      publicKeyPem: key.publicKeyPem as string,
      publicKeyFingerprint: key.publicKeyFingerprint as string,
      status: key.status === 'revoked' ? 'revoked' : key.status === 'rotated' ? 'rotated' : 'active',
      createdAt: typeof key.createdAt === 'string' ? key.createdAt : '',
    }));
}

function recordField(value: unknown, field: string): Record<string, unknown> {
  const record = isRecord(value) && isRecord(value[field]) ? value[field] : null;

  if (!record) {
    throw new DkbError('Registry response is missing ' + field + '.');
  }

  return record;
}

function requiredField(value: Record<string, unknown>, field: string): string {
  if (typeof value[field] !== 'string' || value[field].length === 0) {
    throw new DkbError('Registry remote endpoint is missing ' + field + '.');
  }

  return value[field] as string;
}

function stringField(value: Record<string, unknown>, field: string): string | undefined {
  return typeof value[field] === 'string' ? value[field] as string : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
