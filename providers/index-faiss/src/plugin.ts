import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbBundledPlugin } from '@sjshovan/dkb-pipeline/host.js';
import { DKB_PLUGIN_API_VERSION, type DkbIndexRuntime } from '@sjshovan/dkb-pipeline/types.js';
import {
  buildFaissRuntimeSnapshot,
  closeFaissSnapshot,
  faissProviderHealth,
  loadFaissPackageArtifact,
  searchFaissSnapshot,
  validateFaissPackageQueryability,
  validateFaissRuntimeReady,
  writeFaissPackageArtifacts,
} from './faissStore.js';

export const FAISS_PLUGIN_ID = '@dkb/index-faiss';
export const FAISS_PROVIDER_VERSION = '0.1.0';

export const FAISS_PLUGIN: DkbBundledPlugin = {
  apiVersion: DKB_PLUGIN_API_VERSION,
  id: FAISS_PLUGIN_ID,
  version: FAISS_PROVIDER_VERSION,
  setup(context) {
    context.registerProvider({
      kind: 'index',
      mode: 'packaged',
      format: 'IndexIDMap2(IndexFlatIP)',
      async compilePackage({ artifactsRoot, dkb, compiled, compatibility }) {
        const manifest = await writeFaissPackageArtifacts(artifactsRoot, dkb, compiled, compatibility);
        return manifest ? {
          providerId: FAISS_PLUGIN_ID,
          providerVersion: FAISS_PROVIDER_VERSION,
          build: { format: manifest.format, chunkCount: manifest.chunkCount, files: manifest.files },
          compatibility: { ...manifest.embedding },
        } : null;
      },
      async validatePackage({ dkb, artifactsRoot }) {
        await validateFaissPackageQueryability(dkb, artifactsRoot);
        return { documentCount: (await loadFaissPackageArtifact(dkb, artifactsRoot)).documentCount };
      },
      async verifyRuntime({ libraryRoot, libraryId, packages, packageId, packageVersion }) {
        const result = await validateFaissRuntimeReady({ root: libraryRoot, registryId: libraryId, packages, packageId, packageVersion });
        return { indexId: result.backend.index, documentCount: result.documentCount, status: 'ready' };
      },
      async openRuntime({ libraryRoot, libraryId, packages, compatibility, embedQuery }) {
        const snapshot = await buildFaissRuntimeSnapshot(libraryRoot, libraryId, packages);
        if (!snapshot) return null;
        if (compatibility.embeddingSpace !== snapshot.embedding.model || compatibility.dimensions !== snapshot.embedding.dimensions) {
          await closeFaissSnapshot(snapshot);
          throw new DkbError(`Selected embedding provider is incompatible with installed FAISS packages: expected ${snapshot.embedding.model}/${snapshot.embedding.dimensions}, got ${String(compatibility.embeddingSpace)}/${String(compatibility.dimensions)}`);
        }
        let closed = false;
        const runtime: DkbIndexRuntime = {
          providerId: FAISS_PLUGIN_ID,
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
      health: faissProviderHealth,
    });
  },
};
