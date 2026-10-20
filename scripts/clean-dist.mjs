import fs from 'node:fs/promises';
import path from 'node:path';

for (const target of [
  'dist',
  'apps/cli/dist',
  'services/compiler/dist',
  'services/runtime/dist',
  'packages/protocol/dist',
  'packages/library/dist',
  'packages/pipeline/dist',
  'packages/registry-client/dist',
  'providers/evidence-docling-llamaindex/dist',
  'providers/embedding-fastembed/dist',
  'providers/embedding-tei/dist',
  'providers/index-faiss/dist',
  'providers/index-meilisearch/dist',
  'providers/retrieval-hybrid/dist',
  'packages/distribution-default/dist',
]) {
  await fs.rm(path.resolve(target), { recursive: true, force: true });
}
