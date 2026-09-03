import { defineOptionsSchema } from '@sjshovan/dkb-pipeline/sdk.js';

export const optionsSchema = defineOptionsSchema((input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [{ message: 'Options must be an object' }];
  const value = /** @type {Record<string, unknown>} */ (input);
  const unknown = Object.keys(value).filter((key) => !['maxChunkChars', 'maxSourceBytes'].includes(key));
  if (unknown.length) return [{ message: `Unknown options: ${unknown.join(', ')}` }];
  const maxChunkChars = Number(value.maxChunkChars ?? 1200);
  const maxSourceBytes = Number(value.maxSourceBytes ?? 10 * 1024 * 1024);
  if (!Number.isSafeInteger(maxChunkChars) || maxChunkChars < 64 || maxChunkChars > 8192) return [{ message: 'maxChunkChars must be an integer from 64 to 8192' }];
  if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 1 || maxSourceBytes > 64 * 1024 * 1024) return [{ message: 'maxSourceBytes must be between 1 byte and 64 MiB' }];
  return { maxChunkChars, maxSourceBytes };
}, 'minisearch-lexical-example');
