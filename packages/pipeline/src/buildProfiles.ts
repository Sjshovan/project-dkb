import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DKB_EVIDENCE_IR_FORMAT } from '@sjshovan/dkb-protocol/evidence/ir.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbProviderHost, DkbProviderHostDescription } from './host.js';
import type { DkbEmbeddingProvider, DkbIndexProvider, DkbRetrievalProvider } from './types.js';
import { validateEmbeddingCompatibility } from './validation.js';

export const DKB_EVIDENCE_PROFILE_FORMAT = 'dkb.evidence-profile.v1';
export const DKB_RETRIEVAL_BUILD_PROFILE_FORMAT = 'dkb.retrieval-build-profile.v1';

type ProviderDescription = DkbProviderHostDescription['providers'][number];
type ProcessorDescription = DkbProviderHostDescription['processors'][number];

export interface DkbResolvedEvidenceProfile {
  format: typeof DKB_EVIDENCE_PROFILE_FORMAT;
  schema: typeof DKB_EVIDENCE_IR_FORMAT;
  evidence: {
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
  embedding?: {
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
    embeddingProvider?: string;
    embeddingSpace?: string;
    dimensions?: number;
    metric?: string;
    normalized?: boolean;
    modelRevision?: string;
    queryTransformDigest?: string;
    documentTransformDigest?: string;
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
  const resolvedEvidence = resolveEvidenceProfile(host);
  const evidenceProfileDigest = resolvedEvidence.profileDigest;
  const embeddingId = target.embedding;
  const index = host.provider<DkbIndexProvider>('index');
  const retrieval = host.provider<DkbRetrievalProvider>('retrieval');
  const embedding = embeddingId ? host.provider<DkbEmbeddingProvider>('embedding') : undefined;
  const raw = embedding && embeddingId ? validateEmbeddingCompatibility(await embedding.compatibility(host.optionsFor(embeddingId)), embeddingId) : undefined;
  const embeddingSpace = embeddingId && raw ? requiredString(raw.embeddingSpace, `${embeddingId} compatibility embeddingSpace`) : undefined;
  const dimensions = embeddingId && raw ? requiredPositiveInteger(raw.dimensions, `${embeddingId} compatibility dimensions`) : undefined;
  const metric = embeddingId && raw ? requiredString(raw.metric, `${embeddingId} compatibility metric`) : undefined;
  const normalized = embeddingId && raw ? requiredBoolean(raw.normalized, `${embeddingId} compatibility normalized`) : undefined;
  const queryMode = raw ? optionalString(raw.queryMode) ?? 'query' : undefined;
  const documentMode = raw ? optionalString(raw.documentMode) ?? 'passage' : undefined;
  const modelRevision = raw ? optionalString(raw.modelRevision) : undefined;
  const queryTransformDigest = queryMode ? optionalString(raw?.queryTransformDigest) ?? stableHash({ mode: queryMode }) : undefined;
  const documentTransformDigest = documentMode ? optionalString(raw?.documentTransformDigest) ?? stableHash({ mode: documentMode }) : undefined;
  const retrievalProviders = description.providers
    .filter((provider) => ['embedding', 'index', 'retrieval'].includes(provider.kind));
  const retrievalProfile = {
    format: DKB_RETRIEVAL_BUILD_PROFILE_FORMAT as typeof DKB_RETRIEVAL_BUILD_PROFILE_FORMAT,
    evidenceProfileDigest,
    providers: retrievalProviders,
    options: selectedOptions(host, retrievalProviders.map((provider) => provider.id)),
    ...(embeddingId && embeddingSpace && dimensions && metric && normalized !== undefined && queryMode && documentMode && queryTransformDigest && documentTransformDigest ? { embedding: {
      provider: embeddingId,
      space: embeddingSpace,
      dimensions,
      metric,
      normalized,
      queryMode,
      documentMode,
      ...(modelRevision ? { modelRevision } : {}),
      queryTransformDigest,
      documentTransformDigest,
    } } : {}),
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
  const retrievalProfileDigest = stableHash({
    ...retrievalProfile,
    providers: retrievalProviders.map(profileIdentity),
  });
  const compatibility = {
    evidenceProfileDigest,
    ...(embeddingId && embeddingSpace && dimensions && metric && normalized !== undefined && queryTransformDigest && documentTransformDigest ? {
      embeddingProvider: embeddingId,
      embeddingSpace,
      dimensions,
      metric,
      normalized,
      ...(modelRevision ? { modelRevision } : {}),
      queryTransformDigest,
      documentTransformDigest,
    } : {}),
    indexFormat: index.format,
    protocol: retrieval.protocol,
  };

  return {
    target: description.target,
    evidence: resolvedEvidence,
    retrieval: {
      ...retrievalProfile,
      profileDigest: retrievalProfileDigest,
      compatibility,
      compatibilityDigest: stableHash(compatibility),
    },
  };
}

export function resolveEvidenceProfile(host: DkbProviderHost): DkbResolvedEvidenceProfile {
  const description = host.describe();
  const target = host.config.target;
  const evidenceProviderKinds = target.evidence
    ? new Set(['evidence'])
    : new Set(['parser', 'chunker']);
  const evidenceProviders = description.providers
    .filter((provider) => evidenceProviderKinds.has(provider.kind));
  const processors = [...description.processors];
  const evidenceProfile = {
    format: DKB_EVIDENCE_PROFILE_FORMAT as typeof DKB_EVIDENCE_PROFILE_FORMAT,
    schema: DKB_EVIDENCE_IR_FORMAT as typeof DKB_EVIDENCE_IR_FORMAT,
    evidence: {
      mode: target.evidence ? 'fused' as const : 'separate' as const,
      providers: evidenceProviders,
    },
    processors,
    options: selectedOptions(host, [
      ...evidenceProviders.map((provider) => provider.id),
      ...processors.map((processor) => processor.id),
    ]),
  };
  const evidenceProfileDigest = stableHash({
    ...evidenceProfile,
    evidence: {
      ...evidenceProfile.evidence,
      providers: evidenceProviders.map(profileIdentity),
    },
    processors: processors.map(profileIdentity),
  });
  return {
    ...evidenceProfile,
    profileDigest: evidenceProfileDigest,
  };
}

function selectedOptions(host: DkbProviderHost, ids: readonly string[]): Record<string, Record<string, unknown>> {
  return Object.fromEntries([...new Set(ids)].sort().map((id) => [id, { ...host.profileOptionsFor(id) }]));
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

function profileIdentity<T extends { source: unknown; sourcePath: unknown }>(description: T): Omit<T, 'source' | 'sourcePath'> {
  const { source: _source, sourcePath: _sourcePath, ...identity } = description;
  return identity;
}
