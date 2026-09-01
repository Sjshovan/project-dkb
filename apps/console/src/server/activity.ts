import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const CONSOLE_ACTIVITY_RETENTION_LIMIT = 500;
export const CONSOLE_ACTIVITY_DEFAULT_PAGE_SIZE = 25;
export const CONSOLE_ACTIVITY_MAX_PAGE_SIZE = 50;

export interface ConsoleActivity {
  id: string;
  commandId: string;
  resourceKey: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: string;
  completedAt?: string;
  summary?: string;
}

export interface ConsoleActivityPage {
  activities: ConsoleActivity[];
  pagination: {
    page: number;
    perPage: number;
    total: number;
    totalPages: number;
    retainedLimit: number;
  };
}

export class ConsoleActivityStore {
  readonly #database: DatabaseSync;

  constructor(target: string) {
    mkdirSync(path.dirname(target), { recursive: true });
    this.#database = new DatabaseSync(path.toNamespacedPath(target));
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL,
        resource_key TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        summary TEXT
      );
      CREATE INDEX IF NOT EXISTS activities_started_at ON activities(started_at DESC);
    `);
    this.#prune();
  }

  begin(id: string, commandId: string, resourceKey: string): void {
    this.#database.prepare(`INSERT INTO activities (id, command_id, resource_key, status, started_at) VALUES (?, ?, ?, 'running', ?)`)
      .run(id, commandId, resourceKey, new Date().toISOString());
    this.#prune();
  }

  finish(id: string, status: ConsoleActivity['status'], summary?: string): void {
    this.#database.prepare('UPDATE activities SET status = ?, completed_at = ?, summary = ? WHERE id = ?')
      .run(status, new Date().toISOString(), summary ? redact(summary).slice(0, 2_000) : null, id);
  }

  list(page = 1, perPage = CONSOLE_ACTIVITY_DEFAULT_PAGE_SIZE): ConsoleActivityPage {
    const pageSize = Math.max(1, Math.min(CONSOLE_ACTIVITY_MAX_PAGE_SIZE, Math.trunc(perPage)));
    const totalRow = this.#database.prepare('SELECT COUNT(*) AS total FROM activities').get() as { total: number | bigint };
    const total = Number(totalRow.total);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.max(1, Math.min(totalPages, Math.trunc(page)));
    const rows = this.#database.prepare(`
      SELECT id, command_id, resource_key, status, started_at, completed_at, summary
      FROM activities ORDER BY started_at DESC, rowid DESC LIMIT ? OFFSET ?
    `).all(pageSize, (currentPage - 1) * pageSize) as Array<Record<string, unknown>>;
    const activities = rows.map((row) => ({
      id: String(row.id),
      commandId: String(row.command_id),
      resourceKey: String(row.resource_key),
      status: row.status as ConsoleActivity['status'],
      startedAt: String(row.started_at),
      ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
      ...(row.summary ? { summary: String(row.summary) } : {}),
    }));
    return {
      activities,
      pagination: { page: currentPage, perPage: pageSize, total, totalPages, retainedLimit: CONSOLE_ACTIVITY_RETENTION_LIMIT },
    };
  }

  close(): void {
    this.#database.close();
  }

  #prune(): void {
    this.#database.prepare(`
      DELETE FROM activities WHERE rowid IN (
        SELECT rowid FROM activities
        ORDER BY started_at DESC, rowid DESC
        LIMIT -1 OFFSET ?
      )
    `).run(CONSOLE_ACTIVITY_RETENTION_LIMIT);
  }
}

function redact(value: string): string {
  return value
    .replace(/\bdkb_[A-Za-z0-9._~-]+\b/gu, '[REDACTED]')
    .replace(/\bBearer\s+[^\s]+/giu, 'Bearer [REDACTED]')
    .replace(/\b(token|secret|password)\s*[=:]\s*[^\s,;]+/giu, '$1=[REDACTED]');
}
