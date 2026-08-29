import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DEFAULT_DKB_DISTRIBUTION } from '@sjshovan/dkb-distribution-default';
import { backupDkbStack, composeArguments, prepareDkbStack, restoreDkbStack } from '../apps/cli/dist/stack/manager.js';

const dockerAvailable = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;

test('stack preparation generates reusable local secrets without returning them', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-stack-test-'));
  const previousRoot = process.env.DKB_STACK_STATE_ROOT;
  process.env.DKB_STACK_STATE_ROOT = root;

  try {
    const first = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'proof-stack', 'default');
    const firstEnvironment = await fs.readFile(first.envFile, 'utf8');
    const second = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'proof-stack', 'default');
    const secondEnvironment = await fs.readFile(second.envFile, 'utf8');

    assert.equal(firstEnvironment, secondEnvironment);
    assert.match(firstEnvironment, /DKB_REGISTRY_APP_KEY=base64:/);
    assert.match(firstEnvironment, /DKB_REGISTRY_BOOTSTRAP_NAMESPACE=proof-stack/);
    assert.match(firstEnvironment, /DKB_REGISTRY_BOOTSTRAP_TOKEN=dkb_/);
    assert.match(firstEnvironment, /DKB_MCP_BEARER_TOKEN=/);
    assert.doesNotMatch(JSON.stringify(first), /DKB_MCP_BEARER_TOKEN|DKB_REGISTRY_APP_KEY|DKB_REGISTRY_BOOTSTRAP_TOKEN/);
    assert.equal(first.composeFile.endsWith(path.join('dist', 'stack', 'compose.yaml')), true);
    assert.deepEqual(
      composeArguments(first, ['up']).slice(-5),
      ['--profile', 'tei', '--profile', 'faiss', 'up'],
    );
  } finally {
    if (previousRoot === undefined) delete process.env.DKB_STACK_STATE_ROOT;
    else process.env.DKB_STACK_STATE_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Meilisearch stack target selects the distribution recipe for compiler and Runtime', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-stack-meili-test-'));
  const previousRoot = process.env.DKB_STACK_STATE_ROOT;
  process.env.DKB_STACK_STATE_ROOT = root;

  try {
    const stack = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'meili-proof', 'tei-meilisearch');
    const compiler = JSON.parse(await fs.readFile(path.join(stack.root, 'compiler-context', '.dkb', 'config.json'), 'utf8'));
    const runtime = JSON.parse(await fs.readFile(path.join(stack.root, 'runtime', '.dkb', 'config.json'), 'utf8'));

    assert.deepEqual(runtime, compiler);
    assert.equal(runtime.activeTarget, 'tei-meilisearch');
    assert.equal('targets' in runtime, false);
    assert.deepEqual(
      composeArguments(stack, ['down', '--remove-orphans']).slice(-10),
      ['--profile', 'fastembed', '--profile', 'tei', '--profile', 'faiss', '--profile', 'meilisearch', 'down', '--remove-orphans'],
    );
  } finally {
    if (previousRoot === undefined) delete process.env.DKB_STACK_STATE_ROOT;
    else process.env.DKB_STACK_STATE_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('TEI stack targets select the pinned shared embedding service for compiler and Runtime', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-stack-tei-test-'));
  const previousRoot = process.env.DKB_STACK_STATE_ROOT;
  process.env.DKB_STACK_STATE_ROOT = root;

  try {
    const stack = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'tei-proof', 'tei-meilisearch');
    const environment = await fs.readFile(stack.envFile, 'utf8');
    const compiler = JSON.parse(await fs.readFile(path.join(stack.root, 'compiler-context', '.dkb', 'config.json'), 'utf8'));
    const runtime = JSON.parse(await fs.readFile(path.join(stack.root, 'runtime', '.dkb', 'config.json'), 'utf8'));

    assert.deepEqual(runtime, compiler);
    assert.equal(runtime.activeTarget, 'tei-meilisearch');
    assert.match(environment, /DKB_TEI_IMAGE=ghcr\.io\/huggingface\/text-embeddings-inference:cpu-1\.9\.3@sha256:/);
    assert.match(environment, /DKB_TEI_MODEL_REVISION=5c38ec7c405ec4b44b94cc5a9bb96e735b38267a/);
    assert.deepEqual(
      composeArguments(stack, ['up']).slice(-5),
      ['--profile', 'tei', '--profile', 'meilisearch', 'up'],
    );
  } finally {
    if (previousRoot === undefined) delete process.env.DKB_STACK_STATE_ROOT;
    else process.env.DKB_STACK_STATE_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('changing the compiler target preserves a populated Runtime target until pipeline activation succeeds', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-stack-target-transaction-test-'));
  const previousRoot = process.env.DKB_STACK_STATE_ROOT;
  process.env.DKB_STACK_STATE_ROOT = root;

  try {
    const first = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'target-transaction', 'fastembed-faiss');
    const evidenceProfileDigest = stableHash({ evidence: 'default' });
    const retrievalProfileDigest = stableHash({ retrieval: 'fastembed' });
    await fs.writeFile(path.join(first.root, 'runtime', '.dkb', 'runtime.lock.json'), `${JSON.stringify({
      format: 'dkb.runtime-lock.v2',
      target: 'fastembed-faiss',
      evidenceProfileDigest,
      retrievalProfileDigest,
      compatibilityDigest: stableHash({ compatibility: 'fastembed' }),
      packages: {
        '@test/installed': {
          version: '1.0.0',
          evidenceProfileDigest,
          evidenceDigest: stableHash({ evidence: 'installed' }),
          retrievalProfileDigest,
          retrievalBuildDigest: stableHash({ build: 'fastembed' }),
        },
      },
      generation: 1,
      generatedAt: '2026-08-28T00:00:00.000Z',
    }, null, 2)}\n`, 'utf8');

    const switchedCompiler = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'target-transaction', 'tei-faiss');
    const compiler = JSON.parse(await fs.readFile(path.join(switchedCompiler.root, 'compiler-context', '.dkb', 'config.json'), 'utf8'));
    const runtime = JSON.parse(await fs.readFile(path.join(switchedCompiler.root, 'runtime', '.dkb', 'config.json'), 'utf8'));
    const environment = await fs.readFile(switchedCompiler.envFile, 'utf8');

    assert.deepEqual(
      composeArguments(first, ['down']).slice(-9),
      ['--profile', 'fastembed', '--profile', 'tei', '--profile', 'faiss', '--profile', 'meilisearch', 'down'],
    );
    assert.equal(compiler.activeTarget, 'tei-faiss');
    assert.equal(runtime.activeTarget, 'fastembed-faiss');
    assert.match(environment, /^DKB_PIPELINE_TARGET=tei-faiss$/mu);
  } finally {
    if (previousRoot === undefined) delete process.env.DKB_STACK_STATE_ROOT;
    else process.env.DKB_STACK_STATE_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('stack preparation derives unknown target services and options from the injected distribution', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-stack-custom-distribution-test-'));
  const previousRoot = process.env.DKB_STACK_STATE_ROOT;
  process.env.DKB_STACK_STATE_ROOT = root;
  const baseRecipe = DEFAULT_DKB_DISTRIBUTION.defaults.targets.default;
  const distribution = {
    ...DEFAULT_DKB_DISTRIBUTION,
    id: '@test/distribution',
    defaults: {
      ...DEFAULT_DKB_DISTRIBUTION.defaults,
      activeTarget: 'lab-target',
      targets: { 'lab-target': baseRecipe },
    },
    services: [
      ...DEFAULT_DKB_DISTRIBUTION.services
        .filter((service) => service.requiredBy.includes('default'))
        .map((service) => ({ ...service, requiredBy: ['lab-target'] })),
      {
        id: 'lab-daemon',
        kind: 'docker',
        image: 'example.invalid/lab-daemon:1',
        version: '1',
        requiredBy: ['lab-target'],
        stack: {
          composeProfile: 'lab',
          imageEnvironment: 'DKB_LAB_IMAGE',
          health: {
            component: 'lab-daemon',
            portEnvironment: 'DKB_LAB_PORT',
            defaultHostPort: 8765,
            namedPortBase: 9800,
            path: '/ready',
            expectation: 'http-ok',
          },
        },
      },
    ],
  };

  try {
    const stack = await prepareDkbStack(distribution, 'local');
    const environment = await fs.readFile(stack.envFile, 'utf8');
    assert.equal(stack.target, 'lab-target');
    assert.equal(stack.servicePorts['lab-daemon'], 8765);
    assert.equal(stack.profiles.includes('lab'), true);
    assert.match(environment, /^DKB_LAB_IMAGE=example\.invalid\/lab-daemon:1$/mu);
    await assert.rejects(
      () => prepareDkbStack(distribution, 'local', 'not-a-target'),
      /not available.*Available targets: lab-target/u,
    );
  } finally {
    if (previousRoot === undefined) delete process.env.DKB_STACK_STATE_ROOT;
    else process.env.DKB_STACK_STATE_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('stack release locks are generated from the complete distribution service catalog', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-stack-lock-test-'));
  const output = path.join(root, 'release.lock.json');
  const images = Object.fromEntries(DEFAULT_DKB_DISTRIBUTION.services
    .filter((service) => service.stack && service.image)
    .map((service, index) => [
      service.id,
      `example.invalid/${service.id}@sha256:${String(index + 1).padStart(64, '0')}`,
    ]));

  try {
    const result = spawnSync(process.execPath, [
      'scripts/create-stack-lock.mjs',
      '--version', '0.2.0-test',
      '--output', output,
    ], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: { ...process.env, DKB_STACK_IMAGES_JSON: JSON.stringify(images) },
    });
    assert.equal(result.status, 0, result.stderr);
    const lock = JSON.parse(await fs.readFile(output, 'utf8'));
    assert.equal(lock.distribution, `${DEFAULT_DKB_DISTRIBUTION.id}@${DEFAULT_DKB_DISTRIBUTION.version}`);
    assert.deepEqual(Object.keys(lock.images).sort(), Object.keys(images).sort());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('stopped stack backup and restore preserve state with a verified sidecar', { skip: !dockerAvailable }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-stack-backup-test-'));
  const backups = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-stack-backup-output-'));
  const previousRoot = process.env.DKB_STACK_STATE_ROOT;
  const previousBackups = process.env.DKB_STACK_BACKUP_ROOT;
  process.env.DKB_STACK_STATE_ROOT = root;
  process.env.DKB_STACK_BACKUP_ROOT = backups;

  try {
    const stack = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'backup-proof', 'fastembed-faiss');
    await fs.writeFile(path.join(stack.root, 'runtime', 'proof.txt'), 'preserve me', 'utf8');
    const backup = await backupDkbStack(DEFAULT_DKB_DISTRIBUTION, 'backup-proof');
    assert.equal(backup.containsSecrets, true);
    assert.equal((await fs.readFile(backup.checksumFile, 'utf8')).startsWith(backup.sha256), true);

    await fs.rm(stack.root, { recursive: true, force: true });
    const restored = await restoreDkbStack(DEFAULT_DKB_DISTRIBUTION, backup.archive);
    assert.equal(await fs.readFile(path.join(restored.stateRoot, 'runtime', 'proof.txt'), 'utf8'), 'preserve me');
  } finally {
    if (previousRoot === undefined) delete process.env.DKB_STACK_STATE_ROOT;
    else process.env.DKB_STACK_STATE_ROOT = previousRoot;
    if (previousBackups === undefined) delete process.env.DKB_STACK_BACKUP_ROOT;
    else process.env.DKB_STACK_BACKUP_ROOT = previousBackups;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(backups, { recursive: true, force: true });
  }
});
