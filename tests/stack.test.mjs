import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_DKB_DISTRIBUTION } from '@sjshovan/dkb-distribution-default';
import { backupDkbStack, composeArguments, prepareDkbStack, restoreDkbStack } from '../apps/cli/dist/stack/manager.js';
import { readDkbStack, readDkbStackControl, readEnvironmentFile, runtimeTokensForUrl, writeAtomic, writeStackProviderIdentityConfig } from '../apps/cli/dist/stack/context.js';
import { assertDockerAvailable, immutableDigestFromImageReference, localImageMetadataIssue } from '../apps/cli/dist/stack/docker.js';
import { resolveHostProviderIdentityOptions } from '../apps/cli/dist/providers/externalIdentities.js';

const dockerAvailable = process.env.DKB_SKIP_DOCKER_TESTS !== '1' && spawnSync('docker', ['version'], {
  encoding: 'utf8',
  timeout: 5_000,
  windowsHide: true,
}).status === 0;
if (process.env.DKB_REQUIRE_DOCKER_TESTS === '1') {
  assert.ok(dockerAvailable, 'This test run requires Docker; refusing to skip the stopped-stack backup and restore proof.');
}

test('Stack persists independent HTTP credentials with private reads and explicit public citations', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-stack-http-secrets-'));
  const names = ['DKB_STACK_STATE_ROOT', 'DKB_RUNTIME_READ_ACCESS', 'DKB_RUNTIME_ALLOWED_HOSTS',
    'DKB_RUNTIME_ALLOWED_ORIGINS', 'DKB_MCP_PUBLIC_DOCUMENTS', 'DKB_RUNTIME_READ_TOKEN', 'DKB_RUNTIME_ADMIN_TOKEN'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.DKB_STACK_STATE_ROOT = root;
  t.after(async () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const context = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'private-http');
  const values = await readEnvironmentFile(context.envFile);
  const secrets = ['DKB_RUNTIME_ADMIN_TOKEN', 'DKB_RUNTIME_READ_TOKEN', 'DKB_COMPILER_SERVICE_TOKEN', 'DKB_MCP_BEARER_TOKEN'];
  assert.equal(new Set(secrets.map(name => values[name])).size, 4);
  assert.ok(secrets.every(name => /^[A-Za-z0-9_-]{43}$/u.test(values[name])));
  assert.equal(values.DKB_RUNTIME_READ_ACCESS, 'authenticated');
  assert.equal(values.DKB_MCP_PUBLIC_DOCUMENTS, 'false');
  assert.ok(values.DKB_RUNTIME_ALLOWED_HOSTS.includes(`127.0.0.1:${values.DKB_RUNTIME_PORT}`));
  assert.deepEqual(await runtimeTokensForUrl(`http://127.0.0.1:${values.DKB_RUNTIME_PORT}`), {
    adminToken: values.DKB_RUNTIME_ADMIN_TOKEN, readToken: values.DKB_RUNTIME_READ_TOKEN,
  });
  assert.deepEqual(await runtimeTokensForUrl(`http://127.0.0.1:${values.DKB_RUNTIME_PORT}/other-runtime`), {});
  process.env.DKB_MCP_PUBLIC_DOCUMENTS = 'true';
  await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'private-http');
  const updated = await readEnvironmentFile(context.envFile);
  assert.equal(updated.DKB_MCP_PUBLIC_DOCUMENTS, 'true');
  for (const name of secrets) assert.equal(updated[name], values[name], name);
});

test('stack image checks reject stale version and revision labels', () => {
  const current = {
    'org.opencontainers.image.version': '0.2.0',
    'org.opencontainers.image.revision': 'abc123',
  };
  assert.equal(localImageMetadataIssue(current, '0.2.0', 'abc123'), null);
  assert.equal(localImageMetadataIssue(current, '0.2.0', 'development'), null);
  assert.match(localImageMetadataIssue(current, '0.3.0', 'abc123'), /version is 0\.2\.0; expected 0\.3\.0/u);
  assert.match(localImageMetadataIssue(current, '0.2.0', 'def456'), /revision is abc123; expected def456/u);
  assert.match(localImageMetadataIssue({}, '0.2.0', 'development'), /version is missing/u);
});

test('stack OCI identity resolution accepts only exact pinned references', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  assert.equal(immutableDigestFromImageReference(`example/provider:1.0@${digest}`), digest);
  assert.equal(immutableDigestFromImageReference('example/provider:latest'), null);
  assert.equal(immutableDigestFromImageReference('example/provider@sha256:not-a-digest'), null);
});

test('local composition resolves pinned provider images and rejects broken identity overrides', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-local-identity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const digest = `sha256:${'c'.repeat(64)}`;
  const evidenceService = DEFAULT_DKB_DISTRIBUTION.services.find((service) => service.id === 'evidence-docling-llamaindex');
  const distribution = {
    ...DEFAULT_DKB_DISTRIBUTION,
    services: [{ ...evidenceService, image: `example/evidence:1.0@${digest}` }],
  };
  const resolved = await resolveHostProviderIdentityOptions({ distribution, root, target: 'default' });
  assert.equal(resolved.targetOptions['@dkb/evidence-docling-llamaindex'].imageDigest, digest);

  await fs.mkdir(path.join(root, '.dkb'), { recursive: true });
  await fs.writeFile(path.join(root, '.dkb', 'config.json'), `${JSON.stringify({
    format: 'dkb.config.v2',
    activeTarget: 'default',
    targets: { default: { options: { '@dkb/evidence-docling-llamaindex': { imageDigest: 'sha256:mutable-tag-hash' } } } },
  })}\n`, 'utf8');
  await assert.rejects(
    resolveHostProviderIdentityOptions({ distribution, root, target: 'default' }),
    /will not replace a broken higher-precedence value/u,
  );
});

test('local composition does not resolve services belonging to replaced bundled providers', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-local-replaced-identity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.dkb'), { recursive: true });
  await fs.writeFile(path.join(root, '.dkb', 'config.json'), JSON.stringify({
    format: 'dkb.config.v2',
    targets: { default: { evidence: '@test/local', embedding: '@test/local', index: '@test/local', retrieval: '@test/local' } },
  }));
  const distribution = {
    ...DEFAULT_DKB_DISTRIBUTION,
    services: DEFAULT_DKB_DISTRIBUTION.services.map(service => ({ ...service, image: 'unavailable.invalid/unused:mutable' })),
  };
  const resolved = await resolveHostProviderIdentityOptions({ distribution, root, target: 'default' });
  for (const service of distribution.services) {
    if (service.providerId) assert.equal(resolved.targetOptions[service.providerId]?.imageDigest, undefined);
  }
});

test('local composition resolves bundled identities for renamed Pipeline targets', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-local-alias-identity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const digest = `sha256:${'d'.repeat(64)}`;
  const evidenceService = DEFAULT_DKB_DISTRIBUTION.services.find(service => service.id === 'evidence-docling-llamaindex');
  const distribution = {
    ...DEFAULT_DKB_DISTRIBUTION,
    services: [{ ...evidenceService, image: `example/evidence:1.0@${digest}` }],
  };
  await fs.mkdir(path.join(root, '.dkb'), { recursive: true });
  await fs.writeFile(path.join(root, '.dkb', 'config.json'), JSON.stringify({
    format: 'dkb.config.v2',
    targets: { renamed: DEFAULT_DKB_DISTRIBUTION.defaults.targets.default },
  }));
  assert.equal(evidenceService.requiredBy.includes('renamed'), false);
  const resolved = await resolveHostProviderIdentityOptions({ distribution, root, target: 'renamed' });
  assert.equal(resolved.target, 'renamed');
  assert.equal(resolved.targetOptions[evidenceService.providerId].imageDigest, digest);
});

test('local composition leaves same-ID filesystem replacements to their own identity contracts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-local-override-identity-'));
  const previousGlobal = process.env.DKB_GLOBAL_ROOT;
  t.after(async () => {
    if (previousGlobal === undefined) delete process.env.DKB_GLOBAL_ROOT;
    else process.env.DKB_GLOBAL_ROOT = previousGlobal;
    await fs.rm(root, { recursive: true, force: true });
  });
  const evidenceService = DEFAULT_DKB_DISTRIBUTION.services.find(service => service.id === 'evidence-docling-llamaindex');
  const distribution = {
    ...DEFAULT_DKB_DISTRIBUTION,
    services: [{ ...evidenceService, image: 'unavailable.invalid/unused:mutable' }],
  };
  for (const scope of ['runtime', 'library', 'global']) {
    const runtimeRoot = path.join(root, scope, 'runtime');
    const libraryRoot = path.join(root, scope, 'library');
    const globalRoot = path.join(root, scope, 'global');
    process.env.DKB_GLOBAL_ROOT = globalRoot;
    const pluginsRoot = scope === 'global' ? path.join(globalRoot, 'plugins')
      : path.join(scope === 'library' ? libraryRoot : runtimeRoot, '.dkb', 'plugins');
    const pluginRoot = path.join(pluginsRoot, '@dkb', 'evidence-docling-llamaindex');
    await fs.mkdir(pluginRoot, { recursive: true });
    await fs.writeFile(path.join(pluginRoot, 'plugin.mjs'), 'throw new Error("Identity discovery must not execute operator code");');
    const resolved = await resolveHostProviderIdentityOptions({ distribution, root: runtimeRoot, libraryRoot, target: 'default' });
    assert.equal(resolved.targetOptions[evidenceService.providerId]?.imageDigest, undefined, scope);
  }
});

test('local composition rejects an incomplete override before considering bundled service identities', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-local-broken-identity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pluginRoot = path.join(root, '.dkb', 'plugins', '@dkb', 'evidence-docling-llamaindex');
  await fs.mkdir(pluginRoot, { recursive: true });
  const evidenceService = DEFAULT_DKB_DISTRIBUTION.services.find(service => service.id === 'evidence-docling-llamaindex');
  const distribution = {
    ...DEFAULT_DKB_DISTRIBUTION,
    services: [{ ...evidenceService, image: `example/evidence:1.0@sha256:${'e'.repeat(64)}` }],
  };
  await assert.rejects(resolveHostProviderIdentityOptions({ distribution, root, target: 'default' }), /override is incomplete.*will not fall back/u);
});

test('stack writes exact provider OCI identities into compiler and Runtime contexts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-stack-identity-'));
  const previousRoot = process.env.DKB_STACK_STATE_ROOT;
  process.env.DKB_STACK_STATE_ROOT = root;
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.DKB_STACK_STATE_ROOT;
    else process.env.DKB_STACK_STATE_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  });
  const context = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'identity', { compilerTarget: 'default', runtimeTarget: 'fastembed-faiss' });
  const digests = Object.fromEntries(context.requiredServices
    .filter((service) => service.providerExternalIdentities?.some((identity) => identity.kind === 'image'))
    .map((service, index) => [service.id, `sha256:${String(index + 1).repeat(64)}`]));
  await writeStackProviderIdentityConfig(context, digests, DEFAULT_DKB_DISTRIBUTION);
  const compiler = JSON.parse(await fs.readFile(path.join(context.root, 'compiler-context', '.dkb', 'config.json'), 'utf8'));
  const runtime = JSON.parse(await fs.readFile(path.join(context.runtimeStateRoot, '.dkb', 'config.json'), 'utf8'));

  assert.equal(compiler.targets.default.options['@dkb/evidence-docling-llamaindex'].imageDigest, digests['evidence-docling-llamaindex']);
  assert.equal(compiler.targets.default.options['@dkb/embedding-tei'].imageDigest, digests['embedding-tei']);
  assert.equal(compiler.targets.default.options['@dkb/index-faiss'].imageDigest, digests['index-faiss']);
  assert.equal(runtime.targets['fastembed-faiss'].options['@dkb/embedding-fastembed'].imageDigest, digests['embedding-fastembed']);
  assert.equal(runtime.targets['fastembed-faiss'].options['@dkb/index-faiss'].imageDigest, digests['index-faiss']);
  assert.equal(runtime.activeTarget, 'fastembed-faiss');
  assert.equal(runtime.targets.default.options['@dkb/evidence-docling-llamaindex'].imageDigest, digests['evidence-docling-llamaindex']);
  assert.equal(runtime.targets.default.options['@dkb/embedding-tei'].imageDigest, digests['embedding-tei']);
  assert.equal(runtime.targets.default.options['@dkb/index-faiss'].imageDigest, digests['index-faiss']);
  const staged = await resolveHostProviderIdentityOptions({
    distribution: DEFAULT_DKB_DISTRIBUTION,
    root: context.runtimeStateRoot,
    libraryRoot: context.libraryRoot,
    target: 'default',
  });
  assert.equal(staged.target, 'default');
  assert.equal(staged.targetOptions['@dkb/evidence-docling-llamaindex'].imageDigest, digests['evidence-docling-llamaindex']);
  assert.equal(staged.targetOptions['@dkb/embedding-tei'].imageDigest, digests['embedding-tei']);
});

test('stack Docker preflight fails quickly when the engine is unavailable', () => {
  const started = Date.now();
  const previousPath = process.env.PATH;
  process.env.PATH = '';
  try {
    assert.throws(assertDockerAvailable, /Docker did not respond|Docker engine is not available/iu);
    assert.ok(Date.now() - started < 10_000, 'Docker preflight exceeded its bounded timeout');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test('stack preparation generates reusable local secrets without returning them', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-stack-test-'));
  const previousRoot = process.env.DKB_STACK_STATE_ROOT;
  process.env.DKB_STACK_STATE_ROOT = root;

  try {
    const first = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'proof-stack', { compilerTarget: 'default', runtimeTarget: 'default' });
    const firstEnvironment = await fs.readFile(first.envFile, 'utf8');
    const second = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'proof-stack', { compilerTarget: 'default', runtimeTarget: 'default' });
    const secondEnvironment = await fs.readFile(second.envFile, 'utf8');

    assert.equal(firstEnvironment, secondEnvironment);
    assert.match(firstEnvironment, /DKB_REGISTRY_APP_KEY=base64:/);
    assert.match(firstEnvironment, /DKB_REGISTRY_BOOTSTRAP_NAMESPACE=proof-stack/);
    assert.match(firstEnvironment, /DKB_REGISTRY_BOOTSTRAP_TOKEN=dkb_/);
    assert.match(firstEnvironment, /^DKB_COMPILER_ALLOWED_TARGETS=$/mu);
    assert.match(firstEnvironment, /^DKB_COMPILER_DEFAULT_TARGET=default$/mu);
    assert.match(firstEnvironment, /DKB_MCP_BEARER_TOKEN=/);
    assert.match(firstEnvironment, /DKB_PUBLIC_URL=http:\/\/127\.0\.0\.1:\d+/);
    assert.match(firstEnvironment, /DKB_MCP_PUBLIC_BASE_URL=http:\/\/127\.0\.0\.1:\d+/);
    assert.match(firstEnvironment, /DKB_MCP_ALLOW_INSECURE_NO_AUTH=false/);
    assert.match(firstEnvironment, /DKB_MCP_ALLOWED_HOSTS=127\.0\.0\.1,localhost/);
    assert.match(firstEnvironment, /DKB_MCP_ALLOWED_ORIGINS=127\.0\.0\.1,localhost/);
    assert.doesNotMatch(JSON.stringify(first), /DKB_MCP_BEARER_TOKEN|DKB_REGISTRY_APP_KEY|DKB_REGISTRY_BOOTSTRAP_TOKEN/);
    assert.equal(first.composeFile.endsWith(path.join('dist', 'stack', 'compose.yaml')), true);
    assert.deepEqual(
      composeArguments(first, ['up']).slice(-5),
      ['--profile', 'tei', '--profile', 'faiss', 'up'],
    );
    assert.deepEqual(first.inactiveComposeServices, ['dkb-embedder', 'meilisearch']);
    assert.deepEqual(
      composeArguments(first, ['rm', '--force', '--stop', ...first.inactiveComposeServices], 'all').slice(-13),
      ['--profile', 'fastembed', '--profile', 'tei', '--profile', 'faiss', '--profile', 'meilisearch', 'rm', '--force', '--stop', 'dkb-embedder', 'meilisearch'],
    );
  } finally {
    if (previousRoot === undefined) delete process.env.DKB_STACK_STATE_ROOT;
    else process.env.DKB_STACK_STATE_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('stack preparation leaves an existing Runtime binding unchanged until activation promotes the new target', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-stack-runtime-bootstrap-test-'));
  const previousRoot = process.env.DKB_STACK_STATE_ROOT;
  process.env.DKB_STACK_STATE_ROOT = root;

  try {
    const first = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'runtime-bootstrap', {
      compilerTarget: 'fastembed-faiss',
      runtimeTarget: 'fastembed-faiss',
    });
    const bindingPath = path.join(first.runtimeStateRoot, '.dkb', 'runtime-binding.json');
    const initialBindingSource = await fs.readFile(bindingPath, 'utf8');
    const initialBinding = JSON.parse(initialBindingSource);

    const prepared = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'runtime-bootstrap', {
      compilerTarget: 'tei-faiss',
      runtimeTarget: 'tei-faiss',
    });
    const preparedBindingSource = await fs.readFile(bindingPath, 'utf8');
    const runtimeConfig = JSON.parse(await fs.readFile(path.join(prepared.runtimeStateRoot, '.dkb', 'config.json'), 'utf8'));

    assert.equal(initialBinding.target, 'fastembed-faiss');
    assert.equal(initialBinding.library.path, '/library');
    assert.equal(prepared.runtimeTarget, 'tei-faiss');
    assert.equal(runtimeConfig.activeTarget, 'fastembed-faiss');
    assert.equal(preparedBindingSource, initialBindingSource);
  } finally {
    if (previousRoot === undefined) delete process.env.DKB_STACK_STATE_ROOT;
    else process.env.DKB_STACK_STATE_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('unlocked development stacks refresh local-build images without retaining retired image keys', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-stack-image-refresh-test-'));
  const previousRoot = process.env.DKB_STACK_STATE_ROOT;
  process.env.DKB_STACK_STATE_ROOT = root;

  try {
    const stackRoot = path.join(root, 'image-refresh');
    await fs.mkdir(stackRoot, { recursive: true });
    await fs.writeFile(path.join(stackRoot, 'stack.env'), [
      'DKB_STACK_NAME=image-refresh',
      'DKB_COMPILER_IMAGE=dkb-compiler:0.1.0',
      'DKB_RUNTIME_IMAGE=dkb-runtime:0.1.0',
      'DKB_PROVIDER_IMAGE=dkb-provider-sidecar:0.1.0',
      '',
    ].join('\n'), 'utf8');

    const stack = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'image-refresh', { compilerTarget: 'default', runtimeTarget: 'default' });
    const environment = await fs.readFile(stack.envFile, 'utf8');
    assert.match(environment, /^DKB_COMPILER_IMAGE=dkb-compiler:0\.2\.0$/mu);
    assert.match(environment, /^DKB_RUNTIME_IMAGE=dkb-runtime:0\.2\.0$/mu);
    assert.doesNotMatch(environment, /DKB_PROVIDER_IMAGE/u);
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
    const stack = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'meili-proof', { compilerTarget: 'tei-meilisearch', runtimeTarget: 'tei-meilisearch' });
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
    const stack = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'tei-proof', { compilerTarget: 'tei-meilisearch', runtimeTarget: 'tei-meilisearch' });
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
    const first = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'target-transaction', {
      compilerTarget: 'fastembed-faiss',
      runtimeTarget: 'fastembed-faiss',
    });

    const switchedCompiler = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'target-transaction', { compilerTarget: 'tei-faiss' });
    const compiler = JSON.parse(await fs.readFile(path.join(switchedCompiler.root, 'compiler-context', '.dkb', 'config.json'), 'utf8'));
    const runtime = JSON.parse(await fs.readFile(path.join(switchedCompiler.root, 'runtime', '.dkb', 'config.json'), 'utf8'));
    const environment = await fs.readFile(switchedCompiler.envFile, 'utf8');

    assert.deepEqual(
      composeArguments(first, ['down']).slice(-9),
      ['--profile', 'fastembed', '--profile', 'tei', '--profile', 'faiss', '--profile', 'meilisearch', 'down'],
    );
    assert.equal(compiler.activeTarget, 'tei-faiss');
    assert.equal(runtime.activeTarget, 'fastembed-faiss');
    assert.equal(switchedCompiler.runtimeTarget, 'fastembed-faiss');
    assert.deepEqual(switchedCompiler.profiles, ['fastembed', 'tei', 'faiss']);
    assert.deepEqual(switchedCompiler.inactiveComposeServices, ['meilisearch']);
    assert.match(environment, /^DKB_PIPELINE_TARGET=tei-faiss$/mu);
    assert.match(environment, /^DKB_COMPILER_ALLOWED_TARGETS=$/mu);
    assert.match(environment, /^DKB_COMPILER_DEFAULT_TARGET=tei-faiss$/mu);
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
      () => prepareDkbStack(distribution, 'local', { compilerTarget: 'not-a-target' }),
      /not-a-target.*not configured/u,
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

async function isolatedStack(t, name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `dkb-stack-${name}-`));
  const keys = ['DKB_STACK_STATE_ROOT', 'DKB_COMPILER_ALLOWED_TARGETS', 'DKB_COMPILER_DEFAULT_TARGET'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.DKB_STACK_STATE_ROOT = root;
  delete process.env.DKB_COMPILER_ALLOWED_TARGETS;
  delete process.env.DKB_COMPILER_DEFAULT_TARGET;
  t.after(async () => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, stackRoot: path.join(root, name) };
}

async function writeStackConfig(root, config) {
  const file = path.join(root, '.dkb', 'config.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(config));
  return file;
}

function stackImageDigests(context, digit = 'a') {
  return Object.fromEntries(context.requiredServices.filter(service => service.providerExternalIdentities?.length)
    .map(service => [service.id, `sha256:${digit.repeat(64)}`]));
}

test('Stack preserves trusted recipes, processors, options, Registry association and Library mount across preparation and attestation', async t => {
  const { root, stackRoot } = await isolatedStack(t, 'preserved');
  const libraryRoot = path.join(root, 'separate-library');
  const compilerRoot = path.join(stackRoot, 'compiler-context');
  const runtimeRoot = path.join(stackRoot, 'runtime');
  const recipe = structuredClone(DEFAULT_DKB_DISTRIBUTION.defaults.targets.default);
  recipe.processors = ['@operator/normalize'];
  recipe.options['@dkb/evidence-docling-llamaindex'] = { richFiles: false, workers: 2 };
  const original = { format: 'dkb.config.v2', activeTarget: 'research', registry: { url: 'https://registry.example.test' },
    targets: { research: recipe, future: { ...recipe, processors: ['@operator/other'] } } };
  const compilerPath = await writeStackConfig(compilerRoot, original);
  const runtimePath = await writeStackConfig(runtimeRoot, original);
  process.env.DKB_COMPILER_ALLOWED_TARGETS = 'research,fastembed-faiss';
  const first = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'preserved', { libraryRoot });
  assert.equal(first.target, 'research');
  assert.equal(first.runtimeTarget, 'research');
  assert.deepEqual(first.compilerTargets, ['fastembed-faiss', 'research']);
  assert.deepEqual(first.requiredServices.map(service => service.id),
    DEFAULT_DKB_DISTRIBUTION.services.filter(service => !service.providerId ||
      ['@dkb/evidence-docling-llamaindex', '@dkb/embedding-tei', '@dkb/index-faiss'].includes(service.providerId)).map(service => service.id));
  const bindingPath = path.join(runtimeRoot, '.dkb', 'runtime-binding.json');
  const binding = await fs.readFile(bindingPath, 'utf8');
  await writeStackProviderIdentityConfig(first, stackImageDigests(first), DEFAULT_DKB_DISTRIBUTION);
  delete process.env.DKB_COMPILER_ALLOWED_TARGETS;
  const second = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'preserved');
  await writeStackProviderIdentityConfig(second, stackImageDigests(second), DEFAULT_DKB_DISTRIBUTION);
  assert.equal(second.libraryRoot, libraryRoot);
  assert.equal((await readDkbStack(DEFAULT_DKB_DISTRIBUTION, 'preserved')).libraryRoot, libraryRoot);
  assert.equal(await fs.readFile(bindingPath, 'utf8'), binding);
  assert.match(await fs.readFile(second.envFile, 'utf8'), /^DKB_COMPILER_ALLOWED_TARGETS=fastembed-faiss,research$/mu);
  for (const file of [compilerPath, runtimePath]) {
    const current = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(current.registry, original.registry);
    assert.deepEqual(current.targets.research.processors, recipe.processors);
    assert.equal(current.targets.research.options['@dkb/evidence-docling-llamaindex'].richFiles, false);
    assert.equal(current.targets.research.options['@dkb/evidence-docling-llamaindex'].workers, 2);
    assert.deepEqual(current.targets.future.processors, original.targets.future.processors);
    assert.equal(current.targets.research.options['@dkb/embedding-tei'].model, recipe.options['@dkb/embedding-tei'].model);
    assert.equal(current.targets.research.options['@dkb/embedding-tei'].imageDigest, `sha256:${'a'.repeat(64)}`);
  }
});

test('Stack compiler default and explicit restrictions have independent process and saved precedence', async t => {
  await isolatedStack(t, 'restriction');
  process.env.DKB_COMPILER_ALLOWED_TARGETS = 'default,fastembed-faiss';
  process.env.DKB_COMPILER_DEFAULT_TARGET = 'fastembed-faiss';
  const first = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'restriction');
  assert.equal(first.target, 'fastembed-faiss');
  delete process.env.DKB_COMPILER_DEFAULT_TARGET;
  delete process.env.DKB_COMPILER_ALLOWED_TARGETS;
  assert.equal((await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'restriction')).target, 'fastembed-faiss');
  const explicit = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'restriction', { compilerTarget: 'default' });
  assert.deepEqual(explicit.compilerTargets, ['default', 'fastembed-faiss']);
  const before = await fs.readFile(explicit.envFile, 'utf8');
  await assert.rejects(prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'restriction', { compilerTarget: 'tei-meilisearch' }), /default target.*not allowed/u);
  assert.equal(await fs.readFile(explicit.envFile, 'utf8'), before);
  process.env.DKB_COMPILER_ALLOWED_TARGETS = 'does-not-exist';
  await assert.rejects(prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'restriction'), /unknown target/u);
  assert.equal(await fs.readFile(explicit.envFile, 'utf8'), before);
  process.env.DKB_COMPILER_ALLOWED_TARGETS = '';
  const unrestricted = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'restriction');
  assert.deepEqual(unrestricted.compilerTargets, Object.keys(DEFAULT_DKB_DISTRIBUTION.defaults.targets).sort());
  assert.match(await fs.readFile(unrestricted.envFile, 'utf8'), /^DKB_COMPILER_ALLOWED_TARGETS=$/mu);
  const compose = await fs.readFile(path.join('deploy', 'compose.yaml'), 'utf8');
  assert.match(compose, /DKB_COMPILER_ALLOWED_TARGETS: \$\{DKB_COMPILER_ALLOWED_TARGETS-\}/u);
});

test('Stack uses mounted Library recipes but does not import host-global-only recipes into containers', async t => {
  const { root } = await isolatedStack(t, 'mounted');
  const libraryRoot = path.join(root, 'knowledge');
  await writeStackConfig(libraryRoot, { format: 'dkb.config.v2', activeTarget: 'library-recipe',
    targets: { 'library-recipe': DEFAULT_DKB_DISTRIBUTION.defaults.targets['fastembed-faiss'] } });
  const previous = process.env.DKB_GLOBAL_ROOT;
  process.env.DKB_GLOBAL_ROOT = path.join(root, 'host-global');
  await fs.mkdir(process.env.DKB_GLOBAL_ROOT, { recursive: true });
  await fs.writeFile(path.join(process.env.DKB_GLOBAL_ROOT, 'config.json'), JSON.stringify({ format: 'dkb.config.v2',
    targets: { 'host-only': DEFAULT_DKB_DISTRIBUTION.defaults.targets.default } }));
  try {
    const current = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'mounted', { libraryRoot });
    assert.equal(current.runtimeTarget, 'library-recipe');
    assert.equal(current.compilerTargets.includes('host-only'), false);
    await assert.rejects(prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'mounted', { compilerTarget: 'host-only' }), /not configured/u);
  } finally {
    if (previous === undefined) delete process.env.DKB_GLOBAL_ROOT;
    else process.env.DKB_GLOBAL_ROOT = previous;
  }
});

test('Stack planning does not load same-ID overrides or assign them bundled sidecars', async t => {
  const { stackRoot } = await isolatedStack(t, 'replacement');
  for (const scope of ['compiler-context', 'runtime']) {
    const pluginRoot = path.join(stackRoot, scope, '.dkb', 'plugins', '@dkb', 'embedding-tei');
    await fs.mkdir(pluginRoot, { recursive: true });
    await fs.writeFile(path.join(pluginRoot, 'plugin.mjs'), 'throw new Error("Stack planning must not execute plugins");');
  }
  const current = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'replacement');
  assert.equal(current.requiredServices.some(service => service.id === 'embedding-tei'), false);
  assert.equal(current.profiles.includes('tei'), false);
  await writeStackProviderIdentityConfig(current, stackImageDigests(current), DEFAULT_DKB_DISTRIBUTION);
  const config = JSON.parse(await fs.readFile(path.join(stackRoot, 'compiler-context', '.dkb', 'config.json'), 'utf8'));
  assert.equal(config.targets.default.options['@dkb/embedding-tei'], undefined);
  const plugin = path.join(stackRoot, 'compiler-context', '.dkb', 'plugins', '@dkb', 'embedding-tei', 'plugin.mjs');
  await fs.rm(plugin);
  await assert.rejects(prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'replacement'), /override is incomplete.*will not fall back/u);
});

test('Stack retains unresolved inactive recipes without silently restricting the compiler catalog', async t => {
  const { stackRoot } = await isolatedStack(t, 'unavailable');
  const compilerRoot = path.join(stackRoot, 'compiler-context');
  const file = await writeStackConfig(compilerRoot, { format: 'dkb.config.v2', activeTarget: 'default', targets: {
    incomplete: { index: '@operator/not-ready' },
    malformed: { ...DEFAULT_DKB_DISTRIBUTION.defaults.targets.default, options: {
      '@dkb/embedding-tei': { imageDigest: 'not-an-image-digest' },
    } },
  } });
  const unusedPluginRoot = path.join(compilerRoot, '.dkb', 'plugins', '@dkb', 'embedding-fastembed');
  await fs.mkdir(unusedPluginRoot, { recursive: true });
  const current = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'unavailable');
  assert.equal(current.compilerTargets.includes('incomplete'), true);
  assert.equal(current.compilerTargets.includes('malformed'), true);
  assert.equal(current.compilerTargets.includes('fastembed-faiss'), true);
  await writeStackProviderIdentityConfig(current, stackImageDigests(current), DEFAULT_DKB_DISTRIBUTION);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(saved.targets.incomplete, { index: '@operator/not-ready' });
  assert.equal(saved.targets.malformed.options['@dkb/embedding-tei'].imageDigest, 'not-an-image-digest');
  assert.match(await fs.readFile(current.envFile, 'utf8'), /^DKB_COMPILER_ALLOWED_TARGETS=$/mu);
  await assert.rejects(prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'unavailable', { compilerTarget: 'fastembed-faiss' }), /override is incomplete/u);
});

test('Stack image preparation rejects changed recipe options even when service choices and model are unchanged', async t => {
  const { stackRoot } = await isolatedStack(t, 'recipe-drift');
  const current = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'recipe-drift');
  const compilerFile = path.join(stackRoot, 'compiler-context', '.dkb', 'config.json');
  const runtimeFile = path.join(stackRoot, 'runtime', '.dkb', 'config.json');
  const edited = JSON.parse(await fs.readFile(compilerFile, 'utf8'));
  edited.targets = { default: { options: { '@dkb/embedding-tei': { dimensions: 769 } } } };
  await fs.writeFile(compilerFile, JSON.stringify(edited));
  const before = await Promise.all([compilerFile, runtimeFile].map(file => fs.readFile(file, 'utf8')));
  await assert.rejects(writeStackProviderIdentityConfig(current, stackImageDigests(current), DEFAULT_DKB_DISTRIBUTION), /configuration changed/u);
  assert.deepEqual(await Promise.all([compilerFile, runtimeFile].map(file => fs.readFile(file, 'utf8'))), before);
});

test('Stack refuses conflicting shared service options and preserves explicit image pins', async t => {
  const { stackRoot } = await isolatedStack(t, 'conflict');
  const current = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'conflict');
  const environment = await fs.readFile(current.envFile, 'utf8');
  await assert.rejects(prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'conflict', { compilerTarget: 'tei-faiss-768', runtimeTarget: 'default' }), /different.*model.*shared Stack service/u);
  assert.equal(await fs.readFile(current.envFile, 'utf8'), environment);
  const compilerPath = path.join(stackRoot, 'compiler-context', '.dkb', 'config.json');
  const runtimePath = path.join(stackRoot, 'runtime', '.dkb', 'config.json');
  const pinned = { format: 'dkb.config.v2', activeTarget: 'default', targets: { default: { options: {
    '@dkb/embedding-tei': { imageDigest: `sha256:${'b'.repeat(64)}` },
  } } } };
  await fs.writeFile(compilerPath, JSON.stringify(pinned));
  const compilerBefore = await fs.readFile(compilerPath, 'utf8');
  const runtimeBefore = await fs.readFile(runtimePath, 'utf8');
  await assert.rejects(writeStackProviderIdentityConfig(await readDkbStack(DEFAULT_DKB_DISTRIBUTION, 'conflict'), stackImageDigests(current), DEFAULT_DKB_DISTRIBUTION), /will not overwrite operator options/u);
  assert.equal(await fs.readFile(compilerPath, 'utf8'), compilerBefore);
  assert.equal(await fs.readFile(runtimePath, 'utf8'), runtimeBefore);
});

test('Stack atomic replacement never unlinks the authoritative file and preserves it on rename failure', async t => {
  const { root } = await isolatedStack(t, 'atomic');
  const file = path.join(root, 'config.json');
  await fs.writeFile(file, 'old');
  const rename = fs.rename.bind(fs);
  const remove = fs.rm.bind(fs);
  const removed = [];
  t.mock.method(fs, 'rm', async (target, ...options) => { removed.push(target); return remove(target, ...options); });
  const renameMock = t.mock.method(fs, 'rename', async () => { throw Object.assign(new Error('synthetic busy target'), { code: 'EBUSY' }); });
  await assert.rejects(writeAtomic(file, 'new'), /synthetic busy target/u);
  assert.equal(await fs.readFile(file, 'utf8'), 'old');
  assert.equal(removed.includes(file), false);
  assert.deepEqual(await fs.readdir(root), ['config.json']);
  renameMock.mock.mockImplementation(rename);
  await writeAtomic(file, 'new');
  assert.equal(await fs.readFile(file, 'utf8'), 'new');
  assert.equal(removed.includes(file), false);
  const before = (await fs.stat(file, { bigint: true })).mtimeNs;
  await writeAtomic(file, 'new');
  assert.equal((await fs.stat(file, { bigint: true })).mtimeNs, before);
  t.mock.restoreAll();
});

test('Stack stop and log controls retain exact project topology when the active recipe is broken', async t => {
  const { stackRoot } = await isolatedStack(t, 'recoverable');
  const current = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'recoverable');
  const file = path.join(stackRoot, 'compiler-context', '.dkb', 'config.json');
  await fs.writeFile(file, '{broken');
  await assert.rejects(prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'recoverable'), /Invalid DKB configuration/u);
  await assert.rejects(readDkbStack(DEFAULT_DKB_DISTRIBUTION, 'recoverable'), /Invalid DKB configuration/u);
  const control = await readDkbStackControl(DEFAULT_DKB_DISTRIBUTION, 'recoverable');
  assert.equal(control.projectName, 'dkb-recoverable');
  assert.equal(control.envFile, current.envFile);
  assert.equal('requiredServices' in control, false);
  for (const command of [['down', '--remove-orphans'], ['logs', '--tail', '200']]) {
    const args = composeArguments(control, command);
    assert.deepEqual(args.slice(0, 7), ['compose', '--env-file', current.envFile, '-p', 'dkb-recoverable', '-f', current.composeFile]);
    assert.deepEqual(args.slice(-command.length), command);
    assert.equal(args.filter(value => value === '--profile').length, current.allProfiles.length);
  }
  assert.throws(() => composeArguments(control, ['up', '-d']), /startup requires validated recipe resolution/u);
});

test('Stack image attestation does not substitute the running image into another recipe image', async t => {
  const { stackRoot } = await isolatedStack(t, 'separate-images');
  const customImage = 'example.test/tei:operator-pinned';
  const compilerRoot = path.join(stackRoot, 'compiler-context');
  await writeStackConfig(compilerRoot, { format: 'dkb.config.v2', targets: { separate: {
    ...DEFAULT_DKB_DISTRIBUTION.defaults.targets.default,
    options: { '@dkb/embedding-tei': { image: customImage } },
  } } });
  const current = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'separate-images');
  await writeStackProviderIdentityConfig(current, stackImageDigests(current), DEFAULT_DKB_DISTRIBUTION);
  const configPath = path.join(compilerRoot, '.dkb', 'config.json');
  const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(saved.targets.separate.options['@dkb/embedding-tei'].imageDigest, undefined);
  await writeStackConfig(path.join(stackRoot, 'runtime'), { format: 'dkb.config.v2', targets: { separate: saved.targets.separate } });
  const selected = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'separate-images', { compilerTarget: 'separate', runtimeTarget: 'separate' });
  assert.match(await fs.readFile(selected.envFile, 'utf8'), /^DKB_TEI_IMAGE=example\.test\/tei:operator-pinned$/mu);
  const selectedDigests = { ...stackImageDigests(selected), 'embedding-tei': `sha256:${'b'.repeat(64)}` };
  await writeStackProviderIdentityConfig(selected, selectedDigests, DEFAULT_DKB_DISTRIBUTION);
  assert.equal(JSON.parse(await fs.readFile(configPath, 'utf8')).targets.separate.options['@dkb/embedding-tei'].imageDigest, `sha256:${'b'.repeat(64)}`);
});

test('stopped stack backup and restore preserve state with a verified sidecar', { skip: !dockerAvailable }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-stack-backup-test-'));
  const backups = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-stack-backup-output-'));
  const previousRoot = process.env.DKB_STACK_STATE_ROOT;
  const previousBackups = process.env.DKB_STACK_BACKUP_ROOT;
  process.env.DKB_STACK_STATE_ROOT = root;
  process.env.DKB_STACK_BACKUP_ROOT = backups;
  const originalSpawnSync = childProcess.spawnSync;
  childProcess.spawnSync = (...args) => {
    const started = performance.now();
    const result = originalSpawnSync(...args);
    if (args[0] === 'docker' && args[1]?.[0] === 'compose' && args[1]?.[1] === 'version'
      && (result.error || result.status !== 0)) {
      t.diagnostic(JSON.stringify({ probe: 'docker compose version', elapsedMs: performance.now() - started,
        errorCode: result.error?.code ?? null, status: result.status, signal: result.signal,
        stdout: String(result.stdout ?? '').slice(-2048),
        stderr: String(result.stderr ?? '').slice(-2048) }));
    }
    return result;
  };
  syncBuiltinESMExports();

  try {
    const stack = await prepareDkbStack(DEFAULT_DKB_DISTRIBUTION, 'backup-proof', { compilerTarget: 'fastembed-faiss', runtimeTarget: 'fastembed-faiss' });
    await fs.writeFile(path.join(stack.root, 'runtime', 'proof.txt'), 'preserve me', 'utf8');
    const backup = await backupDkbStack(DEFAULT_DKB_DISTRIBUTION, 'backup-proof');
    assert.equal(backup.containsSecrets, true);
    assert.equal((await fs.readFile(backup.checksumFile, 'utf8')).startsWith(backup.sha256), true);

    await fs.rm(stack.root, { recursive: true, force: true });
    const restored = await restoreDkbStack(DEFAULT_DKB_DISTRIBUTION, backup.archive);
    assert.equal(await fs.readFile(path.join(restored.stateRoot, 'runtime', 'proof.txt'), 'utf8'), 'preserve me');
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    syncBuiltinESMExports();
    if (previousRoot === undefined) delete process.env.DKB_STACK_STATE_ROOT;
    else process.env.DKB_STACK_STATE_ROOT = previousRoot;
    if (previousBackups === undefined) delete process.env.DKB_STACK_BACKUP_ROOT;
    else process.env.DKB_STACK_BACKUP_ROOT = previousBackups;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(backups, { recursive: true, force: true });
  }
});
