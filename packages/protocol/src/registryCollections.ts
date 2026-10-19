import { createHash } from 'node:crypto';
import { DkbError } from './errors.js';
import { isDkbIdentity } from './identity.js';
import { validateDkbManifest } from './validation.js';
import { validateInstallPlan, type DkbInstallPlan } from './builds.js';

export interface DkbRegistryCollectionRevision {
  collectionId: string;
  revision: number;
  digest: string;
  publishedAt?: string | null;
  manifest: {
    type: 'collection';
    id: string;
    name: string;
    revision: number;
    digest: string;
    members: Array<{ id: string; version: string; digest: string }>;
  };
}

export interface CollectionMemberGrant { plan: DkbInstallPlan; installGrant: string }

/** Bind the grant envelope to its exact members; the installer verifies signatures. */
export function validateCollectionGrants(collectionValue: unknown, memberValue: unknown): {
  collection: DkbRegistryCollectionRevision; members: CollectionMemberGrant[];
} {
  const collection = validateRegistryCollectionRevision(collectionValue, {
    collectionId: (collectionValue as { collectionId?: string } | null)?.collectionId ?? '',
  });
  if (!Array.isArray(memberValue) || memberValue.length !== collection.manifest.members.length) {
    throw new DkbError('Collection requires exactly one grant for every immutable member.', 'invalid_collection_grant');
  }
  const members = memberValue.map((value: unknown, index) => {
    const member = value as CollectionMemberGrant;
    if (!member || typeof member !== 'object' || Array.isArray(member)
      || Object.keys(member).some(key => !['plan', 'installGrant'].includes(key))
      || typeof member.installGrant !== 'string' || !/^[\x21-\x7e]{1,4096}$/u.test(member.installGrant)) {
      throw new DkbError('Collection contains an invalid member grant. Request fresh grants.', 'invalid_collection_grant');
    }
    const plan = validateInstallPlan(member.plan, 'Collection member grant');
    const expected = collection.manifest.members[index]!;
    if (plan.package.id !== expected.id || plan.package.version !== expected.version) {
      throw new DkbError('Collection grants do not match its ordered exact member releases.', 'invalid_collection_grant');
    }
    return { plan, installGrant: member.installGrant };
  });
  return { collection, members };
}

/** Preserve the Registry's existing ordered JSON/escaped Unicode wire digest. */
export function registryCollectionDigest(snapshot: Omit<DkbRegistryCollectionRevision['manifest'], 'digest'>): string {
  const json = JSON.stringify({ type: snapshot.type, id: snapshot.id, name: snapshot.name,
    revision: snapshot.revision, members: snapshot.members.map(({ id, version, digest }) => ({ id, version, digest })) });
  const escaped = json.replace(/[\u0080-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `sha256:${createHash('sha256').update(escaped).digest('hex')}`;
}

/** A Collection hashes its immutable member snapshot; each member is separately signed. */
export function validateRegistryCollectionRevision(
  value: unknown,
  expected: { collectionId: string; revision?: number },
): DkbRegistryCollectionRevision {
  const invalid = (detail: string): never => { throw new DkbError(`Invalid Registry Collection snapshot: ${detail}.`, 'invalid_collection_revision'); };
  if (!record(value) || !record(value.manifest)) return invalid('missing revision or manifest');
  if (value.publishedAt !== undefined && value.publishedAt !== null
    && (typeof value.publishedAt !== 'string' || !Number.isFinite(Date.parse(value.publishedAt)))) return invalid('invalid publication timestamp');
  const manifest = value.manifest;
  if (!isDkbIdentity(value.collectionId) || value.collectionId !== expected.collectionId
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
    || (expected.revision !== undefined && value.revision !== expected.revision)
    || !digest(value.digest) || manifest.type !== 'collection' || manifest.id !== value.collectionId
    || manifest.revision !== value.revision || manifest.digest !== value.digest
    || typeof manifest.name !== 'string' || !manifest.name.trim()
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(manifest.name)
    || Object.keys(manifest).some(key => !['type', 'id', 'name', 'revision', 'digest', 'members'].includes(key))
    || !Array.isArray(manifest.members) || manifest.members.length === 0) return invalid('identity, revision, digest, or manifest fields differ');
  let previous = '';
  const members = manifest.members.map(member => {
    if (!record(member) || !isDkbIdentity(member.id) || member.id <= previous
      || typeof member.version !== 'string' || !digest(member.digest)
      || Object.keys(member).some(key => !['id', 'version', 'digest'].includes(key))) return invalid('members must be unique, sorted exact releases');
    validateDkbManifest({ type: 'dkb', name: member.id, version: member.version }, 'Collection member');
    previous = member.id;
    return { id: member.id, version: member.version, digest: member.digest };
  });
  const snapshot = { type: 'collection' as const, id: value.collectionId, name: manifest.name, revision: value.revision as number, members };
  if (registryCollectionDigest(snapshot) !== value.digest) return invalid('Collection digest does not match its exact member snapshot');
  return { collectionId: value.collectionId, revision: snapshot.revision, digest: value.digest,
    ...(value.publishedAt !== undefined ? { publishedAt: value.publishedAt as string | null } : {}),
    manifest: { ...snapshot, digest: value.digest } };
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function digest(value: unknown): value is string { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value); }
