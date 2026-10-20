import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DKB_STATE_DIR } from '@sjshovan/dkb-protocol/paths.js';
import type { DkbEvidence } from '@sjshovan/dkb-protocol/types.js';
import type { DkbRetrieveKnowledgeRequest, DkbRetrieveKnowledgeResponse } from '../read/runtime.js';

export const DKB_TRACE_DB = 'trace.sqlite';
const DEFAULT_TRACE_MAX_ROWS = 100_000;

export function retrievalTraceEnabled(): boolean {
  return process.env.DKB_TRACE_ENABLED === 'true';
}

export interface DkbTraceRun {
  id: string;
  root: string;
  query: string;
  status: DkbRetrieveKnowledgeResponse['status'];
  startedAt: string;
  completedAt: string;
  evidenceCount: number;
  evidenceTokens: number;
  modelTextTokens: number;
  response: DkbRetrieveKnowledgeResponse;
  modelText: string;
  events: DkbTraceEvent[];
  evidence: DkbTraceEvidence[];
}

export interface DkbTraceEvent {
  ordinal: number;
  stage: string;
  at: string;
  payload: Record<string, unknown>;
}

export interface DkbTraceEvidence {
  ordinal: number;
  label: string;
  text: string;
  tokenEstimate: number;
  source: DkbEvidence['source'];
}

export interface DkbTraceSummary {
  id: string;
  query: string;
  status: DkbRetrieveKnowledgeResponse['status'];
  startedAt: string;
  completedAt: string;
  evidenceCount: number;
  evidenceTokens: number;
  modelTextTokens: number;
}

interface TraceRunRow {
  id: string;
  root: string;
  query: string;
  status: DkbRetrieveKnowledgeResponse['status'];
  started_at: string;
  completed_at: string;
  evidence_count: number;
  evidence_tokens: number;
  model_text_tokens: number;
  response_json: string;
  model_text: string;
}

interface TraceEventRow {
  ordinal: number;
  stage: string;
  at: string;
  payload_json: string;
}

interface TraceEvidenceRow {
  ordinal: number;
  label: string;
  text: string;
  token_estimate: number;
  source_json: string;
}

export async function recordRetrievalTrace(options: {
  root: string;
  request?: DkbRetrieveKnowledgeRequest;
  response: DkbRetrieveKnowledgeResponse;
  modelText: string;
  maxRows?: number;
}): Promise<DkbTraceRun> {
  const root = path.resolve(options.root);
  const now = new Date().toISOString();
  const trace: DkbTraceRun = {
    id: traceIdFor(options.response, now),
    root,
    query: options.response.metadata.query,
    status: options.response.status,
    startedAt: now,
    completedAt: now,
    evidenceCount: options.response.evidence.length,
    evidenceTokens: evidenceTokens(options.response.evidence),
    modelTextTokens: estimateTokens(options.modelText),
    response: options.response,
    modelText: options.modelText,
    events: traceEventsFor(options.request, options.response, now),
    evidence: options.response.evidence.map((evidence, index) => ({
      ordinal: index + 1,
      label: evidence.label,
      text: evidenceText(evidence),
      tokenEstimate: estimateTokens(evidenceText(evidence)),
      source: evidence.source,
    })),
  };
  const database = await openTraceDatabase(root);

  try {
    const insertRun = database.prepare(`
      insert into trace_runs (
        id, root, query, status, started_at, completed_at,
        evidence_count, evidence_tokens, model_text_tokens,
        response_json, model_text
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEvent = database.prepare(`
      insert into trace_events (trace_id, ordinal, stage, at, payload_json)
      values (?, ?, ?, ?, ?)
    `);
    const insertEvidence = database.prepare(`
      insert into trace_evidence (trace_id, ordinal, label, text, token_estimate, source_json)
      values (?, ?, ?, ?, ?, ?)
    `);

    database.exec('begin immediate');

    try {
      insertRun.run(
        trace.id,
        trace.root,
        trace.query,
        trace.status,
        trace.startedAt,
        trace.completedAt,
        trace.evidenceCount,
        trace.evidenceTokens,
        trace.modelTextTokens,
        JSON.stringify(trace.response),
        trace.modelText,
      );

      for (const event of trace.events) {
        insertEvent.run(trace.id, event.ordinal, event.stage, event.at, JSON.stringify(event.payload));
      }

      for (const evidence of trace.evidence) {
        insertEvidence.run(
          trace.id,
          evidence.ordinal,
          evidence.label,
          evidence.text,
          evidence.tokenEstimate,
          JSON.stringify(evidence.source),
        );
      }

      pruneTraceRows(database, traceMaxRows(options.maxRows));
      database.exec('commit');
    } catch (error) {
      database.exec('rollback');
      throw error;
    }
  } finally {
    database.close();
  }

  return trace;
}

export async function latestTrace(root: string): Promise<DkbTraceRun | null> {
  const database = await openTraceDatabase(root);

  try {
    const row = database.prepare(`
      select *
      from trace_runs
      order by completed_at desc, rowid desc
      limit 1
    `).get() as TraceRunRow | undefined;

    return row ? hydrateTrace(database, row) : null;
  } finally {
    database.close();
  }
}

export async function listTraces(root: string, limit = 20): Promise<{ traces: DkbTraceSummary[] }> {
  const database = await openTraceDatabase(root);
  const boundedLimit = Math.max(1, Math.min(limit, 100));

  try {
    const rows = database.prepare(`
      select id, query, status, started_at, completed_at, evidence_count, evidence_tokens, model_text_tokens
      from trace_runs
      order by completed_at desc, rowid desc
      limit ?
    `).all(boundedLimit) as unknown as TraceRunRow[];

    return {
      traces: rows.map(traceSummaryFromRow),
    };
  } finally {
    database.close();
  }
}

export async function getTrace(root: string, traceId: string): Promise<DkbTraceRun | null> {
  const database = await openTraceDatabase(root);

  try {
    const row = database.prepare('select * from trace_runs where id = ?').get(traceId) as TraceRunRow | undefined;

    return row ? hydrateTrace(database, row) : null;
  } finally {
    database.close();
  }
}

export function traceDatabasePath(root: string): string {
  return path.join(path.resolve(root), DKB_STATE_DIR, DKB_TRACE_DB);
}

async function openTraceDatabase(root: string): Promise<DatabaseSync> {
  const databasePath = traceDatabasePath(root);

  await fs.mkdir(path.dirname(databasePath), { recursive: true });

  const database = new DatabaseSync(path.toNamespacedPath(databasePath));

  initializeTraceDatabase(database);

  return database;
}

function initializeTraceDatabase(database: DatabaseSync): void {
  database.exec(`
    create table if not exists trace_runs (
      id text primary key,
      root text not null,
      query text not null,
      status text not null,
      started_at text not null,
      completed_at text not null,
      evidence_count integer not null,
      evidence_tokens integer not null,
      model_text_tokens integer not null,
      response_json text not null,
      model_text text not null
    );

    create table if not exists trace_events (
      id integer primary key autoincrement,
      trace_id text not null references trace_runs(id) on delete cascade,
      ordinal integer not null,
      stage text not null,
      at text not null,
      payload_json text not null
    );

    create table if not exists trace_evidence (
      id integer primary key autoincrement,
      trace_id text not null references trace_runs(id) on delete cascade,
      ordinal integer not null,
      label text not null,
      text text not null,
      token_estimate integer not null,
      source_json text not null
    );

    create index if not exists trace_runs_completed_at_idx on trace_runs(completed_at);
    create index if not exists trace_events_trace_id_idx on trace_events(trace_id, ordinal);
    create index if not exists trace_evidence_trace_id_idx on trace_evidence(trace_id, ordinal);
  `);
}

function hydrateTrace(database: DatabaseSync, row: TraceRunRow): DkbTraceRun {
  const eventRows = database.prepare(`
    select ordinal, stage, at, payload_json
    from trace_events
    where trace_id = ?
    order by ordinal asc
  `).all(row.id) as unknown as TraceEventRow[];
  const evidenceRows = database.prepare(`
    select ordinal, label, text, token_estimate, source_json
    from trace_evidence
    where trace_id = ?
    order by ordinal asc
  `).all(row.id) as unknown as TraceEvidenceRow[];

  return {
    id: row.id,
    root: row.root,
    query: row.query,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    evidenceCount: row.evidence_count,
    evidenceTokens: row.evidence_tokens,
    modelTextTokens: row.model_text_tokens,
    response: JSON.parse(row.response_json) as DkbRetrieveKnowledgeResponse,
    modelText: row.model_text,
    events: eventRows.map((event) => ({
      ordinal: event.ordinal,
      stage: event.stage,
      at: event.at,
      payload: JSON.parse(event.payload_json) as Record<string, unknown>,
    })),
    evidence: evidenceRows.map((evidence) => ({
      ordinal: evidence.ordinal,
      label: evidence.label,
      text: evidence.text,
      tokenEstimate: evidence.token_estimate,
      source: JSON.parse(evidence.source_json) as DkbEvidence['source'],
    })),
  };
}

function traceSummaryFromRow(row: TraceRunRow): DkbTraceSummary {
  return {
    id: row.id,
    query: row.query,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    evidenceCount: row.evidence_count,
    evidenceTokens: row.evidence_tokens,
    modelTextTokens: row.model_text_tokens,
  };
}

function traceEventsFor(
  request: DkbRetrieveKnowledgeRequest | undefined,
  response: DkbRetrieveKnowledgeResponse,
  at: string,
): DkbTraceEvent[] {
  return [
    {
      ordinal: 1,
      stage: 'request',
      at,
      payload: {
        need: request?.need ?? response.metadata.query,
        intent: response.metadata.intent,
        limit: request?.limit ?? null,
        phrases: request?.phrases ?? [],
      },
    },
    {
      ordinal: 2,
      stage: 'retrieval',
      at,
      payload: {
        chunksMatched: response.metadata.chunksMatched ?? 0,
        chunksRead: response.metadata.chunksRead ?? 0,
        sourceUnitsMatched: response.metadata.sourceUnitsMatched,
        sourceUnitsRead: response.metadata.sourceUnitsRead,
        adapterGroups: response.metadata.adapterGroups,
      },
    },
    {
      ordinal: 3,
      stage: 'selection',
      at,
      payload: {
        sourceUnitMatches: response.metadata.sourceUnitMatches,
        retrievalProfile: response.metadata.retrievalProfile ?? null,
      },
    },
    {
      ordinal: 4,
      stage: 'sufficiency',
      at,
      payload: { ...response.sufficiency },
    },
  ];
}

function pruneTraceRows(database: DatabaseSync, maxRows: number): void {
  while (traceRowCount(database) > maxRows) {
    const oldest = database.prepare(`
      select id
      from trace_runs
      order by completed_at asc, rowid asc
      limit 1
    `).get() as { id: string } | undefined;

    if (!oldest) {
      return;
    }

    database.prepare('delete from trace_runs where id = ?').run(oldest.id);
  }
}

function traceRowCount(database: DatabaseSync): number {
  const runs = database.prepare('select count(*) as count from trace_runs').get() as { count: number };
  const events = database.prepare('select count(*) as count from trace_events').get() as { count: number };
  const evidence = database.prepare('select count(*) as count from trace_evidence').get() as { count: number };

  return runs.count + events.count + evidence.count;
}

function traceMaxRows(value: number | undefined): number {
  if (value && Number.isInteger(value) && value > 0) {
    return value;
  }

  const envValue = Number.parseInt(process.env.DKB_TRACE_MAX_ROWS ?? '', 10);

  return Number.isInteger(envValue) && envValue > 0 ? envValue : DEFAULT_TRACE_MAX_ROWS;
}

function traceIdFor(response: DkbRetrieveKnowledgeResponse, now: string): string {
  const hash = stableHash({
    now,
    requestId: response.metadata.requestId,
    query: response.metadata.query,
    evidence: response.evidence.map((item) => item.source.hash ?? item.label),
  }).slice(7, 23);

  return `trace_${now.replace(/[^0-9a-z]/gi, '').toLowerCase()}_${hash}`;
}

function evidenceTokens(evidence: DkbEvidence[]): number {
  return evidence.reduce((total, item) => total + estimateTokens(evidenceText(item)), 0);
}

function evidenceText(evidence: DkbEvidence): string {
  if (typeof evidence.text === 'string') {
    return evidence.text;
  }

  if (evidence.rows) {
    return JSON.stringify(evidence.rows);
  }

  return String(evidence.value ?? '');
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}
