import type { LoadedDkb } from '@sjshovan/dkb-protocol/types.js';
import type { DkbEvidenceIr } from '@sjshovan/dkb-protocol/evidence/ir.js';
import type { DkbRetrievalProfileLock, DkbResolvedRetrievalProfile } from '@sjshovan/dkb-pipeline/profile.js';
import type { DkbRetrievalPipeline } from '@sjshovan/dkb-pipeline/types.js';
import type { DkbProviderHost } from '@sjshovan/dkb-pipeline/host.js';
import type { DkbLockManifest } from '@sjshovan/dkb-protocol/types.js';
import type { DkbCorpusStatistics } from './buildStatistics.js';
import type { DkbDiskCapacityCheck } from './diskCapacity.js';
import type { IndexedSourceUnit } from '@sjshovan/dkb-pipeline/types.js';

export interface AtomicCompileArtifactTimings {
  stagePrepare: number;
  retrievalArtifacts: number;
  lock: number;
  buildGraph: number;
  validation: number;
  promotion: number;
  cleanup: number;
  total: number;
}

export interface CompilerArtifactState {
  dkb: LoadedDkb;
  dkbRoot: string;
  compiled: DkbRetrievalPipeline;
  evidence: DkbEvidenceIr;
  corpus: DkbCorpusStatistics;
  diskCapacity: DkbDiskCapacityCheck;
}

export interface RegistryCompileState {
  sourceUnits: IndexedSourceUnit[];
  packages: DkbLockManifest['packages'];
  /**
   * Exact immutable source-release digest supplied by a trusted Registry job.
   * Editable local compilation omits this and derives a canonical source
   * digest from the manifest and source inventory instead.
   */
  packageSourceDigest?: string;
  compilerArtifacts: CompilerArtifactState[];
  retrievalProfileLock?: DkbRetrievalProfileLock;
  resolvedProfile?: DkbResolvedRetrievalProfile;
  providerHost?: DkbProviderHost;
}
