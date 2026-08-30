import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface ConsoleActivity {
  id: string;
  commandId: string;
  resourceKey: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: string;
  completedAt?: string;
  summary?: string;
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
  }

  begin(id: string, commandId: string, resourceKey: string): void {
    this.#database.prepare(`INSERT INTO activities (id, command_id, resource_key, status, started_at) VALUES (?, ?, ?, 'running', ?)`)
      .run(id, commandId, resourceKey, new Date().toISOString());
  }

  finish(id: string, status: ConsoleActivity['status'], summary?: string): void {
    this.#database.prepare('UPDATE activities SET status = ?, completed_at = ?, summary = ? WHERE id = ?')
      .run(status, new Date().toISOString(), summary ? redact(summary).slice(0, 2_000) : null, id);
  }

  list(limit = 100): ConsoleActivity[] {
    const rows = this.#database.prepare(`
      SELECT id, command_id, resource_key, status, started_at, completed_at, summary
      FROM activities ORDER BY started_at DESC LIMIT ?
    `).all(Math.max(1, Math.min(250, limit))) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      commandId: String(row.command_id),
      resourceKey: String(row.resource_key),
      status: row.status as ConsoleActivity['status'],
      startedAt: String(row.started_at),
      ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
      ...(row.summary ? { summary: String(row.summary) } : {}),
    }));
  }

  close(): void {
    this.#database.close();
  }
}

function redact(value: string): string {
  return value
    .replace(/\bdkb_[A-Za-z0-9._~-]+\b/gu, '[REDACTED]')
    .replace(/\bBearer\s+[^\s]+/giu, 'Bearer [REDACTED]')
    .replace(/\b(token|secret|password)\s*[=:]\s*[^\s,;]+/giu, '$1=[REDACTED]');
}
