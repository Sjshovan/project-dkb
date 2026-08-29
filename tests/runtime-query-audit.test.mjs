import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  DKB_QUERY_AUDIT_DB,
  listQueryAudit,
  queryAuditDatabasePath,
} from '@sjshovan/dkb-runtime/runtime/queryAudit.js';

test('query audit creates and reopens only the current derived schema', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-query-audit-current-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  assert.deepEqual(await listQueryAudit(root), []);
  const database = new DatabaseSync(path.toNamespacedPath(queryAuditDatabasePath(root)));

  try {
    const columns = database.prepare('pragma table_info(query_audit)').all();
    const eventId = columns.find((column) => column.name === 'event_id');
    assert.equal(eventId?.notnull, 1);
  } finally {
    database.close();
  }

  assert.deepEqual(await listQueryAudit(root), []);
});

test('query audit rejects a pre-cutover schema instead of silently migrating it', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-query-audit-obsolete-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const databasePath = path.join(root, '.dkb', DKB_QUERY_AUDIT_DB);
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(path.toNamespacedPath(databasePath));

  try {
    database.exec(`
      create table query_audit (
        id integer primary key autoincrement,
        recorded_at text not null,
        channel text not null,
        request_id text not null,
        query text not null,
        intent text not null,
        result_count integer not null,
        status text not null,
        packages_json text not null,
        citations_json text not null,
        timing_json text not null
      )
    `);
  } finally {
    database.close();
  }

  await assert.rejects(
    listQueryAudit(root),
    (error) => {
      assert.match(error.message, /format is obsolete/u);
      assert.match(error.message, /remove only this DKB-owned derived database/u);
      assert.match(error.message, new RegExp(escapeRegExp(databasePath), 'u'));
      return true;
    },
  );

  const preserved = new DatabaseSync(path.toNamespacedPath(databasePath));
  try {
    assert.equal(
      preserved.prepare('pragma table_info(query_audit)').all().some((column) => column.name === 'event_id'),
      false,
    );
  } finally {
    preserved.close();
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
