import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DKB_STATE_DIR } from '@sjshovan/dkb-protocol/paths.js';
import type { DkbRetrieveKnowledgeRequest, DkbRetrieveKnowledgeResponse } from '../read/runtime.js';

export const DKB_QUERY_AUDIT_DB = 'query-audit.sqlite';
const DEFAULT_QUERY_AUDIT_MAX_RECORDS = 100_000;
const DEFAULT_QUERY_AUDIT_QUEUE_MAX = 1_000;
const DEFAULT_QUERY_AUDIT_BATCH_SIZE = 25;
const DEFAULT_QUERY_AUDIT_FLUSH_INTERVAL_MS = 25;

let auditEventSequence = 0;

export type DkbQueryAuditChannel = 'runtime-http' | 'mcp';

export interface DkbQueryAuditEvent {
  id: number;
  eventId: string;
  recordedAt: string;
  channel: DkbQueryAuditChannel;
  requestId: string;
  query: string;
  intent: string;
  resultCount: number;
  status: string;
  packages: string[];
  citations: Array<Record<string, unknown>>;
  timing: unknown;
}

interface QueryAuditRow {
  id: number;
  event_id: string | null;
  recorded_at: string;
  channel: DkbQueryAuditChannel;
  request_id: string;
  query: string;
  intent: string;
  result_count: number;
  status: string;
  packages_json: string;
  citations_json: string;
  timing_json: string;
}

interface QueryAuditWriteOptions {
  root: string;
  channel: DkbQueryAuditChannel;
  request: DkbRetrieveKnowledgeRequest;
  response: DkbRetrieveKnowledgeResponse;
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
  private statsData = {
    queued: 0,
    flushed: 0,
    dropped: 0,
    synchronousFallback: 0,
    failed: 0,
    batches: 0,
  };

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
        flushed: this.flush()
          .then(() => writeQueryAuditEvents(options.root, [event], options.maxRecords))
          .then(() => {
            this.statsData.flushed += 1;
          })
          .catch((error) => {
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

    this.queue.push({
      root: options.root,
      event,
      maxRecords: options.maxRecords,
      resolve,
      reject,
    });
    this.statsData.queued += 1;
    this.schedule();

    return {
      mode: 'queued',
      eventId: event.eventId,
      flushed,
    };
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    while (this.queue.length > 0 || this.activeWrite) {
      if (this.activeWrite) {
        await this.activeWrite;
      } else {
        await this.drainNextBatch();
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  stats(): QueryAuditQueueStats {
    return {
      ...this.statsData,
      queueDepth: this.queue.length,
      inFlight: Boolean(this.activeWrite),
      maxQueueSize: this.maxQueueSize,
    };
  }

  private schedule(): void {
    if (this.timer || this.activeWrite) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drainLoop().catch((error) => {
        this.statsData.failed += 1;
        console.error(JSON.stringify({
          event: 'dkb.query_audit.flush_failed',
          message: error instanceof Error ? error.message : String(error),
        }));
      });
    }, this.flushIntervalMs);
  }

  private async drainLoop(): Promise<void> {
    while (this.queue.length > 0) {
      await this.drainNextBatch();
    }
  }

  private async drainNextBatch(): Promise<void> {
    const batch = this.queue.splice(0, this.batchSize);

    if (batch.length === 0) {
      return;
    }

    const write = this.writeBatch(batch);
    this.activeWrite = write;

    try {
      await write;
    } finally {
      this.activeWrite = null;
    }
  }

  private async writeBatch(batch: QueryAuditJob[]): Promise<void> {
    try {
      if (this.writerDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.writerDelayMs));
      }

      const groups = new Map<string, QueryAuditJob[]>();

      for (const job of batch) {
        const root = path.resolve(job.root);
        const group = groups.get(root) ?? [];

        group.push(job);
        groups.set(root, group);
      }

      for (const [root, jobs] of groups) {
        await writeQueryAuditEvents(root, jobs.map((job) => job.event), jobs.at(-1)?.maxRecords);
      }

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

export function createQueryAuditQueue(options?: QueryAuditQueueOptions): QueryAuditQueue {
  return new QueryAuditQueue(options);
}

const defaultQueryAuditQueue = createQueryAuditQueue();

export async function recordQueryAudit(options: QueryAuditWriteOptions): Promise<DkbQueryAuditEvent> {
  const event = queryAuditEventFor(options);

  return writeQueryAuditEvents(options.root, [event], options.maxRecords);
}

export function enqueueQueryAudit(options: QueryAuditWriteOptions): QueryAuditEnqueueResult {
  return defaultQueryAuditQueue.enqueue(options);
}

export function queryAuditQueueStats(): QueryAuditQueueStats {
  return defaultQueryAuditQueue.stats();
}

export async function flushQueryAuditQueue(): Promise<void> {
  await defaultQueryAuditQueue.flush();
}

export async function closeQueryAuditQueue(): Promise<void> {
  await defaultQueryAuditQueue.close();
}

export async function listQueryAudit(root: string, limit = 20): Promise<DkbQueryAuditEvent[]> {
  const database = await openQueryAuditDatabase(root);
  const boundedLimit = Math.max(1, Math.min(limit, 100));

  try {
    const rows = database.prepare(`
      select * from query_audit
      order by id desc
      limit ?
    `).all(boundedLimit) as unknown as QueryAuditRow[];

    return rows.map(queryAuditEventFromRow);
  } finally {
    database.close();
  }
}

export function queryAuditDatabasePath(root: string): string {
  return path.join(path.resolve(root), DKB_STATE_DIR, DKB_QUERY_AUDIT_DB);
}

async function writeQueryAuditEvents(
  root: string,
  events: DkbQueryAuditEvent[],
  maxRecords?: number,
): Promise<DkbQueryAuditEvent> {
  if (events.length === 0) {
    throw new Error('Cannot write an empty query audit batch.');
  }

  const database = await openQueryAuditDatabase(root);

  try {
    database.exec('begin immediate');
    try {
      const insert = database.prepare(`
        insert into query_audit (
          event_id, recorded_at, channel, request_id, query, intent, result_count,
          status, packages_json, citations_json, timing_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(event_id) do nothing
      `);
      const select = database.prepare('select id from query_audit where event_id = ?');

      for (const event of events) {
        const result = insert.run(
          event.eventId,
          event.recordedAt,
          event.channel,
          event.requestId,
          event.query,
          event.intent,
          event.resultCount,
          event.status,
          JSON.stringify(event.packages),
          JSON.stringify(event.citations),
          JSON.stringify(event.timing),
        );
        const existing = select.get(event.eventId) as { id?: number } | undefined;

        event.id = result.changes > 0
          ? Number(result.lastInsertRowid)
          : Number(existing?.id ?? 0);
      }

      pruneQueryAuditRows(database, queryAuditMaxRecords(maxRecords));
      database.exec('commit');
    } catch (error) {
      database.exec('rollback');
      throw error;
    }
  } finally {
    database.close();
  }

  return events[events.length - 1]!;
}

async function openQueryAuditDatabase(root: string): Promise<DatabaseSync> {
  const databasePath = queryAuditDatabasePath(root);
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);

  database.exec(`
    create table if not exists query_audit (
      id integer primary key autoincrement,
      event_id text unique,
      recorded_at text not null,
      channel text not null check (channel in ('runtime-http', 'mcp')),
      request_id text not null,
      query text not null,
      intent text not null,
      result_count integer not null,
      status text not null,
      packages_json text not null,
      citations_json text not null,
      timing_json text not null
    );
    create index if not exists query_audit_recorded_at_idx on query_audit(recorded_at);
    create index if not exists query_audit_channel_idx on query_audit(channel, id desc);
  `);
  ensureQueryAuditEventIdColumn(database);

  return database;
}

function ensureQueryAuditEventIdColumn(database: DatabaseSync): void {
  const columns = database.prepare('pragma table_info(query_audit)').all() as Array<{ name: string }>;

  if (!columns.some((column) => column.name === 'event_id')) {
    database.exec('alter table query_audit add column event_id text');
    database.exec("update query_audit set event_id = 'legacy:' || id where event_id is null");
  }

  database.exec('create unique index if not exists query_audit_event_id_idx on query_audit(event_id)');
}

function queryAuditEventFor(options: {
  channel: DkbQueryAuditChannel;
  request: DkbRetrieveKnowledgeRequest;
  response: DkbRetrieveKnowledgeResponse;
}): DkbQueryAuditEvent {
  const { response } = options;
  const packages = [...new Set(response.metadata.sourceUnitMatches.map((match) => match.dkbId))];
  const recordedAt = new Date().toISOString();
  const sequence = auditEventSequence += 1;
  const eventId = stableHash({
    type: 'dkb.query_audit.v1',
    recordedAt,
    sequence,
    channel: options.channel,
    requestId: response.metadata.requestId,
  });

  return {
    id: 0,
    eventId,
    recordedAt,
    channel: options.channel,
    requestId: response.metadata.requestId,
    query: response.metadata.query,
    intent: response.metadata.intent,
    resultCount: response.evidence.length,
    status: response.status,
    packages,
    citations: response.evidence.map((evidence) => ({
      label: evidence.label,
      source: evidence.source,
    })),
    timing: response.metadata.retrievalProfile ?? null,
  };
}

function queryAuditEventFromRow(row: QueryAuditRow): DkbQueryAuditEvent {
  return {
    id: row.id,
    eventId: row.event_id ?? `legacy:${row.id}`,
    recordedAt: row.recorded_at,
    channel: row.channel,
    requestId: row.request_id,
    query: row.query,
    intent: row.intent,
    resultCount: row.result_count,
    status: row.status,
    packages: JSON.parse(row.packages_json) as string[],
    citations: JSON.parse(row.citations_json) as Array<Record<string, unknown>>,
    timing: JSON.parse(row.timing_json) as unknown,
  };
}

function pruneQueryAuditRows(database: DatabaseSync, maxRecords: number): void {
  database.prepare(`
    delete from query_audit
    where id <= (
      select coalesce(max(id), 0) - ?
      from query_audit
    )
  `).run(maxRecords);
}

function queryAuditMaxRecords(value: number | undefined): number {
  if (value && Number.isInteger(value) && value > 0) {
    return value;
  }

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
