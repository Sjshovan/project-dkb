import { stableHash } from '@dkb/protocol/contracts/hash.js';
import { DKB_EVIDENCE_IR_FORMAT } from '@dkb/protocol/evidence/ir.js';
import { DkbError } from '@dkb/protocol/errors.js';
import type { DkbProviderHost, DkbProviderHostDescription } from './host.js';
import type { DkbEmbeddingProvider, DkbIndexProvider, DkbRetrievalProvider } from './types.js';

export const DKB_EVIDENCE_PROFILE_FORMAT = 'dkb.evidence-profile.v1';
export const DKB_RETRIEVAL_BUILD_PROFILE_FORMAT = 'dkb.retrieval-build-profile.v1';

type ProviderDescription = DkbProviderHostDescription['providers'][number];
type ProcessorDescription = DkbProviderHostDescription['processors'][number];

export interface DkbResolvedEvidenceProfile {
  format: typeof DKB_EVIDENCE_PROFILE_FORMAT;
  schema: typeof DKB_EVIDENCE_IR_FORMAT;
  ingestion: {
    mode: 'fused' | 'separate';
    providers: ProviderDescription[];
  };
  processors: ProcessorDescription[];
  options: Record<string, Record<string, unknown>>;
  profileDigest: string;
}

export interface DkbResolvedRetrievalBuildProfile {
  format: typeof DKB_RETRIEVAL_BUILD_PROFILE_FORMAT;
  evidenceProfileDigest: string;
  providers: ProviderDescription[];
  options: Record<string, Record<string, unknown>>;
  embedding: {
    provider: string;
    space: string;
    dimensions: number;
    metric: string;
    normalized: boolean;
    queryMode: string;
    documentMode: string;
    modelRevision?: string;
    queryTransformDigest: string;
    documentTransformDigest: string;
  };
  index: {
    provider: string;
    mode: DkbIndexProvider['mode'];
    format: string;
  };
  retrieval: {
    provider: string;
    protocol: string;
  };
  profileDigest: string;
  compatibility: {
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
  };
  compatibilityDigest: string;
}

export interface DkbResolvedBuildProfiles {
  target: string;
  evidence: DkbResolvedEvidenceProfile;
  retrieval: DkbResolvedRetrievalBuildProfile;
}

export async function resolveBuildProfiles(host: DkbProviderHost): Promise<DkbResolvedBuildProfiles> {
  const description = host.describe();
  const target = host.config.target;
  const evidenceProviderKinds = target.ingestion
    ? new Set(['ingestion'])
    : new Set(['parser', 'chunker']);
  const evidenceProviders = description.providers
    .filter((provider) => evidenceProviderKinds.has(provider.kind))
    .sort(compareProvider);
  const processors = [...description.processors];
  const evidenceProfile = {
    format: DKB_EVIDENCE_PROFILE_FORMAT as typeof DKB_EVIDENCE_PROFILE_FORMAT,
    schema: DKB_EVIDENCE_IR_FORMAT as typeof DKB_EVIDENCE_IR_FORMAT,
    ingestion: {
      mode: target.ingestion ? 'fused' as const : 'separate' as const,
      providers: evidenceProviders,
    },
    processors,
    options: selectedOptions(host, [
      ...evidenceProviders.map((provider) => provider.id),
      ...processors.map((processor) => processor.id),
    ]),
  };
  const evidenceProfileDigest = stableHash(evidenceProfile);
  const embedding = host.provider<DkbEmbeddingProvider>('embedding');
  const index = host.provider<DkbIndexProvider>('index');
  const retrieval = host.provider<DkbRetrievalProvider>('retrieval');
  const raw = await embedding.compatibility(host.optionsFor(target.embedding));
  const embeddingSpace = requiredString(raw.embeddingSpace, `${target.embedding} compatibility embeddingSpace`);
  const dimensions = requiredPositiveInteger(raw.dimensions, `${target.embedding} compatibility dimensions`);
  const metric = requiredString(raw.metric, `${target.embedding} compatibility metric`);
  const normalized = requiredBoolean(raw.normalized, `${target.embedding} compatibility normalized`);
  const queryMode = optionalString(raw.queryMode) ?? 'query';
  const documentMode = optionalString(raw.documentMode) ?? 'passage';
  const modelRevision = optionalString(raw.modelRevision);
  const queryTransformDigest = optionalString(raw.queryTransformDigest) ?? stableHash({ mode: queryMode });
  const documentTransformDigest = optionalString(raw.documentTransformDigest) ?? stableHash({ mode: documentMode });
  const retrievalProviders = description.providers
    .filter((provider) => ['embedding', 'index', 'retrieval'].includes(provider.kind))
    .sort(compareProvider);
  const retrievalProfile = {
    format: DKB_RETRIEVAL_BUILD_PROFILE_FORMAT as typeof DKB_RETRIEVAL_BUILD_PROFILE_FORMAT,
    evidenceProfileDigest,
    providers: retrievalProviders,
    options: selectedOptions(host, retrievalProviders.map((provider) => provider.id)),
    embedding: {
      provider: target.embedding,
      space: embeddingSpace,
      dimensions,
      metric,
      normalized,
      queryMode,
      documentMode,
      ...(modelRevision ? { modelRevision } : {}),
      queryTransformDigest,
      documentTransformDigest,
    },
    index: {
      provider: target.index,
      mode: index.mode,
      format: index.format,
    },
    retrieval: {
      provider: target.retrieval,
      protocol: retrieval.protocol,
    },
  };
  const retrievalProfileDigest = stableHash(retrievalProfile);
  const compatibility = {
    evidenceProfileDigest,
    embeddingProvider: target.embedding,
    embeddingSpace,
    dimensions,
    metric,
    normalized,
    ...(modelRevision ? { modelRevision } : {}),
    queryTransformDigest,
    documentTransformDigest,
    indexFormat: index.format,
    protocol: retrieval.protocol,
  };

  return {
    target: description.target,
    evidence: {
      ...evidenceProfile,
      profileDigest: evidenceProfileDigest,
    },
    retrieval: {
      ...retrievalProfile,
      profileDigest: retrievalProfileDigest,
      compatibility,
      compatibilityDigest: stableHash(compatibility),
    },
  };
}

function selectedOptions(host: DkbProviderHost, ids: readonly string[]): Record<string, Record<string, unknown>> {
  return Object.fromEntries([...new Set(ids)].sort().map((id) => [id, { ...host.optionsFor(id) }]));
}

function compareProvider(left: ProviderDescription, right: ProviderDescription): number {
  return left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DkbError(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new DkbError(`${label} must be a positive integer`);
  }
  return Number(value);
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new DkbError(`${label} must be a boolean`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
