import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbBundledPluginModule } from '@sjshovan/dkb-pipeline/host.js';
import { defineOptionsSchema } from '@sjshovan/dkb-pipeline/sdk.js';
import { isSha256Digest } from '@sjshovan/dkb-pipeline/validation.js';
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
const optionsSchema = defineOptionsSchema((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [{ message: 'Options must be an object' }];
  const options = value as Record<string, unknown>;
  const issues = Object.keys(options).filter((key) => key !== 'imageDigest').map((key) => ({ message: `Unknown option ${key}`, path: [key] }));
  if (options.imageDigest !== undefined && !isSha256Digest(options.imageDigest)) issues.push({ message: 'imageDigest must be an exact sha256 digest', path: ['imageDigest'] });
  if (issues.length > 0) return issues;
  const resolved: Record<string, string> = {};
  if (isSha256Digest(options.imageDigest)) resolved.imageDigest = options.imageDigest;
  return resolved;
}, FAISS_PLUGIN_ID);

export const FAISS_PLUGIN: DkbBundledPluginModule = {
  apiVersion: DKB_PLUGIN_API_VERSION,
  id: FAISS_PLUGIN_ID,
  version: FAISS_PROVIDER_VERSION,
  sourceUrl: import.meta.url,
  optionsSchema,
  integrity: {
    apiVersion: DKB_PLUGIN_API_VERSION,
    id: FAISS_PLUGIN_ID,
    version: FAISS_PROVIDER_VERSION,
    protocols: [],
    artifactFormats: ['IndexIDMap2(IndexFlatIP)'],
  },
  setup(context) {
    const execution = { imageDigest: isSha256Digest(context.options.imageDigest) ? context.options.imageDigest : undefined };
    context.registerProvider({
      kind: 'index',
      identity: ({ options }) => ({
        external: isSha256Digest(options.imageDigest)
          ? [{ kind: 'image', name: 'index-helper', digest: options.imageDigest }]
          : [],
      }),
      mode: 'packaged',
      format: 'IndexIDMap2(IndexFlatIP)',
      capabilities: { vectors: 'required' },
      async compilePackage({ artifactsRoot, dkb, compiled, compatibility, signal }) {
        signal?.throwIfAborted();
        const manifest = await writeFaissPackageArtifacts(artifactsRoot, dkb, compiled, compatibility, execution);
        signal?.throwIfAborted();
        return manifest ? {
          build: { format: manifest.format, chunkCount: manifest.chunkCount, files: manifest.files },
          compatibility: { ...manifest.embedding },
        } : null;
      },
      async validatePackage({ dkb, artifactsRoot, signal }) {
        signal?.throwIfAborted();
        await validateFaissPackageQueryability(dkb, artifactsRoot);
        signal?.throwIfAborted();
        return { documentCount: (await loadFaissPackageArtifact(dkb, artifactsRoot)).documentCount };
      },
      async verifyRuntime({ libraryRoot, libraryId, packages, packageId, packageVersion, signal }) {
        signal?.throwIfAborted();
        const result = await validateFaissRuntimeReady({ root: libraryRoot, registryId: libraryId, packages, packageId, packageVersion, execution });
        signal?.throwIfAborted();
        return { indexId: result.backend.index, documentCount: result.documentCount, status: 'ready' };
      },
      async openRuntime({ libraryRoot, libraryId, packages, compatibility, embedQuery, signal }) {
        signal?.throwIfAborted();
        if (!embedQuery) throw new DkbError('FAISS requires a query embedding provider');
        const snapshot = await buildFaissRuntimeSnapshot(libraryRoot, libraryId, packages, execution);
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
          search: (query, limit, searchSignal) => {
            searchSignal?.throwIfAborted();
            return searchFaissSnapshot(snapshot, query, limit, embedQuery, searchSignal);
          },
          async close() {
            if (closed) return;
            closed = true;
            await closeFaissSnapshot(snapshot);
          },
        };
        return runtime;
      },
      health: () => faissProviderHealth(execution),
    });
  },
};
