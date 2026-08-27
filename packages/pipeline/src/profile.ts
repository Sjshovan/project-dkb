import fs from 'node:fs/promises';
import path from 'node:path';
import { stableHash } from '@dkb/protocol/contracts/hash.js';
import { DkbError } from '@dkb/protocol/errors.js';
import { resolveFrom } from '@dkb/protocol/paths.js';
import type { DkbProviderHost, DkbProviderHostDescription } from './host.js';
import type { DkbEmbeddingProvider, DkbIndexProvider, DkbRetrievalProvider } from './types.js';

const DEFAULT_INDEX_PROVIDER_ID = '@dkb/faiss';
const DEFAULT_RETRIEVAL_PROVIDER_ID = '@dkb/hybrid';

export interface DkbCompilerProfileResult {
  compiler: {
    id: string;
    image: string;
    model: string;
  };
  records: ReadonlyArray<{
    embedding: ArrayLike<number>;
  }>;
}

export const DKB_RETRIEVAL_PROFILE_LOCK_PATH = 'dkb-profile.lock.json';
export const DKB_RETRIEVAL_PROFILE_FORMAT = 'dkb.retrieval-profile.v2';

export interface DkbResolvedRetrievalProfile {
  target: string;
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
  compatibility: {
    embeddingSpace: string;
    dimensions: number;
    metric: string;
    normalized: boolean;
    indexFormat: string;
    protocol: string;
  };
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
    target: string;
    configDigest: string;
    providerBuildDigest: string;
    providers: DkbProviderHostDescription['providers'];
    processors: DkbProviderHostDescription['processors'];
    index: {
      provider: string;
      mode: 'packaged' | 'managed';
      format: string;
    };
    retrieval: {
      provider: string;
      protocol: string;
    };
  };
  buildDigest: string;
  compatibility: DkbResolvedRetrievalProfile['compatibility'];
  compatibilityDigest: string;
  profileDigest: string;
  generatedAt: string;
}

export async function resolveProviderRetrievalProfile(host: DkbProviderHost): Promise<DkbResolvedRetrievalProfile> {
  const description = host.describe();
  const target = host.config.target;
  const embedding = host.provider<DkbEmbeddingProvider>('embedding');
  const index = host.provider<DkbIndexProvider>('index');
  const retrieval = host.provider<DkbRetrievalProvider>('retrieval');
  const rawCompatibility = await embedding.compatibility(host.optionsFor(target.embedding));
  const model = stringValue(rawCompatibility.embeddingSpace, `${target.embedding} compatibility embeddingSpace`);
  const dimensions = positiveIntegerValue(rawCompatibility.dimensions, `${target.embedding} compatibility dimensions`);
  const metric = stringValue(rawCompatibility.metric, `${target.embedding} compatibility metric`);
  const normalized = booleanValue(rawCompatibility.normalized, `${target.embedding} compatibility normalized`);
  const indexFormat = index.format;
  const protocol = retrieval.protocol;

  return {
    target: description.target,
    configDigest: description.configDigest,
    providerBuildDigest: description.buildDigest,
    providers: description.providers,
    processors: description.processors,
    compiler: target.ingestion ?? `${target.parser}+${target.chunker}`,
    indexMode: index.mode,
    embedding: { adapter: target.embedding, model, dimensions },
    compatibility: { embeddingSpace: model, dimensions, metric, normalized, indexFormat, protocol },
  };
}

export function retrievalProfileLockForCompilerResults(
  desired: DkbResolvedRetrievalProfile,
  results: readonly DkbCompilerProfileResult[],
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
    const dimensions = result.records.find((record) => record.embedding.length > 0)?.embedding.length ?? 0;

    if (result.compiler.model !== desired.embedding.model) {
      throw new DkbError(`Compiler model mismatch: expected ${desired.embedding.model}, got ${result.compiler.model}`);
    }
    if (dimensions !== desired.embedding.dimensions) {
      throw new DkbError(`Compiler dimension mismatch for ${result.compiler.model}: expected ${desired.embedding.dimensions}, got ${dimensions}`);
    }
  }

  const compilerImages = [...new Set(results.map((result) => result.compiler.image))];
  const compilerIds = [...new Set(results.map((result) => result.compiler.id))];

  if (compilerImages.length !== 1 || compilerIds.length !== 1) {
    throw new DkbError(`Compiler implementation mismatch across packages: ${compilerIds.join(', ')} / ${compilerImages.join(', ')}`);
  }
  const ingestion = desired.providers.find((provider) => provider.kind === 'ingestion');
  const parser = desired.providers.find((provider) => provider.kind === 'parser');
  const chunker = desired.providers.find((provider) => provider.kind === 'chunker');
  const parserId = ingestion?.id ?? parser?.id ?? desired.compiler;
  const chunkerId = ingestion?.id ?? chunker?.id ?? desired.compiler;

  const profile: DkbRetrievalProfileLock['profile'] = {
    compiler: {
      adapter: desired.compiler,
      id: compilerIds[0] ?? desired.compiler,
      image: compilerImages[0] ?? `plugin:${desired.compiler}`,
      imageDigest: options.compilerImageDigest ?? null,
    },
    embedding: {
      adapter: desired.embedding.adapter,
      model: desired.embedding.model,
      modelRevision: options.modelRevision ?? null,
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
    target: desired.target,
    configDigest: desired.configDigest,
    providerBuildDigest: desired.providerBuildDigest,
    providers: desired.providers,
    processors: desired.processors,
    index: {
      provider: desired.providers.find((provider) => provider.kind === 'index')?.id ?? DEFAULT_INDEX_PROVIDER_ID,
      mode: desired.indexMode,
      format: desired.compatibility.indexFormat,
    },
    retrieval: {
      provider: desired.providers.find((provider) => provider.kind === 'retrieval')?.id ?? DEFAULT_RETRIEVAL_PROVIDER_ID,
      protocol: desired.compatibility.protocol,
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
    profileDigest: compatibilityDigest,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
  };
}

export async function writeRetrievalProfileLock(root: string, lock: DkbRetrievalProfileLock): Promise<void> {
  validateRetrievalProfileLock(lock, DKB_RETRIEVAL_PROFILE_LOCK_PATH);
  const target = resolveFrom(root, DKB_RETRIEVAL_PROFILE_LOCK_PATH);
  const temp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temp, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  await fs.rm(target, { force: true });
  await fs.rename(temp, target);
}

export async function readRetrievalProfileLock(root: string): Promise<DkbRetrievalProfileLock> {
  const target = resolveFrom(root, DKB_RETRIEVAL_PROFILE_LOCK_PATH);
  const parsed = JSON.parse(await fs.readFile(target, 'utf8')) as unknown;

  return validateRetrievalProfileLock(parsed, target);
}

export async function maybeReadRetrievalProfileLock(root: string): Promise<DkbRetrievalProfileLock | null> {
  try {
    return await readRetrievalProfileLock(root);
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '';

    if (code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export function validateRetrievalProfileLock(value: unknown, source = DKB_RETRIEVAL_PROFILE_LOCK_PATH): DkbRetrievalProfileLock {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: expected object`);
  }

  const candidate = value as Partial<DkbRetrievalProfileLock>;
  const profile = candidate.profile;

  if (candidate.format !== DKB_RETRIEVAL_PROFILE_FORMAT || !profile || typeof candidate.profileDigest !== 'string') {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: unsupported format or missing profile`);
  }
  if (!profile.compiler || !profile.embedding || !profile.extraction) {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: incomplete profile`);
  }
  if (!Number.isInteger(profile.embedding.dimensions) || profile.embedding.dimensions <= 0) {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: dimensions must be a positive integer`);
  }

  if (!candidate.compatibility || typeof candidate.buildDigest !== 'string' || typeof candidate.compatibilityDigest !== 'string') {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: missing build or compatibility receipt`);
  }
  const actualBuildDigest = stableHash(profile);
  const compatibilityDigest = stableHash(candidate.compatibility);

  if (candidate.compatibilityDigest !== compatibilityDigest) {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: expected digest ${compatibilityDigest}, got ${candidate.compatibilityDigest}`);
  }
  if (candidate.profileDigest !== compatibilityDigest) {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: expected digest ${compatibilityDigest}, got ${candidate.profileDigest}`);
  }
  if (candidate.buildDigest !== actualBuildDigest) {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: expected build digest ${actualBuildDigest}, got ${candidate.buildDigest}`);
  }

  return candidate as DkbRetrievalProfileLock;
}

export function assertMatchingRetrievalProfiles(expected: DkbRetrievalProfileLock, actual: DkbRetrievalProfileLock, label = 'package'): void {
  if (expected.compatibilityDigest !== actual.compatibilityDigest) {
    throw new DkbError(
      `Retrieval profile mismatch for ${label}: registry uses ${expected.profile.embedding.model}/${expected.profile.embedding.dimensions} (${expected.profileDigest}), package uses ${actual.profile.embedding.model}/${actual.profile.embedding.dimensions} (${actual.profileDigest})`,
    );
  }
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
