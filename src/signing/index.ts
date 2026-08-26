import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import { canonicalJson, stableHash } from '../contracts/hash.js';
import { DkbError } from '../protocol/errors.js';
import { artifactLockPath, manifestPath } from '../protocol/paths.js';
import { validateDkbLockManifest } from '../protocol/validation.js';
import type {
  DkbLockManifest,
  DkbPackageReceipt,
  DkbPackageReceiptPackage,
  DkbPackageReceiptPayload,
  DkbPackageReceiptSigningContent,
  DkbPublisherReleaseSignature,
  DkbRegistryReleaseSignature,
  DkbReleaseEnvelope,
  DkbReleasePackage,
  DkbReleasePayload,
  DkbReleaseSignature,
  DkbReleaseSigningContent,
} from '../protocol/types.js';

export const DKB_RELEASE_PATH = 'dkb-release.json';
export const DKB_PACKAGE_RECEIPT_PATH = '.dkb-package.json';

export interface DkbSigningKeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
  publicKeyFingerprint: string;
}

export interface CreateSignedReleaseOptions {
  package?: DkbReleasePackage | DkbPackageReceiptPackage;
  publisher: {
    accountId: string;
    keyId: string;
    privateKeyPem: string;
  };
  registry: {
    registryId: string;
    keyId: string;
    privateKeyPem: string;
  };
  signedAt?: string;
}

export interface SignComposeProjectOptions {
  keyEnv?: string;
  publisherKeyEnv?: string;
  registryKeyEnv?: string;
  signer?: string;
  accountId?: string;
  registryId?: string;
  publisherKeyId?: string;
  registryKeyId?: string;
}

export interface VerifyComposeReleaseOptions {
  keyEnv?: string;
  publisherKeyEnv?: string;
  registryKeyEnv?: string;
  signer?: string;
}

export interface DkbReleaseVerificationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export type DkbReleaseKeyResolver = (input: {
  role: 'publisher' | 'registry';
  signature: DkbPublisherReleaseSignature | DkbRegistryReleaseSignature;
  envelope: DkbReleaseEnvelope | DkbPackageReceipt;
}) => string | null | Promise<string | null>;

export function generateSigningKeyPair(): DkbSigningKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  return {
    privateKeyPem,
    publicKeyPem,
    publicKeyFingerprint: fingerprintPublicKey(publicKeyPem),
  };
}

export function publicKeyPemFromPrivateKey(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' }).toString();
}

export function fingerprintPublicKey(publicKeyPem: string): string {
  const publicKey = createPublicKey(publicKeyPem);
  const der = publicKey.export({ type: 'spki', format: 'der' });

  return `sha256:${createHash('sha256').update(der).digest('hex')}`;
}

export function releasePayloadForLock(lock: DkbLockManifest): DkbReleasePayload {
  return { lock };
}

export function packageReceiptPayloadForLock(lock: DkbLockManifest, packageTreeHash?: string): DkbPackageReceiptPayload {
  return {
    lock,
    ...(packageTreeHash ? { packageTreeHash } : {}),
  };
}

export function releasePackageForLock(lock: DkbLockManifest): DkbReleasePackage {
  return {
    name: lock.registry.name,
    version: lock.registry.version,
    registryId: lock.registry.id,
  };
}

export function releaseSigningContent(input: {
  package: DkbReleasePackage;
  payloadHash: string;
  payload: DkbReleasePayload;
}): DkbReleaseSigningContent {
  return {
    type: 'dkb.release.signing-content',
    version: 1,
    package: input.package,
    payloadHash: input.payloadHash,
    payload: input.payload,
  };
}

export function packageReceiptSigningContent(input: {
  package: DkbPackageReceiptPackage;
  payloadHash: string;
  payload: DkbPackageReceiptPayload;
}): DkbPackageReceiptSigningContent {
  return {
    type: 'dkb.package.receipt.signing-content',
    version: 1,
    package: input.package,
    payloadHash: input.payloadHash,
    payload: input.payload,
  };
}

export function createSignedPackageReceipt(lock: DkbLockManifest, options: CreateSignedReleaseOptions & {
  package: DkbPackageReceiptPackage;
  packageTreeHash?: string;
}): DkbPackageReceipt {
  const payload = packageReceiptPayloadForLock(lock, options.packageTreeHash);
  const payloadHash = stableHash(payload);
  const content = packageReceiptSigningContent({
    package: options.package,
    payloadHash,
    payload,
  });
  const signedAt = options.signedAt ?? new Date().toISOString();
  const publisherPublicKeyPem = publicKeyPemFromPrivateKey(options.publisher.privateKeyPem);
  const registryPublicKeyPem = publicKeyPemFromPrivateKey(options.registry.privateKeyPem);

  return {
    type: 'dkb.package.receipt',
    version: 1,
    package: options.package,
    payloadHash,
    payload,
    publisher: {
      accountId: options.publisher.accountId,
      keyId: options.publisher.keyId,
      publicKeyFingerprint: fingerprintPublicKey(publisherPublicKeyPem),
      algorithm: 'ed25519',
      value: signCanonical(content, options.publisher.privateKeyPem),
      signedAt,
    },
    registry: {
      registryId: options.registry.registryId,
      keyId: options.registry.keyId,
      publicKeyFingerprint: fingerprintPublicKey(registryPublicKeyPem),
      algorithm: 'ed25519',
      value: signCanonical(content, options.registry.privateKeyPem),
      signedAt,
    },
  };
}

export function createSignedReleaseEnvelope(lock: DkbLockManifest, options: CreateSignedReleaseOptions): DkbReleaseEnvelope {
  const payload = releasePayloadForLock(lock);
  const releasePackage = options.package ?? releasePackageForLock(lock);
  const payloadHash = stableHash(payload);
  const content = releaseSigningContent({
    package: releasePackage,
    payloadHash,
    payload,
  });
  const signedAt = options.signedAt ?? new Date().toISOString();
  const publisherPublicKeyPem = publicKeyPemFromPrivateKey(options.publisher.privateKeyPem);
  const registryPublicKeyPem = publicKeyPemFromPrivateKey(options.registry.privateKeyPem);

  return {
    type: 'dkb.release',
    version: 1,
    package: releasePackage,
    payloadHash,
    payload,
    publisher: {
      accountId: options.publisher.accountId,
      keyId: options.publisher.keyId,
      publicKeyFingerprint: fingerprintPublicKey(publisherPublicKeyPem),
      algorithm: 'ed25519',
      value: signCanonical(content, options.publisher.privateKeyPem),
      signedAt,
    },
    registry: {
      registryId: options.registry.registryId,
      keyId: options.registry.keyId,
      publicKeyFingerprint: fingerprintPublicKey(registryPublicKeyPem),
      algorithm: 'ed25519',
      value: signCanonical(content, options.registry.privateKeyPem),
      signedAt,
    },
  };
}

export async function verifyReleaseEnvelope(
  envelope: DkbReleaseEnvelope,
  keyResolver: DkbReleaseKeyResolver,
): Promise<{
  ok: boolean;
  payloadHash: string;
  checks: DkbReleaseVerificationCheck[];
}> {
  const checks: DkbReleaseVerificationCheck[] = [];
  const expectedPayloadHash = stableHash(envelope.payload);
  const payloadHashValid = expectedPayloadHash === envelope.payloadHash;

  checks.push({
    name: 'payload_hash',
    ok: payloadHashValid,
    detail: payloadHashValid
      ? 'payload hash matches release payload'
      : `payload hash mismatch: expected ${expectedPayloadHash}`,
  });

  const content = releaseSigningContent({
    package: envelope.package,
    payloadHash: envelope.payloadHash,
    payload: envelope.payload,
  });

  checks.push(...await verifyRoleSignature('publisher', envelope.publisher, envelope, content, keyResolver));
  checks.push(...await verifyRoleSignature('registry', envelope.registry, envelope, content, keyResolver));

  return {
    ok: checks.every((check) => check.ok),
    payloadHash: envelope.payloadHash,
    checks,
  };
}

export async function verifyPackageReceipt(
  receipt: DkbPackageReceipt,
  keyResolver: DkbReleaseKeyResolver,
): Promise<{
  ok: boolean;
  payloadHash: string;
  checks: DkbReleaseVerificationCheck[];
}> {
  const checks: DkbReleaseVerificationCheck[] = [];
  const expectedPayloadHash = stableHash(receipt.payload);
  const payloadHashValid = expectedPayloadHash === receipt.payloadHash;

  checks.push({
    name: 'payload_hash',
    ok: payloadHashValid,
    detail: payloadHashValid
      ? 'payload hash matches package receipt payload'
      : `payload hash mismatch: expected ${expectedPayloadHash}`,
  });

  const content = packageReceiptSigningContent({
    package: receipt.package,
    payloadHash: receipt.payloadHash,
    payload: receipt.payload,
  });

  checks.push(...await verifyRoleSignature('publisher', receipt.publisher, receipt, content, keyResolver));
  checks.push(...await verifyRoleSignature('registry', receipt.registry, receipt, content, keyResolver));

  return {
    ok: checks.every((check) => check.ok),
    payloadHash: receipt.payloadHash,
    checks,
  };
}

export async function signComposeProject(root: string, options: SignComposeProjectOptions = {}) {
  const resolvedRoot = path.resolve(root);
  const lockPath = artifactLockPath(resolvedRoot);
  const releasePath = manifestPath(resolvedRoot, DKB_RELEASE_PATH);
  const publisherKeyEnv = options.publisherKeyEnv ?? options.keyEnv ?? 'DKB_SIGNING_PRIVATE_KEY';
  const registryKeyEnv = options.registryKeyEnv ?? options.keyEnv ?? publisherKeyEnv;
  const publisherPrivateKeyPem = process.env[publisherKeyEnv];
  const registryPrivateKeyPem = process.env[registryKeyEnv];

  if (!publisherPrivateKeyPem) {
    throw new DkbError(`Missing publisher signing private key environment variable: ${publisherKeyEnv}`);
  }

  if (!registryPrivateKeyPem) {
    throw new DkbError(`Missing registry signing private key environment variable: ${registryKeyEnv}`);
  }

  const lock = validateDkbLockManifest(JSON.parse(await fs.readFile(lockPath, 'utf8')), lockPath);
  const accountId = options.accountId ?? options.signer ?? 'local-dev';
  const registryId = options.registryId ?? lock.registry.id;
  const release = createSignedReleaseEnvelope(lock, {
    publisher: {
      accountId,
      keyId: options.publisherKeyId ?? `${accountId}:local`,
      privateKeyPem: publisherPrivateKeyPem,
    },
    registry: {
      registryId,
      keyId: options.registryKeyId ?? `${registryId}:local`,
      privateKeyPem: registryPrivateKeyPem,
    },
  });

  await fs.writeFile(releasePath, `${JSON.stringify(release, null, 2)}\n`, 'utf8');

  return {
    lockPath,
    releasePath,
    signer: accountId,
    publisher: release.publisher,
    registry: release.registry,
    payloadHash: release.payloadHash,
    signature: `ed25519:${release.publisher.value}`,
  };
}

export async function verifyComposeRelease(root: string, options: VerifyComposeReleaseOptions = {}) {
  const resolvedRoot = path.resolve(root);
  const releasePath = manifestPath(resolvedRoot, DKB_RELEASE_PATH);
  const publisherKeyEnv = options.publisherKeyEnv ?? options.keyEnv ?? 'DKB_SIGNING_PUBLIC_KEY';
  const registryKeyEnv = options.registryKeyEnv ?? options.keyEnv ?? publisherKeyEnv;
  const publisherPublicKeyPem = process.env[publisherKeyEnv];
  const registryPublicKeyPem = process.env[registryKeyEnv];

  if (!publisherPublicKeyPem) {
    throw new DkbError(`Missing publisher signing public key environment variable: ${publisherKeyEnv}`);
  }

  if (!registryPublicKeyPem) {
    throw new DkbError(`Missing registry signing public key environment variable: ${registryKeyEnv}`);
  }

  const release = parseReleaseEnvelope(JSON.parse(await fs.readFile(releasePath, 'utf8')), releasePath);
  const lockPath = artifactLockPath(resolvedRoot);
  const lock = validateDkbLockManifest(JSON.parse(await fs.readFile(lockPath, 'utf8')), lockPath);
  const payloadMatchesLock = stableHash(releasePayloadForLock(lock)) === release.payloadHash
    && canonicalJson(lock) === canonicalJson(release.payload.lock);
  const signerMatches = options.signer
    ? release.publisher.accountId === options.signer || release.publisher.keyId === options.signer
    : true;
  const verification = await verifyReleaseEnvelope(release, ({ role }) => {
    return role === 'publisher' ? publisherPublicKeyPem : registryPublicKeyPem;
  });

  return {
    ok: payloadMatchesLock && signerMatches && verification.ok,
    releasePath,
    signer: release.publisher.accountId,
    publisher: release.publisher,
    registry: release.registry,
    payloadHash: release.payloadHash,
    checks: [
      {
        name: 'payload_matches_lock',
        ok: payloadMatchesLock,
        detail: payloadMatchesLock ? 'release payload matches current artifact lock' : 'release payload differs from current artifact lock',
      },
      ...(options.signer ? [{
        name: 'publisher_matches_signer',
        ok: signerMatches,
        detail: signerMatches ? 'publisher identity matches requested signer' : 'publisher identity does not match requested signer',
      }] : []),
      ...verification.checks,
    ],
  };
}

export function parseReleaseEnvelope(value: unknown, source: string): DkbReleaseEnvelope {
  if (!isRecord(value)) {
    throw new DkbError(`Invalid release envelope at ${source}: expected object`);
  }

  if (value.type !== 'dkb.release' || value.version !== 1 || !isRecord(value.package) || !isRecord(value.payload)) {
    throw new DkbError(`Invalid release envelope at ${source}: missing type, version, package, or payload`);
  }

  const releasePackage = parseReleasePackage(value.package, `${source}#package`);
  const payloadHash = asString(value.payloadHash, `${source}#payloadHash`);
  const payload = {
    lock: validateDkbLockManifest(value.payload.lock, `${source}#payload.lock`),
  };

  return {
    type: 'dkb.release',
    version: 1,
    package: releasePackage,
    payloadHash,
    payload,
    publisher: parsePublisherSignature(value.publisher, `${source}#publisher`),
    registry: parseRegistrySignature(value.registry, `${source}#registry`),
  };
}

export function parsePackageReceipt(value: unknown, source: string): DkbPackageReceipt {
  if (!isRecord(value)) {
    throw new DkbError(`Invalid package receipt at ${source}: expected object`);
  }

  if (value.type !== 'dkb.package.receipt' || value.version !== 1 || !isRecord(value.package) || !isRecord(value.payload)) {
    throw new DkbError(`Invalid package receipt at ${source}: missing type, version, package, or payload`);
  }

  const receiptPackage = parsePackageReceiptPackage(value.package, `${source}#package`);
  const payloadHash = asString(value.payloadHash, `${source}#payloadHash`);
  const payload = {
    lock: validateDkbLockManifest(value.payload.lock, `${source}#payload.lock`),
    ...(typeof value.payload.packageTreeHash === 'string' ? { packageTreeHash: value.payload.packageTreeHash } : {}),
  };

  return {
    type: 'dkb.package.receipt',
    version: 1,
    package: receiptPackage,
    payloadHash,
    payload,
    publisher: parsePublisherSignature(value.publisher, `${source}#publisher`),
    registry: parseRegistrySignature(value.registry, `${source}#registry`),
  };
}

function signCanonical(value: unknown, privateKeyPem: string): string {
  const privateKey = createPrivateKey(privateKeyPem);

  return sign(null, Buffer.from(canonicalJson(value), 'utf8'), privateKey).toString('base64');
}

function verifyCanonical(value: unknown, publicKeyPem: string, signature: string): boolean {
  try {
    const publicKey = createPublicKey(publicKeyPem);

    return verify(null, Buffer.from(canonicalJson(value), 'utf8'), publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

async function verifyRoleSignature(
  role: 'publisher' | 'registry',
  signature: DkbPublisherReleaseSignature | DkbRegistryReleaseSignature,
  envelope: DkbReleaseEnvelope | DkbPackageReceipt,
  content: DkbReleaseSigningContent | DkbPackageReceiptSigningContent,
  keyResolver: DkbReleaseKeyResolver,
): Promise<DkbReleaseVerificationCheck[]> {
  const publicKeyPem = await keyResolver({ role, signature, envelope });

  if (!publicKeyPem) {
    return [
      {
        name: `${role}_key_available`,
        ok: false,
        detail: `no public key available for ${role} key ${signature.keyId}`,
      },
    ];
  }

  const actualFingerprint = safeFingerprintPublicKey(publicKeyPem);
  const fingerprintValid = actualFingerprint === signature.publicKeyFingerprint;
  const signatureValid = signature.algorithm === 'ed25519'
    && verifyCanonical(content, publicKeyPem, signature.value);

  return [
    {
      name: `${role}_key_fingerprint`,
      ok: fingerprintValid,
      detail: fingerprintValid
        ? `${role} public key fingerprint matches signed metadata`
        : `${role} public key fingerprint mismatch: expected ${signature.publicKeyFingerprint}, got ${actualFingerprint ?? 'invalid public key'}`,
    },
    {
      name: `${role}_signature`,
      ok: signatureValid,
      detail: signatureValid ? `${role} signature verifies` : `${role} signature verification failed`,
    },
  ];
}

function safeFingerprintPublicKey(publicKeyPem: string): string | null {
  try {
    return fingerprintPublicKey(publicKeyPem);
  } catch {
    return null;
  }
}

function parseReleasePackage(value: Record<string, unknown>, source: string): DkbReleasePackage {
  return {
    name: asString(value.name, `${source}.name`),
    version: asString(value.version, `${source}.version`),
    ...(typeof value.registryId === 'string' ? { registryId: value.registryId } : {}),
  };
}

function parsePackageReceiptPackage(value: Record<string, unknown>, source: string): DkbPackageReceiptPackage {
  return {
    id: asString(value.id, `${source}.id`),
    publisherId: asString(value.publisherId, `${source}.publisherId`),
    name: asString(value.name, `${source}.name`),
    version: asString(value.version, `${source}.version`),
    ...(typeof value.registryId === 'string' ? { registryId: value.registryId } : {}),
  };
}

function parsePublisherSignature(value: unknown, source: string): DkbPublisherReleaseSignature {
  const signature = parseReleaseSignature(value, source);

  return {
    ...signature,
    accountId: asString((value as Record<string, unknown>).accountId, `${source}.accountId`),
  };
}

function parseRegistrySignature(value: unknown, source: string): DkbRegistryReleaseSignature {
  const signature = parseReleaseSignature(value, source);

  return {
    ...signature,
    registryId: asString((value as Record<string, unknown>).registryId, `${source}.registryId`),
  };
}

function parseReleaseSignature(value: unknown, source: string): DkbReleaseSignature {
  if (!isRecord(value)) {
    throw new DkbError(`Invalid release envelope at ${source}: expected signature object`);
  }

  const algorithm = asString(value.algorithm, `${source}.algorithm`);

  if (algorithm !== 'ed25519') {
    throw new DkbError(`Invalid release envelope at ${source}.algorithm: expected ed25519`);
  }

  return {
    keyId: asString(value.keyId, `${source}.keyId`),
    publicKeyFingerprint: asString(value.publicKeyFingerprint, `${source}.publicKeyFingerprint`),
    algorithm,
    value: asString(value.value, `${source}.value`),
    signedAt: asString(value.signedAt, `${source}.signedAt`),
  };
}

function asString(value: unknown, source: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DkbError(`Invalid release envelope at ${source}: expected non-empty string`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
