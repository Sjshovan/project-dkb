import { DEFAULT_DKB_DISTRIBUTION } from '@sjshovan/dkb-distribution-default';
import type { DkbEvidenceIr } from '@sjshovan/dkb-protocol/evidence/ir.js';
import {
  compileComposeProject as compileComposeProjectCore,
  compileKnowledgeTarget as compileKnowledgeTargetCore,
  compileRetrievalFromEvidence as compileRetrievalFromEvidenceCore,
  ensurePackageBuildForTarget as ensurePackageBuildForTargetCore,
} from './compilerCore.js';

export {
  COMPILE_CACHE_PATH,
  COMPILE_LOCK_PATH,
  COMPILE_RECEIPT_PATH,
  verifyComposeProject,
} from './compilerCore.js';
export type {
  CompiledComposeProject,
  CompiledKnowledgeTarget,
  CompiledLibraryProject,
  CompileComposeProfile,
  PreparedPackageBuildTarget,
  VerifyComposeProjectResult,
} from './compilerCore.js';

export interface CompileComposeProjectOptions {
  signal?: AbortSignal;
  force?: boolean;
  target?: string;
  contextRoot?: string;
  targetOptions?: Record<string, Record<string, unknown>>;
}

export interface CompileRetrievalFromEvidenceOptions {
  signal?: AbortSignal;
  target: string;
  contextRoot?: string;
  targetOptions?: Record<string, Record<string, unknown>>;
}

export async function compileComposeProject(root: string, options: CompileComposeProjectOptions = {}) {
  return compileComposeProjectCore(root, {
    ...options,
    distribution: DEFAULT_DKB_DISTRIBUTION,
  });
}

export async function compileKnowledgeTarget(root: string, options: CompileComposeProjectOptions = {}) {
  return compileKnowledgeTargetCore(root, {
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
  options: {
    target: string;
    contextRoot?: string;
    libraryRoot?: string;
    targetOptions?: Record<string, Record<string, unknown>>;
  },
) {
  return ensurePackageBuildForTargetCore(root, {
    ...options,
    distribution: DEFAULT_DKB_DISTRIBUTION,
  });
}
