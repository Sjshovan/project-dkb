import { stableHash } from './contracts/hash.js';
import { DkbError } from './errors.js';

export const DKB_RETRIEVAL_PROFILE_LOCK_PATH = 'dkb-profile.lock.json';
export const DKB_RETRIEVAL_PROFILE_FORMAT = 'dkb.retrieval-profile.v2';

export type DkbProviderReceiptKind = 'evidence' | 'parser' | 'chunker' | 'embedding' | 'index' | 'retrieval';
export type DkbPluginReceiptSource = 'local' | 'global' | 'bundled';

export interface DkbProviderReceipt {
  id: string;
  version: string;
  kind: DkbProviderReceiptKind;
  source: DkbPluginReceiptSource;
  sourcePath: string;
  sourceDigest: string;
}

export interface DkbProcessorReceipt {
  id: string;
  version: string;
  stage: 'document' | 'chunk' | 'record';
  source: DkbPluginReceiptSource;
  sourcePath: string;
  sourceDigest: string;
}

export interface DkbRetrievalCompatibilityReceipt extends Record<string, unknown> {
  evidenceProfileDigest: string;
  embeddingProvider: string;
  embeddingSpace: string;
  dimensions: number;
  metric: string;
  normalized: boolean;
  modelRevision?: string;
  queryTransformDigest: string;
  documentTransformDigest: string;
  indexFormat: string;
  protocol: string;
}

export interface DkbRetrievalProfileLock {
  format: typeof DKB_RETRIEVAL_PROFILE_FORMAT;
  profile: {
    compiler: {
      adapter: string;
      id: string;
      image: string;
      imageDigest: string | null;
    };
    embedding: {
      adapter: string;
      model: string;
      modelRevision: string | null;
      modelDigest: string | null;
      dimensions: number;
      metric: string;
      normalized: boolean;
      queryMode: string;
      documentMode: string;
    };
    extraction: {
      richParser: string;
      richChunker: string;
      fallbackParser: string;
      fallbackChunker: string;
    };
    evidence: {
      profileDigest: string;
    };
    target: string;
    configDigest: string;
    providerBuildDigest: string;
    providers: DkbProviderReceipt[];
    processors: DkbProcessorReceipt[];
    index: {
      provider: string;
      mode: 'packaged' | 'managed';
      format: string;
    };
    retrieval: {
      provider: string;
      protocol: string;
      profileDigest: string;
    };
  };
  buildDigest: string;
  compatibility: DkbRetrievalCompatibilityReceipt;
  compatibilityDigest: string;
  profileDigest: string;
  generatedAt: string;
}

export function validateRetrievalProfileLock(
  value: unknown,
  source = DKB_RETRIEVAL_PROFILE_LOCK_PATH,
): DkbRetrievalProfileLock {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: expected object`);
  }

  const candidate = value as Partial<DkbRetrievalProfileLock>;
  const profile = candidate.profile;

  if (candidate.format !== DKB_RETRIEVAL_PROFILE_FORMAT || !profile || typeof candidate.profileDigest !== 'string') {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: unsupported format or missing profile`);
  }
  if (!profile.compiler || !profile.embedding || !profile.extraction || !profile.evidence || !profile.index || !profile.retrieval) {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: incomplete profile`);
  }
  if (!Number.isInteger(profile.embedding.dimensions) || profile.embedding.dimensions <= 0) {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: dimensions must be a positive integer`);
  }
  if (!Array.isArray(profile.providers) || !Array.isArray(profile.processors)) {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: provider receipts must be arrays`);
  }
  for (const provider of profile.providers) validateProviderReceipt(provider, source);
  for (const processor of profile.processors) validateProcessorReceipt(processor, source);

  if (!candidate.compatibility || typeof candidate.buildDigest !== 'string' || typeof candidate.compatibilityDigest !== 'string') {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: missing build or compatibility receipt`);
  }
  const actualBuildDigest = stableHash(profile);
  const compatibilityDigest = stableHash(candidate.compatibility);

  if (candidate.compatibilityDigest !== compatibilityDigest) {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: expected digest ${compatibilityDigest}, got ${candidate.compatibilityDigest}`);
  }
  if (candidate.profileDigest !== profile.retrieval.profileDigest) {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: expected profile digest ${profile.retrieval.profileDigest}, got ${candidate.profileDigest}`);
  }
  if (candidate.buildDigest !== actualBuildDigest) {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: expected build digest ${actualBuildDigest}, got ${candidate.buildDigest}`);
  }

  return candidate as DkbRetrievalProfileLock;
}

export function assertMatchingRetrievalProfiles(
  expected: DkbRetrievalProfileLock,
  actual: DkbRetrievalProfileLock,
  label = 'package',
): void {
  if (expected.compatibilityDigest !== actual.compatibilityDigest) {
    throw new DkbError(
      `Retrieval profile mismatch for ${label}: registry uses ${expected.profile.embedding.model}/${expected.profile.embedding.dimensions} (${expected.profileDigest}), package uses ${actual.profile.embedding.model}/${actual.profile.embedding.dimensions} (${actual.profileDigest})`,
    );
  }
}

function validateProviderReceipt(value: DkbProviderReceipt, source: string): void {
  if (!value || !PROVIDER_KINDS.has(value.kind) || !PLUGIN_SOURCES.has(value.source)) {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: invalid provider receipt`);
  }
  for (const field of ['id', 'version', 'sourcePath', 'sourceDigest'] as const) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      throw new DkbError(`Invalid retrieval profile lock at ${source}: provider ${field} must be a non-empty string`);
    }
  }
}

function validateProcessorReceipt(value: DkbProcessorReceipt, source: string): void {
  if (!value || !PROCESSOR_STAGES.has(value.stage) || !PLUGIN_SOURCES.has(value.source)) {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: invalid processor receipt`);
  }
  for (const field of ['id', 'version', 'sourcePath', 'sourceDigest'] as const) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      throw new DkbError(`Invalid retrieval profile lock at ${source}: processor ${field} must be a non-empty string`);
    }
  }
}

const PROVIDER_KINDS = new Set<DkbProviderReceiptKind>(['evidence', 'parser', 'chunker', 'embedding', 'index', 'retrieval']);
const PROCESSOR_STAGES = new Set<DkbProcessorReceipt['stage']>(['document', 'chunk', 'record']);
const PLUGIN_SOURCES = new Set<DkbPluginReceiptSource>(['local', 'global', 'bundled']);
