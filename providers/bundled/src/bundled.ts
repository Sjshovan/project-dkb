import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbBundledPlugin } from '@sjshovan/dkb-pipeline/host.js';
import type { DkbIndexRuntime } from '@sjshovan/dkb-pipeline/types.js';
import {
  buildFaissRuntimeSnapshot,
  closeFaissSnapshot,
  loadFaissPackageArtifact,
  searchFaissSnapshot,
  validateFaissPackageQueryability,
  validateFaissRuntimeReady,
  writeFaissPackageArtifacts,
} from './faissStore.js';
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

export const DKB_FAISS_PLUGIN_ID = '@dkb/index-faiss';
export const DKB_MEILISEARCH_PLUGIN_ID = MEILISEARCH_PROVIDER_ID;
export const DKB_BUNDLED_PROVIDER_VERSION = '0.1.0';

export const BUNDLED_PROVIDER_PLUGINS: readonly DkbBundledPlugin[] = [
  {
    id: DKB_FAISS_PLUGIN_ID,
    version: DKB_BUNDLED_PROVIDER_VERSION,
    setup(context) {
      context.registerProvider({
        kind: 'index',
        mode: 'packaged',
        format: 'IndexIDMap2(IndexFlatIP)',
        async compilePackage({ artifactsRoot, dkb, compiled, compatibility }) {
          const manifest = await writeFaissPackageArtifacts(artifactsRoot, dkb, compiled, compatibility);
          return manifest ? {
            providerId: DKB_FAISS_PLUGIN_ID,
            providerVersion: DKB_BUNDLED_PROVIDER_VERSION,
            build: { format: manifest.format, chunkCount: manifest.chunkCount, files: manifest.files },
            compatibility: { ...manifest.embedding },
          } : null;
        },
        async validatePackage({ dkb, artifactsRoot }) {
          await validateFaissPackageQueryability(dkb, artifactsRoot);
          return { documentCount: (await loadFaissPackageArtifact(dkb, artifactsRoot)).units.length };
        },
        async verifyRuntime({ libraryRoot, libraryId, packages, packageId, packageVersion }) {
          const result = await validateFaissRuntimeReady({ root: libraryRoot, registryId: libraryId, packages, packageId, packageVersion });
          return {
            indexId: result.backend.index,
            documentCount: result.documentCount,
            status: 'ready',
          };
        },
        async openRuntime({ libraryRoot, libraryId, packages, compatibility, embedQuery }) {
          const snapshot = await buildFaissRuntimeSnapshot(libraryRoot, libraryId, packages);

          if (!snapshot) {
            return null;
          }
          if (compatibility.embeddingSpace !== snapshot.embedding.model || compatibility.dimensions !== snapshot.embedding.dimensions) {
            await closeFaissSnapshot(snapshot);
            throw new DkbError(`Selected embedding provider is incompatible with installed FAISS packages: expected ${snapshot.embedding.model}/${snapshot.embedding.dimensions}, got ${String(compatibility.embeddingSpace)}/${String(compatibility.dimensions)}`);
          }
          let closed = false;
          const runtime: DkbIndexRuntime = {
            providerId: DKB_FAISS_PLUGIN_ID,
            mode: 'packaged',
            format: 'IndexIDMap2(IndexFlatIP)',
            packages: snapshot.packages.map((item) => ({ id: item.id, version: item.version, indexId: item.segmentPath, documentCount: item.chunkCount })),
            search: (query, limit) => searchFaissSnapshot(snapshot, query, limit, embedQuery),
            async close() {
              if (closed) return;
              closed = true;
              await closeFaissSnapshot(snapshot);
            },
          };

          return runtime;
        },
        health: async () => ({ ok: true, detail: 'Packaged FAISS indexes' }),
      });
    },
  },
  {
    id: DKB_MEILISEARCH_PLUGIN_ID,
    version: DKB_BUNDLED_PROVIDER_VERSION,
    setup(context) {
      context.registerProvider({
        kind: 'index',
        mode: 'managed',
        format: MEILISEARCH_INDEX_FORMAT,
        compilePackage: (input) => writeMeilisearchPackageArtifacts({ ...input, providerVersion: DKB_BUNDLED_PROVIDER_VERSION }),
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
  },
] as const;

export function bundledProviderIds(): string[] {
  return BUNDLED_PROVIDER_PLUGINS.map((plugin) => plugin.id);
}
