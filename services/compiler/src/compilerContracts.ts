import type { DkbLockManifest } from '@sjshovan/dkb-protocol/types.js';
import type { DkbEvidenceBuildLock } from '@sjshovan/dkb-protocol/builds.js';
import type { DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import type { DkbBuildStorageStatistics, DkbCorpusStatistics } from './buildStatistics.js';
import type { DkbDiskCapacityCheck } from './diskCapacity.js';
import type { AtomicCompileArtifactTimings } from './compilerState.js';

export interface CompiledComposeProject {
  type: 'package';
  registryId: string;
  recordCount: number;
  evidenceCatalogPath: string;
  retrievalManifestPath: string;
  retrievalBuildPath: string;
  lockPath: string;
  lock: DkbLockManifest;
  cacheHit: boolean;
  profile?: CompileComposeProfile;
}

export interface CompiledLibraryProject {
  type: 'library';
  libraryId: string;
  root: string;
  packageCount: number;
  registryPackageCount: number;
  recordCount: number;
  cacheHit: boolean;
  packages: Array<{
    id: string;
    version: string;
    root: string;
    recordCount: number;
    cacheHit: boolean;
    retrievalBuildPath: string;
    lockPath: string;
  }>;
  registryPackages: Array<{
    id: string;
    version: string;
    root: string;
    status: 'retained';
  }>;
}

export type CompiledKnowledgeTarget = CompiledComposeProject | CompiledLibraryProject;

export interface CompileComposeProfile {
  timingsMs: {
    sourceSnapshot: number;
    cacheLookup: number;
    collectState: number;
    aggregateArtifacts: number;
    compileCacheWrite: number;
    total: number;
  };
  aggregateTimingsMs?: AtomicCompileArtifactTimings;
  statistics?: {
    corpus: DkbCorpusStatistics;
    storage: DkbBuildStorageStatistics;
    diskCapacity: {
      ingestion?: DkbDiskCapacityCheck;
      retrieval: DkbDiskCapacityCheck[];
    };
    providerStages: Array<{
      packageId: string;
      ingestionTimingsMs?: Record<string, number>;
      ingestionWrapperTimingsMs?: Record<string, number>;
      embeddingTimingsMs?: Record<string, number>;
    }>;
  };
}

export interface PreparedPackageBuildTarget {
  target: string;
  preparation: 'retained' | 'retrieval_compiled' | 'evidence_compiled';
  evidenceProfileDigest: string;
  retrievalProfileDigest: string;
}

export interface CompileComposeProjectOptions {
  distribution: DkbDistribution;
  signal?: AbortSignal;
  force?: boolean;
  target?: string;
  contextRoot?: string;
  targetOptions?: Record<string, Record<string, unknown>>;
  /** Trusted immutable source-release digest for Registry compilation. */
  sourceDigest?: string;
}

export interface CompileRetrievalFromEvidenceOptions {
  distribution: DkbDistribution;
  signal?: AbortSignal;
  target: string;
  contextRoot?: string;
  libraryRoot?: string;
  targetOptions?: Record<string, Record<string, unknown>>;
  /** Trusted immutable source-release digest for Registry compilation. */
  sourceDigest?: string;
  /** Exact validated parent receipt when Evidence is provided outside this package root. */
  evidenceLock?: DkbEvidenceBuildLock;
}

export interface VerifyComposeProjectResult {
  ok: boolean;
  lockPath: string;
  checks: Array<{
    name: string;
    ok: boolean;
    detail: string;
  }>;
}
