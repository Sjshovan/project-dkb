import type { DkbBundledPlugin } from '@sjshovan/dkb-pipeline/host.js';
import { createHybridRetrievalProvider } from './hybridRetrieval.js';

export const DKB_HYBRID_RETRIEVAL_PLUGIN_ID = '@dkb/retrieval-hybrid';
export const DKB_HYBRID_RETRIEVAL_PLUGIN_VERSION = '0.1.0';

export const HYBRID_RETRIEVAL_PLUGIN: DkbBundledPlugin = {
  id: DKB_HYBRID_RETRIEVAL_PLUGIN_ID,
  version: DKB_HYBRID_RETRIEVAL_PLUGIN_VERSION,
  setup(context) { context.registerProvider(createHybridRetrievalProvider(DKB_HYBRID_RETRIEVAL_PLUGIN_ID)); },
};
