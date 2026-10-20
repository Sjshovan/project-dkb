import type { DkbBundledPluginModule } from '@sjshovan/dkb-pipeline/host.js';
import { defineOptionsSchema } from '@sjshovan/dkb-pipeline/sdk.js';
import { isSha256Digest } from '@sjshovan/dkb-pipeline/validation.js';
import { DKB_PLUGIN_API_VERSION } from '@sjshovan/dkb-pipeline/types.js';
import {
  MEILISEARCH_INDEX_FORMAT,
  MEILISEARCH_PROVIDER_ID,
  installMeilisearchPackage,
  discardMeilisearchPackage,
  meilisearchProviderHealth,
  meilisearchStorageIdentity,
  openMeilisearchRuntime,
  uninstallMeilisearchPackage,
  validateMeilisearchPackageArtifact,
  verifyMeilisearchRuntime,
  writeMeilisearchPackageArtifacts,
} from './meilisearchProvider.js';

export const MEILISEARCH_PROVIDER_VERSION = '0.1.0';
const optionsSchema = defineOptionsSchema((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [{ message: 'Options must be an object' }];
  const options = value as Record<string, unknown>;
  const allowed = ['urlEnv', 'apiKeyEnv', 'imageDigest', 'semanticRatio', 'timeoutMs'];
  const issues = Object.keys(options).filter((key) => !allowed.includes(key)).map((key) => ({ message: `Unknown option ${key}`, path: [key] }));
  if (options.imageDigest !== undefined && !isSha256Digest(options.imageDigest)) issues.push({ message: 'imageDigest must be an exact sha256 digest', path: ['imageDigest'] });
  if (issues.length > 0) return issues;
  const semanticRatio = typeof options.semanticRatio === 'number' ? options.semanticRatio : 0.7;
  if (!Number.isFinite(semanticRatio) || semanticRatio < 0 || semanticRatio > 1) return [{ message: 'semanticRatio must be between 0 and 1', path: ['semanticRatio'] }];
  return {
    urlEnv: environmentName(options.urlEnv) ?? 'MEILI_URL',
    apiKeyEnv: environmentName(options.apiKeyEnv) ?? 'MEILI_MASTER_KEY',
    ...(isSha256Digest(options.imageDigest) ? { imageDigest: options.imageDigest } : {}),
    semanticRatio,
    timeoutMs: positiveInteger(options.timeoutMs) ?? 60_000,
  };
}, MEILISEARCH_PROVIDER_ID);

export const MEILISEARCH_PLUGIN: DkbBundledPluginModule = {
  apiVersion: DKB_PLUGIN_API_VERSION,
  id: MEILISEARCH_PROVIDER_ID,
  version: MEILISEARCH_PROVIDER_VERSION,
  sourceUrl: import.meta.url,
  optionsSchema,
  identity: ({ options }) => ({
    profileOptions: {
      semanticRatio: typeof options.semanticRatio === 'number' ? options.semanticRatio : 0.7,
    },
    external: isSha256Digest(options.imageDigest)
      ? [{ kind: 'image', name: 'index-service', digest: options.imageDigest }]
      : [],
  }),
  integrity: {
    apiVersion: DKB_PLUGIN_API_VERSION,
    id: MEILISEARCH_PROVIDER_ID,
    version: MEILISEARCH_PROVIDER_VERSION,
    protocols: [],
    artifactFormats: [MEILISEARCH_INDEX_FORMAT],
  },
  setup(context) {
    context.registerProvider({
      kind: 'index',
      mode: 'managed',
      storageIdentity: meilisearchStorageIdentity,
      format: MEILISEARCH_INDEX_FORMAT,
      capabilities: { vectors: 'required' },
      compilePackage: writeMeilisearchPackageArtifacts,
      async validatePackage({ dkb, artifactsRoot, compatibility, signal }) {
        signal?.throwIfAborted();
        const artifact = await validateMeilisearchPackageArtifact(dkb, compatibility, artifactsRoot);
        signal?.throwIfAborted();
        return { documentCount: artifact.records.length };
      },
      installPackage: installMeilisearchPackage,
      discardPackage: discardMeilisearchPackage,
      uninstallPackage: uninstallMeilisearchPackage,
      verifyRuntime: verifyMeilisearchRuntime,
      openRuntime: openMeilisearchRuntime,
      health: () => meilisearchProviderHealth(context.options),
    });
  },
};

function environmentName(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value) ? value : undefined;
}
function positiveInteger(value: unknown): number | undefined { return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined; }
