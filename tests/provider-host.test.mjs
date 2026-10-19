import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DKB_CONFIG_FORMAT, resolveContextConfig } from '@sjshovan/dkb-pipeline/config.js';
import { resolveBuildProfiles } from '@sjshovan/dkb-pipeline/buildProfiles.js';
import { DkbProviderHost, pluginPath } from '@sjshovan/dkb-pipeline/host.js';
import { DEFAULT_DKB_DISTRIBUTION } from '@sjshovan/dkb-distribution-default';
import { addPlugin, linkPlugin, listPlugins, removePlugin, setPipelineTarget } from '../apps/cli/dist/providers/management.js';
import { compileDkbWithProviderHost } from '@sjshovan/dkb-compiler/pipelineRunner.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DKB_RUNTIME_ACTIVATION_PATH } from '@sjshovan/dkb-protocol/paths.js';
import { compileComposeProject, compileRetrievalFromEvidence } from '@sjshovan/dkb-compiler/compile.js';
import { validateEvidenceIr } from '@sjshovan/dkb-protocol/evidence/ir.js';
import { meilisearchIndexId, meilisearchIndexPrefix } from '@sjshovan/dkb-index-meilisearch/meilisearchProvider.js';
import { readRetrievalProfileLock, resolveProviderRetrievalProfile, retrievalProfileLockForRetrievalPipelines } from '@sjshovan/dkb-pipeline/profile.js';
import { listPackageBuilds, validatePackageBuildGraph } from '@sjshovan/dkb-library/builds.js';
import { readEvidenceCatalog } from '@sjshovan/dkb-library/evidenceCatalog.js';
import { runtimePipelineCatalog } from '@sjshovan/dkb-runtime/runtime/pipelineCatalog.js';
import { materializeBundledProviderFixtures } from './bundled-provider-fixture.mjs';

const optionsSchema = { '~standard': { version: 1, vendor: 'test', validate(value) { return { value: value ?? {} }; } } };
const integrityFor = (id, version = '1.0.0') => ({
  apiVersion: 3,
  id,
  version,
  externalDigests: {},
  protocols: [],
  artifactFormats: [],
});
const pluginFixture = (id, setup, version = '1.0.0') => ({ apiVersion: 3, id, version, sourceUrl: import.meta.url, optionsSchema, integrity: integrityFor(id, version), setup });

const allPlugin = pluginFixture('@test/all',
  (context) => {
    context.registerProvider({ kind: 'evidence', async compile() { return { records: [], receipt: { build: {} } }; } });
    context.registerProvider({
      kind: 'embedding',
      async embedDocuments({ texts }) { return texts.map(() => [1]); },
      async embedQuery() { return [1]; },
      compatibility(options) {
        return {
          embeddingSpace: 'test-space',
          dimensions: Number(options.dimensions ?? 1),
          metric: 'cosine',
          normalized: true,
        };
      },
    });
    context.registerProvider({ kind: 'index', mode: 'packaged', format: 'test.v1', capabilities: { vectors: 'required' }, async compilePackage() { return null; }, async validatePackage() { return { documentCount: 0 }; }, async verifyRuntime() { return { indexId: 'test', documentCount: 0, status: 'ready' }; }, async openRuntime() { return null; } });
    context.registerProvider({ kind: 'retrieval', protocol: 'test.evidence.v1', capabilities: { vectors: 'optional' }, openRuntime() { return { providerId: '@test/all', protocol: 'test.evidence.v1', async search() { return { hits: [], trace: {} }; }, close() {} }; } });
  },
);

async function distributionWith(t, plugins, defaults = DEFAULT_DKB_DISTRIBUTION.defaults) {
  return materializeBundledProviderFixtures(t, { ...DEFAULT_DKB_DISTRIBUTION, defaults, plugins });
}

test('Pipeline labels do not alter recipe identities while options and loaded provider code remain bound', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-pipeline-alias-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const recipe = { evidence: '@test/all', embedding: '@test/all', index: '@test/all', retrieval: '@test/all', options: { '@test/all': { dimensions: 1 } } };
  const distribution = await distributionWith(t, [allPlugin], {
    format: DKB_CONFIG_FORMAT, activeTarget: 'default', targets: {
      default: recipe, renamed: structuredClone(recipe),
      changed: { ...recipe, options: { '@test/all': { dimensions: 2 } } },
    },
  });
  const hosts = [];
  t.after(async () => { await Promise.all(hosts.map((host) => host.dispose())); });
  for (const target of ['default', 'renamed', 'changed']) hosts.push(await DkbProviderHost.create({ root, globalRoot: path.join(root, 'global'), distribution, target }));
  const descriptions = hosts.map((host) => host.describe());
  const profiles = await Promise.all(hosts.map(resolveProviderRetrievalProfile));
  assert.equal(descriptions[0].target, 'default');
  assert.equal(descriptions[1].target, 'renamed');
  for (const field of ['configDigest', 'buildDigest']) {
    assert.equal(descriptions[0][field], descriptions[1][field], field);
    assert.notEqual(descriptions[0][field], descriptions[2][field], `options affect ${field}`);
  }
  for (const field of ['configDigest', 'providerBuildDigest', 'evidenceProfileDigest', 'retrievalProfileDigest']) assert.equal(profiles[0][field], profiles[1][field], field);
  assert.deepEqual(profiles[0].compatibility, profiles[1].compatibility);
  assert.notEqual(profiles[0].retrievalProfileDigest, profiles[2].retrievalProfileDigest);
  assert.notDeepEqual(profiles[0].compatibility, profiles[2].compatibility);
  await fs.appendFile(fileURLToPath(distribution.plugins[0].sourceUrl), '\n// changed shipped provider bytes\n');
  await assert.rejects(hosts[0].assertCurrent(), /changed|drift|restart/i);
  await assert.rejects(hosts[1].assertCurrent(), /changed|drift|restart/i);
});

test('bundled 384, 768, FastEmbed, and TEI targets share Evidence IR only when ingestion is identical', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-bundled-spaces-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const targets = ['default', 'fastembed-faiss', 'fastembed-faiss-768', 'tei-faiss', 'tei-faiss-768'];
  const resolved = [];

  for (const target of targets) {
    const host = await DkbProviderHost.create({
      root,
      globalRoot: path.join(root, 'global'),
      distribution: DEFAULT_DKB_DISTRIBUTION,
      target,
    });
    try {
      resolved.push(await resolveBuildProfiles(host));
    } finally {
      await host.dispose();
    }
  }

  assert.equal(new Set(resolved.map((profile) => profile.evidence.profileDigest)).size, 1);
  assert.equal(new Set(resolved.map((profile) => profile.retrieval.profileDigest)).size, 4);
  assert.deepEqual(resolved.map((profile) => profile.retrieval.embedding.dimensions), [384, 384, 768, 384, 768]);
  assert.equal(resolved[0].retrieval.profileDigest, resolved[3].retrieval.profileDigest);
  assert.equal(resolved[0].retrieval.compatibilityDigest, resolved[3].retrieval.compatibilityDigest);
  assert.notEqual(resolved[1].retrieval.compatibilityDigest, resolved[3].retrieval.compatibilityDigest);
  assert.equal(resolved[4].retrieval.embedding.modelRevision, 'a5beb1e3e68b9ab74eb54cfd186867f64f240e1a');
});

test('bundled provider receipts bind host-attested OCI digests instead of mutable image tags', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-oci-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const evidenceDigest = `sha256:${'1'.repeat(64)}`;
  const embeddingDigest = `sha256:${'2'.repeat(64)}`;
  const indexDigest = `sha256:${'3'.repeat(64)}`;
  const host = await DkbProviderHost.create({
    root,
    globalRoot: path.join(root, 'global'),
    distribution: DEFAULT_DKB_DISTRIBUTION,
    target: 'default',
    targetOptions: {
      '@dkb/evidence-docling-llamaindex': { imageDigest: evidenceDigest },
      '@dkb/embedding-tei': { imageDigest: embeddingDigest },
      '@dkb/index-faiss': { imageDigest: indexDigest },
    },
  });

  try {
    await resolveProviderRetrievalProfile(host);
    assert.equal(host.providerIntegrity('evidence').externalDigests['image:evidence-worker'], evidenceDigest);
    assert.equal(host.providerIntegrity('embedding').externalDigests['image:embedding-service'], embeddingDigest);
    assert.equal(host.providerIntegrity('index').externalDigests['image:index-helper'], indexDigest);
  } finally {
    await host.dispose();
  }
});

test('a lexical-only Pipeline resolves and locks without an embedding provider or dummy vectors', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-lexical-pipeline-'));
  const runtimeRoot = path.join(root, 'runtime');
  const libraryRoot = path.join(root, 'library');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(libraryRoot);
  const plugin = pluginFixture('@test/lexical', (context) => {
    context.registerProvider({ kind: 'evidence', async compile() { return { records: [], receipt: { build: {} } }; } });
    context.registerProvider({ kind: 'index', mode: 'packaged', format: 'test.lexical.v1', capabilities: { vectors: 'none' }, async compilePackage() { return { build: {} }; }, async validatePackage() { return { documentCount: 0 }; }, async verifyRuntime() { return { indexId: 'lexical', documentCount: 0, status: 'ready' }; }, async openRuntime() { return null; } });
    context.registerProvider({ kind: 'retrieval', protocol: 'dkb.evidence.v1', capabilities: { vectors: 'none' }, openRuntime() { return { providerId: '@test/lexical', protocol: 'dkb.evidence.v1', async search() { return { hits: [], trace: {} }; }, close() {} }; } });
  });
  const defaults = {
    format: DKB_CONFIG_FORMAT,
    activeTarget: 'lexical',
    targets: { lexical: { evidence: '@test/lexical', index: '@test/lexical', retrieval: '@test/lexical' } },
  };
  const host = await DkbProviderHost.create({ root, globalRoot: path.join(root, 'global'), distribution: await distributionWith(t, [plugin], defaults) });

  try {
    const builds = await resolveBuildProfiles(host);
    const resolved = await resolveProviderRetrievalProfile(host);
    const lock = retrievalProfileLockForRetrievalPipelines(resolved, [{ documents: [], chunks: [], records: [], vectors: [], receipts: [] }], { generatedAt: '2026-09-02T00:00:00.000Z' });
    assert.equal(builds.retrieval.embedding, undefined);
    assert.equal(builds.retrieval.compatibility.embeddingProvider, undefined);
    assert.equal(resolved.embedding, undefined);
    assert.equal(lock.profile.embedding, undefined);
    assert.deepEqual(lock.profile.retrieval.providers.map((provider) => provider.kind), ['index', 'retrieval']);
  } finally {
    await host.dispose();
  }

  const catalog = await runtimePipelineCatalog({
    distribution: await distributionWith(t, [plugin], defaults),
    root: runtimeRoot,
    libraryRoot,
    globalRoot: path.join(root, 'global'),
  });
  assert.equal(catalog.activeTarget, 'lexical');
  assert.equal(catalog.targets.length, 1);
  assert.equal(catalog.targets[0].health, 'ready');
  assert.equal(catalog.targets[0].dimensions, null);
  assert.deepEqual(catalog.targets[0].providers, ['@test/lexical', '@test/lexical', '@test/lexical']);
  assert.deepEqual(catalog.targets[0].healthDetails.map((item) => item.kind), ['index', 'retrieval']);
});

test('Runtime Pipeline catalog shares health probes for identical resolved provider chains', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-runtime-pipeline-health-'));
  const libraryRoot = path.join(root, 'library');
  const runtimeRoot = path.join(root, 'runtime');
  const healthCalls = [];
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(libraryRoot);
  const plugin = pluginFixture('@test/health',
    (context) => {
      const health = (kind) => async () => {
        healthCalls.push(kind);
        return { ok: true, detail: `${kind} ready` };
      };
      context.registerProvider({ kind: 'evidence', async compile() { return { records: [], receipt: { build: {} } }; } });
      context.registerProvider({
        kind: 'embedding',
        async embedDocuments({ texts }) { return texts.map(() => [1]); },
        async embedQuery() { return [1]; },
        compatibility() { return { embeddingSpace: 'health-space', dimensions: 1, metric: 'cosine', normalized: true }; },
        health: health('embedding'),
      });
      context.registerProvider({ kind: 'index', mode: 'packaged', format: 'test.v1', capabilities: { vectors: 'required' }, async compilePackage() { return null; }, async validatePackage() { return { documentCount: 0 }; }, async verifyRuntime() { return { indexId: 'test', documentCount: 0, status: 'ready' }; }, async openRuntime() { return null; }, health: health('index') });
      context.registerProvider({
        kind: 'retrieval',
        protocol: 'test.evidence.v1',
        capabilities: { vectors: 'optional' },
        openRuntime() { return { providerId: '@test/health', protocol: 'test.evidence.v1', async search() { return { hits: [], trace: {} }; }, close() {} }; },
        health: health('retrieval'),
      });
    },
  );
  const sharedTarget = { evidence: '@test/health', embedding: '@test/health', index: '@test/health', retrieval: '@test/health' };
  const distribution = await distributionWith(t, [plugin], {
    format: DKB_CONFIG_FORMAT,
    activeTarget: 'first',
    targets: { first: sharedTarget, second: sharedTarget },
  });

  const catalog = await runtimePipelineCatalog({ distribution, root: runtimeRoot, libraryRoot });

  assert.deepEqual(catalog.targets.map((target) => target.health), ['ready', 'ready']);
  assert.deepEqual(healthCalls.sort(), ['embedding', 'index', 'retrieval']);
});

test('Runtime Pipeline catalog reports a target with unresolved external identity without hiding healthy targets', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-runtime-pipeline-identity-'));
  const libraryRoot = path.join(root, 'library');
  const runtimeRoot = path.join(root, 'runtime');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(libraryRoot);
  const sharedTarget = { evidence: '@test/all', embedding: '@test/all', index: '@test/all', retrieval: '@test/all' };
  const attestedPlugin = {
    ...allPlugin,
    identity: ({ options }) => ({ external: options.imageDigest ? [{ kind: 'image', name: 'test-worker', digest: options.imageDigest }] : [] }),
  };
  const distribution = {
    ...await distributionWith(t, [attestedPlugin], {
      format: DKB_CONFIG_FORMAT,
      activeTarget: 'healthy',
      targets: { healthy: { ...sharedTarget, options: { '@test/all': { imageDigest: `sha256:${'1'.repeat(64)}` } } }, unresolved: sharedTarget },
    }),
    services: [{
      id: 'test-worker',
      kind: 'docker',
      providerId: '@test/all',
      requiredBy: ['unresolved'],
      providerExternalIdentities: [{ kind: 'image', name: 'test-worker', option: 'imageDigest' }],
    }],
  };

  const catalog = await runtimePipelineCatalog({ distribution, root: runtimeRoot, libraryRoot });

  const healthy = catalog.targets.find((target) => target.name === 'healthy');
  const unresolved = catalog.targets.find((target) => target.name === 'unresolved');
  assert.equal(healthy.health, 'ready');
  assert.match(healthy.compatibilityDigest, /^sha256:/u);
  assert.equal(unresolved.health, 'unavailable');
  assert.equal(unresolved.compatibilityDigest, null);
  assert.equal(unresolved.evidenceProfileDigest, null);
  assert.equal(unresolved.retrievalProfileDigest, null);
  assert.match(unresolved.healthDetails[0].detail, /cannot establish immutable image:test-worker identity/u);
});

test('renaming a target cannot drop bundled external identity requirements but a local replacement owns its own contract', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-renamed-identity-target-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const distribution = {
    ...await distributionWith(t, [allPlugin], { format: DKB_CONFIG_FORMAT, activeTarget: 'renamed', targets: { renamed: { evidence: '@test/all', embedding: '@test/all', index: '@test/all', retrieval: '@test/all' } } }),
    services: [{ id: 'test-worker', kind: 'docker', providerId: '@test/all', requiredBy: ['original-name'], providerExternalIdentities: [{ kind: 'image', name: 'test-worker', option: 'imageDigest' }] }],
  };
  const bundled = await DkbProviderHost.create({ root, globalRoot: path.join(root, 'global'), distribution });
  assert.throws(() => bundled.assertRequiredExternalIdentities(), /cannot establish immutable image:test-worker/u);
  await bundled.dispose();
  await writeAllPlugin(pluginPath(path.join(root, '.dkb/plugins'), '@test/all'), '1.0.0', 'local replacement');
  const local = await DkbProviderHost.create({ root, globalRoot: path.join(root, 'global'), distribution });
  try { assert.doesNotThrow(() => local.assertRequiredExternalIdentities()); } finally { await local.dispose(); }
});

test('query observers settle independently and report exact selected-plugin health', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-query-observer-settlement-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const healthy = pluginFixture('@test/healthy-observer', (context) => {
    context.registerQueryObserver({
      id: '@test/healthy-observer',
      version: '1.0.0',
      async observe(event) { calls.push(`healthy:${event.eventId}`); },
    });
  });
  const degraded = pluginFixture('@test/degraded-observer', (context) => {
    context.registerQueryObserver({
      id: '@test/degraded-observer',
      version: '1.0.0',
      async observe(event) {
        calls.push(`degraded:${event.eventId}`);
        throw new Error('observer export failed');
      },
    });
  });
  const target = {
    evidence: '@test/all', embedding: '@test/all', index: '@test/all', retrieval: '@test/all',
    observers: ['@test/healthy-observer', '@test/degraded-observer'],
  };
  const host = await DkbProviderHost.create({
    root,
    globalRoot: path.join(root, 'global'),
    distribution: await distributionWith(t, [allPlugin, healthy, degraded], {
      format: DKB_CONFIG_FORMAT,
      activeTarget: 'observer-proof',
      targets: { 'observer-proof': target },
    }),
  });

  try {
    const results = await host.observeQuery({
      eventId: 'observer-event', recordedAt: '2026-09-02T00:00:00.000Z', runtimeId: 'runtime',
      channel: 'cli', status: 'success', data: {},
    });

    assert.deepEqual(calls.sort(), ['degraded:observer-event', 'healthy:observer-event']);
    assert.deepEqual(results.map((result) => ({ id: result.id, ok: result.ok, detail: result.detail })), [
      { id: '@test/healthy-observer', ok: true, detail: undefined },
      { id: '@test/degraded-observer', ok: false, detail: 'observer export failed' },
    ]);
  } finally {
    await host.dispose();
  }
});

test('Meilisearch managed indexes isolate compatibility spaces for the same package release', () => {
  const root = path.resolve('runtime-proof');
  const prefix = meilisearchIndexPrefix(root, 'Proof Library', '@test/package', '1.0.0');
  const fast = meilisearchIndexId(root, 'Proof Library', '@test/package', '1.0.0', stableHash({ space: 'fastembed' }));
  const tei = meilisearchIndexId(root, 'Proof Library', '@test/package', '1.0.0', stableHash({ space: 'tei' }));

  assert.match(fast, new RegExp(`^${prefix}_`));
  assert.match(tei, new RegExp(`^${prefix}_`));
  assert.notEqual(fast, tei);
  assert.equal(
    fast,
    meilisearchIndexId(root, 'Proof Library', '@test/package', '1.0.0', stableHash({ space: 'fastembed' })),
  );
});

test('query observer deadlines isolate stalls and prevent overlapping late deliveries', async (t) => {
  const pending = Promise.withResolvers();
  const signals = [];
  let calls = 0;
  let healthyCalls = 0;
  const host = await observerHost(t, [
    { id: '@test/stalled', version: '1.0.0', observe(_event, { signal }) {
      calls += 1;
      signals.push(signal);
      if (calls === 1) return pending.promise;
    } },
    { id: '@test/healthy', version: '1.0.0', observe() { healthyCalls += 1; } },
  ]);
  t.after(() => pending.resolve());
  const first = await host.observeQuery(observerEvent(), undefined, 15);
  assert.deepEqual(first.map(({ ok }) => ok), [false, true]);
  assert.match(first[0].detail, /exceeded its 15 ms delivery budget/u);
  assert.equal(signals[0].aborted, true);
  const second = await host.observeQuery(observerEvent(), undefined, 15);
  assert.match(second[0].detail, /unfinished delivery/u);
  assert.equal(calls, 1);
  assert.equal(healthyCalls, 2);
  pending.reject(new Error('late observer failure'));
  await new Promise((resolve) => setImmediate(resolve));
  const third = await host.observeQuery(observerEvent(), undefined, 15);
  assert.deepEqual(third.map(({ ok }) => ok), [true, true]);
  assert.equal(calls, 2);
  assert.equal(healthyCalls, 3);
});

test('query observers honour pre-cancellation, caller cancellation, and host disposal', async (t) => {
  const pending = Promise.withResolvers();
  let calls = 0;
  let started = Promise.withResolvers();
  const host = await observerHost(t, [{
    id: '@test/cancelled-observer', version: '1.0.0', observe(_event, { signal }) {
      calls += 1;
      started.resolve(signal);
      return pending.promise;
    },
  }]);
  t.after(() => pending.resolve());
  const cancelled = AbortSignal.abort(new Error('cancelled before observer delivery'));
  assert.match((await host.observeQuery(observerEvent(), cancelled))[0].detail, /cancelled before/u);
  assert.equal(calls, 0);

  const controller = new AbortController();
  const running = host.observeQuery(observerEvent(), controller.signal);
  const signal = await started.promise;
  controller.abort(new Error('caller stopped telemetry'));
  assert.match((await running)[0].detail, /caller stopped/u);
  assert.equal(signal.aborted, true);
  pending.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  started = Promise.withResolvers();
  const unsettled = Promise.withResolvers();
  const other = await observerHost(t, [{
    id: '@test/disposed-observer', version: '1.0.0', observe(_event, { signal: closingSignal }) {
      started.resolve(closingSignal);
      return unsettled.promise;
    },
  }]);
  t.after(() => unsettled.resolve());
  const closing = other.observeQuery(observerEvent());
  const closingSignal = await started.promise;
  await other.dispose();
  assert.match((await closing)[0].detail, /host closed/u);
  assert.equal(closingSignal.aborted, true);
});

async function observerHost(t, observers) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-observer-delivery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const plugins = observers.map((observer) => pluginFixture(observer.id, (context) => context.registerQueryObserver(observer)));
  const target = { evidence: '@test/all', embedding: '@test/all', index: '@test/all', retrieval: '@test/all', observers: observers.map(({ id }) => id) };
  const host = await DkbProviderHost.create({
    root, globalRoot: path.join(root, 'global'),
    distribution: await distributionWith(t, [allPlugin, ...plugins], {
      format: DKB_CONFIG_FORMAT, activeTarget: 'observers', targets: { observers: target },
    }),
  });
  t.after(() => host.dispose());
  return host;
}

function observerEvent() {
  return { eventId: 'deadline-proof', recordedAt: '2026-09-03T00:00:00.000Z', runtimeId: 'runtime', channel: 'cli', status: 'success', data: {} };
}

test('context configuration merges bundled, global, and local targets deterministically', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-config-'));
  const globalRoot = path.join(root, 'global');
  const contextRoot = path.join(root, 'library');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeJson(path.join(globalRoot, 'config.json'), {
    format: DKB_CONFIG_FORMAT,
    targets: {
      default: {
        embedding: '@test/all',
        index: '@test/all',
        retrieval: '@test/all',
        evidence: '@test/all',
        processors: ['@test/global-processor'],
        options: { '@test/all': { shared: 'global', nested: { one: 1 } } },
      },
    },
  });
  await writeJson(path.join(contextRoot, '.dkb/config.json'), {
    format: DKB_CONFIG_FORMAT,
    targets: {
      default: {
        processors: [],
        options: { '@test/all': { local: true, nested: { two: 2 } } },
      },
    },
  });

  const resolved = await resolveContextConfig(contextRoot, { defaults: DEFAULT_DKB_DISTRIBUTION.defaults, globalRoot });

  assert.deepEqual(resolved.target.processors, []);
  assert.deepEqual(resolved.target.options['@test/all'], {
    shared: 'global',
    local: true,
    nested: { one: 1, two: 2 },
  });
});

test('context configuration rejects pre-v2 documents instead of applying a legacy reader', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-config-version-'));
  const contextRoot = path.join(root, 'library');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeJson(path.join(contextRoot, '.dkb/config.json'), { activeTarget: 'default' });

  await assert.rejects(
    resolveContextConfig(contextRoot, {
      defaults: DEFAULT_DKB_DISTRIBUTION.defaults,
      globalRoot: path.join(root, 'global'),
    }),
    /format must be dkb\.config\.v2/u,
  );
});

test('provider configuration rejects inline secrets and accepts environment references', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-secrets-'));
  const contextRoot = path.join(root, 'library');
  const configPath = path.join(contextRoot, '.dkb/config.json');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = targetConfig('@test/all');
  config.targets.default.options = { '@test/all': { apiKey: 'must-not-live-here' } };
  await writeJson(configPath, config);

  await assert.rejects(resolveContextConfig(contextRoot, { defaults: DEFAULT_DKB_DISTRIBUTION.defaults, globalRoot: path.join(root, 'global') }), /cannot store apiKey/i);

  config.targets.default.options = { '@test/all': { apiKeyEnv: 'TEST_PROVIDER_API_KEY' } };
  await writeJson(configPath, config);
  const resolved = await resolveContextConfig(contextRoot, { defaults: DEFAULT_DKB_DISTRIBUTION.defaults, globalRoot: path.join(root, 'global') });
  assert.equal(resolved.target.options['@test/all'].apiKeyEnv, 'TEST_PROVIDER_API_KEY');
});

test('provider host loads only selected plugins and prefers a local override', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-precedence-'));
  const globalRoot = path.join(root, 'global');
  const contextRoot = path.join(root, 'library');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeAllPlugin(pluginPath(path.join(globalRoot, 'plugins'), '@test/all'), '2.0.0', 'global');
  await writeAllPlugin(pluginPath(path.join(contextRoot, '.dkb/plugins'), '@test/all'), '3.0.0', 'local');
  await writeJson(path.join(contextRoot, '.dkb/config.json'), targetConfig('@test/all'));
  await fs.mkdir(path.dirname(pluginPath(path.join(contextRoot, '.dkb/plugins'), '@test/unselected')), { recursive: true });
  await fs.writeFile(pluginPath(path.join(contextRoot, '.dkb/plugins'), '@test/unselected'), 'throw new Error("must not load");\n', 'utf8');

  const host = await DkbProviderHost.create({ root: contextRoot, globalRoot, distribution: await distributionWith(t, [allPlugin]) });
  t.after(() => host.dispose());
  const description = host.describe();

  assert.equal(description.providers.length, 4);
  assert.ok(description.providers.every((provider) => provider.version === '3.0.0'));
  assert.ok(description.providers.every((provider) => provider.source === 'local'));
  assert.deepEqual(await host.provider('embedding').embedQuery({ text: 'query', options: {} }), [3]);
});

test('local plugin code drift changes the provider build digest even when version is unchanged', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-drift-'));
  const globalRoot = path.join(root, 'global');
  const contextRoot = path.join(root, 'library');
  const entrypoint = pluginPath(path.join(contextRoot, '.dkb/plugins'), '@test/all');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeAllPlugin(entrypoint, '1.0.0', 'first');
  await writeJson(path.join(contextRoot, '.dkb/config.json'), targetConfig('@test/all'));
  const first = await DkbProviderHost.create({ root: contextRoot, globalRoot, distribution: await distributionWith(t, [allPlugin]) });
  const firstDigest = first.describe().buildDigest;
  await first.dispose();

  await fs.writeFile(path.join(path.dirname(entrypoint), 'implementation.txt'), 'changed', 'utf8');
  const second = await DkbProviderHost.create({ root: contextRoot, globalRoot, distribution: await distributionWith(t, [allPlugin]) });
  t.after(() => second.dispose());
  assert.notEqual(second.describe().buildDigest, firstDigest);
});

test('provider profile identity ignores install paths and non-shipped TypeScript build metadata', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-portable-identity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profiles = [];
  const descriptions = [];

  for (const [name, buildMetadata] of [['first', 'windows-build-state'], ['second', 'linux-build-state']]) {
    const contextRoot = path.join(root, name);
    const entrypoint = pluginPath(path.join(contextRoot, '.dkb/plugins'), '@test/all');
    await writeAllPlugin(entrypoint, '1.0.0', 'portable');
    await fs.writeFile(path.join(path.dirname(entrypoint), '.tsbuildinfo'), buildMetadata, 'utf8');
    await writeJson(path.join(contextRoot, '.dkb/config.json'), targetConfig('@test/all'));
    const host = await DkbProviderHost.create({
      root: contextRoot,
      globalRoot: path.join(root, 'global'),
      distribution: await distributionWith(t, [allPlugin]),
    });
    descriptions.push(host.describe());
    profiles.push(await resolveBuildProfiles(host));
    await host.dispose();
  }

  assert.notEqual(descriptions[0].providers[0].sourcePath, descriptions[1].providers[0].sourcePath);
  assert.equal(descriptions[0].providers[0].sourceDigest, descriptions[1].providers[0].sourceDigest);
  assert.equal(descriptions[0].buildDigest, descriptions[1].buildDigest);
  assert.equal(profiles[0].evidence.profileDigest, profiles[1].evidence.profileDigest);
  assert.equal(profiles[0].retrieval.profileDigest, profiles[1].retrieval.profileDigest);
  assert.equal(profiles[0].retrieval.compatibilityDigest, profiles[1].retrieval.compatibilityDigest);
});

test('local provider external identity changes only its profile while operational options do not', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-external-identity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const contextRoot = path.join(root, 'library');
  const serviceA = `sha256:${'a'.repeat(64)}`;
  const serviceB = `sha256:${'b'.repeat(64)}`;
  const corePlugin = pluginFixture('@test/identity-core', (context) => {
    context.registerProvider({ kind: 'evidence', async compile() { return { records: [], receipt: { build: {} } }; } });
    context.registerProvider({ kind: 'index', mode: 'packaged', format: 'identity.v1', capabilities: { vectors: 'required' }, async compilePackage() { return null; }, async validatePackage() { return { documentCount: 0 }; }, async verifyRuntime() { return { indexId: 'identity', documentCount: 0, status: 'ready' }; }, async openRuntime() { return null; } });
    context.registerProvider({ kind: 'retrieval', protocol: 'dkb.evidence.v1', capabilities: { vectors: 'optional' }, openRuntime() { return { providerId: '@test/identity-core', protocol: 'dkb.evidence.v1', async search() { return { hits: [], trace: {} }; }, close() {} }; } });
  });
  const pluginSource = `
export const apiVersion = 3;
export const id = '@test/external-embedding';
export const version = '1.0.0';
export const optionsSchema = { '~standard': { version: 1, vendor: 'test', validate(value) { return { value: { model: 'test-model', timeoutMs: 1000, ...(value ?? {}) } }; } } };
export function identity({ options }) { return { profileOptions: { model: options.model } }; }
export function setup(context) {
  context.registerProvider({
    kind: 'embedding',
    identity: ({ options }) => ({ external: [{ kind: 'service', name: 'embedding-api', digest: options.serviceDigest }] }),
    async embedDocuments({ texts }) { return texts.map(() => [1]); },
    async embedQuery() { return [1]; },
    compatibility() { return { embeddingSpace: 'test-model', dimensions: 1, metric: 'cosine', normalized: true }; },
  });
}
`;
  const defaults = {
    format: DKB_CONFIG_FORMAT,
    activeTarget: 'identity',
    targets: {
      identity: {
        evidence: '@test/identity-core',
        embedding: '@test/external-embedding',
        index: '@test/identity-core',
        retrieval: '@test/identity-core',
      },
    },
  };
  const target = pluginPath(path.join(contextRoot, '.dkb/plugins'), '@test/external-embedding');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, pluginSource, 'utf8');
  const profiles = [];
  const receipts = [];
  for (const options of [
    { serviceDigest: serviceA, timeoutMs: 1000 },
    { serviceDigest: serviceB, timeoutMs: 1000 },
    { serviceDigest: serviceB, timeoutMs: 9000 },
  ]) {
    await writeJson(path.join(contextRoot, '.dkb/config.json'), {
      format: DKB_CONFIG_FORMAT,
      targets: { identity: { options: { '@test/external-embedding': options } } },
    });
    const host = await DkbProviderHost.create({
      root: contextRoot,
      globalRoot: path.join(root, 'global'),
      distribution: await distributionWith(t, [corePlugin], defaults),
    });
    profiles.push(await resolveBuildProfiles(host));
    receipts.push(host.providerIntegrity('embedding'));
    await host.dispose();
  }

  assert.equal(new Set(profiles.map((profile) => profile.evidence.profileDigest)).size, 1);
  assert.notEqual(profiles[0].retrieval.profileDigest, profiles[1].retrieval.profileDigest);
  assert.equal(profiles[1].retrieval.profileDigest, profiles[2].retrieval.profileDigest);
  assert.deepEqual(receipts[1].externalDigests, { 'service:embedding-api': serviceB });
});

test('a broken local override fails instead of falling back', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-invalid-'));
  const globalRoot = path.join(root, 'global');
  const contextRoot = path.join(root, 'library');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeAllPlugin(pluginPath(path.join(globalRoot, 'plugins'), '@test/all'), '2.0.0', 'global');
  const local = pluginPath(path.join(contextRoot, '.dkb/plugins'), '@test/all');
  await fs.mkdir(path.dirname(local), { recursive: true });
  await fs.writeFile(local, 'export const apiVersion = 3; export const id = "@test/wrong"; export const version = "1"; export const optionsSchema = { "~standard": { version: 1, vendor: "test", validate(value) { return { value: value ?? {} }; } } }; export function setup() {}\n', 'utf8');
  await writeJson(path.join(contextRoot, '.dkb/config.json'), targetConfig('@test/all'));

  await assert.rejects(
    DkbProviderHost.create({ root: contextRoot, globalRoot, distribution: await distributionWith(t, [allPlugin]) }),
    /plugin API v3 requires.*id=@test\/all/i,
  );
});

test('plugin API v1 and v2 are rejected instead of being loaded through a compatibility path', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-api-v1-'));
  const globalRoot = path.join(root, 'global');
  const contextRoot = path.join(root, 'library');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const local = pluginPath(path.join(contextRoot, '.dkb/plugins'), '@test/all');
  await fs.mkdir(path.dirname(local), { recursive: true });
  await fs.writeFile(local, 'export const apiVersion = 1; export const id = "@test/all"; export const version = "1"; export function setup() {}\n', 'utf8');
  await writeJson(path.join(contextRoot, '.dkb/config.json'), targetConfig('@test/all'));

  await assert.rejects(
    DkbProviderHost.create({ root: contextRoot, globalRoot, distribution: await distributionWith(t, [allPlugin]) }),
    /plugin API v3 requires.*id=@test\/all/i,
  );
  await fs.writeFile(local, 'export const apiVersion = 2; export const id = "@test/all"; export const version = "2"; export const optionsSchema = {}; export function setup() {}\n', 'utf8');
  await assert.rejects(
    DkbProviderHost.create({ root: contextRoot, globalRoot, distribution: await distributionWith(t, [allPlugin]) }),
    /plugin API v3 requires.*id=@test\/all/i,
  );
});

test('processor order is deterministic and hosts dispose independently', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-processors-'));
  const globalRoot = path.join(root, 'global');
  const firstRoot = path.join(root, 'first');
  const secondRoot = path.join(root, 'second');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const processor = (id, suffix) => pluginFixture(id,
    (context) => {
      context.registerProcessor({
        id,
        version: '1.0.0',
        stage: 'record',
        mutate(value) { return { ...value, text: `${value.text}${suffix}` }; },
      });
    });
  const bundled = [allPlugin, processor('@test/first', '-first'), processor('@test/second', '-second')];
  await writeJson(path.join(firstRoot, '.dkb/config.json'), targetConfig('@test/all', ['@test/first', '@test/second']));
  await writeJson(path.join(secondRoot, '.dkb/config.json'), targetConfig('@test/all', ['@test/second']));
  const first = await DkbProviderHost.create({ root: firstRoot, globalRoot, distribution: await distributionWith(t, bundled) });
  const second = await DkbProviderHost.create({ root: secondRoot, globalRoot, distribution: await distributionWith(t, bundled) });
  t.after(() => Promise.all([first.dispose(), second.dispose()]));

  const seed = [{ id: 'r', chunkId: 'c', text: 'seed', provenance: { assetId: 'a', storeId: 's', sourceType: 'filesystem', locator: { path: 'proof.md' }, assetLocator: { path: 'proof.md' }, title: 'Proof', sourceHash: stableHash('source'), updatedAt: new Date(0).toISOString(), chunkOrdinal: 0, chunkStart: 0, chunkEnd: 4 }, metadata: {} }];
  assert.equal((await first.mutate('record', seed))[0].text, 'seed-first-second');
  assert.equal((await second.mutate('record', seed))[0].text, 'seed-second');
  await first.dispose();
  assert.deepEqual(await second.provider('embedding').embedQuery({ text: 'query', options: {} }), [1]);
  assert.throws(() => first.describe(), /disposed/i);
});

test('processor output is validated after each middleware step', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-step-validation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const invalid = pluginFixture('@test/invalid-step', (context) => context.registerProcessor({
    id: '@test/invalid-step',
    version: '1.0.0',
    stage: 'record',
    mutate(value) { return { ...value, metadata: { ...value.metadata, invalid: new Date(0) } }; },
  }));
  const repair = pluginFixture('@test/repair-step', (context) => context.registerProcessor({
    id: '@test/repair-step',
    version: '1.0.0',
    stage: 'record',
    mutate(value) { const { invalid: _invalid, ...metadata } = value.metadata; return { ...value, metadata }; },
  }));
  await writeJson(path.join(root, '.dkb/config.json'), targetConfig('@test/all', ['@test/invalid-step', '@test/repair-step']));
  const host = await DkbProviderHost.create({ root, globalRoot: path.join(root, 'global'), distribution: await distributionWith(t, [allPlugin, invalid, repair]) });
  t.after(() => host.dispose());
  const record = { id: 'record', chunkId: 'chunk', text: 'proof', provenance: { assetId: 'asset', storeId: 'filesystem', sourceType: 'filesystem', locator: { path: 'proof.md' }, assetLocator: { path: 'proof.md' }, title: 'Proof', sourceHash: stableHash('proof'), updatedAt: new Date(0).toISOString(), chunkOrdinal: 0, chunkStart: 0, chunkEnd: 5 }, metadata: {} };

  await assert.rejects(host.mutate('record', [record]), /not JSON-safe|non-plain object/u);
});

test('fused Evidence pipelines fail closed on processor stages they cannot interleave', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-fused-stage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const processor = pluginFixture('@test/document-after-fused', (context) => context.registerProcessor({
    id: '@test/document-after-fused',
    version: '1.0.0',
    stage: 'document',
    mutate(value) { return value; },
  }));
  await writeJson(path.join(root, '.dkb/config.json'), targetConfig('@test/all', ['@test/document-after-fused']));

  await assert.rejects(
    DkbProviderHost.create({ root, globalRoot: path.join(root, 'global'), distribution: await distributionWith(t, [allPlugin, processor]) }),
    /fused Evidence provider.*only record processors/iu,
  );
});

test('DKB replaces provider-supplied reserved metadata with canonical identities', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-reserved-metadata-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceHash = stableHash('source bytes');
  const plugin = pluginFixture('@test/canonical-metadata', (context) => {
    context.registerProvider({
      kind: 'evidence',
      async compile() {
        return {
          records: [{
            id: 'native-record',
            chunkId: 'native-chunk',
            text: 'trusted identity proof',
            provenance: { assetId: 'asset', storeId: 'filesystem', sourceType: 'filesystem', locator: { path: 'proof.md', chunk: 0 }, assetLocator: { path: 'proof.md' }, title: 'Proof', sourceHash, updatedAt: new Date(0).toISOString(), chunkOrdinal: 0, chunkStart: 0, chunkEnd: 22 },
            metadata: { custom: 'kept', dkb_package_id: '@hostile/claim', dkb_package_version: '999.0.0', dkb_path: '../../hostile', dkb_source_hash: stableHash('hostile'), dkb_text_hash: stableHash('hostile') },
          }],
          receipt: { build: {} },
        };
      },
    });
    context.registerProvider({ kind: 'embedding', async embedDocuments({ texts }) { return texts.map(() => [1]); }, async embedQuery() { return [1]; }, compatibility() { return { embeddingSpace: 'canonical', dimensions: 1, metric: 'cosine', normalized: true }; } });
    context.registerProvider({ kind: 'index', mode: 'packaged', format: 'canonical.v1', capabilities: { vectors: 'required' }, async compilePackage() { return null; }, async validatePackage() { return { documentCount: 1 }; }, async verifyRuntime() { return { indexId: 'canonical', documentCount: 1, status: 'ready' }; }, async openRuntime() { return null; } });
    context.registerProvider({ kind: 'retrieval', protocol: 'dkb.evidence.v1', capabilities: { vectors: 'optional' }, openRuntime() { return { providerId: '@test/canonical-metadata', protocol: 'dkb.evidence.v1', async search() { return { hits: [], trace: {} }; }, close() {} }; } });
  });
  const defaults = { format: DKB_CONFIG_FORMAT, activeTarget: 'default', targets: { default: { evidence: plugin.id, embedding: plugin.id, index: plugin.id, retrieval: plugin.id } } };
  const host = await DkbProviderHost.create({ root, globalRoot: path.join(root, 'global'), distribution: await distributionWith(t, [plugin], defaults) });
  t.after(() => host.dispose());
  const compiled = await compileDkbWithProviderHost(host, {
    root,
    manifestPath: path.join(root, 'dkb.json'),
    manifestHash: stableHash('manifest'),
    manifest: { manifestVersion: 1, type: 'dkb', id: '@test/canonical-package', name: '@test/canonical-package', version: '1.2.3', adapter: 'folder', entrypoint: '.', permissions: { read: true, write: false } },
  });
  const record = compiled.records[0];

  assert.equal(record.metadata.custom, 'kept');
  assert.equal(record.metadata.dkb_package_id, '@test/canonical-package');
  assert.equal(record.metadata.dkb_package_version, '1.2.3');
  assert.equal(record.metadata.dkb_path, 'proof.md');
  assert.equal(record.metadata.dkb_source_hash, sourceHash);
  assert.equal(record.metadata.dkb_text_hash, stableHash(record.text));
});

test('separate parser, chunker, embedder, and middleware providers share one compilation contract', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-separate-'));
  const library = path.join(root, 'library');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = (id, setup) => pluginFixture(id, setup);
  const bundled = [
    provider('@test/parser', (context) => context.registerProvider({ kind: 'parser', async parse() { return [{ id: 'doc', path: 'proof.md', text: 'parsed', provenance: { assetId: 'proof.md', storeId: 'filesystem', sourceType: 'filesystem', assetLocator: { path: 'proof.md' }, title: 'Proof', sourceHash: 'sha256:' + 'a'.repeat(64), updatedAt: '2026-01-01T00:00:00.000Z' }, metadata: { sourceHash: 'untrusted custom label' } }]; } })),
    provider('@test/chunker', (context) => context.registerProvider({ kind: 'chunker', async chunk({ documents }) { return [{ id: 'chunk', documentId: documents[0].id, text: `${documents[0].text}-chunked`, provenance: { locator: { path: 'proof.md', section: 'first' }, chunkOrdinal: 0, chunkStart: 0, chunkEnd: documents[0].text.length }, metadata: { chunkStart: 9999, sourceHash: 'must not override source provenance' } }]; } })),
    provider('@test/embedder', (context) => context.registerProvider({ kind: 'embedding', async embedDocuments({ texts }) { return texts.map(() => [0.5, 0.5]); }, async embedQuery() { return [0.5, 0.5]; }, compatibility() { return { embeddingSpace: 'test', dimensions: 2, metric: 'cosine', normalized: true }; } })),
    provider('@test/index', (context) => context.registerProvider({ kind: 'index', mode: 'packaged', format: 'test.v1', capabilities: { vectors: 'required' }, async compilePackage() { return null; }, async validatePackage() { return { documentCount: 0 }; }, async verifyRuntime() { return { indexId: 'test', documentCount: 0, status: 'ready' }; }, async openRuntime() { return null; } })),
    provider('@test/retrieval', (context) => context.registerProvider({ kind: 'retrieval', protocol: 'test.evidence.v1', capabilities: { vectors: 'optional' }, openRuntime() { return { providerId: '@test/retrieval', protocol: 'test.evidence.v1', async search() { return { hits: [], trace: {} }; }, close() {} }; } })),
    provider('@test/document-mutator', (context) => context.registerProcessor({ id: '@test/document-mutator', version: '1.0.0', stage: 'document', mutate(value) { return { ...value, text: `${value.text}-document` }; } })),
    provider('@test/chunk-mutator', (context) => context.registerProcessor({ id: '@test/chunk-mutator', version: '1.0.0', stage: 'chunk', mutate(value) { return { ...value, text: `${value.text}-chunk` }; } })),
    provider('@test/record-mutator', (context) => context.registerProcessor({ id: '@test/record-mutator', version: '1.0.0', stage: 'record', mutate(value) { return { ...value, text: `${value.text}-record` }; } })),
  ];
  await writeJson(path.join(library, '.dkb/config.json'), {
    format: DKB_CONFIG_FORMAT,
    targets: {
      default: {
        parser: '@test/parser',
        chunker: '@test/chunker',
        embedding: '@test/embedder',
        index: '@test/index',
        retrieval: '@test/retrieval',
        processors: ['@test/document-mutator', '@test/chunk-mutator', '@test/record-mutator'],
      },
    },
  });
  const host = await DkbProviderHost.create({ root: library, globalRoot: path.join(root, 'global'), distribution: await distributionWith(t, bundled) });
  t.after(() => host.dispose());
  const compiled = await compileDkbWithProviderHost(host, {
    root: library,
    manifestPath: path.join(library, 'dkb.json'),
    manifestHash: 'sha256:test',
    manifest: { manifestVersion: 1, type: 'dkb', id: '@test/proof', name: '@test/proof', version: '1.0.0', adapter: 'folder', entrypoint: '.', permissions: { read: true, write: false } },
  });

  assert.equal(compiled.documents[0].text, 'parsed-document');
  assert.equal(compiled.chunks[0].text, 'parsed-document-chunked-chunk');
  assert.equal(compiled.records[0].text, 'parsed-document-chunked-chunk-record');
  assert.equal(compiled.records[0].provenance.sourceHash, `sha256:${'a'.repeat(64)}`);
  assert.equal(compiled.records[0].provenance.chunkStart, 0);
  assert.equal(compiled.records[0].provenance.chunkEnd, 'parsed-document'.length);
  assert.deepEqual(compiled.records[0].provenance.locator, { path: 'proof.md', section: 'first' });
  assert.notEqual(compiled.records[0].provenance.sourceHash, stableHash(compiled.documents[0].text));
  assert.equal('embedding' in compiled.records[0], false);
  assert.deepEqual(compiled.vectors, [{ evidenceId: compiled.records[0].id, values: [0.5, 0.5] }]);
  assert.deepEqual(
    compiled.receipts
      .filter((receipt) => receipt.build.kind === 'processor')
      .map((receipt) => receipt.build.stage),
    ['document', 'chunk', 'record'],
  );
});

test('separate providers compile a complete package without a LlamaIndex-native result', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-separate-package-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeJson(path.join(root, 'dkb.json'), {
    manifestVersion: 1,
    type: 'dkb',
    name: '@test/separate-package',
    displayName: 'Separate package',
    version: '1.0.0',
    permissions: { read: true, write: false },
  });
  await fs.writeFile(path.join(root, 'proof.md'), 'SOURCE-PROOF-14', 'utf8');
  await writeJson(path.join(root, '.dkb/config.json'), {
    format: DKB_CONFIG_FORMAT,
    targets: {
      default: {
        parser: '@test/separate',
        chunker: '@test/separate',
        embedding: '@test/initial-embedding',
        index: '@test/separate',
        retrieval: '@test/separate',
        processors: ['@test/separate'],
      },
    },
  });
  const plugin = pluginPath(path.join(root, '.dkb/plugins'), '@test/separate');
  await fs.mkdir(path.dirname(plugin), { recursive: true });
  await fs.writeFile(plugin, `
import fs from 'node:fs/promises';
import path from 'node:path';
export const apiVersion = 3;
export const id = '@test/separate';
export const version = '1.0.0';
export const optionsSchema = { '~standard': { version: 1, vendor: 'test', validate(value) { return { value: value ?? {} }; } } };
export function setup(context) {
  context.registerProvider({ kind: 'parser', async parse({ dkb }) { const counter = path.join(dkb.root, '.dkb', 'parse-count.txt'); await fs.mkdir(path.dirname(counter), { recursive: true }); const count = Number.parseInt(await fs.readFile(counter, 'utf8').catch(() => '0'), 10); await fs.writeFile(counter, String(count + 1)); return [{ id: 'proof', path: 'proof.md', text: 'SOURCE-PROOF-14', provenance: { assetId: 'proof.md', storeId: 'filesystem', sourceType: 'filesystem', assetLocator: { path: 'proof.md' }, title: 'Proof', sourceHash: 'sha256:' + 'a'.repeat(64), updatedAt: '2026-01-01T00:00:00.000Z' }, metadata: {} }]; } });
  context.registerProvider({ kind: 'chunker', async chunk({ documents }) { return [{ id: 'proof-chunk', documentId: documents[0].id, text: documents[0].text, provenance: { locator: { path: 'proof.md', chunk: 0 }, chunkOrdinal: 0, chunkStart: 0, chunkEnd: documents[0].text.length }, metadata: {} }]; } });
  context.registerProvider({
    kind: 'index', mode: 'packaged', format: 'test.index.v1', capabilities: { vectors: 'required' },
    async compilePackage({ artifactsRoot, compiled }) {
      const target = path.join(artifactsRoot, 'test-index.json');
      const vectors = new Map(compiled.vectors.map((vector) => [vector.evidenceId, vector.values]));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify(compiled.records.map((record) => ({ ...record, embedding: vectors.get(record.id) }))));
      return { build: { recordCount: compiled.records.length } };
    },
    async validatePackage() { return { documentCount: 1 }; },
    async verifyRuntime() { return { indexId: 'test', documentCount: 1, status: 'ready' }; },
    async openRuntime() { return null; },
  });
  context.registerProvider({ kind: 'retrieval', protocol: 'dkb.evidence.v1', capabilities: { vectors: 'optional' }, openRuntime() { return { providerId: id, protocol: 'dkb.evidence.v1', async search() { return { hits: [], trace: {} }; }, close() {} }; } });
  context.registerProcessor({ id, version, stage: 'record', mutate(value) { return { ...value, text: value.text + '-MUTATED' }; } });
}
`, 'utf8');
  const initialEmbedding = pluginPath(path.join(root, '.dkb/plugins'), '@test/initial-embedding');
  await fs.mkdir(path.dirname(initialEmbedding), { recursive: true });
  await fs.writeFile(initialEmbedding, `
export const apiVersion = 3;
export const id = '@test/initial-embedding';
export const version = '1.0.0';
export const optionsSchema = { '~standard': { version: 1, vendor: 'test', validate(value) { return { value: value ?? {} }; } } };
export function setup(context) {
  context.registerProvider({ kind: 'embedding', async embedDocuments({ texts }) { return texts.map(() => [0.6, 0.8]); }, async embedQuery() { return [0.6, 0.8]; }, compatibility() { return { embeddingSpace: 'test-space-v1', dimensions: 2, metric: 'cosine', normalized: true }; } });
}
`, 'utf8');
  const alternate = pluginPath(path.join(root, '.dkb/plugins'), '@test/alternate');
  await fs.mkdir(path.dirname(alternate), { recursive: true });
  await fs.writeFile(alternate, `
export const apiVersion = 3;
export const id = '@test/alternate';
export const version = '1.0.0';
export const optionsSchema = { '~standard': { version: 1, vendor: 'test', validate(value) { return { value: value ?? {} }; } } };
export function setup(context) {
  context.registerProvider({ kind: 'embedding', async embedDocuments({ texts }) { return texts.map(() => [1, 0]); }, async embedQuery() { return [1, 0]; }, compatibility() { return { embeddingSpace: 'test-space-v2', dimensions: 2, metric: 'cosine', normalized: true }; } });
}
`, 'utf8');
  const config = JSON.parse(await fs.readFile(path.join(root, '.dkb/config.json'), 'utf8'));
  config.targets.alternate = {
    parser: '@test/separate',
    chunker: '@test/separate',
    embedding: '@test/alternate',
    index: '@test/separate',
    retrieval: '@test/separate',
    processors: ['@test/separate'],
  };
  await writeJson(path.join(root, '.dkb/config.json'), config);

  const result = await compileComposeProject(root, { force: true });
  const graph = await validatePackageBuildGraph(root);
  const [catalog, evidence, profile, indexRecords] = await Promise.all([
    Promise.resolve(readEvidenceCatalog(graph.evidencePath)),
    fs.readFile(path.join(graph.evidencePath, 'evidence.ir.json'), 'utf8').then(JSON.parse).then(validateEvidenceIr),
    readRetrievalProfileLock(graph.retrievalPath),
    fs.readFile(path.join(graph.retrievalPath, 'artifacts', 'test-index.json'), 'utf8').then(JSON.parse),
  ]);

  assert.equal(result.recordCount, 1);
  assert.equal(result.profile.statistics.corpus.sourceFiles, 1);
  assert.equal(result.profile.statistics.corpus.evidenceRecords, 1);
  assert.equal(result.profile.statistics.corpus.recordsPerSource.max, 1);
  assert.ok(result.profile.statistics.storage.totalDerivedBytes > 0);
  assert.ok(result.profile.statistics.diskCapacity.retrieval[0].requiredFreeBytes > 0);
  assert.match(catalog.records[0].text, /SOURCE-PROOF-14-MUTATED/);
  assert.equal(evidence.evidence[0].text, 'SOURCE-PROOF-14-MUTATED');
  assert.equal(indexRecords[0].text, 'SOURCE-PROOF-14-MUTATED');
  assert.equal('compiler' in profile.profile, false);
  assert.equal('extraction' in profile.profile, false);
  assert.deepEqual(profile.profile.evidence.providers.map((provider) => provider.kind), ['parser', 'chunker']);
  assert.deepEqual(profile.profile.evidence.providers.map((provider) => provider.id), ['@test/separate', '@test/separate']);
  assert.deepEqual(profile.profile.retrieval.providers.map((provider) => provider.kind), ['embedding', 'index', 'retrieval']);
  assert.equal(profile.profile.index.provider, '@test/separate');
  assert.equal(profile.compatibility.dimensions, 2);
  assert.equal(await fs.readFile(path.join(root, '.dkb/parse-count.txt'), 'utf8'), '1');

  const alternateResult = await compileRetrievalFromEvidence(root, evidence, { target: 'alternate' });
  const alternateLock = JSON.parse(await fs.readFile(path.join(alternateResult.retrievalBuildPath, 'retrieval.lock.json'), 'utf8'));
  const alternateGraph = await validatePackageBuildGraph(root, {
    version: alternateLock.package.version,
    evidenceProfileDigest: alternateLock.evidenceProfileDigest,
    evidenceDigest: alternateLock.evidenceDigest,
    retrievalProfileDigest: alternateLock.retrievalProfileDigest,
    retrievalBuildDigest: alternateLock.retrievalBuildDigest,
  });
  const alternateEvidence = validateEvidenceIr(JSON.parse(await fs.readFile(path.join(alternateGraph.evidencePath, 'evidence.ir.json'), 'utf8')));
  const alternateProfile = await readRetrievalProfileLock(alternateGraph.retrievalPath);
  const alternateIndex = JSON.parse(await fs.readFile(path.join(alternateGraph.retrievalPath, 'artifacts', 'test-index.json'), 'utf8'));

  assert.equal(await fs.readFile(path.join(root, '.dkb/parse-count.txt'), 'utf8'), '1');
  assert.equal(alternateEvidence.evidenceDigest, evidence.evidenceDigest);
  assert.equal(alternateProfile.profile.evidence.profileDigest, profile.profile.evidence.profileDigest);
  assert.notEqual(alternateProfile.profileDigest, profile.profileDigest);
  assert.deepEqual(alternateIndex[0].embedding, [1, 0]);
});

test('embedding cache reuses exact text within one space and misses after a space change', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-embedding-cache-'));
  const counterPath = path.join(root, '.dkb', 'embed-count.txt');
  const previousCounter = process.env.DKB_TEST_EMBED_COUNTER;
  process.env.DKB_TEST_EMBED_COUNTER = counterPath;
  t.after(async () => {
    if (previousCounter === undefined) delete process.env.DKB_TEST_EMBED_COUNTER;
    else process.env.DKB_TEST_EMBED_COUNTER = previousCounter;
    await fs.rm(root, { recursive: true, force: true });
  });
  await writeJson(path.join(root, 'dkb.json'), {
    manifestVersion: 1,
    type: 'dkb',
    name: '@test/embedding-cache',
    version: '1.0.0',
    permissions: { read: true, write: false },
  });
  await fs.writeFile(path.join(root, 'knowledge.md'), 'CACHE-SPACE-55', 'utf8');
  await writeJson(path.join(root, '.dkb/config.json'), {
    format: DKB_CONFIG_FORMAT,
    activeTarget: 'first',
    targets: {
      first: {
        evidence: '@test/cache-core',
        embedding: '@test/cache-embedding',
        index: '@test/cache-core',
        retrieval: '@test/cache-core',
        options: { '@test/cache-embedding': { space: 'first', value: 0.25 } },
      },
      second: {
        evidence: '@test/cache-core',
        embedding: '@test/cache-embedding',
        index: '@test/cache-core',
        retrieval: '@test/cache-core',
        options: { '@test/cache-embedding': { space: 'second', value: 0.75 } },
      },
    },
  });
  const core = pluginPath(path.join(root, '.dkb/plugins'), '@test/cache-core');
  await fs.mkdir(path.dirname(core), { recursive: true });
  await fs.writeFile(core, `
import fs from 'node:fs/promises';
import path from 'node:path';
export const apiVersion = 3;
export const id = '@test/cache-core';
export const version = '1.0.0';
export const optionsSchema = { '~standard': { version: 1, vendor: 'test', validate(value) { return { value: value ?? {} }; } } };
export function setup(context) {
  context.registerProvider({
    kind: 'evidence',
    async compile({ dkb }) {
      const text = await fs.readFile(path.join(dkb.root, 'knowledge.md'), 'utf8');
      return { records: [{ id: 'cache', chunkId: 'cache', text, provenance: { assetId: 'knowledge.md', storeId: 'filesystem', sourceType: 'filesystem', locator: { path: 'knowledge.md' }, assetLocator: { path: 'knowledge.md' }, title: 'knowledge.md', sourceHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', updatedAt: '2026-08-28T00:00:00.000Z', chunkOrdinal: 0, chunkStart: 0, chunkEnd: text.length }, metadata: { dkb_path: 'knowledge.md', dkb_source_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }], receipt: { build: {} } };
    },
  });
  context.registerProvider({ kind: 'index', mode: 'packaged', format: 'cache.index.v1', capabilities: { vectors: 'required' }, async compilePackage({ artifactsRoot, compiled }) { const target = path.join(artifactsRoot, 'cache-index.json'); const vectors = new Map(compiled.vectors.map((vector) => [vector.evidenceId, vector.values])); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, JSON.stringify(compiled.records.map((record) => ({ ...record, embedding: vectors.get(record.id) })))); return { build: {} }; }, async validatePackage() { return { documentCount: 1 }; }, async verifyRuntime() { return { indexId: 'test', documentCount: 1, status: 'ready' }; }, async openRuntime() { return null; } });
  context.registerProvider({ kind: 'retrieval', protocol: 'dkb.evidence.v1', capabilities: { vectors: 'optional' }, openRuntime() { return { providerId: id, protocol: 'dkb.evidence.v1', async search() { return { hits: [], trace: {} }; }, close() {} }; } });
}
`, 'utf8');
  const embedding = pluginPath(path.join(root, '.dkb/plugins'), '@test/cache-embedding');
  await fs.mkdir(path.dirname(embedding), { recursive: true });
  await fs.writeFile(embedding, `
import fs from 'node:fs/promises';
export const apiVersion = 3;
export const id = '@test/cache-embedding';
export const version = '1.0.0';
export const optionsSchema = { '~standard': { version: 1, vendor: 'test', validate(value) { return { value: value ?? {} }; } } };
export function setup(context) {
  context.registerProvider({
    kind: 'embedding',
    async embedDocuments({ texts, options }) { const target = process.env.DKB_TEST_EMBED_COUNTER; const count = Number.parseInt(await fs.readFile(target, 'utf8').catch(() => '0'), 10); await fs.writeFile(target, String(count + 1)); return texts.map(() => [Number(options.value)]); },
    async embedQuery({ options }) { return [Number(options.value)]; },
    compatibility(options) { return { embeddingSpace: String(options.space), dimensions: 1, metric: 'cosine', normalized: true }; },
  });
}
`, 'utf8');

  await compileComposeProject(root, { force: true, target: 'first' });
  await compileComposeProject(root, { force: true, target: 'first' });
  assert.equal(await fs.readFile(counterPath, 'utf8'), '1');
  const firstGraph = await validatePackageBuildGraph(root);
  const firstIndex = JSON.parse(await fs.readFile(path.join(firstGraph.retrievalPath, 'artifacts', 'cache-index.json'), 'utf8'));
  assert.deepEqual(firstIndex[0].embedding, [0.25]);

  await compileComposeProject(root, { force: true, target: 'second' });
  assert.equal(await fs.readFile(counterPath, 'utf8'), '2');
  const builds = await listPackageBuilds(root);
  assert.equal(builds.evidence.length, 1);
  assert.equal(builds.retrieval.length, 2);

  await fs.writeFile(path.join(root, '.dkb', 'cache', 'embeddings.sqlite'), 'not a sqlite database', 'utf8');
  await compileComposeProject(root, { force: true, target: 'first' });
  assert.equal(await fs.readFile(counterPath, 'utf8'), '3');
  assert.ok((await fs.readdir(path.join(root, '.dkb', 'cache'))).some((name) => name.startsWith('embeddings.sqlite.corrupt-')));
  assert.equal((await listPackageBuilds(root)).retrieval.length, 2);
});

test('plugin add, link, list, and guarded removal operate within the selected scope', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-manage-'));
  const library = path.join(root, 'library');
  const globalRoot = path.join(root, 'global');
  const source = path.join(root, 'source');
  const linkedSource = path.join(root, 'linked-source');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writePluginSource(source, '@test/copied', '1.2.3');
  await writePluginSource(linkedSource, '@test/linked', '2.0.0');

  const copied = await addPlugin({ root: library, globalRoot, source });
  const linked = await linkPlugin({ root: library, globalRoot, source: linkedSource, scope: 'global' });
  assert.equal(copied.scope, 'local');
  assert.equal(linked.scope, 'global');
  assert.equal(await fs.readFile(path.join(path.dirname(copied.path), 'helper.txt'), 'utf8'), 'support');
  assert.ok((await fs.lstat(path.dirname(linked.path))).isSymbolicLink());

  const listed = await listPlugins({ distribution: DEFAULT_DKB_DISTRIBUTION, root: library, globalRoot });
  assert.ok(listed.some((entry) => entry.id === '@test/copied' && entry.scope === 'local' && entry.valid));
  assert.ok(listed.some((entry) => entry.id === '@test/linked' && entry.scope === 'global' && entry.valid));
  assert.ok(listed.some((entry) => entry.id === '@dkb/index-faiss' && entry.scope === 'bundled' && entry.selected));

  assert.equal((await removePlugin({ distribution: DEFAULT_DKB_DISTRIBUTION, root: library, globalRoot, id: '@test/copied' })).removed, true);
  assert.equal((await removePlugin({ distribution: DEFAULT_DKB_DISTRIBUTION, root: library, globalRoot, id: '@test/linked', scope: 'global' })).removed, true);
});

test('pipeline changes validate before atomic promotion and preserve the prior configuration on failure', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-promote-'));
  const library = path.join(root, 'library');
  const globalRoot = path.join(root, 'global');
  const configPath = path.join(library, '.dkb/config.json');
  const distribution = await distributionWith(t, [allPlugin], targetConfig('@test/all'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const promoted = await setPipelineTarget({
    distribution,
    root: library,
    globalRoot,
    name: 'default',
    activate: true,
    patch: {
      evidence: '@test/all',
      embedding: '@test/all',
      index: '@test/all',
      retrieval: '@test/all',
      processors: [],
    },
  });
  const before = await fs.readFile(configPath, 'utf8');
  assert.equal(promoted.target, 'default');

  await assert.rejects(setPipelineTarget({
    distribution,
    root: library,
    globalRoot,
    name: 'broken',
    activate: true,
    patch: {
      evidence: '@missing/evidence',
      embedding: '@test/all',
      index: '@test/all',
      retrieval: '@test/all',
    },
  }), /Selected plugin @missing\/evidence was not found/);
  assert.equal(await fs.readFile(configPath, 'utf8'), before);
});

test('saving a recipe without activation validates that recipe and retains the default suggestion', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-save-'));
  const library = path.join(root, 'library');
  const globalRoot = path.join(root, 'global');
  const configPath = path.join(library, '.dkb/config.json');
  const defaults = targetConfig('@test/all');
  defaults.targets.default.evidence = '@missing/unselected';
  const distribution = await distributionWith(t, [allPlugin], defaults);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const patch = {
    evidence: '@test/all', embedding: '@test/all', index: '@test/all', retrieval: '@test/all', processors: [],
  };

  const saved = await setPipelineTarget({ distribution, root: library, globalRoot, name: 'available', activate: false, patch });
  assert.equal(saved.target, 'available');
  assert.equal(JSON.parse(await fs.readFile(configPath, 'utf8')).activeTarget, undefined);

  await setPipelineTarget({ distribution, root: library, globalRoot, name: 'available', activate: true, patch });
  const before = await fs.readFile(configPath, 'utf8');
  await assert.rejects(setPipelineTarget({
    distribution, root: library, globalRoot, name: 'broken', activate: false,
    patch: { ...patch, evidence: '@missing/saved-recipe' },
  }), /Selected plugin @missing\/saved-recipe was not found/);
  assert.equal(await fs.readFile(configPath, 'utf8'), before);

  const alternate = await setPipelineTarget({ distribution, root: library, globalRoot, name: 'alternate', activate: false, patch });
  assert.equal(alternate.target, 'alternate');
  assert.equal(JSON.parse(await fs.readFile(configPath, 'utf8')).activeTarget, 'available');
});

test('Library Pipeline recipes are suggestions and never act as Runtime activation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-compatible-promote-'));
  const library = path.join(root, 'library');
  const globalRoot = path.join(root, 'global');
  const configPath = path.join(library, '.dkb/config.json');
  const distribution = await distributionWith(t, [allPlugin], targetConfig('@test/all'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await setPipelineTarget({
    distribution,
    root: library,
    globalRoot,
    name: 'default',
    activate: true,
    patch: {
      evidence: '@test/all',
      embedding: '@test/all',
      index: '@test/all',
      retrieval: '@test/all',
      processors: [],
    },
  });
  const before = await fs.readFile(configPath, 'utf8');
  await setPipelineTarget({
    distribution,
    root: library,
    globalRoot,
    name: 'base',
    activate: true,
    patch: {
      evidence: '@test/all',
      embedding: '@test/all',
      index: '@test/all',
      retrieval: '@test/all',
      processors: [],
      options: { '@test/all': { dimensions: 2 } },
    },
  });
  const after = await fs.readFile(configPath, 'utf8');
  assert.notEqual(after, before);
  assert.equal(JSON.parse(after).activeTarget, 'base');
  await assert.rejects(fs.access(path.join(library, ...DKB_RUNTIME_ACTIVATION_PATH.split('/'))));
});

test('Runtime Pipeline configuration overrides Library, global, and bundled recipes in order', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-runtime-config-precedence-'));
  const runtime = path.join(root, 'runtime');
  const library = path.join(root, 'library');
  const globalRoot = path.join(root, 'global');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const target = (dimensions) => ({
    format: DKB_CONFIG_FORMAT,
    activeTarget: 'default',
    targets: { default: { evidence: '@test/all', embedding: '@test/all', index: '@test/all', retrieval: '@test/all', options: { '@test/all': { dimensions } } } },
  });
  await writeJson(path.join(globalRoot, 'config.json'), target(2));
  await writeJson(path.join(library, '.dkb/config.json'), target(3));
  await writeJson(path.join(runtime, '.dkb/config.json'), target(4));

  const resolved = await resolveContextConfig(runtime, {
    defaults: target(1),
    globalRoot,
    libraryRoot: library,
  });
  assert.equal(resolved.target.options['@test/all'].dimensions, 4);
  assert.equal(resolved.global.targets.default.options['@test/all'].dimensions, 2);
  assert.equal(resolved.library.targets.default.options['@test/all'].dimensions, 3);
  assert.equal(resolved.local.targets.default.options['@test/all'].dimensions, 4);
});

function targetConfig(id, processors = []) {
  return {
    format: DKB_CONFIG_FORMAT,
    targets: {
      default: { evidence: id, embedding: id, index: id, retrieval: id, processors },
    },
  };
}

async function writeJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeAllPlugin(target, version, source) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `
export const apiVersion = 3;
export const id = '@test/all';
export const version = '${version}';
export const optionsSchema = { '~standard': { version: 1, vendor: 'test', validate(value) { return { value: value ?? {} }; } } };
export function setup(context) {
  context.registerProvider({ kind: 'evidence', async compile() { return { records: [], receipt: { build: { source: '${source}' } } }; } });
  context.registerProvider({ kind: 'embedding', async embedDocuments({ texts }) { return texts.map(() => [${Number(version[0])}]); }, async embedQuery() { return [${Number(version[0])}]; }, compatibility() { return { embeddingSpace: 'test', dimensions: 1, metric: 'cosine', normalized: true }; } });
  context.registerProvider({ kind: 'index', mode: 'packaged', format: 'test.v1', capabilities: { vectors: 'required' }, async compilePackage() { return null; }, async validatePackage() { return { documentCount: 0 }; }, async verifyRuntime() { return { indexId: 'test', documentCount: 0, status: 'ready' }; }, async openRuntime() { return null; } });
  context.registerProvider({ kind: 'retrieval', protocol: 'test.evidence.v1', capabilities: { vectors: 'optional' }, openRuntime() { return { providerId: id, protocol: 'test.evidence.v1', async search() { return { hits: [], trace: {} }; }, close() {} }; } });
}
`, 'utf8');
}

async function writePluginSource(target, id, version) {
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'helper.txt'), 'support', 'utf8');
  await fs.writeFile(path.join(target, 'plugin.mjs'), `
export const apiVersion = 3;
export const id = '${id}';
export const version = '${version}';
export const optionsSchema = { '~standard': { version: 1, vendor: 'test', validate(value) { return { value: value ?? {} }; } } };
export function setup(context) {
  context.registerProcessor({ id, version, stage: 'record', mutate(value) { return value; } });
}
`, 'utf8');
}
