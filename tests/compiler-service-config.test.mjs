import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  LLAMAINDEX_COMPILER_IMAGE,
  LLAMAINDEX_COMPILER_SERVICE_VERSION,
  LLAMAINDEX_DOCUMENT_BATCH_SIZE,
  compilerProviderHealth,
} from '@sjshovan/dkb-evidence-docling-llamaindex/compiler.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('local, one-shot, Python, and Compose compiler defaults stay aligned', async () => {
  assert.equal(LLAMAINDEX_COMPILER_IMAGE, 'dkb-evidence-docling-llamaindex:0.1.0');
  assert.equal(LLAMAINDEX_COMPILER_SERVICE_VERSION, '4');
  assert.equal(LLAMAINDEX_DOCUMENT_BATCH_SIZE, 32);

  const python = await readFile(path.join(root, 'providers/evidence-docling-llamaindex/python/compile.py'), 'utf8');
  assert.match(python, /DKB_LLAMA_DOCUMENT_BATCH_SIZE", "32"/);
  assert.match(python, /SOURCE_UPDATED_AT = "1970-01-01T00:00:00\.000Z"/);
  assert.doesNotMatch(python, /datetime\.now/);
  assert.doesNotMatch(python, /FASTEMBED|EMBED_BATCH|INFERENCE_BATCH/);

  const service = await readFile(path.join(root, 'providers/evidence-docling-llamaindex/python/service.py'), 'utf8');
  assert.match(service, /SERVICE_VERSION = "4"/);

  const dockerfile = await readFile(path.join(root, 'providers/evidence-docling-llamaindex/python/Dockerfile'), 'utf8');
  assert.match(dockerfile, /org\.dkb\.compiler\.service\.version="4"/);

  const compose = YAML.parse(await readFile(path.join(root, 'deploy/compose.yaml'), 'utf8'));
  const environment = compose.services['dkb-compiler-worker'].environment;
  const registryEnvironment = compose['x-registry-environment'];
  assert.equal(String(environment.DKB_LLAMA_DOCUMENT_BATCH_SIZE), '32');
  assert.equal(environment.DKB_LLAMA_EMBED_BATCH_SIZE, undefined);
  assert.equal(environment.DKB_LLAMA_INFERENCE_BATCH_SIZE, undefined);
  assert.equal(
    registryEnvironment.DKB_COMPILER_TARGET,
    undefined,
    'The Registry consumes the compiler capability catalog and must not restart when a Stack prepares another target',
  );
});

test('Evidence provider health uses the configured remote worker inside a service deployment', async (t) => {
  const previous = process.env.DKB_LLAMA_COMPILER_SERVICE_URL;
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, serviceVersion: LLAMAINDEX_COMPILER_SERVICE_VERSION }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (previous === undefined) delete process.env.DKB_LLAMA_COMPILER_SERVICE_URL;
    else process.env.DKB_LLAMA_COMPILER_SERVICE_URL = previous;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.equal(typeof address, 'object');
  process.env.DKB_LLAMA_COMPILER_SERVICE_URL = `http://127.0.0.1:${address.port}`;

  assert.deepEqual(await compilerProviderHealth(), {
    ok: true,
    detail: `llamaindex.docling.evidence service v${LLAMAINDEX_COMPILER_SERVICE_VERSION} at http://127.0.0.1:${address.port}`,
  });
});
