import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DkbProviderHost } from '@sjshovan/dkb-pipeline/host.js';
import { defineEmbeddingProvider } from '@sjshovan/dkb-pipeline/sdk.js';
import { runPluginConformance } from '@sjshovan/dkb-pipeline/testing.js';
import { materializeBundledProviderFixtures } from './bundled-provider-fixture.mjs';
import {
  validateIndexHits,
  validatePipelineChunks,
  validatePipelineDocuments,
  validatePipelineRecords,
  validateParsedDocuments,
  validateLocatedChunks,
  validateRetrievalHits,
  validateVector,
  validateVectors,
} from '@sjshovan/dkb-pipeline/validation.js';

const optionsSchema = { '~standard': { version: 1, vendor: 'test', validate(value) { return { value: value ?? {} }; } } };
const sourceHash = `sha256:${'a'.repeat(64)}`;
const plugin = (id, setup) => ({
  apiVersion: 3, id, version: '1.0.0', sourceUrl: import.meta.url, optionsSchema, setup,
  integrity: { apiVersion: 3, id, version: '1.0.0', protocols: [], artifactFormats: [] },
});

function sample(stage) {
  if (stage === 'document') return { id: 'document-1', path: 'source.md', text: 'alpha', metadata: {}, provenance: { assetId: 'asset-1', storeId: 'filesystem', sourceType: 'filesystem', assetLocator: { path: 'source.md' }, title: 'Source', sourceHash, updatedAt: '2026-01-01T00:00:00.000Z' } };
  if (stage === 'chunk') return { id: 'chunk-1', documentId: 'document-1', text: 'alpha', metadata: {}, provenance: { locator: { path: 'source.md', chunk: 0 }, chunkOrdinal: 0, chunkStart: 0, chunkEnd: 5 } };
  return {
    id: 'record-1', chunkId: 'chunk-1', text: 'alpha', metadata: {},
    provenance: {
      assetId: 'asset-1', storeId: 'filesystem', sourceType: 'filesystem',
      locator: { path: 'source.md', chunk: 0 }, assetLocator: { path: 'source.md' },
      title: 'Source', sourceHash, updatedAt: '2026-01-01T00:00:00.000Z',
      chunkOrdinal: 0, chunkStart: 0, chunkEnd: 5,
    },
  };
}

async function processorHost(t, stage, mutate) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-output-boundaries-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const core = plugin('@test/output-core', (context) => {
    context.registerProvider({ kind: 'parser', async parse() { return []; } });
    context.registerProvider({ kind: 'chunker', async chunk() { return []; } });
    context.registerProvider({
      kind: 'index', mode: 'packaged', format: 'test.output.v1', capabilities: { vectors: 'none' },
      async compilePackage() { return null; }, async validatePackage() { return { documentCount: 0 }; },
      async verifyRuntime() { return { indexId: 'test', documentCount: 0, status: 'ready' }; },
      async openRuntime() { return null; },
    });
    context.registerProvider({
      kind: 'retrieval', protocol: 'dkb.evidence.v1', capabilities: { vectors: 'none' },
      openRuntime() { return { providerId: '@test/output-core', protocol: 'dkb.evidence.v1', async search() { return { hits: [], trace: {} }; }, close() {} }; },
    });
  });
  const processor = plugin('@test/output-processor', (context) => context.registerProcessor({
    id: '@test/output-processor', version: '1.0.0', stage, mutate,
  }));
  const host = await DkbProviderHost.create({
    root, globalRoot: path.join(root, 'global'),
    distribution: await materializeBundledProviderFixtures(t, {
      id: '@test/output-distribution', version: '1.0.0', defaultTarget: 'test', services: [],
      defaults: { format: 'dkb.config.v2', activeTarget: 'test', targets: {
        test: { parser: core.id, chunker: core.id, index: core.id, retrieval: core.id, processors: [processor.id] },
      } },
      plugins: [core, processor],
    }),
  });
  t.after(() => host.dispose());
  return host;
}

for (const stage of ['document', 'chunk', 'record']) {
  test(`production ${stage} processors reject in-place protected mutations and allow in-place text edits`, async (t) => {
    let mutation;
    const host = await processorHost(t, stage, (value) => { mutation(value); return value; });
    const cases = [
      ['id', (value) => { value.id = 'forged-id'; }],
      ['reserved metadata', (value) => { value.metadata.dkb_source = { path: 'forged.md' }; }],
      ...(stage === 'document' ? [
        ['path', (value) => { value.path = 'forged.md'; }],
        ['source provenance', (value) => { value.provenance.sourceHash = `sha256:${'b'.repeat(64)}`; }],
      ] : stage === 'chunk' ? [
        ['document reference', (value) => { value.documentId = 'forged-document'; }],
        ['span provenance', (value) => { value.provenance.chunkStart = 1; }],
      ] : [
        ['chunk reference', (value) => { value.chunkId = 'forged-chunk'; }],
        ['source hash', (value) => { value.provenance.sourceHash = `sha256:${'b'.repeat(64)}`; }],
        ['source locator', (value) => { value.provenance.assetLocator.path = 'forged.md'; }],
        ['chunk locator', (value) => { value.provenance.locator.chunk = 9; }],
      ]),
    ];
    for (const [label, change] of cases) {
      mutation = change;
      await assert.rejects(host.mutate(stage, [sample(stage)]),
        (error) => /^protected_(identity|provenance)_mutation$/u.test(error.code), label);
    }
    mutation = (value) => { value.text += ' beta'; value.metadata.summary = 'alpha beta'; };
    const [output] = await host.mutate(stage, [sample(stage)]);
    assert.equal(output.text, 'alpha beta');
    assert.equal(output.metadata.summary, 'alpha beta');
    assert.deepEqual(output.provenance, sample(stage).provenance);
  });
}

test('separate providers require explicit provenance instead of metadata inference', () => {
  const document = sample('document');
  const chunk = sample('chunk');
  assert.deepEqual(validateParsedDocuments([document], 'parser'), [document]);
  assert.deepEqual(validateLocatedChunks([chunk], 'chunker', [document]), [chunk]);
  for (const [value, validate] of [[document, validateParsedDocuments], [chunk, validateLocatedChunks]]) {
    const hidden = { ...value, metadata: { ...value.provenance } };
    delete hidden.provenance;
    assert.throws(() => validate([hidden], 'test'), /requires explicit/u);
  }
  assert.throws(() => validateParsedDocuments([{ ...document, provenance: { ...document.provenance, assetLocator: { path: '../private.md' } } }], 'parser'), /contained portable path/u);
  assert.throws(() => validateLocatedChunks([{ ...chunk, provenance: { ...chunk.provenance, chunkStart: 7, chunkEnd: 5 } }], 'chunker'), /must not precede/u);
});

test('discarded processor inputs cannot mutate another record through shared provenance', async (t) => {
  const first = sample('record');
  const second = { ...sample('record'), id: 'record-2', chunkId: 'chunk-2', provenance: first.provenance };
  const host = await processorHost(t, 'record', (value) => {
    if (value.id === 'record-1') {
      value.provenance.sourceHash = `sha256:${'b'.repeat(64)}`;
      value.provenance.assetLocator.path = 'forged.md';
      return null;
    }
    value.text += ' normalized';
    return value;
  });

  const output = await host.mutate('record', [first, second]);
  assert.equal(output.length, 1);
  assert.equal(output[0].id, 'record-2');
  assert.equal(output[0].text, 'alpha normalized');
  assert.deepEqual(output[0].provenance, sample('record').provenance);
  assert.deepEqual(first.provenance, sample('record').provenance);
  assert.equal(second.text, 'alpha');
});

test('retained processor outputs cannot be rewritten by a later mutation or after completion', async (t) => {
  let retained;
  const host = await processorHost(t, 'record', (value) => {
    if (value.id === 'record-1') {
      value.text += ' normalized';
      retained = value;
      return value;
    }
    retained.provenance.sourceHash = `sha256:${'b'.repeat(64)}`;
    retained.provenance.locator.path = 'forged.md';
    retained.text = 'forged output';
    retained.metadata.dkb_source = 'forged';
    return value;
  });

  const output = await host.mutate('record', [sample('record'), { ...sample('record'), id: 'record-2', chunkId: 'chunk-2' }]);
  retained.provenance.assetLocator.path = 'later-forgery.md';
  retained.text = 'later output';
  assert.equal(output[0].text, 'alpha normalized');
  assert.deepEqual(output[0].metadata, {});
  assert.deepEqual(output[0].provenance, sample('record').provenance);
  assert.deepEqual(output[1].provenance, sample('record').provenance);
});

test('provider validators reject sparse vector and candidate arrays instead of skipping holes', () => {
  const known = new Set(['record-1']);
  const cases = [
    ['query vector', () => validateVector(Array(2), 2, 'test')],
    ['partially sparse vector', () => validateVector([1, , 0], 3, 'test')],
    ['document vector batch', () => validateVectors(Array(2), 2, 2, 'test')],
    ['document vector row', () => validateVectors([[1, 0], Array(2)], 2, 2, 'test')],
    ['index hits', () => validateIndexHits(Array(1), known, 5, 'test')],
    ['retrieval hits', () => validateRetrievalHits(Array(1), known, 5, 'test')],
    ['retrieval channels', () => validateRetrievalHits([{ evidenceId: 'record-1', score: 1, channels: Array(1) }], known, 5, 'test')],
  ];
  for (const [label, action] of cases) assert.throws(action, (error) => /^invalid_/u.test(error.code), label);
  assert.deepEqual(validateVectors([[1, 0], [0, 1]], 2, 2, 'test'), [[1, 0], [0, 1]]);
  assert.deepEqual(validateIndexHits([], known, 5, 'test'), []);
  assert.deepEqual(validateRetrievalHits([{ evidenceId: 'record-1', score: 0, channels: ['lexical'] }], known, 5, 'test'), [{ evidenceId: 'record-1', score: 0, channels: ['lexical'] }]);
});

test('Evidence collections and nested metadata cannot hide invalid values in sparse slots', () => {
  for (const [stage, validate] of [
    ['document', validatePipelineDocuments], ['chunk', validatePipelineChunks], ['record', validatePipelineRecords],
  ]) {
    assert.throws(() => validate(Array(1), 'test'), /dense array/u, stage);
    const value = sample(stage);
    value.metadata.nested = { values: Array(1) };
    assert.throws(() => validate([value], 'test'), (error) => error.code === 'invalid_json', stage);
  }
});

test('public embedding conformance rejects sparse document batches and query vectors', async () => {
  for (const malformed of ['batch', 'query']) {
    const report = await runPluginConformance({
      apiVersion: 3, id: '@test/sparse-embedding', version: '1.0.0', optionsSchema,
      setup(context) {
        context.registerProvider(defineEmbeddingProvider({
          kind: 'embedding',
          async embedDocuments({ texts }) { return malformed === 'batch' ? Array(texts.length) : texts.map(() => [1, 0]); },
          async embedQuery() { return malformed === 'query' ? Array(2) : [1, 0]; },
          compatibility() { return { embeddingSpace: 'test', dimensions: 2, metric: 'cosine', normalized: true }; },
        }));
      },
    });
    assert.equal(report.ok, false, malformed);
    assert.equal(report.checks.find((check) => check.name === 'Document and query vector compatibility')?.status, 'failed', malformed);
  }
});
