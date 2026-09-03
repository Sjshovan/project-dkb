import type {
  DkbEvidenceCatalogAsset,
  DkbEvidenceCatalogRecord,
} from '@sjshovan/dkb-protocol/evidence/catalog.js';
import type {
  DkbStoreType,
  KnowledgeCapabilityProfile,
  KnowledgeQueryable,
  LoadedDkb,
} from '@sjshovan/dkb-protocol/types.js';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { DkbJsonValue } from '@sjshovan/dkb-protocol/json.js';
import type { DkbProviderExecutionReceipt } from '@sjshovan/dkb-protocol/providerReceipts.js';
export type { DkbJsonValue } from '@sjshovan/dkb-protocol/json.js';

export type DkbProviderKind = 'evidence' | 'parser' | 'chunker' | 'embedding' | 'index' | 'retrieval';
export type DkbProcessorStage = 'document' | 'chunk' | 'record';
export const DKB_PLUGIN_API_VERSION = 3;

export type DkbProviderOptions = Readonly<Record<string, DkbJsonValue>>;
export type DkbProviderOptionsSchema = StandardSchemaV1<unknown, Record<string, DkbJsonValue>>;

export type DkbExternalIdentityKind = 'service' | 'image' | 'model';

export interface DkbExternalIdentityDigest {
  kind: DkbExternalIdentityKind;
  name: string;
  digest: string;
}

export interface DkbProviderIdentityDeclaration {
  external?: readonly DkbExternalIdentityDigest[];
}

export interface DkbPluginIdentityDeclaration extends DkbProviderIdentityDeclaration {
  /** The validated, output-affecting subset of options. Omitted options remain operational only. */
  profileOptions?: DkbProviderOptions;
}

export type DkbPluginIdentityResolver = (
  context: { readonly options: DkbProviderOptions },
) => DkbPluginIdentityDeclaration;

export type DkbProviderIdentityResolver = (
  context: { readonly options: DkbProviderOptions },
) => DkbProviderIdentityDeclaration;

export type DkbPluginIdentity = DkbPluginIdentityDeclaration | DkbPluginIdentityResolver;
export type DkbProviderIdentity = DkbProviderIdentityDeclaration | DkbProviderIdentityResolver;

export interface DkbPipelineProvenance {
  assetId: string;
  storeId: string;
  sourceType: 'filesystem' | 'sqlite' | 'database';
  locator: Record<string, DkbJsonValue>;
  assetLocator: Record<string, DkbJsonValue>;
  title: string;
  sourceHash: string;
  updatedAt: string;
  chunkOrdinal: number;
  chunkStart: number;
  chunkEnd: number;
}

export interface DkbPipelineDocument {
  id: string;
  path: string;
  mediaType?: string;
  text?: string;
  provenance?: DkbPipelineSourceProvenance;
  metadata: Record<string, DkbJsonValue>;
}

export interface DkbPipelineChunk {
  id: string;
  documentId: string;
  text: string;
  provenance?: DkbPipelineChunkProvenance;
  metadata: Record<string, DkbJsonValue>;
}

export type DkbPipelineSourceProvenance = Pick<DkbPipelineProvenance,
  'assetId' | 'storeId' | 'sourceType' | 'assetLocator' | 'title' | 'sourceHash' | 'updatedAt'>;
export type DkbPipelineChunkProvenance = Pick<DkbPipelineProvenance,
  'locator' | 'chunkOrdinal' | 'chunkStart' | 'chunkEnd'>;

/** Separate parser output always identifies the original source, before processors. */
export interface DkbParsedDocument extends DkbPipelineDocument {
  provenance: DkbPipelineSourceProvenance;
}

/** Separate chunker output always locates the chunk within its parsed document. */
export interface DkbLocatedChunk extends DkbPipelineChunk {
  provenance: DkbPipelineChunkProvenance;
}

export interface DkbPipelineRecord {
  id: string;
  chunkId: string;
  text: string;
  provenance: DkbPipelineProvenance;
  metadata: Record<string, DkbJsonValue>;
}

export interface DkbEvidencePipeline {
  documents: DkbPipelineDocument[];
  chunks: DkbPipelineChunk[];
  records: DkbPipelineRecord[];
  receipts: DkbProviderBuildReceipt[];
}

export interface DkbEvidenceVector {
  evidenceId: string;
  values: number[];
}

export interface DkbRetrievalPipeline extends DkbEvidencePipeline {
  vectors: DkbEvidenceVector[];
}

export interface DkbProviderBuildReceipt extends DkbProviderExecutionReceipt {
  diagnostics?: Record<string, DkbJsonValue>;
}

export interface DkbProviderOutputReceipt {
  build: Record<string, DkbJsonValue>;
  compatibility?: Record<string, DkbJsonValue>;
  /** Operational measurements retained in compile reports, never immutable identity. */
  diagnostics?: Record<string, DkbJsonValue>;
}

export interface IndexedSourceAsset {
  id: string;
  dkbId: string;
  storeId: string;
  type: DkbStoreType;
  locator: Record<string, unknown>;
  title: string;
  hash: string;
  updatedAt: string;
}

export interface IndexedSourceUnit {
  id: string;
  evidenceId?: string;
  assetId: string;
  dkbId: string;
  packageVersion?: string;
  storeId: string;
  type: DkbStoreType;
  locator: Record<string, unknown>;
  assetLocator: Record<string, unknown>;
  title: string;
  text: string;
  keywords: string[];
  capabilities: KnowledgeCapabilityProfile;
  queryable?: KnowledgeQueryable;
  hash: string;
  updatedAt: string;
  chunkOrdinal: number;
  chunkStart: number;
  chunkEnd: number;
  heading?: string;
}

export interface DkbProviderServiceRequirement {
  id: string;
  kind: 'process' | 'docker' | 'remote';
}

export interface DkbEvidenceProvider {
  kind: 'evidence';
  serviceRequirements?: readonly DkbProviderServiceRequirement[];
  identity?: DkbProviderIdentity;
  lifecycle?: DkbProviderLifecycle;
  compile(input: {
    dkb: LoadedDkb;
    options: DkbProviderOptions;
    signal?: AbortSignal;
  }): Promise<{
    documents?: DkbPipelineDocument[];
    chunks?: DkbPipelineChunk[];
    records: DkbPipelineRecord[];
    receipt: DkbProviderOutputReceipt;
  }>;
  health?(): Promise<DkbProviderHealth>;
  dispose?(): Promise<void> | void;
}

export interface DkbParserProvider {
  kind: 'parser';
  serviceRequirements?: readonly DkbProviderServiceRequirement[];
  identity?: DkbProviderIdentity;
  parse(input: {
    dkb: LoadedDkb;
    options: DkbProviderOptions;
    signal?: AbortSignal;
  }): Promise<DkbParsedDocument[]>;
  health?(): Promise<DkbProviderHealth>;
  dispose?(): Promise<void> | void;
}

export interface DkbChunkerProvider {
  kind: 'chunker';
  serviceRequirements?: readonly DkbProviderServiceRequirement[];
  identity?: DkbProviderIdentity;
  chunk(input: {
    documents: readonly DkbParsedDocument[];
    options: DkbProviderOptions;
    signal?: AbortSignal;
  }): Promise<DkbLocatedChunk[]>;
  health?(): Promise<DkbProviderHealth>;
  dispose?(): Promise<void> | void;
}

export interface DkbEmbeddingProvider {
  kind: 'embedding';
  serviceRequirements?: readonly DkbProviderServiceRequirement[];
  identity?: DkbProviderIdentity;
  lifecycle?: DkbProviderLifecycle;
  embedDocuments(input: {
    texts: readonly string[];
    options: DkbProviderOptions;
    signal?: AbortSignal;
  }): Promise<number[][]>;
  embedQuery(input: {
    text: string;
    options: DkbProviderOptions;
    signal?: AbortSignal;
  }): Promise<number[]>;
  compatibility(options: DkbProviderOptions): Promise<Record<string, DkbJsonValue>> | Record<string, DkbJsonValue>;
  health?(): Promise<DkbProviderHealth>;
  dispose?(): Promise<void> | void;
}

export interface DkbIndexProviderBase {
  kind: 'index';
  serviceRequirements?: readonly DkbProviderServiceRequirement[];
  identity?: DkbProviderIdentity;
  mode: 'packaged' | 'managed';
  format: string;
  capabilities: {
    vectors: 'required' | 'optional' | 'none';
  };
  openRuntime(input: {
    libraryRoot: string;
    libraryId: string;
    packages: readonly DkbRuntimePackageBuild[];
    compatibility: Record<string, DkbJsonValue>;
    embedQuery?: (text: string, signal?: AbortSignal) => Promise<number[]>;
    options: DkbProviderOptions;
    signal?: AbortSignal;
  }): Promise<DkbIndexRuntime | null>;
  health?(): Promise<DkbProviderHealth>;
  dispose?(): Promise<void> | void;
}

export interface DkbPackagedIndexProvider extends DkbIndexProviderBase {
  mode: 'packaged';
  compilePackage(input: {
    artifactsRoot: string;
    dkb: LoadedDkb;
    compiled: DkbRetrievalPipeline;
    compatibility: Record<string, DkbJsonValue>;
    options: DkbProviderOptions;
    signal?: AbortSignal;
  }): Promise<DkbProviderOutputReceipt | null>;
  validatePackage(input: {
    dkb: LoadedDkb;
    artifactsRoot: string;
    compatibility: Record<string, DkbJsonValue>;
    options: DkbProviderOptions;
    signal?: AbortSignal;
  }): Promise<{ documentCount: number }>;
  verifyRuntime(input: {
    libraryRoot: string;
    libraryId: string;
    packages: readonly DkbRuntimePackageBuild[];
    packageId?: string;
    packageVersion?: string;
    compatibility: Record<string, DkbJsonValue>;
    options: DkbProviderOptions;
    signal?: AbortSignal;
  }): Promise<DkbIndexMutationResult>;
}

export interface DkbManagedIndexProvider extends DkbIndexProviderBase {
  mode: 'managed';
  compilePackage(input: {
    artifactsRoot: string;
    dkb: LoadedDkb;
    compiled: DkbRetrievalPipeline;
    compatibility: Record<string, DkbJsonValue>;
    options: DkbProviderOptions;
    signal?: AbortSignal;
  }): Promise<DkbProviderOutputReceipt | null>;
  validatePackage(input: {
    dkb: LoadedDkb;
    artifactsRoot: string;
    compatibility: Record<string, DkbJsonValue>;
    options: DkbProviderOptions;
    signal?: AbortSignal;
  }): Promise<{ documentCount: number }>;
  installPackage(input: {
    libraryRoot: string;
    libraryId: string;
    dkb: LoadedDkb;
    artifactsRoot: string;
    compatibility: Record<string, DkbJsonValue>;
    options: DkbProviderOptions;
    signal?: AbortSignal;
  }): Promise<DkbIndexMutationResult>;
  /** Roll back only the exact newly-created index returned by installPackage. */
  discardPackage(input: {
    indexId: string;
    libraryRoot: string;
    libraryId: string;
    dkb: LoadedDkb;
    artifactsRoot: string;
    compatibility: Record<string, DkbJsonValue>;
    options: DkbProviderOptions;
    signal?: AbortSignal;
  }): Promise<DkbIndexMutationResult>;
  uninstallPackage(input: {
    libraryRoot: string;
    libraryId: string;
    packageId: string;
    packageVersion: string;
    options: DkbProviderOptions;
    signal?: AbortSignal;
  }): Promise<DkbIndexMutationResult>;
  verifyRuntime(input: {
    libraryRoot: string;
    libraryId: string;
    packages: readonly DkbRuntimePackageBuild[];
    packageId?: string;
    packageVersion?: string;
    compatibility: Record<string, DkbJsonValue>;
    options: DkbProviderOptions;
    signal?: AbortSignal;
  }): Promise<DkbIndexMutationResult>;
}

export type DkbIndexProvider = DkbPackagedIndexProvider | DkbManagedIndexProvider;

export interface DkbRuntimePackageBuild {
  dkb: LoadedDkb;
  evidenceRoot: string;
  retrievalRoot: string;
  artifactsRoot: string;
}

export interface DkbRetrievalProvider {
  kind: 'retrieval';
  serviceRequirements?: readonly DkbProviderServiceRequirement[];
  identity?: DkbProviderIdentity;
  protocol: string;
  capabilities: {
    vectors: 'required' | 'optional' | 'none';
  };
  openRuntime(input: {
    index: DkbIndexRuntime | null;
    evidence: {
      assets: readonly DkbEvidenceCatalogAsset[];
      records: readonly DkbEvidenceCatalogRecord[];
    };
    options: DkbProviderOptions;
    signal?: AbortSignal;
  }): Promise<DkbRetrievalRuntime> | DkbRetrievalRuntime;
  health?(): Promise<DkbProviderHealth>;
  dispose?(): Promise<void> | void;
}

export interface DkbRetrievalScope {
  dkbId?: string;
  packageVersion?: string;
  assetId?: string;
  sourceType?: string;
}

export interface DkbRetrievalHit {
  evidenceId: string;
  score: number;
  channels: string[];
  matchedTokens?: string[];
}

export interface DkbRetrievalRuntime {
  providerId: string;
  protocol: string;
  search(input: {
    query: string;
    limit: number;
    scope?: DkbRetrievalScope;
    signal?: AbortSignal;
  }): Promise<{ hits: DkbRetrievalHit[]; trace: Record<string, DkbJsonValue> }>;
  close(): Promise<void> | void;
}

export interface DkbIndexMutationResult {
  indexId: string;
  documentCount: number;
  status: 'ready' | 'removed' | 'orphaned';
  created?: boolean;
  warning?: string;
}

export interface DkbIndexRuntime {
  providerId: string;
  mode: DkbIndexProvider['mode'];
  format: string;
  packages: Array<{ id: string; version: string; indexId: string; documentCount: number }>;
  search(query: string, limit: number, signal?: AbortSignal): Promise<{
    hits: Array<{ id: string; score: number }>;
    trace: Record<string, DkbJsonValue>;
  }>;
  close(): Promise<void> | void;
}

export type DkbProvider =
  | DkbEvidenceProvider
  | DkbParserProvider
  | DkbChunkerProvider
  | DkbEmbeddingProvider
  | DkbIndexProvider
  | DkbRetrievalProvider;

export interface DkbProviderHealth {
  ok: boolean;
  detail?: string;
}

export interface DkbProviderLifecycle {
  inspect?(): Promise<unknown>;
  start?(options?: { restart?: boolean }): Promise<unknown>;
  status?(): Promise<unknown>;
  stop?(): Promise<unknown>;
  doctor?(): Promise<{ ok: boolean; [key: string]: unknown }>;
}

export interface DkbProcessor<TValue = DkbPipelineDocument | DkbPipelineChunk | DkbPipelineRecord> {
  id: string;
  serviceRequirements?: readonly DkbProviderServiceRequirement[];
  version: string;
  stage: DkbProcessorStage;
  mutate(value: TValue, context: {
    root: string;
    options: DkbProviderOptions;
    signal?: AbortSignal;
  }): Promise<TValue | null> | TValue | null;
  dispose?(): Promise<void> | void;
}

export interface DkbPluginSetupContext {
  readonly root: string;
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly options: DkbProviderOptions;
  registerProvider(provider: DkbProvider): void;
  registerProcessor(processor: DkbProcessor): void;
  registerQueryObserver(observer: DkbQueryObserver): void;
}

export interface DkbPluginModule {
  apiVersion: typeof DKB_PLUGIN_API_VERSION;
  id: string;
  version: string;
  optionsSchema: DkbProviderOptionsSchema;
  identity?: DkbPluginIdentity;
  setup(context: DkbPluginSetupContext): Promise<void> | void;
}

export interface DkbProviderIntegrityReceipt {
  apiVersion: typeof DKB_PLUGIN_API_VERSION;
  id: string;
  version: string;
  filesDigest: string;
  dependencyDigest: string;
  externalDigests: Record<string, string>;
  protocols: string[];
  artifactFormats: string[];
}

export interface DkbQueryObservation {
  eventId: string;
  recordedAt: string;
  runtimeId: string;
  channel: 'cli' | 'http' | 'mcp';
  status: 'success' | 'insufficient' | 'cancelled' | 'failed';
  data: Readonly<Record<string, DkbJsonValue>>;
}

export interface DkbQueryObserver {
  id: string;
  version: string;
  observe(event: Readonly<DkbQueryObservation>, context: {
    root: string;
    options: DkbProviderOptions;
    signal?: AbortSignal;
  }): Promise<void> | void;
  health?(): Promise<DkbProviderHealth>;
  dispose?(): Promise<void> | void;
}

export interface DkbQueryObserverResult {
  id: string;
  version: string;
  source: 'local' | 'global' | 'bundled';
  integrityDigest: string;
  ok: boolean;
  detail?: string;
}

export interface DkbProviderRegistration {
  id: string;
  version: string;
  provider: DkbProvider;
  source: 'local' | 'global' | 'bundled';
  sourcePath: string;
  sourceDigest: string;
  integrity: DkbProviderIntegrityReceipt;
  integrityDigest: string;
}

export interface DkbProcessorRegistration {
  id: string;
  version: string;
  processor: DkbProcessor;
  source: 'local' | 'global' | 'bundled';
  sourcePath: string;
  sourceDigest: string;
  integrity: DkbProviderIntegrityReceipt;
  integrityDigest: string;
}

export interface DkbQueryObserverRegistration {
  id: string;
  version: string;
  observer: DkbQueryObserver;
  source: 'local' | 'global' | 'bundled';
  sourcePath: string;
  sourceDigest: string;
  integrity: DkbProviderIntegrityReceipt;
  integrityDigest: string;
}
