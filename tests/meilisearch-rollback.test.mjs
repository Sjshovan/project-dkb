import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { discardMeilisearchPackage, meilisearchIndexId, writeMeilisearchPackageArtifacts } from '@sjshovan/dkb-index-meilisearch/meilisearchProvider.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-meili-rollback-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dkb = { root, manifest: { id: '@test/knowledge', version: '1.0.0' } };
  const artifactsRoot = path.join(root, 'artifacts');
  const compatibility = { dimensions: 1, metric: 'cosine', embeddingSpace: 'new-space' };
  const record = { id: 'evidence-1', chunkId: 'chunk-1', text: 'alpha beta', metadata: {}, provenance: { assetId: 'asset-1', storeId: 'filesystem', sourceType: 'filesystem', locator: { path: 'knowledge.txt', chunk: 0 }, assetLocator: { path: 'knowledge.txt' }, title: 'knowledge.txt', sourceHash: `sha256:${'a'.repeat(64)}`, updatedAt: '2026-01-01T00:00:00.000Z', chunkOrdinal: 0, chunkStart: 0, chunkEnd: 10 } };
  await writeMeilisearchPackageArtifacts({ dkb, artifactsRoot, compatibility, compiled: { documents: [], chunks: [], records: [record], vectors: [{ evidenceId: record.id, values: [1] }], receipts: [] } });
  const libraryId = '@test/library';
  const indexId = meilisearchIndexId(root, libraryId, dkb.manifest.id, dkb.manifest.version, stableHash(compatibility));
  const oldIndexId = meilisearchIndexId(root, libraryId, dkb.manifest.id, dkb.manifest.version, stableHash({ ...compatibility, embeddingSpace: 'old-space' }));
  const requests = [];
  const indexes = new Set([indexId, oldIndexId]);
  let fail = false;
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader('content-type', 'application/json');
    if (fail) { response.writeHead(503); response.end(JSON.stringify({ message: 'fixture unavailable', code: 'unavailable' })); return; }
    if (request.method === 'DELETE') { indexes.delete(decodeURIComponent(request.url.slice('/indexes/'.length))); response.end('null'); return; }
    response.writeHead(500); response.end(JSON.stringify({ message: 'Unexpected request' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const previous = process.env.DKB_TEST_ROLLBACK_MEILI_URL;
  process.env.DKB_TEST_ROLLBACK_MEILI_URL = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { if (previous === undefined) delete process.env.DKB_TEST_ROLLBACK_MEILI_URL; else process.env.DKB_TEST_ROLLBACK_MEILI_URL = previous; });
  return { input: { libraryRoot: root, libraryId, dkb, artifactsRoot, compatibility, indexId, options: { urlEnv: 'DKB_TEST_ROLLBACK_MEILI_URL', apiKeyEnv: 'DKB_TEST_ROLLBACK_UNUSED_KEY', timeoutMs: 500 } }, indexes, requests, oldIndexId, fail: () => { fail = true; } };
}

test('Meilisearch transaction rollback deletes only its exact newly prepared space', async (t) => {
  const f = await fixture(t);
  const result = await discardMeilisearchPackage(f.input);
  assert.equal(result.status, 'removed', result.warning);
  assert.equal(result.indexId, f.input.indexId);
  assert.deepEqual(f.requests, [`DELETE /indexes/${f.input.indexId}`]);
  assert.deepEqual([...f.indexes], [f.oldIndexId]);
});

test('Meilisearch rollback rejects another space or arbitrary index without contacting the service', async (t) => {
  const f = await fixture(t);
  for (const indexId of [f.oldIndexId, 'unrelated-index']) {
    await assert.rejects(discardMeilisearchPackage({ ...f.input, indexId }), /prepared build owns only/);
  }
  assert.deepEqual(f.requests, []);
  assert.equal(f.indexes.size, 2);
  const signal = AbortSignal.abort(new Error('cancel rollback'));
  await assert.rejects(discardMeilisearchPackage({ ...f.input, signal }), /cancel rollback/);
  assert.deepEqual(f.requests, []);
});

test('Meilisearch rollback reports an exact actionable orphan without broad fallback', async (t) => {
  const f = await fixture(t);
  f.fail();
  const result = await discardMeilisearchPackage(f.input);
  assert.equal(result.status, 'orphaned');
  assert.equal(result.indexId, f.input.indexId);
  assert.match(result.warning, /Previous indexes were left untouched.*remove only this orphan/);
  assert.equal(f.indexes.size, 2);
  assert.ok(f.requests.every((request) => request === `DELETE /indexes/${f.input.indexId}`));
});
