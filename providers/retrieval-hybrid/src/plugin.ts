import type { DkbBundledPluginModule } from '@sjshovan/dkb-pipeline/host.js';
import { emptyOptionsSchema } from '@sjshovan/dkb-pipeline/sdk.js';
import { DKB_PLUGIN_API_VERSION } from '@sjshovan/dkb-pipeline/types.js';
import { createHybridRetrievalProvider } from './hybridRetrieval.js';

export const DKB_HYBRID_RETRIEVAL_PLUGIN_ID = '@dkb/retrieval-hybrid';
export const DKB_HYBRID_RETRIEVAL_PLUGIN_VERSION = '0.1.0';

export const HYBRID_RETRIEVAL_PLUGIN: DkbBundledPluginModule = {
  apiVersion: DKB_PLUGIN_API_VERSION,
  id: DKB_HYBRID_RETRIEVAL_PLUGIN_ID,
  version: DKB_HYBRID_RETRIEVAL_PLUGIN_VERSION,
  sourceUrl: import.meta.url,
  optionsSchema: emptyOptionsSchema,
  integrity: {
    apiVersion: DKB_PLUGIN_API_VERSION,
    id: DKB_HYBRID_RETRIEVAL_PLUGIN_ID,
    version: DKB_HYBRID_RETRIEVAL_PLUGIN_VERSION,
    protocols: ['dkb.evidence.v1'],
    artifactFormats: [],
  },
  setup(context) { context.registerProvider(createHybridRetrievalProvider(DKB_HYBRID_RETRIEVAL_PLUGIN_ID)); },
};
