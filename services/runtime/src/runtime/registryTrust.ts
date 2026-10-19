import fs from 'node:fs/promises';
import path from 'node:path';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { createPublicKey } from 'node:crypto';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import type { DkbSigningKeyRecord } from '@sjshovan/dkb-protocol/types.js';
import { fingerprintPublicKey } from '@sjshovan/dkb-library/signing.js';
import { assertDkbFileLock, withDkbFileLock } from '@sjshovan/dkb-library/locks.js';
import { normalizeRegistryUrl } from '@sjshovan/dkb-registry-client/config.js';
import { writeJsonAtomic } from './paths.js';

const TRUST_FORMAT = 'dkb.registry-trust.v1';

/** Public keys belong to the Library operator, never to downloaded package content. */
export function registryTrustPath(libraryRoot: string, registryUrl: string): string {
  const origin = normalizeRegistryUrl(registryUrl);
  return path.join(path.resolve(libraryRoot), '.dkb', 'trust', 'registries', `${stableHash(origin).slice(7)}.json`);
}

export async function readPinnedRegistryKeys(libraryRoot: string, registryUrl: string): Promise<DkbSigningKeyRecord[]> {
  const source = registryTrustPath(libraryRoot, registryUrl);
  const value = await fs.readFile(source, 'utf8').then(JSON.parse).catch((error: NodeJS.ErrnoException) => {
    throw new DkbError(
      `${error.code === 'ENOENT' ? 'Missing' : 'Unreadable'} pinned Registry trust for ${normalizeRegistryUrl(registryUrl)} at ${source}. `
      + (error.code === 'ENOENT'
        ? 'Reinstall an exact signed release from this Registry to establish trusted keys before querying.'
        : corruptTrustRecovery(source)),
      'registry_trust_required',
    );
  });
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['format', 'registryUrl', 'updatedAt', 'keys'].includes(key))
    || value.format !== TRUST_FORMAT || value.registryUrl !== normalizeRegistryUrl(registryUrl)
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new DkbError(`Pinned Registry trust is invalid at ${source}. ${corruptTrustRecovery(source)}`, 'registry_trust_invalid');
  }
  try {
    return parseRegistryTrustedKeys(value);
  } catch (error) {
    throw new DkbError(`Pinned Registry trust is invalid at ${source}: ${(error as Error).message}. ${corruptTrustRecovery(source)}`, 'registry_trust_invalid');
  }
}

/** Call only after verifying a chain against keys fetched from its operator-selected origin. */
export async function pinRegistryTrustedKeys(input: {
  libraryRoot: string;
  registryUrl: string;
  keys: DkbSigningKeyRecord[];
  mutationLockHeld?: boolean;
}): Promise<void> {
  const update = async () => {
    const registryUrl = normalizeRegistryUrl(input.registryUrl);
    const source = registryTrustPath(input.libraryRoot, registryUrl);
    const incoming = parseRegistryTrustedKeys({ keys: input.keys });
    const exists = await fs.stat(source).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    const previous = exists ? await readPinnedRegistryKeys(input.libraryRoot, registryUrl) : [];
    const keys = new Map(previous.map((key) => [keyIdentity(key), key]));
    for (const key of incoming) {
      const pinned = keys.get(keyIdentity(key));
      if (pinned && pinned.publicKeyFingerprint !== key.publicKeyFingerprint) {
        throw new DkbError(`Registry ${registryUrl} attempted to replace pinned signing key ${key.id}. Keep the existing trust and investigate Registry key rotation.`, 'registry_key_substitution');
      }
      if (pinned?.status === 'revoked' && key.status !== 'revoked') {
        throw new DkbError(`Registry ${registryUrl} attempted to reactivate revoked signing key ${key.id}.`, 'registry_key_revoked');
      }
      const status = pinned?.status === 'revoked' || key.status === 'revoked' ? 'revoked'
        : pinned?.status === 'rotated' || key.status === 'rotated' ? 'rotated' : 'active';
      keys.set(keyIdentity(key), { ...key, status });
    }
    const sorted = [...keys.values()].sort((left, right) => keyIdentity(left).localeCompare(keyIdentity(right)));
    if (stableHash(previous) === stableHash(sorted)) return;
    await writeJsonAtomic(source, { format: TRUST_FORMAT, registryUrl, updatedAt: new Date().toISOString(), keys: sorted });
  };
  if (input.mutationLockHeld) {
    await assertDkbFileLock(input.libraryRoot, 'library-mutation');
    await update();
  }
  else await withDkbFileLock(input.libraryRoot, 'library-mutation', update);
}

export function parseRegistryTrustedKeys(value: unknown): DkbSigningKeyRecord[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { keys?: unknown }).keys)) {
    throw new DkbError('Registry public-key response is invalid');
  }
  const identities = new Set<string>();
  const keys = (value as { keys: unknown[] }).keys;
  return keys.map((value) => {
    const key = value as DkbSigningKeyRecord;
    if (!key || typeof key !== 'object' || Array.isArray(key)
      || typeof key.id !== 'string' || !key.id.trim()
      || !['publisher', 'registry'].includes(key.subjectType)
      || typeof key.subjectId !== 'string' || !key.subjectId.trim()
      || key.algorithm !== 'ed25519'
      || typeof key.publicKeyPem !== 'string' || !key.publicKeyPem.trim()
      || !/^sha256:[a-f0-9]{64}$/u.test(key.publicKeyFingerprint)
      || !['active', 'rotated', 'revoked'].includes(key.status)
      || typeof key.createdAt !== 'string' || !Number.isFinite(Date.parse(key.createdAt))) {
      throw new DkbError('Registry public-key response contains an invalid signing key');
    }
    let fingerprint: string;
    try {
      if (createPublicKey(key.publicKeyPem).asymmetricKeyType !== 'ed25519') throw new Error('Expected Ed25519');
      fingerprint = fingerprintPublicKey(key.publicKeyPem);
    } catch { throw new DkbError(`Registry signing key ${key.id} is not a valid Ed25519 public key`); }
    if (fingerprint !== key.publicKeyFingerprint) throw new DkbError(`Registry signing key ${key.id} fingerprint does not match its public key`);
    const identity = keyIdentity(key);
    if (identities.has(identity)) throw new DkbError(`Registry public-key response duplicates signing key ${key.id}`);
    identities.add(identity);
    return {
      id: key.id, subjectType: key.subjectType, subjectId: key.subjectId, algorithm: key.algorithm,
      publicKeyPem: key.publicKeyPem, publicKeyFingerprint: key.publicKeyFingerprint,
      status: key.status, createdAt: key.createdAt,
    };
  });
}

function keyIdentity(key: DkbSigningKeyRecord): string { return JSON.stringify([key.subjectType, key.subjectId, key.id]); }

function corruptTrustRecovery(source: string): string {
  return `Back up and move the malformed operator-owned trust file ${source} aside for inspection, then deliberately reinstall an exact signed release from its verified Registry origin to re-establish trust. DKB will not delete or overwrite existing trust automatically.`;
}
