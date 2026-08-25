import fs from 'node:fs/promises';
import path from 'node:path';
import { stableHash } from '../contracts/hash.js';
import { DkbError } from '../protocol/errors.js';
import { resolveFrom } from '../protocol/paths.js';
import type { DkbRetrievalProfileConfig, LoadedRegistry } from '../protocol/types.js';
import {
  LLAMAINDEX_COMPILER_ID,
  LLAMAINDEX_COMPILER_IMAGE,
  type LlamaIndexCompilerResult,
} from '../compiler/llamaindex.js';

export const DKB_RETRIEVAL_PROFILE_LOCK_PATH = 'dkb-profile.lock.json';
export const DKB_RETRIEVAL_PROFILE_FORMAT = 'dkb.retrieval-profile.v1';
export const DEFAULT_EMBEDDING_MODEL = 'BAAI/bge-small-en-v1.5';

const SUPPORTED_FASTEMBED_MODELS: Record<string, number> = {
  'BAAI/bge-small-en-v1.5': 384,
  'BAAI/bge-base-en-v1.5': 768,
};

export interface DkbResolvedRetrievalProfile {
  compiler: 'llamaindex';
  embedding: {
    adapter: 'fastembed';
    model: string;
    dimensions: number;
  };
}

export interface DkbRetrievalProfileLock {
  format: typeof DKB_RETRIEVAL_PROFILE_FORMAT;
  profile: {
    compiler: {
      adapter: 'llamaindex';
      id: typeof LLAMAINDEX_COMPILER_ID;
      image: string;
      imageDigest: string | null;
    };
    embedding: {
      adapter: 'fastembed';
      model: string;
      modelRevision: string | null;
      modelDigest: string | null;
      dimensions: number;
      metric: 'cosine';
      normalized: true;
      queryMode: 'query';
      documentMode: 'passage';
    };
    extraction: {
      richParser: 'docling';
      richChunker: 'docling.hybrid';
      fallbackParser: 'llamaindex';
      fallbackChunker: 'llamaindex.sentence';
    };
  };
  profileDigest: string;
  generatedAt: string;
}

export function resolveRegistryRetrievalProfile(registry: LoadedRegistry, overrideModel?: string): DkbResolvedRetrievalProfile {
  return resolveRetrievalProfile(registry.manifest.retrievalProfile, overrideModel);
}

export function resolveRetrievalProfile(config?: DkbRetrievalProfileConfig, overrideModel?: string): DkbResolvedRetrievalProfile {
  const compiler = config?.compiler ?? 'llamaindex';
  const adapter = config?.embedding?.adapter ?? 'fastembed';
  const requestedOverride = overrideModel?.trim();
  const configuredModel = config?.embedding?.model?.trim();
  const model = requestedOverride || configuredModel || DEFAULT_EMBEDDING_MODEL;

  if (compiler !== 'llamaindex') {
    throw new DkbError(`Unsupported DKB retrieval compiler: ${compiler}`);
  }
  if (adapter !== 'fastembed') {
    throw new DkbError(`Unsupported DKB embedding adapter: ${adapter}`);
  }

  const knownDimensions = SUPPORTED_FASTEMBED_MODELS[model];
  const configuredDimensions = !requestedOverride || requestedOverride === configuredModel
    ? config?.embedding?.dimensions
    : undefined;
  const dimensions = configuredDimensions ?? knownDimensions;

  if (!dimensions || dimensions <= 0) {
    throw new DkbError(`Embedding model ${model} is not registered. Add its positive dimensions to retrievalProfile.embedding.dimensions before compiling.`);
  }
  if (knownDimensions && configuredDimensions && configuredDimensions !== knownDimensions) {
    throw new DkbError(`Embedding model ${model} requires ${knownDimensions} dimensions, not ${configuredDimensions}`);
  }

  return {
    compiler,
    embedding: {
      adapter,
      model,
      dimensions,
    },
  };
}

export function retrievalProfileLockForCompilerResults(
  desired: DkbResolvedRetrievalProfile,
  results: LlamaIndexCompilerResult[],
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

    if (result.compiler.id !== LLAMAINDEX_COMPILER_ID) {
      throw new DkbError(`Compiler profile mismatch: expected ${LLAMAINDEX_COMPILER_ID}, got ${result.compiler.id}`);
    }
    if (result.compiler.model !== desired.embedding.model) {
      throw new DkbError(`Compiler model mismatch: expected ${desired.embedding.model}, got ${result.compiler.model}`);
    }
    if (dimensions !== desired.embedding.dimensions) {
      throw new DkbError(`Compiler dimension mismatch for ${result.compiler.model}: expected ${desired.embedding.dimensions}, got ${dimensions}`);
    }
  }

  const compilerImages = [...new Set(results.map((result) => result.compiler.image))];

  if (compilerImages.length !== 1) {
    throw new DkbError(`Compiler image mismatch across packages: ${compilerImages.join(', ')}`);
  }

  const profile: DkbRetrievalProfileLock['profile'] = {
    compiler: {
      adapter: 'llamaindex',
      id: LLAMAINDEX_COMPILER_ID,
      image: compilerImages[0] ?? LLAMAINDEX_COMPILER_IMAGE,
      imageDigest: options.compilerImageDigest ?? null,
    },
    embedding: {
      adapter: 'fastembed',
      model: desired.embedding.model,
      modelRevision: options.modelRevision ?? null,
      modelDigest: options.modelDigest ?? null,
      dimensions: desired.embedding.dimensions,
      metric: 'cosine',
      normalized: true,
      queryMode: 'query',
      documentMode: 'passage',
    },
    extraction: {
      richParser: 'docling',
      richChunker: 'docling.hybrid',
      fallbackParser: 'llamaindex',
      fallbackChunker: 'llamaindex.sentence',
    },
  };

  return {
    format: DKB_RETRIEVAL_PROFILE_FORMAT,
    profile,
    profileDigest: stableHash(profile),
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

  const actualDigest = stableHash(profile);

  if (candidate.profileDigest !== actualDigest) {
    throw new DkbError(`Invalid retrieval profile lock at ${source}: expected digest ${actualDigest}, got ${candidate.profileDigest}`);
  }

  return candidate as DkbRetrievalProfileLock;
}

export function assertMatchingRetrievalProfiles(expected: DkbRetrievalProfileLock, actual: DkbRetrievalProfileLock, label = 'package'): void {
  if (expected.profileDigest !== actual.profileDigest) {
    throw new DkbError(
      `Retrieval profile mismatch for ${label}: registry uses ${expected.profile.embedding.model}/${expected.profile.embedding.dimensions} (${expected.profileDigest}), package uses ${actual.profile.embedding.model}/${actual.profile.embedding.dimensions} (${actual.profileDigest})`,
    );
  }
}

export function supportedRetrievalModels(): Array<{ model: string; dimensions: number }> {
  return Object.entries(SUPPORTED_FASTEMBED_MODELS)
    .map(([model, dimensions]) => ({ model, dimensions }))
    .sort((left, right) => left.model.localeCompare(right.model));
}
