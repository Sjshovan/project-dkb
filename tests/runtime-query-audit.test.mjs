import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  DKB_QUERY_AUDIT_DB,
  listQueryObserverHealth,
  listQueryAudit,
  queryAuditDatabasePath,
  recordQueryObserverHealth,
  recordQueryAudit,
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
    assert.equal(columns.find((column) => column.name === 'runtime_id')?.notnull, 0);
    assert.equal(columns.find((column) => column.name === 'library_id')?.notnull, 0);
  } finally {
    database.close();
  }

  assert.deepEqual(await listQueryAudit(root), []);
});

test('rejected admission persists explicit unknown identities and preserves the earlier nonnullable v2 database', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-query-audit-v2-rejected-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = queryAuditDatabasePath(root);
  await fs.mkdir(path.dirname(source), { recursive: true });
  const previous = new DatabaseSync(path.toNamespacedPath(source));
  const historical = '{"type":"dkb.query_audit.v2","historical":"do not invent missing admission fields"}';
  try {
    previous.exec(`create table query_audit (id integer primary key autoincrement, event_id text not null unique, recorded_at text not null, channel text not null, runtime_id text not null, library_id text not null, request_id text not null, query text not null, status text not null, event_json text not null)`);
    previous.prepare('insert into query_audit(event_id, recorded_at, channel, runtime_id, library_id, request_id, query, status, event_json) values(?,?,?,?,?,?,?,?,?)').run('old', '2026-09-03', 'cli', 'previous-runtime', 'previous-library', 'old', 'old query', 'success', historical);
  } finally { previous.close(); }
  const options = { root, runtimeId: null, activation: null, channel: 'cli', requestId: 'rejected', query: 'query', intent: 'search', status: 'failed', outcome: 'failed', error: { code: 'runtime_activation_required', message: 'No binding exists' } };
  await recordQueryAudit(options);
  const event = (await listQueryAudit(root))[0];
  assert.equal(event.admission, 'rejected_before_admission');
  assert.deepEqual(event.runtime, { id: null, activationDigest: null });
  assert.equal(event.library, null);
  assert.equal(event.pipeline, null);
  assert.deepEqual(event.packages, []);
  const backup = (await fs.readdir(path.dirname(source))).find((file) => file.startsWith('query-audit.v2-backup-'));
  assert.ok(backup);
  const preserved = new DatabaseSync(path.toNamespacedPath(path.join(path.dirname(source), backup)));
  try { assert.equal(preserved.prepare('select event_json from query_audit').get().event_json, historical); } finally { preserved.close(); }
  await assert.rejects(() => recordQueryAudit({ ...options, outcome: 'success' }), /cannot claim a result or build graph/);
  assert.equal((await listQueryAudit(root)).length, 1);
});

test('query observer health keeps per-activation success and failure state', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-query-observer-health-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const event = {
    runtime: { activationDigest: 'sha256:activation-one' },
    pipeline: { target: 'observer-proof' },
    eventId: 'sha256:event-one',
    recordedAt: '2026-09-02T12:00:00.000Z',
  };
  const results = [
    { id: '@test/healthy', version: '1.0.0', source: 'local', integrityDigest: 'sha256:healthy', ok: true },
    { id: '@test/degraded', version: '1.0.0', source: 'bundled', integrityDigest: 'sha256:degraded', ok: false, detail: 'export failed\nwithout changing the response' },
  ];

  await recordQueryObserverHealth(root, event, results);
  await recordQueryObserverHealth(root, {
    ...event,
    eventId: 'sha256:event-two',
    recordedAt: '2026-09-02T12:01:00.000Z',
  }, results);

  assert.deepEqual(await listQueryObserverHealth(root, 'sha256:not-active'), []);
  const health = await listQueryObserverHealth(root, event.runtime.activationDigest);
  assert.deepEqual(health.map((entry) => ({
    id: entry.id,
    status: entry.status,
    successCount: entry.successCount,
    failureCount: entry.failureCount,
    detail: entry.detail,
    lastEventId: entry.lastEventId,
  })), [
    {
      id: '@test/degraded', status: 'degraded', successCount: 0, failureCount: 2,
      detail: 'export failed without changing the response', lastEventId: 'sha256:event-two',
    },
    {
      id: '@test/healthy', status: 'healthy', successCount: 2, failureCount: 0,
      detail: undefined, lastEventId: 'sha256:event-two',
    },
  ]);
});

test('query audit preserves a pre-cutover database and starts a fresh v2 audit', async (t) => {
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

  assert.deepEqual(await listQueryAudit(root), []);
  const auditDirectory = path.dirname(databasePath);
  const backup = (await fs.readdir(auditDirectory)).find((entry) => /^query-audit\.v1-backup-.+\.sqlite$/u.test(entry));
  assert.ok(backup);
  const preserved = new DatabaseSync(path.toNamespacedPath(path.join(auditDirectory, backup)));
  try {
    assert.equal(
      preserved.prepare('pragma table_info(query_audit)').all().some((column) => column.name === 'event_id'),
      false,
    );
  } finally {
    preserved.close();
  }
  const current = new DatabaseSync(path.toNamespacedPath(databasePath));
  try {
    assert.equal(current.prepare('pragma table_info(query_audit)').all().some((column) => column.name === 'event_json'), true);
  } finally {
    current.close();
  }
});

test('separate CLI processes cannot collapse identical first requests in the same recorded millisecond', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-query-audit-process-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await listQueryAudit(root);
  const script = `
    import { recordQueryAudit } from '@sjshovan/dkb-runtime/runtime/queryAudit.js';
    const NativeDate = Date;
    globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : ['2026-09-03T12:00:00.000Z'])); } };
    await recordQueryAudit({ root: process.argv[1], runtimeId: null, activation: null, channel: 'cli', requestId: 'same-request', query: 'same-query', intent: 'search', status: 'failed', outcome: 'failed' });
  `;
  for (let index = 0; index < 2; index += 1) {
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, root], { cwd: process.cwd(), env: process.env, windowsHide: true });
  }
  const events = await listQueryAudit(root);
  assert.equal(events.length, 2);
  assert.equal(new Set(events.map((event) => event.eventId)).size, 2);
  assert.equal(events[0].recordedAt, events[1].recordedAt);
});
