import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DKB_STATE_DIR } from '@sjshovan/dkb-protocol/paths.js';
import { runtimeActivationDigest, type DkbRuntimeActivation } from '@sjshovan/dkb-protocol/runtimeActivation.js';
import type { DkbQueryObserverResult } from '@sjshovan/dkb-pipeline/types.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

export const DKB_QUERY_AUDIT_DB = 'query-audit.sqlite';
export const DKB_QUERY_AUDIT_FORMAT = 'dkb.query_audit.v2';
const DEFAULT_QUERY_AUDIT_MAX_RECORDS = 100_000;
const DEFAULT_QUERY_AUDIT_QUEUE_MAX = 1_000;
const DEFAULT_QUERY_AUDIT_BATCH_SIZE = 25;
const DEFAULT_QUERY_AUDIT_FLUSH_INTERVAL_MS = 25;

let auditEventSequence = 0;

export type DkbQueryAuditChannel = 'cli' | 'runtime-http' | 'mcp';
export type DkbQueryAuditOutcome = 'success' | 'insufficient' | 'cancelled' | 'failed';

export interface DkbQueryAuditCandidate {
  packageId: string;
  packageVersion: string;
  evidenceDigest: string;
  retrievalBuildDigest: string;
  evidenceId: string;
  score: number | null;
  channels: string[];
}

export interface DkbQueryAuditCitation {
  evidenceId: string;
  packageId: string;
  packageVersion: string;
  locator?: Record<string, unknown>;
  url?: string | null;
}

interface DkbQueryAuditEventBase {
  type: typeof DKB_QUERY_AUDIT_FORMAT;
  id: number;
  eventId: string;
  recordedAt: string;
  channel: DkbQueryAuditChannel;
  client: { id?: string; sessionId?: string; address?: string; userAgent?: string };
  packages: Array<{ id: string; version: string; evidenceDigest: string; retrievalBuildDigest: string }>;
  requestId: string;
  query: string;
  intent: string;
  resultCount: number;
  status: string;
  outcome: DkbQueryAuditOutcome;
  candidates: DkbQueryAuditCandidate[];
  citations: DkbQueryAuditCitation[];
  timing: unknown;
  error?: { code?: string; message: string };
}

export interface DkbAdmittedQueryAuditEvent extends DkbQueryAuditEventBase {
  admission: 'admitted';
  runtime: { id: string; activationDigest: string };
  library: { id: string; generation: number; stateDigest: string };
  pipeline: { target: string; evidenceProfileDigest: string; retrievalProfileDigest: string; compatibilityDigest: string };
}

export interface DkbRejectedQueryAuditEvent extends DkbQueryAuditEventBase {
  admission: 'rejected_before_admission';
  runtime: { id: string | null; activationDigest: null };
  library: null;
  pipeline: null;
}

export type DkbQueryAuditEvent = DkbAdmittedQueryAuditEvent | DkbRejectedQueryAuditEvent;

interface QueryAuditRow { id: number; event_json: string }

interface QueryObserverHealthRow {
  observer_id: string;
  observer_version: string;
  observer_source: DkbQueryObserverResult['source'];
  observer_integrity_digest: string;
  activation_digest: string;
  target: string;
  status: DkbQueryObserverHealth['status'];
  success_count: number;
  failure_count: number;
  last_event_id: string;
  last_observed_at: string;
  detail: string | null;
}

export interface DkbQueryObserverHealth {
  id: string;
  version: string;
  source: DkbQueryObserverResult['source'];
  integrityDigest: string;
  activationDigest: string;
  target: string;
  status: 'healthy' | 'degraded';
  successCount: number;
  failureCount: number;
  lastEventId: string;
  lastObservedAt: string;
  detail?: string;
}

export interface QueryAuditWriteOptions {
  root: string;
  channel: DkbQueryAuditChannel;
  runtimeId: string | null;
  activation: DkbRuntimeActivation | null;
  requestId: string;
  query: string;
  intent: string;
  status: string;
  outcome: DkbQueryAuditOutcome;
  candidates?: DkbQueryAuditCandidate[];
  citations?: DkbQueryAuditCitation[];
  timing?: unknown;
  client?: DkbQueryAuditEvent['client'];
  error?: DkbQueryAuditEvent['error'];
  maxRecords?: number;
}

interface QueryAuditJob {
  root: string;
  event: DkbQueryAuditEvent;
  maxRecords?: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export interface QueryAuditQueueStats {
  queued: number;
  flushed: number;
  dropped: number;
  synchronousFallback: number;
  failed: number;
  batches: number;
  queueDepth: number;
  inFlight: boolean;
  maxQueueSize: number;
}

export type QueryAuditEnqueueResult =
  | { mode: 'queued'; eventId: string; flushed: Promise<void> }
  | { mode: 'synchronous_fallback'; eventId: string; flushed: Promise<void> };

export interface QueryAuditQueueOptions {
  maxQueueSize?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  writerDelayMs?: number;
}

export class QueryAuditQueue {
  private readonly maxQueueSize: number;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly writerDelayMs: number;
  private queue: QueryAuditJob[] = [];
  private timer: NodeJS.Timeout | null = null;
  private activeWrite: Promise<void> | null = null;
  private closed = false;
  private statsData = { queued: 0, flushed: 0, dropped: 0, synchronousFallback: 0, failed: 0, batches: 0 };

  constructor(options: QueryAuditQueueOptions = {}) {
    this.maxQueueSize = boundedPositiveInteger(options.maxQueueSize, queryAuditQueueMaxRecords());
    this.batchSize = boundedPositiveInteger(options.batchSize, DEFAULT_QUERY_AUDIT_BATCH_SIZE);
    this.flushIntervalMs = Math.max(0, boundedPositiveInteger(options.flushIntervalMs, DEFAULT_QUERY_AUDIT_FLUSH_INTERVAL_MS));
    this.writerDelayMs = Math.max(0, options.writerDelayMs ?? 0);
  }

  enqueue(options: QueryAuditWriteOptions): QueryAuditEnqueueResult {
    const event = queryAuditEventFor(options);
    if (this.closed || this.queue.length >= this.maxQueueSize) {
      this.statsData.synchronousFallback += 1;
      return {
        mode: 'synchronous_fallback',
        eventId: event.eventId,
        flushed: this.flush().then(() => writeQueryAuditEvents(options.root, [event], options.maxRecords)).then(() => {
          this.statsData.flushed += 1;
        }).catch((error) => {
          this.statsData.failed += 1;
          throw error;
        }),
      };
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const flushed = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    flushed.catch(() => undefined);
    this.queue.push({ root: options.root, event, maxRecords: options.maxRecords, resolve, reject });
    this.statsData.queued += 1;
    this.schedule();
    return { mode: 'queued', eventId: event.eventId, flushed };
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.queue.length > 0 || this.activeWrite) {
      if (this.activeWrite) await this.activeWrite;
      else await this.drainNextBatch();
    }
  }

  async close(): Promise<void> { this.closed = true; await this.flush(); }

  stats(): QueryAuditQueueStats {
    return { ...this.statsData, queueDepth: this.queue.length, inFlight: Boolean(this.activeWrite), maxQueueSize: this.maxQueueSize };
  }

  private schedule(): void {
    if (this.timer || this.activeWrite) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drainLoop().catch((error) => {
        this.statsData.failed += 1;
        console.error(JSON.stringify({ event: 'dkb.query_audit.flush_failed', message: error instanceof Error ? error.message : String(error) }));
      });
    }, this.flushIntervalMs);
  }

  private async drainLoop(): Promise<void> { while (this.queue.length > 0) await this.drainNextBatch(); }

  private async drainNextBatch(): Promise<void> {
    const batch = this.queue.splice(0, this.batchSize);
    if (batch.length === 0) return;
    const write = this.writeBatch(batch);
    this.activeWrite = write;
    try { await write; } finally { this.activeWrite = null; }
  }

  private async writeBatch(batch: QueryAuditJob[]): Promise<void> {
    try {
      if (this.writerDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.writerDelayMs));
      const groups = new Map<string, QueryAuditJob[]>();
      for (const job of batch) {
        const root = path.resolve(job.root);
        const group = groups.get(root) ?? [];
        group.push(job);
        groups.set(root, group);
      }
      for (const [root, jobs] of groups) await writeQueryAuditEvents(root, jobs.map((job) => job.event), jobs.at(-1)?.maxRecords);
      this.statsData.batches += 1;
      this.statsData.flushed += batch.length;
      batch.forEach((job) => job.resolve());
    } catch (error) {
      this.statsData.failed += batch.length;
      batch.forEach((job) => job.reject(error));
      throw error;
    }
  }
}

export function createQueryAuditQueue(options?: QueryAuditQueueOptions): QueryAuditQueue { return new QueryAuditQueue(options); }
const defaultQueryAuditQueue = createQueryAuditQueue();

export async function recordQueryAudit(options: QueryAuditWriteOptions): Promise<DkbQueryAuditEvent> {
  const event = queryAuditEventFor(options);
  return writeQueryAuditEvents(options.root, [event], options.maxRecords);
}

/** Open the mandatory sink first; finalize once, then commit without another asynchronous gap. */
export async function finalizeQueryAudit(root: string, finalize: () => Promise<QueryAuditWriteOptions>): Promise<DkbQueryAuditEvent> {
  let database: DatabaseSync | undefined;
  try {
    database = await openQueryAuditDatabase(root);
    const options = await finalize();
    if (path.resolve(options.root) !== path.resolve(root)) throw new Error('Query finalization changed its audit root');
    return commitQueryAuditEvents(database, [queryAuditEventFor(options)], options.maxRecords);
  } catch (error) {
    throw new DkbError(
      `Runtime could not persist its mandatory query audit; no response was released. Inspect ${queryAuditDatabasePath(root)} and restore writable storage before retrying. ${error instanceof Error ? error.message : String(error)}`,
      'runtime_audit_failed',
    );
  } finally { database?.close(); }
}

export function enqueueQueryAudit(options: QueryAuditWriteOptions): QueryAuditEnqueueResult { return defaultQueryAuditQueue.enqueue(options); }
export function queryAuditQueueStats(): QueryAuditQueueStats { return defaultQueryAuditQueue.stats(); }
export async function flushQueryAuditQueue(): Promise<void> { await defaultQueryAuditQueue.flush(); }
export async function closeQueryAuditQueue(): Promise<void> { await defaultQueryAuditQueue.close(); }

export async function listQueryAudit(root: string, limit = 20): Promise<DkbQueryAuditEvent[]> {
  const database = await openQueryAuditDatabase(root);
  const boundedLimit = Math.max(1, Math.min(limit, 100));
  try {
    const rows = database.prepare('select id, event_json from query_audit order by id desc limit ?').all(boundedLimit) as unknown as QueryAuditRow[];
    return rows.map((row) => ({ ...JSON.parse(row.event_json) as DkbQueryAuditEvent, id: row.id }));
  } finally { database.close(); }
}

export async function recordQueryObserverHealth(
  root: string,
  event: DkbQueryAuditEvent,
  results: readonly DkbQueryObserverResult[],
): Promise<void> {
  if (results.length === 0) return;
  if (event.admission === 'rejected_before_admission') throw new DkbError('A rejected admission has no trusted query observers');
  const database = await openQueryAuditDatabase(root);
  try {
    database.exec('begin immediate');
    try {
      const upsert = database.prepare(`
        insert into query_observer_health (
          activation_digest, observer_id, observer_version, observer_source,
          observer_integrity_digest, target, status, success_count, failure_count,
          last_event_id, last_observed_at, detail
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(activation_digest, observer_id) do update set
          observer_version = excluded.observer_version,
          observer_source = excluded.observer_source,
          observer_integrity_digest = excluded.observer_integrity_digest,
          target = excluded.target,
          status = excluded.status,
          success_count = query_observer_health.success_count + excluded.success_count,
          failure_count = query_observer_health.failure_count + excluded.failure_count,
          last_event_id = excluded.last_event_id,
          last_observed_at = excluded.last_observed_at,
          detail = excluded.detail
      `);
      for (const result of results) {
        upsert.run(
          event.runtime.activationDigest,
          result.id,
          result.version,
          result.source,
          result.integrityDigest,
          event.pipeline.target,
          result.ok ? 'healthy' : 'degraded',
          result.ok ? 1 : 0,
          result.ok ? 0 : 1,
          event.eventId,
          event.recordedAt,
          result.detail ? boundedObserverDetail(result.detail) : null,
        );
      }
      database.exec('commit');
    } catch (error) {
      database.exec('rollback');
      throw error;
    }
  } finally {
    database.close();
  }
}

export async function listQueryObserverHealth(
  root: string,
  activationDigest?: string,
): Promise<DkbQueryObserverHealth[]> {
  if (!await fs.access(queryAuditDatabasePath(root)).then(() => true, () => false)) return [];
  const database = await openQueryAuditDatabase(root);
  try {
    const rows = (activationDigest
      ? database.prepare(`
          select * from query_observer_health
          where activation_digest = ?
          order by observer_id
        `).all(activationDigest)
      : database.prepare('select * from query_observer_health order by target, observer_id').all()) as unknown as QueryObserverHealthRow[];
    return rows.map(queryObserverHealthFromRow);
  } finally {
    database.close();
  }
}

export function queryAuditDatabasePath(root: string): string {
  return path.join(path.resolve(root), DKB_STATE_DIR, DKB_QUERY_AUDIT_DB);
}

async function writeQueryAuditEvents(root: string, events: DkbQueryAuditEvent[], maxRecords?: number): Promise<DkbQueryAuditEvent> {
  if (events.length === 0) throw new Error('Cannot write an empty query audit batch.');
  const database = await openQueryAuditDatabase(root);
  try { return commitQueryAuditEvents(database, events, maxRecords); } finally { database.close(); }
}

function commitQueryAuditEvents(database: DatabaseSync, events: DkbQueryAuditEvent[], maxRecords?: number): DkbQueryAuditEvent {
  database.exec('begin immediate');
  try {
      const insert = database.prepare(`
        insert into query_audit (event_id, recorded_at, channel, runtime_id, library_id, request_id, query, status, event_json)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict(event_id) do nothing
      `);
      const select = database.prepare('select id from query_audit where event_id = ?');
      for (const event of events) {
        const result = insert.run(event.eventId, event.recordedAt, event.channel, event.runtime.id, event.library?.id ?? null, event.requestId, event.query, event.status, JSON.stringify(event));
        const existing = select.get(event.eventId) as { id?: number } | undefined;
        event.id = result.changes > 0 ? Number(result.lastInsertRowid) : Number(existing?.id ?? 0);
      }
      pruneQueryAuditRows(database, queryAuditMaxRecords(maxRecords));
      database.exec('commit');
  } catch (error) {
    database.exec('rollback');
    throw error;
  }
  return events[events.length - 1]!;
}

async function openQueryAuditDatabase(root: string): Promise<DatabaseSync> {
  const databasePath = queryAuditDatabasePath(root);
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  let database = new DatabaseSync(path.toNamespacedPath(databasePath));
  try {
    const existing = database.prepare("select name from sqlite_master where type = 'table' and name = 'query_audit'").get();
    if (existing && !hasCurrentQueryAuditSchema(database)) {
      database.close();
      await preserveObsoleteQueryAudit(databasePath);
      database = new DatabaseSync(path.toNamespacedPath(databasePath));
    }
    database.exec(`
      create table if not exists query_audit (
        id integer primary key autoincrement,
        event_id text not null unique,
        recorded_at text not null,
        channel text not null check (channel in ('cli', 'runtime-http', 'mcp')),
        runtime_id text,
        library_id text,
        request_id text not null,
        query text not null,
        status text not null,
        event_json text not null
      );
      create unique index if not exists query_audit_event_id_idx on query_audit(event_id);
      create index if not exists query_audit_recorded_at_idx on query_audit(recorded_at);
      create index if not exists query_audit_channel_idx on query_audit(channel, id desc);
      create index if not exists query_audit_runtime_idx on query_audit(runtime_id, id desc);
      create index if not exists query_audit_library_idx on query_audit(library_id, id desc);
      create table if not exists query_observer_health (
        activation_digest text not null,
        observer_id text not null,
        observer_version text not null,
        observer_source text not null check (observer_source in ('local', 'global', 'bundled')),
        observer_integrity_digest text not null,
        target text not null,
        status text not null check (status in ('healthy', 'degraded')),
        success_count integer not null check (success_count >= 0),
        failure_count integer not null check (failure_count >= 0),
        last_event_id text not null,
        last_observed_at text not null,
        detail text,
        primary key (activation_digest, observer_id)
      );
      create index if not exists query_observer_health_target_idx
        on query_observer_health(target, observer_id);
    `);
    if (!hasCurrentQueryAuditSchema(database)) throw new Error(`Unable to initialize ${DKB_QUERY_AUDIT_FORMAT} at ${databasePath}`);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function hasCurrentQueryAuditSchema(database: DatabaseSync): boolean {
  const columns = database.prepare('pragma table_info(query_audit)').all() as Array<{ name: string; notnull: number; pk: number; type: string }>;
  const expected = [
    ['id', 'INTEGER', 0, 1], ['event_id', 'TEXT', 1, 0], ['recorded_at', 'TEXT', 1, 0],
    ['channel', 'TEXT', 1, 0], ['runtime_id', 'TEXT', 0, 0], ['library_id', 'TEXT', 0, 0],
    ['request_id', 'TEXT', 1, 0], ['query', 'TEXT', 1, 0], ['status', 'TEXT', 1, 0], ['event_json', 'TEXT', 1, 0],
  ] as const;
  return JSON.stringify(columns.map((column) => [column.name, column.type.toUpperCase(), column.notnull, column.pk])) === JSON.stringify(expected);
}

async function preserveObsoleteQueryAudit(databasePath: string): Promise<void> {
  const previous = new DatabaseSync(path.toNamespacedPath(databasePath), { readOnly: true });
  let version: 'v1' | 'v2';
  try {
    version = (previous.prepare('pragma table_info(query_audit)').all() as Array<{ name: string }>).some((column) => column.name === 'event_json') ? 'v2' : 'v1';
  } finally { previous.close(); }
  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
  let backupPath = path.join(path.dirname(databasePath), `query-audit.${version}-backup-${timestamp}.sqlite`);
  let suffix = 1;
  while (await fs.access(backupPath).then(() => true, () => false)) {
    backupPath = path.join(path.dirname(databasePath), `query-audit.${version}-backup-${timestamp}-${suffix}.sqlite`);
    suffix += 1;
  }
  await fs.rename(databasePath, backupPath);
}

function queryAuditEventFor(options: QueryAuditWriteOptions): DkbQueryAuditEvent {
  const recordedAt = new Date().toISOString();
  const sequence = auditEventSequence += 1;
  if (!options.activation && (options.outcome === 'success' || options.outcome === 'insufficient' || options.candidates?.length || options.citations?.length)) {
    throw new DkbError('Rejected query admission cannot claim a result or build graph');
  }
  if (options.activation && (!options.runtimeId || options.runtimeId !== options.activation.runtimeId)) throw new DkbError('Query audit Runtime does not match its admitted activation');
  const packages = Object.entries(options.activation?.packages ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([id, entry]) => ({
    id,
    version: entry.version,
    evidenceDigest: entry.evidenceDigest,
    retrievalBuildDigest: entry.retrievalBuildDigest,
  }));
  const eventId = stableHash({ type: DKB_QUERY_AUDIT_FORMAT, nonce: randomUUID(), recordedAt, sequence, channel: options.channel, requestId: options.requestId });
  return {
    type: DKB_QUERY_AUDIT_FORMAT,
    id: 0,
    eventId,
    recordedAt,
    channel: options.channel,
    client: auditClient(options.client),
    ...(options.activation ? {
      admission: 'admitted' as const,
      runtime: { id: options.runtimeId!, activationDigest: runtimeActivationDigest(options.activation) },
      library: { ...options.activation.library },
      pipeline: {
        target: options.activation.target,
        evidenceProfileDigest: options.activation.evidenceProfileDigest,
        retrievalProfileDigest: options.activation.retrievalProfileDigest,
        compatibilityDigest: options.activation.compatibilityDigest,
      },
    } : {
      admission: 'rejected_before_admission' as const,
      runtime: { id: options.runtimeId, activationDigest: null }, library: null, pipeline: null,
    }),
    packages,
    requestId: options.requestId,
    query: options.query,
    intent: options.intent,
    resultCount: options.citations?.length || options.candidates?.length || 0,
    status: options.status,
    outcome: options.outcome,
    candidates: options.candidates ?? [],
    citations: options.citations ?? [],
    timing: options.timing ?? null,
    ...(options.error ? { error: options.error } : {}),
  };
}

function pruneQueryAuditRows(database: DatabaseSync, maxRecords: number): void {
  database.prepare('delete from query_audit where id <= (select coalesce(max(id), 0) - ? from query_audit)').run(maxRecords);
}

function queryAuditMaxRecords(value: number | undefined): number {
  if (value && Number.isInteger(value) && value > 0) return value;
  const envValue = Number.parseInt(process.env.DKB_QUERY_AUDIT_MAX_RECORDS ?? '', 10);
  return Number.isInteger(envValue) && envValue > 0 ? envValue : DEFAULT_QUERY_AUDIT_MAX_RECORDS;
}

function queryAuditQueueMaxRecords(): number {
  const envValue = Number.parseInt(process.env.DKB_QUERY_AUDIT_QUEUE_MAX ?? '', 10);
  return Number.isInteger(envValue) && envValue > 0 ? envValue : DEFAULT_QUERY_AUDIT_QUEUE_MAX;
}

function boundedPositiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function queryObserverHealthFromRow(row: QueryObserverHealthRow): DkbQueryObserverHealth {
  return {
    id: row.observer_id,
    version: row.observer_version,
    source: row.observer_source,
    integrityDigest: row.observer_integrity_digest,
    activationDigest: row.activation_digest,
    target: row.target,
    status: row.status,
    successCount: row.success_count,
    failureCount: row.failure_count,
    lastEventId: row.last_event_id,
    lastObservedAt: row.last_observed_at,
    ...(row.detail ? { detail: row.detail } : {}),
  };
}

function boundedObserverDetail(value: string): string {
  return value.replace(/[\r\n]+/gu, ' ').trim().slice(0, 500) || 'Observer execution failed';
}

function auditClient(client: DkbQueryAuditEvent['client'] | undefined): DkbQueryAuditEvent['client'] {
  const result: DkbQueryAuditEvent['client'] = {};
  for (const field of ['id', 'sessionId', 'address', 'userAgent'] as const) {
    if (typeof client?.[field] === 'string') result[field] = client[field].slice(0, field === 'userAgent' ? 256 : 128);
  }
  return result;
}
