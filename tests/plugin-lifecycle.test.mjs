import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DkbProviderHost } from '@sjshovan/dkb-pipeline/host.js';
import { runPluginConformance, verifyPluginModule } from '@sjshovan/dkb-pipeline/testing.js';
import { materializeBundledProviderFixtures } from './bundled-provider-fixture.mjs';

const id = '@test/lifecycle';
const optionsSchema = { '~standard': { version: 1, vendor: 'test', validate() { return { value: {} }; } } };
function plugin(setup, pluginId = id) {
  return { apiVersion: 3, id: pluginId, version: '1.0.0', optionsSchema, sourceUrl: import.meta.url,
    integrity: { apiVersion: 3, id: pluginId, version: '1.0.0', protocols: [], artifactFormats: [] }, setup };
}
function tracked(label, properties, disposed, failure = false) {
  const resource = { ...properties, dispose() {
    assert.equal(this, resource, 'dispose retains the registration receiver');
    disposed.push(label);
    if (failure) throw new Error('secondary disposal failure');
  } };
  return resource;
}
const evidence = { kind: 'evidence', async compile() { return { records: [], receipt: { build: {} } }; } };
const embedding = { kind: 'embedding', async embedDocuments() { return []; }, async embedQuery() { return [1]; }, compatibility() { return { dimensions: 1 }; } };
const index = { kind: 'index', mode: 'packaged', format: 'test.v1', capabilities: { vectors: 'none' }, async compilePackage() { return null; }, async validatePackage() { return { documentCount: 0 }; }, async verifyRuntime() { return { indexId: 'test', documentCount: 0, status: 'ready' }; }, async openRuntime() { return null; } };
const retrieval = { kind: 'retrieval', protocol: 'test.v1', capabilities: { vectors: 'none' }, async openRuntime() { return { providerId: id, protocol: 'test.v1', async search() { return { hits: [], trace: {} }; }, close() {} }; } };

async function createHost(t, plugins, target = { evidence: id, index: id, retrieval: id }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-plugin-lifecycle-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const distribution = await materializeBundledProviderFixtures(t, {
    id: '@test/distribution', version: '1.0.0', services: [], plugins,
    defaults: { format: 'dkb.config.v2', activeTarget: 'test', targets: { test: target } },
  });
  return DkbProviderHost.create({ root, globalRoot: path.join(root, 'global'), distribution });
}

const failures = [
  { name: 'setup throws', expected: /original setup failure/, setup(context, disposed) {
    context.registerProvider(tracked('provider', evidence, disposed, true));
    context.registerProcessor(tracked('processor', { id, version: '1.0.0', stage: 'record', mutate(value) { return value; } }, disposed));
    context.registerQueryObserver(tracked('observer', { id, version: '1.0.0', observe() {} }, disposed));
    throw new Error('original setup failure');
  }, count: 3 },
  { name: 'invalid second registration', expected: /embedding.*(implement|methods)/, setup(context, disposed) {
    context.registerProvider(tracked('first', evidence, disposed));
    context.registerProvider(tracked('invalid', { kind: 'embedding' }, disposed, true));
  }, count: 2 },
  { name: 'duplicate provider kind', expected: /both registered|more than one/, setup(context, disposed) {
    context.registerProvider(tracked('first', evidence, disposed));
    context.registerProvider(tracked('duplicate', evidence, disposed));
  }, count: 2 },
  { name: 'same object registered twice', expected: /both registered|more than one/, setup(context, disposed) {
    const resource = tracked('shared', evidence, disposed);
    context.registerProvider(resource); context.registerProvider(resource);
  }, count: 1 },
  { name: 'provider identity fails after valid provider', expected: /original identity failure/, setup(context, disposed) {
    context.registerProvider(tracked('first', evidence, disposed));
    context.registerProvider(tracked('invalid-identity', { ...embedding, identity() { throw new Error('original identity failure'); } }, disposed));
  }, count: 2 },
  { name: 'plugin swallows an invalid registration error', expected: /embedding.*(implement|methods)/, setup(context, disposed) {
    context.registerProvider(tracked('first', evidence, disposed));
    try { context.registerProvider(tracked('invalid', { kind: 'embedding' }, disposed)); } catch {}
  }, count: 2 },
];

for (const scenario of failures) {
  test(`host rolls back ${scenario.name} and preserves the original failure`, async (t) => {
    const disposed = [];
    await assert.rejects(createHost(t, [plugin((context) => scenario.setup(context, disposed))]), scenario.expected);
    assert.equal(disposed.length, scenario.count);
    assert.equal(new Set(disposed).size, scenario.count);
  });
  test(`public verification/conformance roll back ${scenario.name} exactly once`, async () => {
    for (const mode of ['verify', 'conformance']) {
      const disposed = [];
      const definition = plugin((context) => scenario.setup(context, disposed));
      if (mode === 'verify') await assert.rejects(verifyPluginModule(definition), scenario.expected);
      else {
        const report = await runPluginConformance(definition);
        assert.equal(report.ok, false);
        assert.match(report.checks.find((entry) => entry.status === 'failed').detail, scenario.expected);
      }
      assert.equal(disposed.length, scenario.count, mode);
      assert.equal(new Set(disposed).size, scenario.count, mode);
    }
  });
}

test('a later plugin failure disposes prior admissions and shared duplicate resources once', async (t) => {
  const disposed = [];
  const shared = tracked('index', index, disposed);
  const first = plugin((context) => {
    context.registerProvider(tracked('evidence', evidence, disposed));
    context.registerProvider(shared);
    context.registerProvider(tracked('retrieval', retrieval, disposed));
  });
  const second = plugin((context) => {
    context.registerProvider(tracked('embedding', embedding, disposed));
    context.registerProvider(shared);
  }, '@test/second');
  await assert.rejects(createHost(t, [first, second], { evidence: id, embedding: '@test/second', index: id, retrieval: id }), /both registered/);
  assert.deepEqual(disposed.sort(), ['embedding', 'evidence', 'index', 'retrieval']);
});

test('normal host shutdown is idempotent across shared registration roles', async (t) => {
  const disposed = [];
  const definition = plugin((context) => {
    context.registerProvider(tracked('evidence', evidence, disposed));
    context.registerProvider(tracked('index', index, disposed));
    context.registerProvider(tracked('retrieval', retrieval, disposed));
    const shared = tracked('shared', { id, version: '1.0.0', stage: 'record', mutate(value) { return value; }, observe() {} }, disposed);
    context.registerProcessor(shared); context.registerQueryObserver(shared);
  });
  const host = await createHost(t, [definition], { evidence: id, index: id, retrieval: id, processors: [id], observers: [id] });
  await Promise.all([host.dispose(), host.dispose()]);
  assert.deepEqual(disposed.sort(), ['evidence', 'index', 'retrieval', 'shared']);
});

test('successful conformance disposes a shared processor/observer only once', async () => {
  const disposed = [];
  const report = await runPluginConformance(plugin((context) => {
    const shared = tracked('shared', { id, version: '1.0.0', stage: 'record', mutate(value) { return value; }, observe() {} }, disposed);
    context.registerProcessor(shared); context.registerQueryObserver(shared);
  }));
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.deepEqual(disposed, ['shared']);
});
