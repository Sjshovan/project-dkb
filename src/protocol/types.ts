export type DkbAdapter = 'folder' | 'sqlite' | 'postgres' | 'compose';
export type DkbStoreType = 'filesystem' | 'sqlite' | 'postgres' | 'database';
export type DkbStoreMode = 'read' | 'write' | 'readwrite';
export type DkbTargetOrigin = 'local' | 'remote';
export type DkbWriteMode = 'read_only' | 'queued' | 'direct';
export type DkbAvailability = 'ready' | 'unavailable';
export type DkbIndexFreshness = 'fresh' | 'stale' | 'unknown';
export type DkbWriteOperation = 'write' | 'append' | 'delete' | 'update' | 'supersede';
export type DkbEntryKind = 'dkb' | 'collection';
export type DkbEntrySource = 'local' | 'registry';
export type DkbEntryStatus = 'installed' | 'broken';
export type DkbVersionSelector = 'latest' | string;

export interface DkbAccepts {
  lanes?: string[];
  subjects?: string[];
  intents?: string[];
  recordTypes?: string[];
}

export interface DkbWrite {
  mode: Exclude<DkbWriteMode, 'read_only'>;
  operations: DkbWriteOperation[];
  accepts?: DkbAccepts;
  dedupe?: 'required' | 'optional' | 'none';
  schema?: string;
  confirmationRequired?: boolean;
}

export interface DkbOwner {
  id?: string;
  name?: string;
  email?: string;
  url?: string;
  repository?: string;
}

export interface DkbCollectionRef {
  id?: string;
  name?: string;
  description?: string;
}

export interface DkbSpaceFields {
  namespace?: string;
  appId?: string;
}

export interface DkbPermissions {
  read?: boolean;
  write?: boolean;
}

export interface DkbLocalSourcesPolicy {
  enabled?: boolean;
  root?: string;
  excludes?: string[];
}

export interface DkbLibraryRootRequirement {
  path?: string;
  version?: DkbVersionSelector;
  revision?: number | 'latest';
}

export interface DkbCollectionOverride {
  include?: Record<string, DkbVersionSelector>;
  exclude?: string[];
}

export interface DkbRetrievalProfileConfig {
  compiler?: 'llamaindex';
  embedding?: {
    adapter?: 'fastembed';
    model?: string;
    dimensions?: number;
  };
}

export interface DkbStore {
  id: string;
  type: DkbStoreType;
  path?: string;
  connectionRef?: string;
  mode?: DkbStoreMode;
  permissions?: DkbPermissions;
  meta?: Record<string, unknown>;
}

export interface DkbAccess {
  read: boolean;
  write: boolean;
  append: boolean;
  delete: boolean;
}

export interface DkbWritePolicy {
  mode: DkbWriteMode;
  queueRequired: boolean;
  confirmationRequired: boolean;
}

export interface DkbState {
  availability: DkbAvailability;
  indexFreshness: DkbIndexFreshness;
  lastIndexedAt: string | null;
}

export interface DkbManifest extends DkbSpaceFields {
  id: string;
  name: string;
  version: string;
  description?: string;
  adapter: DkbAdapter;
  entrypoint: string;
  domains: string[];
  collection?: DkbCollectionRef;
  owner?: DkbOwner;
  permissions?: DkbPermissions;
  stores?: DkbStore[];
  roles?: string[];
  write?: DkbWrite;
  meta?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface DkbSourceManifest extends DkbSpaceFields {
  manifestVersion?: number;
  type: 'dkb' | 'collection' | 'library';
  name: string;
  displayName?: string;
  version?: string;
  description?: string;
  publisher?: string;
  package?: string;
  owner?: DkbOwner;
  author?: DkbOwner;
  license?: string;
  members?: Record<string, DkbVersionSelector>;
  roots?: Record<string, DkbLibraryRootRequirement>;
  collectionOverrides?: Record<string, DkbCollectionOverride>;
  registry?: {
    url?: string;
  };
  localSources?: DkbLocalSourcesPolicy;
  permissions?: DkbPermissions;
  domains?: string[];
  roles?: string[];
  write?: DkbWrite;
  meta?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface DkcManifest extends DkbSpaceFields {
  id: string;
  name: string;
  version: string;
  revision?: number;
  digest?: string;
  description?: string;
  roles?: string[];
  members: Record<string, DkbVersionSelector>;
  dkbs?: Array<{ path: string }>;
  meta?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface DkrManifest extends DkbSpaceFields {
  id: string;
  name: string;
  version: string;
  owner?: DkbOwner;
  roots: Record<string, DkbLibraryRootRequirement>;
  collectionOverrides?: Record<string, DkbCollectionOverride>;
  registry?: {
    url?: string;
  };
  meta?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface DkbLockManifest {
  registry: {
    id: string;
    name: string;
    version: string;
  };
  packages: Record<string, {
    id: string;
    name: string;
    version: string;
    path: string | null;
    manifestHash: string;
    sourceInventoryHash: string;
    chunkRepositoryHash: string;
    recordCount: number;
    stores: Array<{
      id: string;
      type: DkbStoreType;
      path?: string;
      connectionRef?: string;
      hash: string;
      recordCount: number;
    }>;
    publisher?: string;
    package?: string;
    resolved?: string;
    integrity?: string;
    archiveHash?: string;
    receiptHash?: string;
    packageTreeHash?: string;
    payloadHash?: string;
    publisherSignature?: DkbPublisherReleaseSignature;
    registrySignature?: DkbRegistryReleaseSignature;
    installedPath?: string;
    registryId?: string;
    installedAt?: string;
  }>;
  artifacts: {
    sourceIndex: DkbLockArtifact;
    sourceGraph: DkbLockArtifact;
    sourceVector: DkbLockArtifact;
  };
  retrievalProfile?: {
    path: string;
    profileDigest: string;
  };
  compiled?: {
    path: string;
    artifactHash: string | null;
    chunkRepositoryHash: string;
    indexHash: string;
    recordCount: number;
    compiledAt: string;
  };
}

export interface DkbLibraryLockEntry {
  identity: string;
  kind: DkbEntryKind;
  source: DkbEntrySource;
  version?: string;
  revision?: number;
  digest?: string;
  path: string;
  registryUrl?: string;
  requiredBy: string[];
  installedAt: string;
}

export interface DkbLibraryLockManifest {
  library: {
    name: string;
    retrievalProfileDigest?: string;
  };
  generation: number;
  entries: Record<string, DkbLibraryLockEntry>;
  resolvedAt: string;
}

export interface DkbSigningKeyRecord {
  id: string;
  subjectType: 'publisher' | 'registry';
  subjectId: string;
  algorithm: 'ed25519';
  publicKeyPem: string;
  publicKeyFingerprint: string;
  status: 'active' | 'rotated' | 'revoked';
  createdAt: string;
  rotatedAt?: string;
  revokedAt?: string;
}

export interface DkbReleasePackage {
  name: string;
  version: string;
  registryId?: string;
}

export interface DkbReleasePayload {
  lock: DkbLockManifest;
}

export interface DkbReleaseSigningContent {
  type: 'dkb.release.signing-content';
  version: 1;
  package: DkbReleasePackage;
  payloadHash: string;
  payload: DkbReleasePayload;
}

export interface DkbReleaseSignature {
  keyId: string;
  publicKeyFingerprint: string;
  algorithm: 'ed25519';
  value: string;
  signedAt: string;
}

export interface DkbPublisherReleaseSignature extends DkbReleaseSignature {
  accountId: string;
}

export interface DkbRegistryReleaseSignature extends DkbReleaseSignature {
  registryId: string;
}

export interface DkbReleaseEnvelope {
  type: 'dkb.release';
  version: 1;
  package: DkbReleasePackage;
  payloadHash: string;
  payload: DkbReleasePayload;
  publisher: DkbPublisherReleaseSignature;
  registry: DkbRegistryReleaseSignature;
}

export interface DkbPackageReceiptPackage extends DkbReleasePackage {
  id: string;
  publisherId: string;
}

export interface DkbPackageReceiptPayload {
  lock: DkbLockManifest;
  packageTreeHash?: string;
}

export interface DkbPackageReceiptSigningContent {
  type: 'dkb.package.receipt.signing-content';
  version: 1;
  package: DkbPackageReceiptPackage;
  payloadHash: string;
  payload: DkbPackageReceiptPayload;
}

export interface DkbPackageReceipt {
  type: 'dkb.package.receipt';
  version: 1;
  package: DkbPackageReceiptPackage;
  payloadHash: string;
  payload: DkbPackageReceiptPayload;
  publisher: DkbPublisherReleaseSignature;
  registry: DkbRegistryReleaseSignature;
}

export interface DkbLockArtifact {
  path: string;
  hash: string | null;
  status: 'built' | 'not_built' | 'missing';
}

export interface LoadedDkb {
  root: string;
  origin?: DkbTargetOrigin;
  manifest: DkbManifest;
  packagePath?: string | null;
  manifestHash?: string;
  identityKey?: string;
}

export interface LoadedCollection {
  root: string;
  manifest: DkcManifest;
  dkbs: LoadedDkb[];
}

export interface LoadedLibrary {
  root: string;
  manifest: DkrManifest;
  collections: LoadedCollection[];
  dkbs: LoadedDkb[];
}

export interface DiscoveredLibraryEntry {
  root: string;
  source: DkbEntrySource;
  manifest: DkbSourceManifest;
}

export interface DkbRecord {
  id: string;
  title: string;
  content: string;
  source: string;
  topics: string[];
  keywords?: string[];
  entities: string[];
  updatedAt: string;
  aliases?: string[];
  sourceRef?: KnowledgeSourceRef;
  queryable?: KnowledgeQueryable;
  sourceUnits?: KnowledgeSourceUnit[];
  sourceIds?: string[];
  capabilities?: KnowledgeCapabilityProfile;
}

export interface QueryHit extends DkbRecord {
  dkbId: string;
  adapter: DkbAdapter;
  score: number;
  retrievalPasses?: RetrievalPass[];
}

export type RetrievalPass = 'lexical' | 'vector' | 'graph';

export interface KnowledgeSourceRef {
  storeId: string;
  type: DkbStoreType;
  locator: Record<string, unknown>;
  hash?: string;
  evidenceId?: string;
  chunkId?: string;
  dkbId?: string;
  packageVersion?: string;
}

export interface KnowledgeSourceUnit {
  id?: string;
  assetId?: string;
  storeId?: string;
  type?: DkbStoreType;
  locator: Record<string, unknown>;
  assetLocator?: Record<string, unknown>;
  title?: string;
  text?: string;
  keywords?: string[];
  hash?: string;
  updatedAt?: string;
  capabilities?: KnowledgeCapabilityProfile;
  queryable?: KnowledgeQueryable;
  chunkOrdinal?: number;
  chunkStart?: number;
  chunkEnd?: number;
  heading?: string;
}

export type KnowledgeCapabilitySupport = 'none' | 'partial' | 'full';

export interface KnowledgeCapabilityProfile {
  evidence: KnowledgeCapabilitySupport;
  records: KnowledgeCapabilitySupport;
  exactCount: KnowledgeCapabilitySupport;
  approximateCount: KnowledgeCapabilitySupport;
  structuredFilter: KnowledgeCapabilitySupport;
  operations: DkbReadOperation[];
}

export interface KnowledgeQueryable {
  operations: DkbReadOperation[];
  fields?: Record<string, {
    type: 'string' | 'number' | 'boolean' | 'date' | 'unknown';
    operators: DkbReadOperator[];
    returnable?: boolean;
    searchable?: boolean;
  }>;
  defaultLimit?: number;
  maxLimit?: number;
}

export type DkbReadOperation = 'fetch' | 'search' | 'lookup' | 'aggregate';
export type DkbReadOperator = 'equals' | 'contains' | 'gt' | 'lt' | 'gte' | 'lte' | 'between';
export type DkbReadStatus = 'processing' | 'complete' | 'partial' | 'failed' | 'blocked';
export type DkbReadBlockReason =
  | 'unknown_target'
  | 'unsupported_operation'
  | 'unsupported_field'
  | 'unsupported_operator'
  | 'permission_denied'
  | 'missing_connection'
  | 'source_unavailable'
  | 'validation_failed'
  | 'no_results';

export interface DkbReadRequest {
  queries: DkbReadQuery[];
}

export interface DkbReadQuery {
  id: string;
  target: string;
  operation: DkbReadOperation;
  metric?: 'count';
  filters?: Array<{
    field: string;
    op: DkbReadOperator;
    value: unknown;
  }>;
  return?: string[];
  limit?: number;
}

export interface DkbReadResult {
  status: DkbReadStatus;
  sourcePolicy: string;
  sufficiency?: DkbEvidenceSufficiency;
  queries: Array<{
    id: string;
    target: string;
    status: DkbReadStatus;
    reason: DkbReadBlockReason | null;
    message: string;
    evidence: DkbEvidence[];
    trace: Record<string, unknown>;
  }>;
}

export interface DkbEvidenceSufficiency {
  status: DkbReadStatus;
  confidence: number;
  matchedNeed: boolean;
  expanded: boolean;
  reason: 'matched_need' | 'matched_specific_identifier' | 'weak_match' | 'no_evidence' | 'blocked' | 'no_need';
  passes: number;
}

export interface DkbEvidence {
  type: 'text' | 'rows' | 'aggregate';
  label: string;
  value?: unknown;
  text?: string;
  rows?: Array<Record<string, unknown>>;
  source: KnowledgeSourceRef;
}

export interface QueryTrace {
  dkbId: string;
  adapter: DkbAdapter;
  recordsScanned: number;
  hits: number;
}

export interface QueryResponse {
  query: string;
  collectionId: string;
  results: QueryHit[];
  trace: QueryTrace[];
}
