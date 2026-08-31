import type { DkbLockManifest } from '@sjshovan/dkb-protocol/types.js';
import type { DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import type { DkbBuildStorageStatistics, DkbCorpusStatistics } from './buildStatistics.js';
import type { DkbDiskCapacityCheck } from './diskCapacity.js';
import type { AtomicCompileArtifactTimings } from './compilerState.js';

export interface CompiledCollection {
  id: string;
  name: string;
  version: string;
  dkbs: Array<{
    id: string;
    name: string;
    version: string;
    adapter: string;
    records: number;
  }>;
  recordCount: number;
}

export interface CompiledComposeProject {
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
  force?: boolean;
  mode?: 'library' | 'package';
  target?: string;
  contextRoot?: string;
}

export interface CompileRetrievalFromEvidenceOptions {
  distribution: DkbDistribution;
  target: string;
  contextRoot?: string;
  libraryRoot?: string;
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
