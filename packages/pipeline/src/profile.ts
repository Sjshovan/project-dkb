import fs from 'node:fs/promises';
import path from 'node:path';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { resolveFrom } from '@sjshovan/dkb-protocol/paths.js';
import {
  DKB_RETRIEVAL_PROFILE_FORMAT,
  DKB_RETRIEVAL_PROFILE_LOCK_PATH,
  validateRetrievalProfileLock,
  type DkbRetrievalCompatibilityReceipt,
  type DkbRetrievalProfileLock,
} from '@sjshovan/dkb-protocol/retrievalProfile.js';
import type { DkbProviderHost, DkbProviderHostDescription } from './host.js';
import type { DkbEmbeddingProvider, DkbIndexProvider, DkbRetrievalPipeline, DkbRetrievalProvider } from './types.js';
import { resolveBuildProfiles } from './buildProfiles.js';

export {
  DKB_RETRIEVAL_PROFILE_FORMAT,
  DKB_RETRIEVAL_PROFILE_LOCK_PATH,
  assertMatchingRetrievalProfiles,
  validateRetrievalProfileLock,
} from '@sjshovan/dkb-protocol/retrievalProfile.js';
export type {
  DkbRetrievalCompatibilityReceipt,
  DkbRetrievalProfileLock,
} from '@sjshovan/dkb-protocol/retrievalProfile.js';

export interface DkbResolvedRetrievalProfile {
  target: string;
  evidenceProfileDigest: string;
  retrievalProfileDigest: string;
  configDigest: string;
  providerBuildDigest: string;
  providers: DkbProviderHostDescription['providers'];
  processors: DkbProviderHostDescription['processors'];
  indexMode: DkbIndexProvider['mode'];
  embedding?: {
    provider: string;
    space: string;
    dimensions: number;
    queryMode: string;
    documentMode: string;
  };
  compatibility: DkbRetrievalCompatibilityReceipt;
}

export async function resolveProviderRetrievalProfile(host: DkbProviderHost): Promise<DkbResolvedRetrievalProfile> {
  host.assertRequiredExternalIdentities();
  const description = host.describe();
  const target = host.config.target;
  const index = host.provider<DkbIndexProvider>('index');
  const builds = await resolveBuildProfiles(host);
  const embedding = target.embedding && builds.retrieval.embedding ? {
    provider: target.embedding,
    space: builds.retrieval.embedding.space,
    dimensions: builds.retrieval.embedding.dimensions,
    queryMode: builds.retrieval.embedding.queryMode,
    documentMode: builds.retrieval.embedding.documentMode,
  } : undefined;

  return {
    target: description.target,
    evidenceProfileDigest: builds.evidence.profileDigest,
    retrievalProfileDigest: builds.retrieval.profileDigest,
    configDigest: description.configDigest,
    providerBuildDigest: description.buildDigest,
    providers: description.providers,
    processors: description.processors,
    indexMode: index.mode,
    ...(embedding ? { embedding } : {}),
    compatibility: builds.retrieval.compatibility,
  };
}

export function retrievalProfileLockForRetrievalPipelines(
  desired: DkbResolvedRetrievalProfile,
  results: readonly DkbRetrievalPipeline[],
  options: {
    generatedAt?: string;
  } = {},
): DkbRetrievalProfileLock {
  if (results.length === 0) {
    throw new DkbError('A retrieval profile lock requires at least one compiler result');
  }

  for (const result of results) {
    if (!desired.embedding) {
      if (result.vectors.length !== 0) throw new DkbError(`Lexical-only target ${desired.target} must not emit vectors`);
      continue;
    }
    if (result.vectors.length !== result.records.length) {
      throw new DkbError(`Retrieval pipeline vector count mismatch: expected ${result.records.length}, got ${result.vectors.length}`);
    }
    const recordIds = new Set(result.records.map((record) => record.id));
    const vectorIds = new Set(result.vectors.map((vector) => vector.evidenceId));
    if (recordIds.size !== result.records.length || vectorIds.size !== result.vectors.length
      || [...recordIds].some((id) => !vectorIds.has(id))) {
      throw new DkbError('Retrieval pipeline vectors must map one-to-one to exact Evidence record IDs');
    }
    const dimensions = result.vectors[0]?.values.length ?? 0;

    if (dimensions !== desired.embedding.dimensions
      || result.vectors.some((vector) => vector.values.length !== dimensions
        || vector.values.some((value) => typeof value !== 'number' || !Number.isFinite(value)))) {
      throw new DkbError(`Embedding dimension mismatch for ${desired.embedding.space}: expected ${desired.embedding.dimensions}, got ${dimensions}`);
    }
  }

  const evidence = desired.providers.find((provider) => provider.kind === 'evidence');
  const parser = desired.providers.find((provider) => provider.kind === 'parser');
  const chunker = desired.providers.find((provider) => provider.kind === 'chunker');
  const index = desired.providers.find((provider) => provider.kind === 'index');
  const retrieval = desired.providers.find((provider) => provider.kind === 'retrieval');
  if ((!evidence && (!parser || !chunker)) || !index || !retrieval) {
    throw new DkbError(`Resolved target ${desired.target} is missing required provider receipts`);
  }
  const evidenceProviders = desired.providers.filter((provider) => provider.kind === 'evidence'
    || provider.kind === 'parser'
    || provider.kind === 'chunker');
  const retrievalProviders = desired.providers.filter((provider) => provider.kind === 'embedding'
    || provider.kind === 'index'
    || provider.kind === 'retrieval');

  const profile: DkbRetrievalProfileLock['profile'] = {
    ...(desired.embedding ? { embedding: {
      provider: desired.embedding.provider,
      space: desired.embedding.space,
      ...(desired.compatibility.modelRevision ? { modelRevision: desired.compatibility.modelRevision } : {}),
      dimensions: desired.embedding.dimensions,
      metric: requiredCompatibilityString(desired.compatibility.metric, 'metric'),
      normalized: requiredCompatibilityBoolean(desired.compatibility.normalized, 'normalized'),
      queryMode: desired.embedding.queryMode,
      documentMode: desired.embedding.documentMode,
      queryTransformDigest: requiredCompatibilityString(desired.compatibility.queryTransformDigest, 'queryTransformDigest'),
      documentTransformDigest: requiredCompatibilityString(desired.compatibility.documentTransformDigest, 'documentTransformDigest'),
    } } : {}),
    evidence: {
      profileDigest: desired.evidenceProfileDigest,
      providers: evidenceProviders,
      processors: desired.processors,
    },
    target: desired.target,
    configDigest: desired.configDigest,
    providerBuildDigest: desired.providerBuildDigest,
    index: {
      provider: index.id,
      mode: desired.indexMode,
      format: desired.compatibility.indexFormat,
    },
    retrieval: {
      provider: retrieval.id,
      protocol: desired.compatibility.protocol,
      profileDigest: desired.retrievalProfileDigest,
      providers: retrievalProviders,
    },
  };

  const buildDigest = stableHash(profile);
  const compatibility = desired.compatibility;
  const compatibilityDigest = stableHash(compatibility);

  return validateRetrievalProfileLock({
    format: DKB_RETRIEVAL_PROFILE_FORMAT,
    profile,
    buildDigest,
    compatibility,
    compatibilityDigest,
    profileDigest: desired.retrievalProfileDigest,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
  });
}

function requiredCompatibilityString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new DkbError(`Retrieval compatibility ${label} must be a non-empty string`);
  return value;
}

function requiredCompatibilityBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new DkbError(`Retrieval compatibility ${label} must be a boolean`);
  return value;
}

export async function readRetrievalProfileLock(root: string): Promise<DkbRetrievalProfileLock> {
  const target = resolveFrom(root, DKB_RETRIEVAL_PROFILE_LOCK_PATH);
  const parsed = JSON.parse(await fs.readFile(target, 'utf8')) as unknown;

  return validateRetrievalProfileLock(parsed, target);
}
