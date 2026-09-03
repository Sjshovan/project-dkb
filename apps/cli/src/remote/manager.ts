import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { DkbRegistryClient } from '@sjshovan/dkb-registry-client/client.js';
import { resolveRegistryContext } from '@sjshovan/dkb-registry-client/config.js';
import { defaultRuntimeStateRoot } from '@sjshovan/dkb-runtime/runtime/state.js';
import { discoverRemoteDkb } from '@sjshovan/dkb-runtime/remote/discovery.js';
import {
  loadRemoteCatalog,
  packageFromDiscovery,
  registerRemoteInCatalog,
  removeRemoteFromCatalog,
  type DkbPersistentRemote,
} from './catalog.js';
import { assertVerifiedDiscovery, verifyRegistryEndpointAttestation } from '@sjshovan/dkb-runtime/remote/verification.js';
import type {
  DkbDiscoveryDocument,
  DkbDiscoveryEndpoint,
  DkbRemoteEndpointAttestation,
} from '@sjshovan/dkb-runtime/remote/types.js';
import type { DkbSigningKeyRecord } from '@sjshovan/dkb-protocol/types.js';

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
  stateRoot?: string;
}): Promise<{
  remote: DkbPersistentRemote;
  discovery: DkbDiscoveryDocument;
  attestation: DkbRemoteEndpointAttestation;
}> {
  const registry = await resolveRegistryContext({
    url: input.registryUrl,
    root: input.stateRoot ?? defaultRuntimeStateRoot(),
  });
  const client = new DkbRegistryClient({ baseUrl: registry.url });
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
} = {}): Promise<{ remotes: DkbPersistentRemote[] }> {
  const stateRoot = input.stateRoot ?? defaultRuntimeStateRoot();
  return { remotes: await loadRemoteCatalog(stateRoot) };
}

export async function removeRegisteredRemote(id: string, stateRoot = defaultRuntimeStateRoot()): Promise<void> {
  await removeRemoteFromCatalog(stateRoot, id);
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
