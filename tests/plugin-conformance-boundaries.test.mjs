import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DkbProviderHost } from '@sjshovan/dkb-pipeline/host.js';
import { runPluginConformance } from '@sjshovan/dkb-pipeline/testing.js';
import { defineEmbeddingProvider, definePackagedIndexProvider, defineManagedIndexProvider, defineRetrievalProvider, emptyOptionsSchema } from '@sjshovan/dkb-pipeline/sdk.js';
import { materializeBundledProviderFixtures } from './bundled-provider-fixture.mjs';

const compatibility = { embeddingSpace: 'test-space', dimensions: 2, metric: 'cosine', normalized: true };
const plugin = (id, setup) => ({ apiVersion: 3, id, version: '1.0.0', optionsSchema: emptyOptionsSchema, setup });
const failed = (report, name) => {
  assert.equal(report.ok, false, JSON.stringify(report.checks));
  assert.equal(report.checks.find((check) => check.name === name)?.status, 'failed', JSON.stringify(report.checks));
};

test('embedding conformance requires the complete compatibility contract and equal vector dimensions', async () => {
  for (const field of ['embeddingSpace', 'dimensions', 'metric', 'normalized']) {
    const incomplete = { ...compatibility };
    delete incomplete[field];
    const report = await runPluginConformance(embeddingPlugin({ compatibility: incomplete }));
    failed(report, 'Document and query vector compatibility');
    assert.match(report.checks.find((check) => check.name === 'Document and query vector compatibility').detail, /embeddingSpace.*dimensions.*metric.*normalized/u);
  }
  for (const changes of [{ compatibility: { ...compatibility, dimensions: 0 } }, { compatibility: { ...compatibility, normalized: 'true' } }, { queryVector: [1, 0, 0] }, { documentVector: [1] }]) {
    failed(await runPluginConformance(embeddingPlugin(changes)), 'Document and query vector compatibility');
  }
  assert.equal((await runPluginConformance(embeddingPlugin())).ok, true);
});

function embeddingPlugin({ compatibility: supplied = compatibility, documentVector = [1, 0], queryVector = [1, 0], health } = {}) {
  return plugin('@test/conformance-embedding', (context) => context.registerProvider(defineEmbeddingProvider({
    kind: 'embedding', compatibility() { return supplied; },
    async embedDocuments({ texts }) { return texts.map(() => documentVector); },
    async embedQuery() { return queryVector; },
    ...(health ? { health } : {}),
  })));
}

test('index conformance rejects mismatched counts and non-ready verification', async () => {
  for (const changes of [
    { validation: { documentCount: 0 } }, { validation: { documentCount: 999 } },
    { validation: Object.assign([], { documentCount: 1 }) },
    { verification: { indexId: 'fixture', documentCount: 1, status: 'orphaned', warning: 'Index unavailable' } },
    { verification: { indexId: 'fixture', documentCount: 1, status: 'removed' } },
    { verification: { indexId: 'fixture', documentCount: 999, status: 'ready' } },
  ]) {
    failed(await runPluginConformance(indexPlugin(changes)), 'packaged index lifecycle');
  }
  failed(await runPluginConformance(indexPlugin({ mode: 'managed', installedCount: 999 })), 'managed index lifecycle');
  assert.equal((await runPluginConformance(indexPlugin())).ok, true);
});

test('index conformance requires an opened Runtime and the actual indexed Evidence hit', async () => {
  for (const mode of ['packaged', 'managed']) {
    failed(await runPluginConformance(indexPlugin({ mode, missingRuntime: true })), `${mode} index lifecycle`);
    failed(await runPluginConformance(indexPlugin({ mode, hits: [] })), `${mode} index lifecycle`);
    failed(await runPluginConformance(indexPlugin({ mode, hits: [{ id: 'unknown-evidence', score: 1 }] })), `${mode} index lifecycle`);
    assert.equal((await runPluginConformance(indexPlugin({ mode }))).ok, true);
  }
});

function indexPlugin({ validation = { documentCount: 1 }, verification = { indexId: 'fixture', documentCount: 1, status: 'ready' }, mode = 'packaged', installedCount = 1, missingRuntime = false, hits = [{ id: 'evidence-1', score: 1 }], storageIdentity = () => `sha256:${'a'.repeat(64)}` } = {}) {
  const define = mode === 'managed' ? defineManagedIndexProvider : definePackagedIndexProvider;
  return plugin('@test/conformance-index', (context) => context.registerProvider(define({
    kind: 'index', mode, format: 'test.index.v1', capabilities: { vectors: 'none' },
    async compilePackage() { return null; },
    async validatePackage() { return validation; },
    async verifyRuntime() { return verification; },
    async openRuntime() { return missingRuntime ? null : { providerId: '@test/conformance-index', mode, format: 'test.index.v1', packages: [],
      async search() { return { hits, trace: {} }; }, async close() {} }; },
    ...(mode === 'managed' ? {
      storageIdentity,
      async installPackage() { return { indexId: 'fixture', documentCount: installedCount, status: 'ready', created: true }; },
      async discardPackage({ indexId }) { return { indexId, documentCount: 0, status: 'removed' }; },
      async uninstallPackage() { return { indexId: 'fixture', documentCount: 0, status: 'removed' }; },
    } : {}),
  })));
}

test('managed conformance rejects invalid and unstable backing-store identities', async () => {
  for (const value of [undefined, '', 'https://index.example', 'sha256:bad', 42]) {
    failed(await runPluginConformance(indexPlugin({ mode: 'managed', storageIdentity: () => value })), 'managed index lifecycle');
  }
  let call = 0;
  failed(await runPluginConformance(indexPlugin({ mode: 'managed', storageIdentity: () => `sha256:${String(++call).repeat(64)}` })), 'managed index lifecycle');
});

test('provider health cannot override host identity or smuggle non-boolean readiness', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-health-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = '@test/owned-health';
  let payload = { ok: true, id: '@test/impostor', kind: 'embedding', extra: 'discarded' };
  const definition = {
    ...indexPlugin(), id, sourceUrl: import.meta.url,
    integrity: { apiVersion: 3, id, version: '1.0.0', protocols: [], artifactFormats: [] },
    setup(context) {
      indexPlugin().setup({ ...context, registerProvider(provider) { context.registerProvider({ ...provider, health: async () => payload }); } });
      context.registerProvider({ kind: 'evidence', async compile() { return { records: [], receipt: { build: {} } }; } });
      context.registerProvider({ kind: 'retrieval', protocol: 'test.evidence.v1', capabilities: { vectors: 'none' }, async openRuntime() { return { providerId: id, protocol: 'test.evidence.v1', async search() { return { hits: [], trace: {} }; }, close() {} }; } });
    },
  };
  const distribution = await materializeBundledProviderFixtures(t, {
    id: '@test/distribution', version: '1.0.0', services: [],
    defaults: { format: 'dkb.config.v2', activeTarget: 'fixture', targets: { fixture: { evidence: id, index: id, retrieval: id, embedding: null } } },
    plugins: [definition],
  });
  const host = await DkbProviderHost.create({ root, globalRoot: path.join(root, 'global'), distribution });
  t.after(() => host.dispose());
  assert.deepEqual(await host.health(['index']), [{ id, kind: 'index', ok: true }]);
  for (const malformed of [null, undefined, [], { ok: 'false' }, { ok: 1 }, { ok: true, detail: {} }]) {
    payload = malformed;
    const [health] = await host.health(['index']);
    assert.equal(health.id, id);
    assert.equal(health.kind, 'index');
    assert.equal(health.ok, false);
    assert.match(health.detail, /health\(\).*boolean ok.*Repair the selected plugin/u);
    failed(await runPluginConformance(embeddingPlugin({ health: async () => malformed })), 'embedding health');
  }
  payload = { ok: false, detail: 'Service is offline' };
  assert.deepEqual(await host.health(['index']), [{ id, kind: 'index', ok: false, detail: 'Service is offline' }]);
});

test('retrieval conformance includes a relevant competing package and rejects a scope-blind provider', async () => {
  const definition = plugin('@test/scope-blind', (context) => context.registerProvider(defineRetrievalProvider({
    kind: 'retrieval', protocol: 'dkb.evidence.v1', capabilities: { vectors: 'none' },
    openRuntime({ evidence }) {
      return { providerId: context.pluginId, protocol: 'dkb.evidence.v1',
        async search({ query, limit }) {
          return { hits: evidence.records.filter((record) => record.text.includes(query)).slice(0, limit)
            .map((record) => ({ evidenceId: record.evidenceId, score: 1, channels: ['lexical'] })), trace: {} };
        }, close() {},
      };
    },
  })));
  const report = await runPluginConformance(definition);
  failed(report, 'Retrieval Runtime and result validation');
  assert.match(report.checks.find((check) => check.name === 'Retrieval Runtime and result validation').detail, /outside the requested Evidence scope/u);
});

test('retrieval conformance rejects a provider that always returns no results', async () => {
  const definition = plugin('@test/empty-retrieval', (context) => context.registerProvider(defineRetrievalProvider({
    kind: 'retrieval', protocol: 'dkb.evidence.v1', capabilities: { vectors: 'none' },
    openRuntime() { return { providerId: context.pluginId, protocol: 'dkb.evidence.v1',
      async search() { return { hits: [], trace: {} }; }, close() {} }; },
  })));
  const report = await runPluginConformance(definition);
  failed(report, 'Retrieval Runtime and result validation');
  assert.match(report.checks.find((check) => check.name === 'Retrieval Runtime and result validation').detail, /relevant in-scope alpha/u);
});

test('managed conformance failures clean up only their validated newly-created index and preserve the primary error', async () => {
  for (const stage of ['verify', 'search']) {
    for (const created of [true, false, undefined]) {
      for (const { cleanupFailure, installedCount } of [{ cleanupFailure: false, installedCount: 1 }, { cleanupFailure: true, installedCount: 1 }, { cleanupFailure: false, installedCount: 999 }]) {
        const calls = [];
        const id = '@test/conformance-cleanup';
        const indexId = 'new-conformance-index';
        const definition = plugin(id, (context) => context.registerProvider(defineManagedIndexProvider({
          kind: 'index', mode: 'managed', format: 'test.index.v1', capabilities: { vectors: 'none' },
          storageIdentity() { return `sha256:${'a'.repeat(64)}`; },
          async compilePackage() { return null; },
          async validatePackage() { return { documentCount: 1 }; },
          async installPackage() { calls.push('install'); return { indexId, documentCount: installedCount, status: 'ready', ...(created === undefined ? {} : { created }) }; },
          async verifyRuntime() {
            calls.push('verify');
            if (stage === 'verify') throw new Error('primary verify failure');
            return { indexId, documentCount: 1, status: 'ready' };
          },
          async openRuntime() {
            return { providerId: id, mode: 'managed', format: 'test.index.v1', packages: [],
              async search() { calls.push('search'); throw new Error('primary search failure'); },
              close() { calls.push('close'); if (cleanupFailure) throw new Error('runtime close failure'); },
            };
          },
          async discardPackage(input) {
            calls.push(`discard:${input.indexId}`);
            assert.equal(input.indexId, indexId);
            if (cleanupFailure) throw new Error('cleanup transport failure');
            return { indexId, documentCount: 0, status: 'removed' };
          },
          async uninstallPackage() { calls.push('broad-uninstall'); return { indexId, documentCount: 0, status: 'removed' }; },
          dispose() { calls.push('dispose'); },
        })));
        const report = await runPluginConformance(definition);
        failed(report, 'managed index lifecycle');
        const primary = report.checks.find((check) => check.name === 'managed index lifecycle');
        assert.match(primary.detail, created === undefined || installedCount !== 1 ? /exact Evidence count.*explicit index ownership/u : new RegExp(`primary ${stage} failure`, 'u'));
        assert.equal(calls.includes('broad-uninstall'), false);
        assert.equal(calls.filter((call) => call === `discard:${indexId}`).length, created === true ? 1 : 0);
        assert.equal(calls.filter((call) => call === 'dispose').length, 1);
        const cleanup = report.checks.find((check) => check.name === 'managed index failure cleanup');
        if (created === true) {
          assert.equal(cleanup.status, cleanupFailure ? 'failed' : 'passed');
          if (cleanupFailure) assert.match(cleanup.detail, /new-conformance-index.*cleanup transport failure.*no broad package uninstall/u);
        } else assert.equal(cleanup, undefined);
        if (stage === 'search' && installedCount === 1 && created !== undefined && cleanupFailure) {
          assert.equal(report.checks.find((check) => check.name === 'index Runtime failure disposal')?.status, 'failed');
        }
      }
    }
  }
});
