import { definePlugin, defineParserProvider, defineChunkerProvider } from '@sjshovan/dkb-pipeline/sdk.js';
import { optionsSchema } from './options.mjs';
import { parseSources, chunkHeadings } from './source.mjs';
import { lexicalIndex } from './index.mjs';
import { lexicalRetrieval } from './retrieval.mjs';

export default definePlugin({
  apiVersion: 3,
  id: '@example/minisearch-lexical',
  version: '1.0.0',
  optionsSchema,
  setup(context) {
    context.registerProvider(defineParserProvider({ kind: 'parser', parse: parseSources }));
    context.registerProvider(defineChunkerProvider({ kind: 'chunker', chunk: chunkHeadings }));
    context.registerProvider(lexicalIndex(context.pluginId));
    context.registerProvider(lexicalRetrieval(context.pluginId));
  },
});
