import {
  compileComposeProject,
  compileKnowledgeTarget,
  type CompileComposeProjectOptions,
} from '@sjshovan/dkb-compiler/compile.js';
import { DEFAULT_DKB_DISTRIBUTION } from '@sjshovan/dkb-distribution-default';
import { resolveHostProviderIdentityOptions } from './externalIdentities.js';

export async function compileLocalKnowledgeTarget(
  root: string,
  options: CompileComposeProjectOptions = {},
) {
  const contextRoot = options.contextRoot ?? root;
  const identity = await resolveHostProviderIdentityOptions({
    distribution: DEFAULT_DKB_DISTRIBUTION,
    root: contextRoot,
    ...(options.target ? { target: options.target } : {}),
  });
  return compileKnowledgeTarget(root, {
    ...options,
    target: identity.target,
    targetOptions: identity.targetOptions,
  });
}

export async function compileLocalComposeProject(
  root: string,
  options: CompileComposeProjectOptions = {},
) {
  const contextRoot = options.contextRoot ?? root;
  const identity = await resolveHostProviderIdentityOptions({
    distribution: DEFAULT_DKB_DISTRIBUTION,
    root: contextRoot,
    ...(options.target ? { target: options.target } : {}),
  });
  return compileComposeProject(root, {
    ...options,
    target: identity.target,
    targetOptions: identity.targetOptions,
  });
}
