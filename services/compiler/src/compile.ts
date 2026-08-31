import { DEFAULT_DKB_DISTRIBUTION } from '@sjshovan/dkb-distribution-default';
import type { DkbEvidenceIr } from '@sjshovan/dkb-protocol/evidence/ir.js';
import {
  compileComposeProject as compileComposeProjectCore,
  compileRetrievalFromEvidence as compileRetrievalFromEvidenceCore,
  ensurePackageBuildForTarget as ensurePackageBuildForTargetCore,
} from './compilerCore.js';

export {
  COMPILE_CACHE_PATH,
  COMPILE_LOCK_PATH,
  COMPILE_RECEIPT_PATH,
  compileCollection,
  verifyComposeProject,
} from './compilerCore.js';
export type {
  CompiledCollection,
  CompiledComposeProject,
  CompileComposeProfile,
  PreparedPackageBuildTarget,
  VerifyComposeProjectResult,
} from './compilerCore.js';

export interface CompileComposeProjectOptions {
  force?: boolean;
  mode?: 'library' | 'package';
  target?: string;
  contextRoot?: string;
}

export interface CompileRetrievalFromEvidenceOptions {
  target: string;
  contextRoot?: string;
}

export async function compileComposeProject(root: string, options: CompileComposeProjectOptions = {}) {
  return compileComposeProjectCore(root, {
    ...options,
    distribution: DEFAULT_DKB_DISTRIBUTION,
  });
}

export async function compileRetrievalFromEvidence(
  root: string,
  evidence: DkbEvidenceIr,
  options: CompileRetrievalFromEvidenceOptions,
) {
  return compileRetrievalFromEvidenceCore(root, evidence, {
    ...options,
    distribution: DEFAULT_DKB_DISTRIBUTION,
  });
}

export async function ensurePackageBuildForTarget(
  root: string,
  options: { target: string; contextRoot?: string; libraryRoot?: string },
) {
  return ensurePackageBuildForTargetCore(root, {
    ...options,
    distribution: DEFAULT_DKB_DISTRIBUTION,
  });
}
