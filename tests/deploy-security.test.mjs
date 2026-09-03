import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the developer-preview Registry is exposed only on host loopback', async () => {
  const compose = YAML.parse(await readFile(path.join(root, 'deploy/compose.yaml'), 'utf8'));

  assert.deepEqual(compose.services['registry-web'].ports, [
    '127.0.0.1:${DKB_REGISTRY_PORT:-8018}:8000',
  ]);
});
