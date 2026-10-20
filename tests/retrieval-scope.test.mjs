import assert from 'node:assert/strict';
import test from 'node:test';
import { createHybridRetrievalProvider } from '@sjshovan/dkb-retrieval-hybrid';

test('hybrid retrieval removes cross-package vector candidates before fusion', async () => {
  const records = [
    evidenceRecord('evidence-a', '@test/scope-a', 'SCOPE-A-ONLY'),
    evidenceRecord('evidence-b', '@test/scope-b', 'SCOPE-B-ONLY'),
  ];
  const index = {
    providerId: '@test/index',
    mode: 'packaged',
    format: 'test.index.v1',
    packages: [],
    async search() {
      return { hits: [{ id: 'evidence-b', score: 1 }], trace: { mode: 'cross-package-fixture' } };
    },
    close() {},
  };
  const provider = createHybridRetrievalProvider('@test/hybrid');
  const runtime = provider.openRuntime({
    index,
    evidence: { assets: [], records },
    options: {},
  });

  try {
    const result = await runtime.search({
      query: 'SCOPE-A-ONLY',
      limit: 5,
      scope: { dkbId: '@test/scope-a' },
    });

    assert.deepEqual(result.hits.map((hit) => hit.evidenceId), ['evidence-a']);
    assert.equal(result.trace.vectorCandidates, 0);
    assert.equal(result.trace.vectorCandidatesRejectedByScope, 1);
  } finally {
    await runtime.close();
  }
});

test('bundled hybrid relevance rejects weak vector matches before any transport sees them', async () => {
  const record = evidenceRecord('evidence-code', '@test/code', 'The base code contains the class which registers ModuleManager.');
  const index = { providerId: '@test/index', mode: 'packaged', format: 'test.index.v1', packages: [],
    async search() { return { hits: [{ id: record.evidenceId, score: 1 }], trace: {} }; }, close() {} };
  const runtime = createHybridRetrievalProvider('@test/hybrid').openRuntime({
    index, evidence: { assets: [], records: [record] }, options: {},
  });
  try {
    const weak = await runtime.search({ query: 'What is the launch code for the moon base?', limit: 5 });
    assert.equal(weak.trace.tokenCoverage, 0.5);
    assert.deepEqual(weak.hits, []);
    const supported = await runtime.search({ query: 'Which class registers ModuleManager?', limit: 5 });
    assert.equal(supported.trace.tokenCoverage, 1);
    assert.deepEqual(supported.hits.map((hit) => hit.evidenceId), [record.evidenceId]);
    const unrelated = await runtime.search({ query: 'qzxxnonexistent', limit: 5 });
    assert.deepEqual(unrelated.hits, []);
  } finally { await runtime.close(); }
});

function evidenceRecord(evidenceId, packageId, text) {
  return {
    evidenceId,
    sourceId: `${evidenceId}-source`,
    packageId,
    packageVersion: '1.0.0',
    assetId: `${evidenceId}.md`,
    storeId: 'filesystem',
    sourceType: 'filesystem',
    locator: { path: `${evidenceId}.md`, chunk: 0 },
    assetLocator: { path: `${evidenceId}.md` },
    title: `${evidenceId}.md`,
    text,
    textHash: `sha256:${'b'.repeat(64)}`,
    sourceHash: `sha256:${'a'.repeat(64)}`,
    provenance: {},
    keywords: [text],
    capabilities: {
      evidence: 'full',
      records: 'none',
      exactCount: 'none',
      approximateCount: 'partial',
      structuredFilter: 'none',
      operations: ['fetch', 'search'],
    },
    chunkOrdinal: 0,
    chunkStart: 0,
    chunkEnd: text.length,
    updatedAt: '2026-08-28T00:00:00.000Z',
  };
}
