import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildLexicalRuntimeSnapshot } from '@dkb/providers-bundled/lexicalStore.js';
import { readNavigationChunks } from '@dkb/runtime/read/navigation.js';
import { readDkb } from '@dkb/runtime/read/runtime.js';
import { writeSourceIndex, type IndexedSourceUnit } from '@dkb/providers-bundled/sourceIndex.js';

test('package-local lexical search returns stable chunk ids and honors scope', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-navigation-'));
  const catalogPath = path.join(root, 'chunks.sqlite');
  const database = new DatabaseSync(catalogPath);

  try {
    database.exec(`
      create table chunks (
        numeric_id text primary key,
        chunk_id text not null,
        asset_id text not null,
        type text not null
      );
      create table lexical_tokens (
        token text not null,
        numeric_id text not null,
        weight real not null,
        primary key (token, numeric_id)
      );
      insert into chunks values ('101', 'chunk-auth', 'asset-auth', 'folder');
      insert into chunks values ('102', 'chunk-jobs', 'asset-jobs', 'folder');
      insert into lexical_tokens values ('retryuntil', '101', 3);
      insert into lexical_tokens values ('retry', '101', 1);
      insert into lexical_tokens values ('jobs', '102', 3);
    `);
  } finally {
    database.close();
  }

  const authUnit = testUnit('chunk-auth', 'asset-auth', 'Authentication', 'retryUntil controls failed job retries.');
  const jobsUnit = testUnit('chunk-jobs', 'asset-jobs', 'Jobs', 'Jobs may retry after a failure.');
  const unitsById = new Map([authUnit, jobsUnit].map((unit) => [unit.id, unit]));
  const lexical = buildLexicalRuntimeSnapshot({
    packages: [{ id: 'runtime-auth', version: '1.0.0', catalogPath, chunkCount: 2 }],
    numericIdToUnitId: new Map([['101', authUnit.id], ['102', jobsUnit.id]]),
    unitsById,
  });

  assert.ok(lexical);
  assert.deepEqual(lexical.search('retryUntil', 5).map((hit) => hit.unitId), ['chunk-auth']);
  assert.deepEqual(lexical.search('jobs', 5, { assetId: 'asset-auth' }), []);
  lexical.close();
  await fs.rm(root, { recursive: true, force: true });
});

test('direct read returns compiled chunk evidence and blocks search-shaped reads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-navigation-'));
  const unit = testUnit('chunk-001', 'asset-001', 'README', 'The runtime reads compiled chunks directly.');

  try {
    await writeSourceIndex(root, [unit], []);
    const read = await readNavigationChunks(root, ['package-a/chunk-001']);

    assert.equal(read.status, 'complete');
    assert.equal(read.chunks[0]?.reference.sourceId, 'chunk-001');
    assert.match(read.chunks[0]?.text ?? '', /UNTRUSTED_SOURCE_BEGIN/);
    assert.equal(read.trace.adapterRead, false);
    assert.equal(read.trace.sourceCompilation, false);

    const direct = await readDkb(root, {
      queries: [{ id: 'q1', target: 'package-a/chunk-001', operation: 'fetch' }],
    });
    assert.equal(direct.status, 'complete');
    assert.equal(direct.queries[0]?.status, 'complete');

    const blocked = await readDkb(root, {
      queries: [{ id: 'q2', target: 'package-a', operation: 'search' }],
    });
    assert.equal(blocked.queries[0]?.status, 'blocked');
    assert.equal(blocked.queries[0]?.reason, 'unsupported_operation');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function testUnit(id: string, assetId: string, title: string, text: string): IndexedSourceUnit {
  return {
    id,
    assetId,
    dkbId: 'package-a',
    packageVersion: '1.0.0',
    storeId: 'source',
      type: 'filesystem',
    locator: { path: `sources/${id}.md` },
    assetLocator: { path: `sources/${assetId}.md` },
    title,
    text,
    keywords: [],
    capabilities: {
      evidence: 'full',
      records: 'none',
      exactCount: 'none',
      approximateCount: 'partial',
      structuredFilter: 'none',
      operations: ['fetch', 'search'],
    },
    hash: `hash-${id}`,
    updatedAt: '2026-08-19T00:00:00.000Z',
    chunkOrdinal: 0,
    chunkStart: 0,
    chunkEnd: text.length,
  };
}
