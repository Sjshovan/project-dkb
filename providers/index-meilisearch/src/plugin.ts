import type { DkbBundledPlugin } from '@sjshovan/dkb-pipeline/host.js';
import {
  MEILISEARCH_INDEX_FORMAT,
  MEILISEARCH_PROVIDER_ID,
  installMeilisearchPackage,
  meilisearchProviderHealth,
  openMeilisearchRuntime,
  uninstallMeilisearchPackage,
  validateMeilisearchPackageArtifact,
  verifyMeilisearchRuntime,
  writeMeilisearchPackageArtifacts,
} from './meilisearchProvider.js';

export const MEILISEARCH_PROVIDER_VERSION = '0.1.0';

export const MEILISEARCH_PLUGIN: DkbBundledPlugin = {
  id: MEILISEARCH_PROVIDER_ID,
  version: MEILISEARCH_PROVIDER_VERSION,
  setup(context) {
    context.registerProvider({
      kind: 'index',
      mode: 'managed',
      format: MEILISEARCH_INDEX_FORMAT,
      compilePackage: (input) => writeMeilisearchPackageArtifacts({ ...input, providerVersion: MEILISEARCH_PROVIDER_VERSION }),
      async validatePackage({ dkb, artifactsRoot, compatibility }) {
        const artifact = await validateMeilisearchPackageArtifact(dkb, compatibility, artifactsRoot);
        return { documentCount: artifact.records.length };
      },
      installPackage: installMeilisearchPackage,
      uninstallPackage: uninstallMeilisearchPackage,
      verifyRuntime: verifyMeilisearchRuntime,
      openRuntime: openMeilisearchRuntime,
      health: () => meilisearchProviderHealth(context.options),
    });
  },
};
