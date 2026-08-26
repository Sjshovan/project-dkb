import fs from 'node:fs/promises';
import path from 'node:path';
import { stableHash } from '../contracts/hash.js';
import { DkbError } from '../protocol/errors.js';
import { resolveFrom } from '../protocol/paths.js';
import type { DkbRetrievalProfileConfig, LoadedLibrary } from '../protocol/types.js';
import type { DkbProviderHost, DkbProviderHostDescription } from '../providers/host.js';
import type { DkbEmbeddingProvider } from '../providers/types.js';
import { DKB_FAISS_PLUGIN_ID, DKB_FASTEMBED_PLUGIN_ID, DKB_HYBRID_RETRIEVAL_PLUGIN_ID, DKB_LLAMA_INDEX_PLUGIN_ID } from '../providers/bundled.js';
import {
  LLAMAINDEX_COMPILER_ID,
  LLAMAINDEX_COMPILER_IMAGE,
  type LlamaIndexCompilerResult,
} from '../compiler/llamaindex.js';

export const DKB_RETRIEVAL_PROFILE_LOCK_PATH = 'dkb-profile.lock.json';
export const DKB_RETRIEVAL_PROFILE_FORMAT = 'dkb.retrieval-profile.v2';
export const DEFAULT_EMBEDDING_MODEL = 'BAAI/bge-small-en-v1.5';

const SUPPORTED_FASTEMBED_MODELS: Record<string, number> = {
  'BAAI/bge-small-en-v1.5': 384,
  'BAAI/bge-base-en-v1.5': 768,
};

export interface DkbResolvedRetrievalProfile {
  target: string;
  configDigest: string;
  providerBuildDigest: string;
  providers: DkbProviderHostDescription['providers'];
  processors: DkbProviderHostDescription['processors'];
  compiler: string;
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
      metric: 'cosine';
      normalized: true;
      queryMode: 'query';
      documentMode: 'passage';
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

export function resolveLibraryRetrievalProfile(library: LoadedLibrary, overrideModel?: string): DkbResolvedRetrievalProfile {
  void library;
  return resolveRetrievalProfile(undefined, overrideModel);
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
    throw new DkbError(`Embedding model ${model} is not registered. Set positive dimensions in the selected embedding provider options.`);
  }
  if (knownDimensions && configuredDimensions && configuredDimensions !== knownDimensions) {
    throw new DkbError(`Embedding model ${model} requires ${knownDimensions} dimensions, not ${configuredDimensions}`);
  }

  return {
    target: 'default',
    configDigest: stableHash({ model, dimensions }),
    providerBuildDigest: stableHash({
      ingestion: DKB_LLAMA_INDEX_PLUGIN_ID,
      embedding: DKB_FASTEMBED_PLUGIN_ID,
      index: DKB_FAISS_PLUGIN_ID,
      retrieval: DKB_HYBRID_RETRIEVAL_PLUGIN_ID,
    }),
    providers: [],
    processors: [],
    compiler,
    embedding: {
      adapter,
      model,
      dimensions,
    },
    compatibility: {
      embeddingSpace: model,
      dimensions,
      metric: 'cosine',
      normalized: true,
      indexFormat: 'IndexIDMap2(IndexFlatIP)',
      protocol: 'dkb.evidence.v1',
    },
  };
}

export async function resolveProviderRetrievalProfile(host: DkbProviderHost): Promise<DkbResolvedRetrievalProfile> {
  const description = host.describe();
  const target = host.config.target;
  const embedding = host.provider<DkbEmbeddingProvider>('embedding');
  const rawCompatibility = await embedding.compatibility(host.optionsFor(target.embedding));
  const model = stringValue(rawCompatibility.embeddingSpace, `${target.embedding} compatibility embeddingSpace`);
  const dimensions = positiveIntegerValue(rawCompatibility.dimensions, `${target.embedding} compatibility dimensions`);
  const metric = stringValue(rawCompatibility.metric, `${target.embedding} compatibility metric`);
  const normalized = booleanValue(rawCompatibility.normalized, `${target.embedding} compatibility normalized`);
  const indexFormat = target.index === DKB_FAISS_PLUGIN_ID ? 'IndexIDMap2(IndexFlatIP)' : stringValue(rawCompatibility.indexFormat, `${target.index} compatibility indexFormat`);
  const protocol = typeof rawCompatibility.protocol === 'string' ? rawCompatibility.protocol : 'dkb.evidence.v1';

  return {
    target: description.target,
    configDigest: description.configDigest,
    providerBuildDigest: description.buildDigest,
    providers: description.providers,
    processors: description.processors,
    compiler: target.ingestion ?? `${target.parser}+${target.chunker}`,
    embedding: { adapter: target.embedding, model, dimensions },
    compatibility: { embeddingSpace: model, dimensions, metric, normalized, indexFormat, protocol },
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
      adapter: desired.compiler,
      id: LLAMAINDEX_COMPILER_ID,
      image: compilerImages[0] ?? LLAMAINDEX_COMPILER_IMAGE,
      imageDigest: options.compilerImageDigest ?? null,
    },
    embedding: {
      adapter: desired.embedding.adapter,
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
    target: desired.target,
    configDigest: desired.configDigest,
    providerBuildDigest: desired.providerBuildDigest,
    providers: desired.providers,
    processors: desired.processors,
    index: {
      provider: desired.providers.find((provider) => provider.kind === 'index')?.id ?? DKB_FAISS_PLUGIN_ID,
      mode: desired.providers.find((provider) => provider.kind === 'index')?.id === '@dkb/meilisearch' ? 'managed' : 'packaged',
      format: desired.compatibility.indexFormat,
    },
    retrieval: {
      provider: desired.providers.find((provider) => provider.kind === 'retrieval')?.id ?? DKB_HYBRID_RETRIEVAL_PLUGIN_ID,
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

export function supportedRetrievalModels(): Array<{ model: string; dimensions: number }> {
  return Object.entries(SUPPORTED_FASTEMBED_MODELS)
    .map(([model, dimensions]) => ({ model, dimensions }))
    .sort((left, right) => left.model.localeCompare(right.model));
}
