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
  'providers/bundled/dist',
]) {
  await fs.rm(path.resolve(target), { recursive: true, force: true });
}
