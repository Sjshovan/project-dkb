import path from 'node:path';
import { DEFAULT_DKB_DISTRIBUTION } from '@sjshovan/dkb-distribution-default';
import { DKB_CONFIG_PATH, readDkbContextConfig, writeDkbContextConfig } from '@sjshovan/dkb-pipeline/config.js';
import { resolveHostProviderIdentityOptions } from '@sjshovan/dkb-cli/dist/providers/externalIdentities.js';

// Host proof composition only: reuse the CLI's attestation and configuration
// contracts. Compiler/Runtime cores remain unaware of Docker and proof setup.
export async function prepareHostProofContext({ root, target, distribution = DEFAULT_DKB_DISTRIBUTION }) {
  const contextRoot = path.resolve(root);
  const identity = await resolveHostProviderIdentityOptions({ distribution, root: contextRoot, target });
  const configPath = path.join(contextRoot, DKB_CONFIG_PATH);
  const config = await readDkbContextConfig(configPath);
  await writeDkbContextConfig(configPath, {
    ...config,
    activeTarget: identity.target,
    targets: {
      ...config.targets,
      [identity.target]: {
        ...config.targets?.[identity.target],
        options: identity.targetOptions,
      },
    },
  });
  return { contextRoot, ...identity };
}
