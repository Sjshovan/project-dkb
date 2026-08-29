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
    embedding: {
      provider: string;
      space: string;
      modelRevision?: string;
      dimensions: number;
      metric: string;
      normalized: boolean;
      queryMode: string;
      documentMode: string;
      queryTransformDigest: string;
      documentTransformDigest: string;
    };
    evidence: {
      profileDigest: string;
      providers: DkbProviderReceipt[];
      processors: DkbProcessorReceipt[];
    };
    target: string;
    configDigest: string;
    providerBuildDigest: string;
    index: {
      provider: string;
      mode: 'packaged' | 'managed';
      format: string;
    };
    retrieval: {
      provider: string;
      protocol: string;
      profileDigest: string;
      providers: DkbProviderReceipt[];
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
  if (!profile.embedding || !profile.evidence || !profile.index || !profile.retrieval) {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: incomplete profile`);
  }
  if (!Number.isInteger(profile.embedding.dimensions) || profile.embedding.dimensions <= 0) {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: dimensions must be a positive integer`);
  }
  if (!Array.isArray(profile.evidence.providers) || !Array.isArray(profile.evidence.processors)
    || !Array.isArray(profile.retrieval.providers)) {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: provider receipts must be arrays`);
  }
  for (const provider of profile.evidence.providers) validateProviderReceipt(provider, source, EVIDENCE_PROVIDER_KINDS);
  for (const processor of profile.evidence.processors) validateProcessorReceipt(processor, source);
  for (const provider of profile.retrieval.providers) validateProviderReceipt(provider, source, RETRIEVAL_PROVIDER_KINDS);
  validateResolvedProfile(profile, source);

  if (!candidate.compatibility || typeof candidate.buildDigest !== 'string' || typeof candidate.compatibilityDigest !== 'string') {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: missing build or compatibility receipt`);
  }
  if (typeof candidate.generatedAt !== 'string' || candidate.generatedAt.length === 0) {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: generatedAt must be a non-empty string`);
  }
  validateCompatibility(profile, candidate.compatibility, source);
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
      `Retrieval profile mismatch for ${label}: registry uses ${expected.profile.embedding.space}/${expected.profile.embedding.dimensions} (${expected.profileDigest}), package uses ${actual.profile.embedding.space}/${actual.profile.embedding.dimensions} (${actual.profileDigest})`,
    );
  }
}

function validateProviderReceipt(value: DkbProviderReceipt, source: string, allowedKinds: ReadonlySet<DkbProviderReceiptKind>): void {
  if (!value || !allowedKinds.has(value.kind) || !PLUGIN_SOURCES.has(value.source)) {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: invalid provider receipt`);
  }
  for (const field of ['id', 'version', 'sourcePath', 'sourceDigest'] as const) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      throw new DkbError(`Invalid retrieval profile lock at ${source}: provider ${field} must be a non-empty string`);
    }
  }
  assertDigest(value.sourceDigest, `Invalid retrieval profile lock at ${source}: provider sourceDigest`);
}

function validateResolvedProfile(profile: DkbRetrievalProfileLock['profile'], source: string): void {
  for (const [label, value] of Object.entries({
    target: profile.target,
    embeddingProvider: profile.embedding.provider,
    embeddingSpace: profile.embedding.space,
    embeddingMetric: profile.embedding.metric,
    queryMode: profile.embedding.queryMode,
    documentMode: profile.embedding.documentMode,
    indexProvider: profile.index.provider,
    indexFormat: profile.index.format,
    retrievalProvider: profile.retrieval.provider,
    retrievalProtocol: profile.retrieval.protocol,
  })) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new DkbError(`Invalid retrieval profile lock at ${source}: ${label} must be a non-empty string`);
    }
  }
  for (const [label, digest] of Object.entries({
    configDigest: profile.configDigest,
    providerBuildDigest: profile.providerBuildDigest,
    evidenceProfileDigest: profile.evidence.profileDigest,
    retrievalProfileDigest: profile.retrieval.profileDigest,
  })) assertDigest(digest, `Invalid retrieval profile lock at ${source}: ${label}`);
  if (!['packaged', 'managed'].includes(profile.index.mode) || typeof profile.embedding.normalized !== 'boolean') {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: invalid index mode or embedding normalization`);
  }
  for (const [label, digest] of Object.entries({
    queryTransformDigest: profile.embedding.queryTransformDigest,
    documentTransformDigest: profile.embedding.documentTransformDigest,
  })) assertDigest(digest, `Invalid retrieval profile lock at ${source}: ${label}`);

  const retrievalProviders = new Map(profile.retrieval.providers.map((provider) => [provider.kind, provider.id]));
  if (retrievalProviders.size !== 3 || profile.retrieval.providers.length !== 3
    || retrievalProviders.get('embedding') !== profile.embedding.provider
    || retrievalProviders.get('index') !== profile.index.provider
    || retrievalProviders.get('retrieval') !== profile.retrieval.provider) {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: selected provider receipts do not match the resolved retrieval profile`);
  }
  const evidenceKinds = new Set(profile.evidence.providers.map((provider) => provider.kind));
  const fused = profile.evidence.providers.length === 1 && evidenceKinds.size === 1 && evidenceKinds.has('evidence');
  const separate = profile.evidence.providers.length === 2 && evidenceKinds.size === 2
    && evidenceKinds.has('parser') && evidenceKinds.has('chunker');
  if (!fused && !separate) {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: Evidence provider receipts are incomplete`);
  }
}

function validateCompatibility(
  profile: DkbRetrievalProfileLock['profile'],
  compatibility: DkbRetrievalCompatibilityReceipt,
  source: string,
): void {
  if (compatibility.modelRevision !== profile.embedding.modelRevision) {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: compatibility modelRevision does not match the resolved profile`);
  }
  const expected = {
    evidenceProfileDigest: profile.evidence.profileDigest,
    embeddingProvider: profile.embedding.provider,
    embeddingSpace: profile.embedding.space,
    dimensions: profile.embedding.dimensions,
    metric: profile.embedding.metric,
    normalized: profile.embedding.normalized,
    queryTransformDigest: profile.embedding.queryTransformDigest,
    documentTransformDigest: profile.embedding.documentTransformDigest,
    indexFormat: profile.index.format,
    protocol: profile.retrieval.protocol,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (compatibility[field] !== value) {
      throw new DkbError(`Invalid retrieval profile lock at ${source}: compatibility ${field} does not match the resolved profile`);
    }
  }
}

function assertDigest(value: unknown, label: string): void {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/iu.test(value)) {
    throw new DkbError(`${label} must be a sha256 digest`);
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
  assertDigest(value.sourceDigest, `Invalid retrieval profile lock at ${source}: processor sourceDigest`);
}

const EVIDENCE_PROVIDER_KINDS = new Set<DkbProviderReceiptKind>(['evidence', 'parser', 'chunker']);
const RETRIEVAL_PROVIDER_KINDS = new Set<DkbProviderReceiptKind>(['embedding', 'index', 'retrieval']);
const PROCESSOR_STAGES = new Set<DkbProcessorReceipt['stage']>(['document', 'chunk', 'record']);
const PLUGIN_SOURCES = new Set<DkbPluginReceiptSource>(['local', 'global', 'bundled']);
