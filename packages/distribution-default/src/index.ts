import { DKB_CONFIG_FORMAT, type DkbContextConfig } from '@sjshovan/dkb-pipeline/config.js';
import type { DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import { EVIDENCE_DOCLING_LLAMAINDEX_PLUGIN } from '@sjshovan/dkb-evidence-docling-llamaindex/plugin.js';
import { FASTEMBED_PLUGIN } from '@sjshovan/dkb-embedding-fastembed/plugin.js';
import { TEI_PLUGIN } from '@sjshovan/dkb-embedding-tei/plugin.js';
import { FAISS_PLUGIN } from '@sjshovan/dkb-index-faiss/plugin.js';
import { MEILISEARCH_PLUGIN } from '@sjshovan/dkb-index-meilisearch/plugin.js';
import { HYBRID_RETRIEVAL_PLUGIN } from '@sjshovan/dkb-retrieval-hybrid/plugin.js';

const SMALL_MODEL = 'BAAI/bge-small-en-v1.5';
const BASE_MODEL = 'BAAI/bge-base-en-v1.5';
const SMALL_MODEL_REVISION = '5c38ec7c405ec4b44b94cc5a9bb96e735b38267a';
const BASE_MODEL_REVISION = 'a5beb1e3e68b9ab74eb54cfd186867f64f240e1a';
const ALL_TARGETS = ['default', 'fastembed-faiss', 'fastembed-faiss-768', 'tei-faiss', 'tei-faiss-768', 'tei-meilisearch'];

export const DEFAULT_TARGETS: DkbContextConfig = {
  format: DKB_CONFIG_FORMAT,
  activeTarget: 'default',
  targets: {
    default: target('@dkb/embedding-tei', '@dkb/index-faiss', {
      '@dkb/embedding-tei': { model: SMALL_MODEL, modelRevision: SMALL_MODEL_REVISION, dimensions: 384 },
    }),
    'fastembed-faiss': target('@dkb/embedding-fastembed', '@dkb/index-faiss', {
      '@dkb/embedding-fastembed': { model: SMALL_MODEL, dimensions: 384 },
    }),
    'fastembed-faiss-768': target('@dkb/embedding-fastembed', '@dkb/index-faiss', {
      '@dkb/embedding-fastembed': { model: BASE_MODEL, dimensions: 768 },
    }),
    'tei-faiss': target('@dkb/embedding-tei', '@dkb/index-faiss', {
      '@dkb/embedding-tei': { model: SMALL_MODEL, modelRevision: SMALL_MODEL_REVISION, dimensions: 384 },
    }),
    'tei-faiss-768': target('@dkb/embedding-tei', '@dkb/index-faiss', {
      '@dkb/embedding-tei': { model: BASE_MODEL, modelRevision: BASE_MODEL_REVISION, dimensions: 768 },
    }),
    'tei-meilisearch': target('@dkb/embedding-tei', '@dkb/index-meilisearch', {
      '@dkb/embedding-tei': { model: SMALL_MODEL, modelRevision: SMALL_MODEL_REVISION, dimensions: 384 },
      '@dkb/index-meilisearch': { urlEnv: 'MEILI_URL', keyEnv: 'MEILI_MASTER_KEY' },
    }),
  },
};

export const DEFAULT_DKB_DISTRIBUTION: DkbDistribution = {
  id: '@dkb/distribution-default',
  version: '0.2.0',
  defaults: DEFAULT_TARGETS,
  plugins: [EVIDENCE_DOCLING_LLAMAINDEX_PLUGIN, FASTEMBED_PLUGIN, TEI_PLUGIN, FAISS_PLUGIN, MEILISEARCH_PLUGIN, HYBRID_RETRIEVAL_PLUGIN],
  services: [
    {
      id: 'registry',
      kind: 'docker',
      image: 'dkb-registry:0.1.0',
      version: '0.1.0',
      requiredBy: ALL_TARGETS,
      stack: {
        imageEnvironment: 'DKB_REGISTRY_IMAGE',
        recovery: 'Build the Registry image from the dkb-registry checkout, then retry.',
        health: {
          component: 'registry-web',
          portEnvironment: 'DKB_REGISTRY_PORT',
          defaultHostPort: 8018,
          namedPortBase: 8100,
          path: '/health',
          expectation: 'json-ok',
        },
      },
    },
    {
      id: 'compiler',
      kind: 'docker',
      image: 'dkb-compiler:0.2.0',
      version: '0.2.0',
      requiredBy: ALL_TARGETS,
      stack: {
        imageEnvironment: 'DKB_COMPILER_IMAGE',
        build: { context: '.', dockerfile: 'services/compiler/Dockerfile' },
      },
    },
    {
      id: 'runtime',
      kind: 'docker',
      image: 'dkb-runtime:0.2.0',
      version: '0.2.0',
      requiredBy: ALL_TARGETS,
      stack: {
        imageEnvironment: 'DKB_RUNTIME_IMAGE',
        build: { context: '.', dockerfile: 'services/runtime/Dockerfile' },
        health: {
          component: 'dkb-runtime',
          portEnvironment: 'DKB_RUNTIME_PORT',
          defaultHostPort: 7331,
          namedPortBase: 8600,
          path: '/health',
          expectation: 'json-ok',
        },
      },
    },
    {
      id: 'evidence-docling-llamaindex',
      kind: 'docker',
      providerId: '@dkb/evidence-docling-llamaindex',
      image: 'dkb-evidence-docling-llamaindex:0.1.0',
      version: '0.1.0',
      requiredBy: ALL_TARGETS,
      stack: {
        imageEnvironment: 'DKB_EVIDENCE_IMAGE',
        optionEnvironment: { tokenizerModel: 'DKB_EVIDENCE_TOKENIZER_MODEL' },
        build: {
          context: 'providers/evidence-docling-llamaindex/python',
          dockerfile: 'providers/evidence-docling-llamaindex/python/Dockerfile',
        },
      },
    },
    {
      id: 'embedding-fastembed',
      kind: 'docker',
      providerId: '@dkb/embedding-fastembed',
      image: 'dkb-embedding-fastembed:0.1.0',
      version: '0.1.0',
      requiredBy: ['fastembed-faiss', 'fastembed-faiss-768'],
      stack: {
        composeProfile: 'fastembed',
        imageEnvironment: 'DKB_FASTEMBED_IMAGE',
        optionEnvironment: { model: 'DKB_FASTEMBED_MODEL' },
        build: {
          context: 'providers/embedding-fastembed/python',
          dockerfile: 'providers/embedding-fastembed/python/Dockerfile',
        },
      },
    },
    {
      id: 'embedding-tei',
      kind: 'docker',
      providerId: '@dkb/embedding-tei',
      image: 'ghcr.io/huggingface/text-embeddings-inference:cpu-1.9.3@sha256:ad950d30878eceb72aaf32024d26fa2b1d04a75304fa0b4776b49aa1941fea07',
      version: '1.9.3',
      requiredBy: ['default', 'tei-faiss', 'tei-faiss-768', 'tei-meilisearch'],
      stack: {
        composeProfile: 'tei',
        imageEnvironment: 'DKB_TEI_IMAGE',
        optionEnvironment: {
          model: 'DKB_TEI_MODEL',
          modelRevision: 'DKB_TEI_MODEL_REVISION',
        },
        health: {
          component: 'dkb-tei',
          portEnvironment: 'DKB_TEI_PORT',
          defaultHostPort: 8080,
          namedPortBase: 9600,
          path: '/health',
          expectation: 'http-ok',
        },
      },
    },
    {
      id: 'index-faiss',
      kind: 'docker',
      providerId: '@dkb/index-faiss',
      image: 'dkb-index-faiss:0.1.0',
      version: '0.1.0',
      requiredBy: ['default', 'fastembed-faiss', 'fastembed-faiss-768', 'tei-faiss', 'tei-faiss-768'],
      stack: {
        composeProfile: 'faiss',
        imageEnvironment: 'DKB_FAISS_IMAGE',
        build: {
          context: 'providers/index-faiss/python',
          dockerfile: 'providers/index-faiss/python/Dockerfile',
        },
      },
    },
    {
      id: 'index-meilisearch',
      kind: 'docker',
      providerId: '@dkb/index-meilisearch',
      image: 'getmeili/meilisearch:v1.29',
      version: '1.29',
      requiredBy: ['tei-meilisearch'],
      stack: {
        composeProfile: 'meilisearch',
        imageEnvironment: 'DKB_MEILISEARCH_IMAGE',
        stateDirectory: 'meilisearch',
        secretEnvironment: ['DKB_MEILI_MASTER_KEY'],
        health: {
          component: 'meilisearch',
          portEnvironment: 'DKB_MEILI_PORT',
          defaultHostPort: 7700,
          namedPortBase: 9100,
          path: '/health',
          expectation: 'status-available',
        },
      },
    },
  ],
};

function target(
  embedding: string,
  index: string,
  options: Record<string, Record<string, unknown>>,
): NonNullable<DkbContextConfig['targets']>[string] {
  return {
    evidence: '@dkb/evidence-docling-llamaindex',
    embedding,
    index,
    retrieval: '@dkb/retrieval-hybrid',
    processors: [],
    options: {
      '@dkb/evidence-docling-llamaindex': { tokenizerModel: SMALL_MODEL },
      ...options,
    },
  };
}
