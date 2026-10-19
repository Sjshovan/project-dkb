import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DKB_CONFIG_FORMAT } from '@sjshovan/dkb-pipeline/config.js';
import { createDkbPackageArchive, extractDkbPackageArchive } from '@sjshovan/dkb-library/archive.js';
import { validatePackageBuildGraph } from '@sjshovan/dkb-library/builds.js';
import { resolveRegistryCompilerCatalog, resolveRegistryCompilerTarget } from '@sjshovan/dkb-compiler/registryTargets.js';
import { serveDkbRegistryCompiler } from '@sjshovan/dkb-compiler/server.js';
import { compileRegistryPackage } from '../services/compiler/dist/registryCompilation.js';
import { readCompilerBuildIdentity } from '../services/compiler/dist/compilerCapabilities.js';
import { materializeBundledProviderFixtures } from './bundled-provider-fixture.mjs';
import { observeLoopbackTransport } from './fixtures/loopback-transport-diagnostics.mjs';

const optionsSchema = { '~standard': { version: 1, vendor: 'test', validate(value) { return { value: value ?? {} }; } } };

async function distribution(t, healthy = true, identity) {
  const id = '@test/registry-compiler';
  return materializeBundledProviderFixtures(t, {
    id: '@test/distribution',
    version: '1.0.0',
    defaults: {
      format: DKB_CONFIG_FORMAT,
      activeTarget: 'trusted',
      targets: { trusted: { evidence: id, index: id, retrieval: id } },
    },
    plugins: [{
      apiVersion: 3,
      id,
      version: '1.0.0',
      sourceUrl: import.meta.url,
      optionsSchema,
      ...(identity ? { identity } : {}),
      integrity: { apiVersion: 3, id, version: '1.0.0', externalDigests: {}, protocols: ['test.evidence.v1'], artifactFormats: ['test.index.v1'] },
      setup(context) {
        const health = async () => ({ ok: healthy, detail: healthy ? 'ready' : 'fixture unavailable' });
        context.registerProvider({ kind: 'evidence', async compile() { return { records: [], receipt: { build: {} } }; }, health });
        context.registerProvider({
          kind: 'index', mode: 'packaged', format: 'test.index.v1', capabilities: { vectors: 'none' },
          async compilePackage() { return { build: {} }; }, async validatePackage() { return { documentCount: 0 }; },
          async verifyRuntime() { return { indexId: 'test', documentCount: 0, status: 'ready' }; },
          async openRuntime() { return { providerId: id, format: 'test.index.v1', async search() { return { candidates: [], trace: {} }; }, async close() {} }; },
          health,
        });
        context.registerProvider({
          kind: 'retrieval', protocol: 'test.evidence.v1', capabilities: { vectors: 'none' },
          async openRuntime() { return { providerId: id, protocol: 'test.evidence.v1', async search() { return { hits: [], trace: {} }; }, async close() {} }; },
          health,
        });
      },
    }],
    services: [],
  });
}

async function distributionRequiringOciIdentity(t) {
  const id = '@test/registry-compiler';
  const digestOption = 'imageDigest';
  const fixture = await distribution(t, true, ({ options }) => ({
    external: typeof options[digestOption] === 'string'
      ? [{ kind: 'image', name: 'fixture-worker', digest: options[digestOption] }]
      : [],
  }));
  return {
    ...fixture,
    defaults: {
      ...fixture.defaults,
      targets: {
        trusted: {
          ...fixture.defaults.targets.trusted,
          options: { [id]: {} },
        },
      },
    },
    services: [{
      id: 'fixture-worker',
      kind: 'docker',
      providerId: id,
      requiredBy: ['trusted'],
      providerExternalIdentities: [{ kind: 'image', name: 'fixture-worker', option: digestOption }],
      image: 'fixture-worker:latest',
    }],
  };
}

test('Registry compiler advertises only its allowlisted target and rejects digest drift', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-registry-targets-'));
  const previousAllowed = process.env.DKB_COMPILER_ALLOWED_TARGETS;
  const previousDefault = process.env.DKB_COMPILER_DEFAULT_TARGET;
  t.after(async () => {
    setEnvironment('DKB_COMPILER_ALLOWED_TARGETS', previousAllowed);
    setEnvironment('DKB_COMPILER_DEFAULT_TARGET', previousDefault);
    await fs.rm(root, { recursive: true, force: true });
  });
  process.env.DKB_COMPILER_ALLOWED_TARGETS = 'trusted';
  process.env.DKB_COMPILER_DEFAULT_TARGET = 'trusted';
  const catalog = await resolveRegistryCompilerCatalog(await distribution(t), root);
  assert.equal(catalog.defaultTarget, 'trusted');
  assert.deepEqual(catalog.targets.map((target) => target.name), ['trusted']);
  assert.equal(catalog.targets[0].available, true);
  await assert.rejects(
    resolveRegistryCompilerTarget({
      distribution: await distribution(t),
      contextRoot: root,
      target: 'trusted',
      expected: { compatibilityDigest: `sha256:${'0'.repeat(64)}` },
    }),
    /target trusted drifted: expected compatibilityDigest/u,
  );
});

test('Registry compiler fails closed until a trusted exact OCI identity is configured', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-registry-oci-'));
  const previousAllowed = process.env.DKB_COMPILER_ALLOWED_TARGETS;
  const previousDefault = process.env.DKB_COMPILER_DEFAULT_TARGET;
  t.after(async () => {
    setEnvironment('DKB_COMPILER_ALLOWED_TARGETS', previousAllowed);
    setEnvironment('DKB_COMPILER_DEFAULT_TARGET', previousDefault);
    await fs.rm(root, { recursive: true, force: true });
  });
  process.env.DKB_COMPILER_ALLOWED_TARGETS = 'trusted';
  process.env.DKB_COMPILER_DEFAULT_TARGET = 'trusted';
  const unresolved = await resolveRegistryCompilerCatalog(await distributionRequiringOciIdentity(t), root);
  assert.equal(unresolved.targets[0].available, false);
  assert.equal(unresolved.targets[0].buildDigest, null);
  assert.equal(unresolved.targets[0].compatibility, null);
  assert.deepEqual(unresolved.targets[0].providers, []);
  assert.equal(unresolved.targets[0].resolutionError.code, 'pipeline_resolution_failed');
  await assert.rejects(resolveRegistryCompilerTarget({ distribution: await distributionRequiringOciIdentity(t), contextRoot: root }), /target trusted is unhealthy/u);

  const digest = `sha256:${'b'.repeat(64)}`;
  await fs.mkdir(path.join(root, '.dkb'), { recursive: true });
  await fs.writeFile(path.join(root, '.dkb', 'config.json'), `${JSON.stringify({
    format: DKB_CONFIG_FORMAT,
    activeTarget: 'trusted',
    targets: { trusted: { options: { '@test/registry-compiler': { imageDigest: digest } } } },
  })}\n`, 'utf8');
  const catalog = await resolveRegistryCompilerCatalog(await distributionRequiringOciIdentity(t), root);
  assert.equal(catalog.targets[0].available, true);
});

test('Registry compiler rejects unknown allowlist entries and unhealthy targets', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-registry-target-health-'));
  const previousAllowed = process.env.DKB_COMPILER_ALLOWED_TARGETS;
  const previousDefault = process.env.DKB_COMPILER_DEFAULT_TARGET;
  t.after(async () => {
    setEnvironment('DKB_COMPILER_ALLOWED_TARGETS', previousAllowed);
    setEnvironment('DKB_COMPILER_DEFAULT_TARGET', previousDefault);
    await fs.rm(root, { recursive: true, force: true });
  });
  process.env.DKB_COMPILER_ALLOWED_TARGETS = 'missing';
  process.env.DKB_COMPILER_DEFAULT_TARGET = 'missing';
  await assert.rejects(resolveRegistryCompilerCatalog(await distribution(t), root), /contains unknown targets: missing/u);
  process.env.DKB_COMPILER_ALLOWED_TARGETS = 'trusted';
  process.env.DKB_COMPILER_DEFAULT_TARGET = 'trusted';
  await assert.rejects(
    resolveRegistryCompilerTarget({ distribution: await distribution(t, false), contextRoot: root, target: 'trusted' }),
    /target trusted is unhealthy/u,
  );
});

test('an unresolved optional recipe remains visible without blocking a healthy default or leaking plugin errors', async (t) => {
  globalThis.dkbOptionalRecipeSetups = 0;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-registry-optional-target-'));
  const previousAllowed = process.env.DKB_COMPILER_ALLOWED_TARGETS;
  const previousDefault = process.env.DKB_COMPILER_DEFAULT_TARGET;
  t.after(async () => {
    delete globalThis.dkbOptionalRecipeSetups;
    setEnvironment('DKB_COMPILER_ALLOWED_TARGETS', previousAllowed);
    setEnvironment('DKB_COMPILER_DEFAULT_TARGET', previousDefault);
    await fs.rm(root, { recursive: true, force: true });
  });
  delete process.env.DKB_COMPILER_ALLOWED_TARGETS;
  process.env.DKB_COMPILER_DEFAULT_TARGET = 'trusted';
  const fixture = await distribution(t);
  fixture.defaults.targets.optional = { ...fixture.defaults.targets.trusted, evidence: '@test/broken' };
  const plugin = path.join(root, '.dkb/plugins/@test/broken/plugin.mjs');
  await fs.mkdir(path.dirname(plugin), { recursive: true });
  await fs.writeFile(plugin, `export const apiVersion=3; export const id='@test/broken'; export const version='1.0.0';
export const optionsSchema={'~standard':{version:1,vendor:'test',validate(value){return {value};}}};
export function setup(){globalThis.dkbOptionalRecipeSetups++;throw new Error('sensitive-fixture-options must-not-be-exported');}`);
  const catalog = await resolveRegistryCompilerCatalog(fixture, root);
  assert.deepEqual(catalog.targets.map((item) => item.name), ['optional', 'trusted']);
  const unavailable = catalog.targets[0];
  assert.equal(unavailable.available, false);
  for (const key of ['buildDigest', 'evidenceProfileDigest', 'retrievalProfileDigest', 'compatibilityDigest', 'compatibility', 'chains']) assert.equal(unavailable[key], null);
  for (const key of ['providers', 'processors', 'requiredServices', 'serviceRequirements']) assert.deepEqual(unavailable[key], []);
  assert.doesNotMatch(JSON.stringify(catalog), /sensitive-fixture|must-not-be-exported/);
  const setups = globalThis.dkbOptionalRecipeSetups;
  assert.equal((await resolveRegistryCompilerTarget({ distribution: fixture, contextRoot: root })).name, 'trusted');
  assert.equal(globalThis.dkbOptionalRecipeSetups, setups, 'selected healthy compilation does not initialize an unrelated optional plugin');
  await assert.rejects(resolveRegistryCompilerTarget({ distribution: fixture, contextRoot: root, target: 'optional' }), /target optional is unhealthy/);
  process.env.DKB_COMPILER_DEFAULT_TARGET = 'optional';
  assert.equal((await resolveRegistryCompilerCatalog(fixture, root)).defaultTarget, 'optional');
  await assert.rejects(resolveRegistryCompilerTarget({ distribution: fixture, contextRoot: root }), /target optional is unhealthy/);
  // An explicit restriction never imports or advertises the broken recipe.
  process.env.DKB_COMPILER_ALLOWED_TARGETS = 'trusted';
  process.env.DKB_COMPILER_DEFAULT_TARGET = 'trusted';
  assert.deepEqual((await resolveRegistryCompilerCatalog(fixture, root)).targets.map((item) => item.name), ['trusted']);
});

test('Registry compiler response binds the exact resolved compiler identity', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-registry-compiler-response-'));
  const sourceRoot = path.join(root, 'source');
  const archivePath = path.join(root, 'source.dkbpkg');
  const contextRoot = path.join(root, 'context');
  const previousAllowed = process.env.DKB_COMPILER_ALLOWED_TARGETS;
  const previousDefault = process.env.DKB_COMPILER_DEFAULT_TARGET;
  t.after(async () => {
    setEnvironment('DKB_COMPILER_ALLOWED_TARGETS', previousAllowed);
    setEnvironment('DKB_COMPILER_DEFAULT_TARGET', previousDefault);
    await fs.rm(root, { recursive: true, force: true });
  });
  process.env.DKB_COMPILER_ALLOWED_TARGETS = 'trusted';
  process.env.DKB_COMPILER_DEFAULT_TARGET = 'trusted';
  await fs.mkdir(sourceRoot, { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'dkb.json'), `${JSON.stringify({
    manifestVersion: 1,
    type: 'dkb',
    name: '@test/compiler-response',
    displayName: 'Compiler response',
    version: '1.0.0',
    permissions: { read: true, write: false },
  }, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(sourceRoot, 'proof.md'), 'COMPILER-IDENTITY-42\n', 'utf8');
  await createDkbPackageArchive(sourceRoot, archivePath);
  const sourceArchive = await fs.readFile(archivePath);
  const sourceDigest = `sha256:${createHash('sha256').update(sourceArchive).digest('hex')}`;
  const selected = await resolveRegistryCompilerTarget({
    distribution: await distribution(t),
    contextRoot,
    target: 'trusted',
  });

  const response = await compileRegistryPackage({
    jobId: 'compiler-response-proof',
    request: {
      expectedCompilerBuildDigest: (await readCompilerBuildIdentity()).buildDigest,
      package: {
        id: '@test/compiler-response',
        name: '@test/compiler-response',
        version: '1.0.0',
        publisherId: 'test',
      },
      target: selected.name,
      evidenceProfileDigest: selected.evidenceProfileDigest,
      retrievalProfileDigest: selected.retrievalProfileDigest,
      compatibilityDigest: selected.compatibilityDigest,
      providerBuildDigest: selected.buildDigest,
    },
    sourceArchive: {
      fileName: 'source.dkbpkg',
      hash: sourceDigest,
      contents: sourceArchive.toString('base64'),
    },
  }, {
    distribution: await distribution(t),
    contextRoot,
  });

  assert.deepEqual(response.compiler, {
    id: 'dkb.registry.package',
    installedBuildDigest: (await readCompilerBuildIdentity()).buildDigest,
    target: selected.name,
    buildDigest: selected.buildDigest,
    compatibilityDigest: selected.compatibilityDigest,
    profileDigest: selected.retrievalProfileDigest,
    providers: selected.providers,
  });
  const compiledArchive = path.join(root, 'compiled.dkbpkg');
  const compiledRoot = path.join(root, 'compiled');
  await fs.writeFile(compiledArchive, Buffer.from(response.archive.contents, 'base64'));
  await extractDkbPackageArchive(compiledArchive, compiledRoot);
  const graph = await validatePackageBuildGraph(compiledRoot);
  assert.equal(graph.evidence.package.sourceDigest, sourceDigest);

  const evidenceArchivePath = path.join(root, 'evidence.dkbevidence');
  await createDkbPackageArchive(graph.evidencePath, evidenceArchivePath);
  const evidenceArchive = await fs.readFile(evidenceArchivePath);
  const retrievalResponse = await compileRegistryPackage({
    jobId: 'compiler-response-retrieval-proof',
    request: {
      expectedCompilerBuildDigest: (await readCompilerBuildIdentity()).buildDigest,
      stage: 'retrieval',
      package: {
        id: '@test/compiler-response',
        name: '@test/compiler-response',
        version: '1.0.0',
        publisherId: 'test',
      },
      target: selected.name,
      evidenceProfileDigest: selected.evidenceProfileDigest,
      retrievalProfileDigest: selected.retrievalProfileDigest,
      compatibilityDigest: selected.compatibilityDigest,
      providerBuildDigest: selected.buildDigest,
    },
    sourceArchive: {
      fileName: 'source.dkbpkg',
      hash: sourceDigest,
      contents: sourceArchive.toString('base64'),
    },
    evidenceArchive: {
      fileName: 'evidence.dkbevidence',
      hash: `sha256:${createHash('sha256').update(evidenceArchive).digest('hex')}`,
      contents: evidenceArchive.toString('base64'),
    },
  }, {
    distribution: await distribution(t),
    contextRoot,
  });
  const retrievalArchive = path.join(root, 'retrieval-compiled.dkbpkg');
  const retrievalRoot = path.join(root, 'retrieval-compiled');
  await fs.writeFile(retrievalArchive, Buffer.from(retrievalResponse.archive.contents, 'base64'));
  await extractDkbPackageArchive(retrievalArchive, retrievalRoot);
  const retrievalGraph = await validatePackageBuildGraph(retrievalRoot);
  assert.equal(retrievalGraph.evidence.package.sourceDigest, sourceDigest);
});

test('Registry source and Evidence upload names cannot escape owned staging or alter valid compilation', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-registry-upload-names-'));
  const workRoot = path.join(directory, 'work');
  const sourceRoot = path.join(directory, 'source');
  const contextRoot = path.join(directory, 'context');
  const previous = new Map(['DKB_COMPILER_WORK_ROOT', 'DKB_COMPILER_ALLOWED_TARGETS', 'DKB_COMPILER_DEFAULT_TARGET']
    .map((name) => [name, process.env[name]]));
  t.after(async () => {
    for (const [name, value] of previous) setEnvironment(name, value);
    await fs.rm(directory, { recursive: true, force: true });
  });
  process.env.DKB_COMPILER_WORK_ROOT = workRoot;
  process.env.DKB_COMPILER_ALLOWED_TARGETS = 'trusted';
  process.env.DKB_COMPILER_DEFAULT_TARGET = 'trusted';
  await fs.mkdir(sourceRoot);
  const manifest = JSON.stringify({ manifestVersion: 1, type: 'dkb', name: '@test/upload-names', version: '1.0.0', permissions: { read: true, write: false } });
  await fs.writeFile(path.join(sourceRoot, 'dkb.json'), manifest);
  const sourceSentinel = path.join(directory, 'source-sentinel.dkbpkg');
  const evidenceSentinel = path.join(directory, 'evidence-sentinel.dkbevidence');
  await fs.writeFile(sourceSentinel, 'Original outside source file');
  await fs.writeFile(evidenceSentinel, 'Original outside Evidence file');
  const archivePath = path.join(directory, 'source.dkbpkg');
  await createDkbPackageArchive(sourceRoot, archivePath);
  const sourceBytes = await fs.readFile(archivePath);
  const sourceDigest = `sha256:${createHash('sha256').update(sourceBytes).digest('hex')}`;
  const fixture = await distribution(t);
  const request = {
    expectedCompilerBuildDigest: (await readCompilerBuildIdentity()).buildDigest,
    package: { id: '@test/upload-names', version: '1.0.0', publisherId: 'test' },
    target: 'trusted',
  };
  const sourceArchive = { fileName: 'source.dkbpkg', hash: sourceDigest, contents: sourceBytes.toString('base64') };
  const options = { distribution: fixture, contextRoot };
  const baseline = await compileRegistryPackage({ jobId: 'benign-upload-name', request, sourceArchive }, options);
  const baselineArchive = path.join(directory, 'baseline.dkbpkg');
  const baselineRoot = path.join(directory, 'baseline');
  await fs.writeFile(baselineArchive, Buffer.from(baseline.archive.contents, 'base64'));
  await extractDkbPackageArchive(baselineArchive, baselineRoot);
  const graph = await validatePackageBuildGraph(baselineRoot);
  const evidencePath = path.join(directory, 'evidence.dkbevidence');
  await createDkbPackageArchive(graph.evidencePath, evidencePath);
  const evidenceBytes = await fs.readFile(evidencePath);
  const evidenceArchive = {
    hash: `sha256:${createHash('sha256').update(evidenceBytes).digest('hex')}`,
    contents: evidenceBytes.toString('base64'),
  };
  const cases = [
    { name: 'benign', source: 'source.dkbpkg', evidence: 'evidence.dkbevidence' },
    { name: 'traversal', source: '../../source-sentinel.dkbpkg', evidence: '../../evidence-sentinel.dkbevidence' },
    { name: 'windows-traversal', source: '..\\..\\source-sentinel.dkbpkg', evidence: '..\\..\\evidence-sentinel.dkbevidence' },
    { name: 'malformed', source: '\0source.dkbpkg', evidence: '\0evidence.dkbevidence' },
  ];
  for (const item of cases) {
    const response = await compileRegistryPackage({
      jobId: `upload-name-${item.name}`, request: { ...request, stage: 'retrieval' },
      sourceArchive: { ...sourceArchive, fileName: item.source },
      evidenceArchive: { ...evidenceArchive, fileName: item.evidence },
    }, options);
    assert.equal(response.build.evidenceDigest, graph.evidence.evidenceDigest);
    assert.equal(typeof response.archive.contents, 'string');
    assert.ok(response.archive.contents.length > 0, `${item.name} must still produce a valid compiled response`);
    assert.equal(await fs.readFile(sourceSentinel, 'utf8'), 'Original outside source file');
    assert.equal(await fs.readFile(evidenceSentinel, 'utf8'), 'Original outside Evidence file');
    assert.equal(await fs.readFile(path.join(sourceRoot, 'dkb.json'), 'utf8'), manifest);
    assert.deepEqual(await fs.readdir(workRoot), [], 'Only owned scratch is created, then removed');
  }
});

test('Registry compiler liveness does not wait for provider capability probes', async (t) => {
  const previousToken = process.env.DKB_COMPILER_SERVICE_TOKEN;
  process.env.DKB_COMPILER_SERVICE_TOKEN = randomUUID();
  t.after(() => setEnvironment('DKB_COMPILER_SERVICE_TOKEN', previousToken));
  const server = await serveDkbRegistryCompiler({ host: '127.0.0.1', port: 0 });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.equal(typeof address, 'object');

  const transport = observeLoopbackTransport(address.port);
  let acceptedConnections = 0, requests = 0, responses = 0;
  server.on('connection', () => { acceptedConnections++; });
  server.on('request', (_request, response) => {
    requests++;
    response.once('finish', () => { responses++; });
  });
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      service: 'dkb.registry.compiler',
      version: '0.2.0',
    });
  } catch (error) {
    assert.fail(JSON.stringify({ error: { name: error.name, code: error.code, message: error.message },
      listening: server.listening, acceptedConnections, requests, responses, transport: transport.snapshot() }));
  } finally { transport.dispose(); }
});

function setEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
