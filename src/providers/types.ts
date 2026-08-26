import type { LoadedDkb } from '../protocol/types.js';

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
  compilePackage?(input: {
    root: string;
    dkb: LoadedDkb;
    compiled: DkbCompiledPipeline;
    options: Readonly<Record<string, unknown>>;
    signal?: AbortSignal;
  }): Promise<DkbProviderBuildReceipt | null>;
  installPackage?(input: {
    libraryRoot: string;
    libraryId: string;
    dkb: LoadedDkb;
    options: Readonly<Record<string, unknown>>;
    signal?: AbortSignal;
  }): Promise<{ indexId: string; documentCount: number }>;
  uninstallPackage?(input: {
    libraryRoot: string;
    libraryId: string;
    packageId: string;
    packageVersion: string;
    options: Readonly<Record<string, unknown>>;
    signal?: AbortSignal;
  }): Promise<{ indexId: string; removed: boolean; warning?: string }>;
  health?(): Promise<DkbProviderHealth>;
  dispose?(): Promise<void> | void;
}

export interface DkbRetrievalProvider {
  kind: 'retrieval';
  health?(): Promise<DkbProviderHealth>;
  dispose?(): Promise<void> | void;
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
