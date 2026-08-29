import type { DkbBundledPlugin } from '@sjshovan/dkb-pipeline/host.js';
import { DKB_PLUGIN_API_VERSION, type DkbEmbeddingProvider } from '@sjshovan/dkb-pipeline/types.js';
import {
  DKB_TEI_PLUGIN_ID,
  doctorTeiService,
  embedWithTei,
  ensureTeiService,
  stopTeiService,
  teiCompatibility,
  teiServiceStatus,
} from './tei.js';

export const DKB_TEI_PLUGIN_VERSION = '0.1.0';

export const TEI_PLUGIN: DkbBundledPlugin = {
  apiVersion: DKB_PLUGIN_API_VERSION,
  id: DKB_TEI_PLUGIN_ID,
  version: DKB_TEI_PLUGIN_VERSION,
  setup(context) {
    const provider: DkbEmbeddingProvider = {
      kind: 'embedding',
      lifecycle: {
        start: (options) => ensureTeiService(context.options, Boolean(options?.restart)),
        status: () => teiServiceStatus(context.options),
        stop: () => stopTeiService(context.options),
        doctor: () => doctorTeiService(context.options),
      },
      embedDocuments: ({ texts, options, signal }) => embedWithTei(texts, 'document', options, signal),
      async embedQuery({ text, options, signal }) { return (await embedWithTei([text], 'query', options, signal))[0] ?? []; },
      compatibility: teiCompatibility,
      async health() {
        const result = await doctorTeiService(context.options);
        return { ok: result.ok, detail: result.ok ? `TEI ${result.status.model}@${result.status.modelRevision} ready at ${result.status.url}` : result.recovery };
      },
    };
    context.registerProvider(provider);
  },
};
