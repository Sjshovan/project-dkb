import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { materializeEvidenceCatalog, readEvidenceCatalog } from '@sjshovan/dkb-library/evidenceCatalog.js';
import { buildEvidenceIr } from '@sjshovan/dkb-protocol/evidence/ir.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';

test('canonical Evidence catalog preserves source identities, text, provenance, chunks, and derived capabilities', async (t) => {
  const { root, evidence } = await catalogFixture(t);
  const catalog = readEvidenceCatalog(root);
  assert.equal(catalog.evidenceDigest, evidence.evidenceDigest);
  assert.equal(catalog.evidenceProfileDigest, evidence.evidenceProfileDigest);
  assert.equal(catalog.assets.length, 3);
  assert.equal(catalog.records.length, 4);
  for (const record of catalog.records) {
    const canonical = evidence.evidence.find((entry) => entry.evidenceId === record.evidenceId);
    const chunk = evidence.chunks.find((entry) => entry.evidenceId === record.evidenceId);
    for (const field of ['sourceId', 'packageId', 'packageVersion', 'assetId', 'storeId', 'sourceType', 'locator', 'assetLocator', 'title', 'text', 'textHash', 'sourceHash', 'provenance']) {
      assert.deepEqual(record[field], canonical[field], field);
    }
    assert.equal(record.chunkOrdinal, chunk.ordinal);
    assert.equal(record.chunkStart, chunk.start);
    assert.equal(record.chunkEnd, chunk.end);
    assert.equal(record.updatedAt, '2026-09-02T00:00:00.000Z');
    assert.equal(record.heading, 'Verified heading');
    assert.equal(record.queryable, undefined);
    assert.ok(record.keywords.includes('catalog-proof-62'));
    assert.equal(record.capabilities.records, record.sourceType === 'filesystem' ? 'none' : 'full');
  }
  const original = structuredClone(catalog);
  await materializeEvidenceCatalog(root, evidence);
  assert.deepEqual(readEvidenceCatalog(root), original);
});

test('cold catalog reads reject altered text, provenance, source metadata, capabilities, and membership', async (t) => {
  const { root, evidence, target } = await catalogFixture(t);
  const mutations = [
    ['text and claimed text hash', "update evidence_records set evidence_text = 'FORGED-TEXT-99', text_hash = 'sha256:forged'"],
    ['title', "update evidence_records set title = 'Forged title'"],
    ['source identity', "update evidence_records set source_id = 'sha256:forged'"],
    ['package identity', "update evidence_records set package_version = '9.9.9'"],
    ['source hash', "update evidence_records set source_hash = 'sha256:forged'"],
    ['record locator', `update evidence_records set locator_json = '{"path":"forged.md"}'`],
    ['asset locator', `update evidence_records set asset_locator_json = '{"path":"forged.md"}'`],
    ['provenance', `update evidence_records set provenance_json = '{"dkb_heading":"Forged"}'`],
    ['keywords', `update evidence_records set keywords_json = '["forged-keyword"]'`],
    ['capabilities', `update evidence_records set capabilities_json = '{"records":"full"}'`],
    ['queryable behavior', `update evidence_records set queryable_json = '{"table":"forged_table"}'`],
    ['chunk offsets', 'update evidence_records set chunk_end = chunk_end + 1'],
    ['heading', "update evidence_records set heading = 'Forged'"],
    ['asset metadata', "update evidence_assets set title = 'Forged'"],
    ['deleted records', 'delete from evidence_records'],
    ['deleted assets', 'delete from evidence_assets'],
    ['extra asset', "insert into evidence_assets values ('@test/foreign', 'extra', 'files', 'filesystem', '{}', 'Extra', 'sha256:forged', '1970-01-01T00:00:00.000Z')"],
    ['claimed Evidence digest', "update catalog_meta set value = 'sha256:forged' where key = 'evidenceDigest'"],
    ['claimed Evidence profile', "update catalog_meta set value = 'sha256:forged' where key = 'evidenceProfileDigest'"],
  ];
  for (const [label, sql] of mutations) {
    const database = new DatabaseSync(path.toNamespacedPath(target));
    try { database.exec(sql); } finally { database.close(); }
    assert.throws(() => readEvidenceCatalog(root), (error) => error.code === 'invalid_evidence_catalog', label);
    await materializeEvidenceCatalog(root, evidence);
  }
  assert.equal(readEvidenceCatalog(root).records.length, 4);
});

test('catalog validation fails closed when canonical Evidence IR is missing or tampered', async (t) => {
  const { root, evidence } = await catalogFixture(t);
  const evidencePath = path.join(root, 'evidence.ir.json');
  const changed = structuredClone(evidence);
  changed.evidence[0].text = 'FORGED-TEXT-99';
  await fs.writeFile(evidencePath, JSON.stringify(changed));
  assert.throws(() => readEvidenceCatalog(root), /expected digest/u);
  await fs.unlink(evidencePath);
  assert.throws(() => readEvidenceCatalog(root), (error) => error.code === 'ENOENT');
});

async function catalogFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-evidence-catalog-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRecords = [
    sourceRecord('duplicate-source', 'filesystem', 0),
    sourceRecord('duplicate-source', 'filesystem', 1),
    sourceRecord('\u{10000}', 'sqlite', 0),
    sourceRecord('\uE000', 'database', 0),
  ];
  const evidence = buildEvidenceIr([{ records: sourceRecords }], { evidenceProfileDigest: stableHash({ fixture: 'catalog' }) });
  await fs.writeFile(path.join(root, 'evidence.ir.json'), JSON.stringify(evidence));
  const target = await materializeEvidenceCatalog(root, evidence);
  return { root, evidence, target };
}

function sourceRecord(assetId, type, ordinal) {
  const text = `Verified CATALOG-PROOF-62 source ${assetId} chunk ${ordinal}.`;
  return {
    id: `${assetId}:${ordinal}`, assetId, storeId: 'files', type,
    locator: { path: `${assetId}.md`, chunk: ordinal }, assetLocator: { path: `${assetId}.md` },
    title: `${assetId} source`, text, hash: stableHash({ text }), updatedAt: '2026-09-02T00:00:00.000Z',
    chunkOrdinal: ordinal, chunkStart: ordinal * 100, chunkEnd: ordinal * 100 + text.length,
    metadata: { dkb_package_id: '@test/catalog', dkb_package_version: '1.0.0', dkb_source_hash: stableHash({ assetId }), heading: 'Verified heading' },
  };
}
