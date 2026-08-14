export type DkbAdapter = 'folder' | 'sqlite' | 'postgres' | 'compose';
export type DkbStoreType = 'filesystem' | 'sqlite' | 'postgres';
export type DkbStoreMode = 'read' | 'write' | 'readwrite';
export type DkbSourceRegionType = 'file' | 'folder' | 'table' | 'table_group' | 'view' | 'record' | 'dataset' | 'endpoint';
export type DkbWriteMode = 'read_only' | 'queued' | 'direct';
export type DkbAvailability = 'ready' | 'unavailable';
export type DkbIndexFreshness = 'fresh' | 'stale' | 'unknown';
export type DkbWriteOperation = 'write' | 'append' | 'delete' | 'update' | 'supersede';

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
  type?: 'package' | 'registry';
  name: string;
  version?: string;
  description?: string;
  publisher?: string;
  package?: string;
  owner?: DkbOwner;
  author?: DkbOwner;
  license?: string;
  collection?: string | DkbCollectionRef;
  dependencies?: Record<string, string>;
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
  description?: string;
  roles?: string[];
  dkbs: Array<{ path: string }>;
  meta?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface DkrManifest extends DkbSpaceFields {
  id: string;
  name: string;
  version: string;
  owner?: DkbOwner;
  collections?: Array<{ path: string }>;
  dkbs?: Array<{ path: string }>;
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
    krRepositoryHash: string;
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
    krIndex: DkbLockArtifact;
    krGraph: DkbLockArtifact;
    krVector: DkbLockArtifact;
    sourceIndex?: DkbLockArtifact;
  };
  compiled?: {
    path: string;
    artifactHash: string | null;
    krRepositoryHash: string;
    indexHash: string;
    recordCount: number;
    compiledAt: string;
  };
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

export interface LoadedRegistry {
  root: string;
  manifest: DkrManifest;
  collections: LoadedCollection[];
  dkbs: LoadedDkb[];
}

export interface KnowledgeRegionRelationship {
  type: 'parent' | 'child' | 'sibling' | 'foreign_key' | 'reference' | 'semantic';
  regionId: string;
}

export interface KnowledgeRegionGrouping {
  strategy: 'filesystem_direct_files' | 'database_foreign_keys' | 'single_source' | 'json_record' | 'semantic_cluster';
  reason: string;
}

export interface KnowledgeRegion {
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
  regionType?: DkbSourceRegionType;
  parentRegionId?: string;
  childRegionIds?: string[];
  relatedRegionIds?: string[];
  ancestry?: string[];
  relationships?: KnowledgeRegionRelationship[];
  grouping?: KnowledgeRegionGrouping;
  sourceUnits?: KnowledgeSourceUnit[];
  sourceIds?: string[];
  capabilities?: KnowledgeCapabilityProfile;
}

export interface QueryHit extends KnowledgeRegion {
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
