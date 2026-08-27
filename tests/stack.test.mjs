import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareDkbStack } from '../apps/cli/dist/stack/manager.js';

test('stack preparation generates reusable local secrets without returning them', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-stack-test-'));
  const previousRoot = process.env.DKB_STACK_STATE_ROOT;
  process.env.DKB_STACK_STATE_ROOT = root;

  try {
    const first = await prepareDkbStack('proof-stack', 'default');
    const firstEnvironment = await fs.readFile(first.envFile, 'utf8');
    const second = await prepareDkbStack('proof-stack', 'default');
    const secondEnvironment = await fs.readFile(second.envFile, 'utf8');

    assert.equal(firstEnvironment, secondEnvironment);
    assert.match(firstEnvironment, /DKB_REGISTRY_APP_KEY=base64:/);
    assert.match(firstEnvironment, /DKB_REGISTRY_BOOTSTRAP_NAMESPACE=proof-stack/);
    assert.match(firstEnvironment, /DKB_REGISTRY_BOOTSTRAP_TOKEN=dkb_/);
    assert.match(firstEnvironment, /DKB_MCP_BEARER_TOKEN=/);
    assert.doesNotMatch(JSON.stringify(first), /DKB_MCP_BEARER_TOKEN|DKB_REGISTRY_APP_KEY|DKB_REGISTRY_BOOTSTRAP_TOKEN/);
    assert.equal(first.composeFile.endsWith(path.join('dist', 'stack', 'compose.yaml')), true);
  } finally {
    if (previousRoot === undefined) delete process.env.DKB_STACK_STATE_ROOT;
    else process.env.DKB_STACK_STATE_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Meilisearch stack target configures the same provider contract for compiler and Runtime', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-stack-meili-test-'));
  const previousRoot = process.env.DKB_STACK_STATE_ROOT;
  process.env.DKB_STACK_STATE_ROOT = root;

  try {
    const stack = await prepareDkbStack('meili-proof', 'meilisearch');
    const compiler = JSON.parse(await fs.readFile(path.join(stack.root, 'compiler-context', '.dkb', 'config.json'), 'utf8'));
    const runtime = JSON.parse(await fs.readFile(path.join(stack.root, 'runtime', '.dkb', 'config.json'), 'utf8'));

    assert.deepEqual(runtime, compiler);
    assert.equal(runtime.activeTarget, 'meilisearch');
    assert.equal(runtime.targets.meilisearch.index, '@dkb/meilisearch');
    assert.equal(runtime.targets.meilisearch.options['@dkb/meilisearch'].apiKeyEnv, 'MEILI_MASTER_KEY');
  } finally {
    if (previousRoot === undefined) delete process.env.DKB_STACK_STATE_ROOT;
    else process.env.DKB_STACK_STATE_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
});
