import { createPublicKey, verify } from 'node:crypto';
import { canonicalJson } from '@dkb/protocol/contracts/hash.js';
import { fingerprintPublicKey } from '@dkb/library/signing.js';
import { DkbError } from '@dkb/protocol/errors.js';
import type { DkbDiscoveryDocument, DkbDiscoveryPackage, DkbRemoteEndpointAttestation } from './types.js';

export function assertVerifiedDiscovery(input: {
  discovery: DkbDiscoveryDocument;
  packageId: string;
  version: string;
  packageTreeHash: string;
  endpointUrl: string;
  registryUrl: string;
}): DkbDiscoveryPackage {
  if (input.discovery.version !== '0.2') {
    throw new DkbError('Registry-verified remote DKBs require discovery protocol 0.2.');
  }

  const endpoint = input.discovery.endpoints.find((candidate) => normalizeEndpointUrl(candidate.url) === normalizeEndpointUrl(input.endpointUrl));

  if (!endpoint || endpoint.type !== 'dkb-runtime-http' || endpoint.access !== 'public-read') {
    throw new DkbError('Remote endpoint is not the registry-approved public-read DKB runtime endpoint.');
  }

  const packageEntry = input.discovery.packages?.find((candidate) => candidate.id === input.packageId);

  if (!packageEntry || packageEntry.version !== input.version || packageEntry.packageTreeHash !== input.packageTreeHash) {
    throw new DkbError(`Remote DKB release mismatch for ${input.packageId}@${input.version}.`);
  }

  const install = packageEntry.install;

  if (!install
    || normalizeEndpointUrl(install.registryUrl) !== normalizeEndpointUrl(input.registryUrl)
    || install.packageId !== input.packageId
    || install.version !== input.version
    || install.packageTreeHash !== input.packageTreeHash) {
    throw new DkbError(`Remote DKB install descriptor mismatch for ${input.packageId}@${input.version}.`);
  }

  return packageEntry;
}

function normalizeEndpointUrl(value: string): string {
  return value.replace(/\/$/, '');
}

export function verifyRegistryEndpointAttestation(input: {
  attestation: DkbRemoteEndpointAttestation;
  trustedKeys: Array<{
    id: string;
    algorithm?: string;
    publicKeyPem: string;
    publicKeyFingerprint: string;
    status?: string;
  }>;
  registryUrl: string;
  endpointUrl: string;
  discoveryUrl: string;
  packageId: string;
  version: string;
  packageTreeHash: string;
  now?: Date;
}): void {
  const attestation = input.attestation;

  if (attestation.type !== 'dkb.remote.endpoint.attestation' || attestation.version !== 1) {
    throw new DkbError('Registry returned an unsupported remote endpoint attestation.');
  }

  const subject = attestation.subject;
  const expected = {
    registryUrl: input.registryUrl,
    endpointUrl: input.endpointUrl,
    discoveryUrl: input.discoveryUrl,
    packageId: input.packageId,
    version: input.version,
    packageTreeHash: input.packageTreeHash,
  };

  if (canonicalJson(subject) !== canonicalJson(expected)) {
    throw new DkbError(`Registry endpoint attestation does not match ${input.packageId}@${input.version}.`);
  }

  const now = input.now ?? new Date();
  const issuedAt = Date.parse(attestation.issuedAt);
  const expiresAt = Date.parse(attestation.expiresAt);

  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt || expiresAt <= now.getTime()) {
    throw new DkbError('Registry endpoint attestation is expired or has invalid timestamps.');
  }

  const key = input.trustedKeys.find((candidate) => candidate.id === attestation.registry.keyId && candidate.status !== 'revoked');

  if (!key) {
    throw new DkbError(`Registry endpoint attestation key is unavailable: ${attestation.registry.keyId}`);
  }

  if (attestation.registry.algorithm !== 'ed25519' || key.algorithm && key.algorithm !== 'ed25519') {
    throw new DkbError('Registry endpoint attestation uses an unsupported signature algorithm.');
  }

  if (key.publicKeyFingerprint !== attestation.registry.publicKeyFingerprint || fingerprintPublicKey(key.publicKeyPem) !== attestation.registry.publicKeyFingerprint) {
    throw new DkbError('Registry endpoint attestation public key fingerprint mismatch.');
  }

  const content = {
    type: attestation.type,
    version: attestation.version,
    subject,
    issuedAt: attestation.issuedAt,
    expiresAt: attestation.expiresAt,
  };

  let valid = false;

  try {
    valid = verify(
      null,
      Buffer.from(canonicalJson(content), 'utf8'),
      createPublicKey(key.publicKeyPem),
      Buffer.from(attestation.registry.value, 'base64'),
    );
  } catch {
    valid = false;
  }

  if (!valid) {
    throw new DkbError('Registry endpoint attestation signature verification failed.');
  }
}
