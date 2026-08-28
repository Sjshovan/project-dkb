import type {
  DkbStoreType,
  KnowledgeCapabilityProfile,
  KnowledgeQueryable,
  LoadedDkb,
} from '@sjshovan/dkb-protocol/types.js';

export type DkbProviderKind = 'ingestion' | 'parser' | 'chunker' | 'embedding' | 'index' | 'retrieval';
export type DkbProcessorStage = 'document' | 'chunk' | 'record';

export interface DkbPipelineDocument {
  id: string;
  path: string;
  mediaType?: string;
  text?: string;
  metadata: Record<string, unknown>;
}

export interface DkbPipelineChunk {
  id: string;
  documentId: string;
  text: string;
  metadata: Record<string, unknown>;
}

export interface DkbPipelineRecord {
  id: string;
  chunkId: string;
  text: string;
  embedding?: number[];
  metadata: Record<string, unknown>;
}

export interface DkbCompiledPipeline {
  documents: DkbPipelineDocument[];
  chunks: DkbPipelineChunk[];
  records: DkbPipelineRecord[];
  receipts: DkbProviderBuildReceipt[];
  nativeResult?: unknown;
}

export interface DkbProviderBuildReceipt {
  providerId: string;
  providerVersion: string;
  build: Record<string, unknown>;
  compatibility?: Record<string, unknown>;
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

export interface DkbIngestionProvider {
  kind: 'ingestion';
  lifecycle?: DkbProviderLifecycle;
  compile(input: {
    dkb: LoadedDkb;
    options: Readonly<Record<string, unknown>>;
    signal?: AbortSignal;
  }): Promise<{
    documents?: DkbPipelineDocument[];
    chunks?: DkbPipelineChunk[];
    records: DkbPipelineRecord[];
    receipt: DkbProviderBuildReceipt;
    nativeResult?: unknown;
  }>;
  health?(): Promise<DkbProviderHealth>;
  dispose?(): Promise<void> | void;
}

export interface DkbParserProvider {
  kind: 'parser';
  parse(input: {
    dkb: LoadedDkb;
    options: Readonly<Record<string, unknown>>;
    signal?: AbortSignal;
  }): Promise<DkbPipelineDocument[]>;
  health?(): Promise<DkbProviderHealth>;
  dispose?(): Promise<void> | void;
}

export interface DkbChunkerProvider {
  kind: 'chunker';
  chunk(input: {
    documents: readonly DkbPipelineDocument[];
    options: Readonly<Record<string, unknown>>;
    signal?: AbortSignal;
  }): Promise<DkbPipelineChunk[]>;
  health?(): Promise<DkbProviderHealth>;
  dispose?(): Promise<void> | void;
}

export interface DkbEmbeddingProvider {
  kind: 'embedding';
  lifecycle?: DkbProviderLifecycle;
  embedDocuments(input: {
    texts: readonly string[];
    options: Readonly<Record<string, unknown>>;
    signal?: AbortSignal;
  }): Promise<number[][]>;
  embedQuery(input: {
    text: string;
    options: Readonly<Record<string, unknown>>;
    signal?: AbortSignal;
  }): Promise<number[]>;
  compatibility(options: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> | Record<string, unknown>;
  health?(): Promise<DkbProviderHealth>;
  dispose?(): Promise<void> | void;
}

export interface DkbIndexProvider {
  kind: 'index';
  mode: 'packaged' | 'managed';
  format: string;
  compilePackage?(input: {
    root: string;
    dkb: LoadedDkb;
    compiled: DkbCompiledPipeline;
    compatibility: Record<string, unknown>;
    options: Readonly<Record<string, unknown>>;
    signal?: AbortSignal;
  }): Promise<DkbProviderBuildReceipt | null>;
  validatePackage?(input: {
    dkb: LoadedDkb;
    compatibility: Record<string, unknown>;
    options: Readonly<Record<string, unknown>>;
    signal?: AbortSignal;
  }): Promise<{ documentCount: number }>;
  installPackage?(input: {
    libraryRoot: string;
    libraryId: string;
    dkb: LoadedDkb;
    compatibility: Record<string, unknown>;
    options: Readonly<Record<string, unknown>>;
    signal?: AbortSignal;
  }): Promise<DkbIndexMutationResult>;
  uninstallPackage?(input: {
    libraryRoot: string;
    libraryId: string;
    packageId: string;
    packageVersion: string;
    options: Readonly<Record<string, unknown>>;
    signal?: AbortSignal;
  }): Promise<DkbIndexMutationResult>;
  verifyRuntime?(input: {
    libraryRoot: string;
    libraryId: string;
    packageId?: string;
    packageVersion?: string;
    compatibility: Record<string, unknown>;
    options: Readonly<Record<string, unknown>>;
    signal?: AbortSignal;
  }): Promise<DkbIndexMutationResult>;
  openRuntime(input: {
    libraryRoot: string;
    libraryId: string;
    compatibility: Record<string, unknown>;
    embedQuery(text: string, signal?: AbortSignal): Promise<number[]>;
    options: Readonly<Record<string, unknown>>;
    signal?: AbortSignal;
  }): Promise<DkbIndexRuntime | null>;
  health?(): Promise<DkbProviderHealth>;
  dispose?(): Promise<void> | void;
}

export interface DkbRetrievalProvider {
  kind: 'retrieval';
  protocol: string;
  health?(): Promise<DkbProviderHealth>;
  dispose?(): Promise<void> | void;
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
  assets: IndexedSourceAsset[];
  units: IndexedSourceUnit[];
  lexicalSearch?(query: string, limit: number, scope?: {
    dkbId?: string;
    packageVersion?: string;
    assetId?: string;
    sourceType?: string;
  }): Array<{ unitId: string; score: number; matchedTokens: string[] }>;
  search(query: string, limit: number, signal?: AbortSignal): Promise<{
    hits: Array<{ id: string; score: number }>;
    trace: Record<string, unknown>;
  }>;
  close(): Promise<void> | void;
}

export type DkbProvider =
  | DkbIngestionProvider
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
  version: string;
  stage: DkbProcessorStage;
  mutate(value: TValue, context: {
    root: string;
    options: Readonly<Record<string, unknown>>;
    signal?: AbortSignal;
  }): Promise<TValue | null> | TValue | null;
  dispose?(): Promise<void> | void;
}

export interface DkbPluginSetupContext {
  readonly root: string;
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly options: Readonly<Record<string, unknown>>;
  registerProvider(provider: DkbProvider): void;
  registerProcessor(processor: DkbProcessor): void;
}

export interface DkbPluginModule {
  id: string;
  version: string;
  setup(context: DkbPluginSetupContext): Promise<void> | void;
}

export interface DkbProviderRegistration {
  id: string;
  version: string;
  provider: DkbProvider;
  source: 'local' | 'global' | 'bundled';
  sourcePath: string;
  sourceDigest: string;
}

export interface DkbProcessorRegistration {
  id: string;
  version: string;
  processor: DkbProcessor;
  source: 'local' | 'global' | 'bundled';
  sourcePath: string;
  sourceDigest: string;
}
