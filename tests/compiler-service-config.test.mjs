import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  LLAMAINDEX_COMPILER_IMAGE,
  LLAMAINDEX_COMPILER_SERVICE_VERSION,
  LLAMAINDEX_DOCUMENT_BATCH_SIZE,
} from '@sjshovan/dkb-evidence-docling-llamaindex/compiler.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('local, one-shot, Python, and Compose compiler defaults stay aligned', async () => {
  assert.equal(LLAMAINDEX_COMPILER_IMAGE, 'dkb-evidence-docling-llamaindex:0.1.0');
  assert.equal(LLAMAINDEX_COMPILER_SERVICE_VERSION, '3');
  assert.equal(LLAMAINDEX_DOCUMENT_BATCH_SIZE, 32);

  const python = await readFile(path.join(root, 'providers/evidence-docling-llamaindex/python/compile.py'), 'utf8');
  assert.match(python, /DKB_LLAMA_DOCUMENT_BATCH_SIZE", "32"/);
  assert.doesNotMatch(python, /FASTEMBED|EMBED_BATCH|INFERENCE_BATCH/);

  const service = await readFile(path.join(root, 'providers/evidence-docling-llamaindex/python/service.py'), 'utf8');
  assert.match(service, /SERVICE_VERSION = "3"/);

  const dockerfile = await readFile(path.join(root, 'providers/evidence-docling-llamaindex/python/Dockerfile'), 'utf8');
  assert.match(dockerfile, /org\.dkb\.compiler\.service\.version="3"/);

  const compose = YAML.parse(await readFile(path.join(root, 'deploy/compose.yaml'), 'utf8'));
  const environment = compose.services['dkb-compiler-worker'].environment;
  assert.equal(String(environment.DKB_LLAMA_DOCUMENT_BATCH_SIZE), '32');
  assert.equal(environment.DKB_LLAMA_EMBED_BATCH_SIZE, undefined);
  assert.equal(environment.DKB_LLAMA_INFERENCE_BATCH_SIZE, undefined);
});
