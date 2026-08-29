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
import type { DkbCompiledPipeline, DkbEmbeddingProvider, DkbIndexProvider, DkbRetrievalProvider } from './types.js';
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
  compiler: string;
  indexMode: DkbIndexProvider['mode'];
  embedding: {
    adapter: string;
    model: string;
    dimensions: number;
  };
  compatibility: DkbRetrievalCompatibilityReceipt;
}

export async function resolveProviderRetrievalProfile(host: DkbProviderHost): Promise<DkbResolvedRetrievalProfile> {
  const description = host.describe();
  const target = host.config.target;
  const index = host.provider<DkbIndexProvider>('index');
  const builds = await resolveBuildProfiles(host);
  const model = builds.retrieval.embedding.space;
  const dimensions = builds.retrieval.embedding.dimensions;

  return {
    target: description.target,
    evidenceProfileDigest: builds.evidence.profileDigest,
    retrievalProfileDigest: builds.retrieval.profileDigest,
    configDigest: description.configDigest,
    providerBuildDigest: description.buildDigest,
    providers: description.providers,
    processors: description.processors,
    compiler: target.evidence ?? (target.parser === target.chunker ? target.parser! : `${target.parser}+${target.chunker}`),
    indexMode: index.mode,
    embedding: { adapter: target.embedding, model, dimensions },
    compatibility: builds.retrieval.compatibility,
  };
}

export function retrievalProfileLockForCompiledPipelines(
  desired: DkbResolvedRetrievalProfile,
  results: readonly DkbCompiledPipeline[],
  options: {
    compilerImageDigest?: string | null;
    modelRevision?: string | null;
    modelDigest?: string | null;
    generatedAt?: string;
  } = {},
): DkbRetrievalProfileLock {
  if (results.length === 0) {
    throw new DkbError('A retrieval profile lock requires at least one compiler result');
  }

  for (const result of results) {
    const dimensions = result.records.find((record) => (record.embedding?.length ?? 0) > 0)?.embedding?.length ?? 0;

    if (dimensions !== desired.embedding.dimensions) {
      throw new DkbError(`Embedding dimension mismatch for ${desired.embedding.model}: expected ${desired.embedding.dimensions}, got ${dimensions}`);
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
  const parserId = evidence?.id ?? parser?.id ?? desired.compiler;
  const chunkerId = evidence?.id ?? chunker?.id ?? desired.compiler;
  const evidenceImplementation = evidence ?? parser!;

  const profile: DkbRetrievalProfileLock['profile'] = {
    compiler: {
      adapter: desired.compiler,
      id: evidenceImplementation.id,
      image: evidenceImplementation.sourcePath,
      imageDigest: options.compilerImageDigest ?? evidenceImplementation.sourceDigest,
    },
    embedding: {
      adapter: desired.embedding.adapter,
      model: desired.embedding.model,
      modelRevision: options.modelRevision ?? desired.compatibility.modelRevision ?? null,
      modelDigest: options.modelDigest ?? null,
      dimensions: desired.embedding.dimensions,
      metric: desired.compatibility.metric,
      normalized: desired.compatibility.normalized,
      queryMode: 'query',
      documentMode: 'passage',
    },
    extraction: {
      richParser: parserId,
      richChunker: chunkerId,
      fallbackParser: parserId,
      fallbackChunker: chunkerId,
    },
    evidence: {
      profileDigest: desired.evidenceProfileDigest,
    },
    target: desired.target,
    configDigest: desired.configDigest,
    providerBuildDigest: desired.providerBuildDigest,
    providers: desired.providers,
    processors: desired.processors,
    index: {
      provider: index.id,
      mode: desired.indexMode,
      format: desired.compatibility.indexFormat,
    },
    retrieval: {
      provider: retrieval.id,
      protocol: desired.compatibility.protocol,
      profileDigest: desired.retrievalProfileDigest,
    },
  };

  const buildDigest = stableHash(profile);
  const compatibility = desired.compatibility;
  const compatibilityDigest = stableHash(compatibility);

  return {
    format: DKB_RETRIEVAL_PROFILE_FORMAT,
    profile,
    buildDigest,
    compatibility,
    compatibilityDigest,
    profileDigest: desired.retrievalProfileDigest,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
  };
}

export async function readRetrievalProfileLock(root: string): Promise<DkbRetrievalProfileLock> {
  const target = resolveFrom(root, DKB_RETRIEVAL_PROFILE_LOCK_PATH);
  const parsed = JSON.parse(await fs.readFile(target, 'utf8')) as unknown;

  return validateRetrievalProfileLock(parsed, target);
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DkbError(`${label} must be a non-empty string`);
  }
  return value;
}

function positiveIntegerValue(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new DkbError(`${label} must be a positive integer`);
  }
  return Number(value);
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new DkbError(`${label} must be a boolean`);
  }
  return value;
}
