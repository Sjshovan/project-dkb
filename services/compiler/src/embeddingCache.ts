import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { DKB_CACHE_DIR, resolveFrom } from '@sjshovan/dkb-protocol/paths.js';

export const DKB_EMBEDDING_CACHE_PATH = `${DKB_CACHE_DIR}/embeddings.sqlite`;

export interface DkbEmbeddingCache {
  get(textHash: string, dimensions?: number): number[] | null;
  put(textHash: string, vector: readonly number[]): void;
  close(): void;
}

export function embeddingCacheEnabled(): boolean {
  const value = process.env.DKB_EMBEDDING_CACHE?.trim().toLowerCase();
  return value === undefined || !['0', 'false', 'no', 'off'].includes(value);
}

export async function openEmbeddingCache(root: string, spaceDigest: string): Promise<DkbEmbeddingCache> {
  const target = resolveFrom(root, DKB_EMBEDDING_CACHE_PATH);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const database = await openRecoverableDatabase(target);
  const select = database.prepare(`
    SELECT dimensions, vector_json
    FROM embeddings
    WHERE space_digest = ? AND text_hash = ?
  `);
  const remove = database.prepare(`
    DELETE FROM embeddings
    WHERE space_digest = ? AND text_hash = ?
  `);
  const insert = database.prepare(`
    INSERT INTO embeddings (space_digest, text_hash, dimensions, vector_json, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(space_digest, text_hash) DO UPDATE SET
      dimensions = excluded.dimensions,
      vector_json = excluded.vector_json,
      created_at = excluded.created_at
  `);

  return {
    get(textHash, expectedDimensions) {
      const row = select.get(spaceDigest, textHash) as { dimensions?: unknown; vector_json?: unknown } | undefined;
      if (!row) return null;
      try {
        const dimensions = Number(row.dimensions);
        const vector = JSON.parse(String(row.vector_json)) as unknown;
        if (!Number.isInteger(dimensions)
          || dimensions <= 0
          || (expectedDimensions !== undefined && dimensions !== expectedDimensions)
          || !Array.isArray(vector)
          || vector.length !== dimensions
          || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
          throw new DkbError('invalid cached vector');
        }
        return [...vector];
      } catch {
        remove.run(spaceDigest, textHash);
        return null;
      }
    },
    put(textHash, vector) {
      assertVector(vector, `Embedding cache value for ${textHash}`);
      insert.run(spaceDigest, textHash, vector.length, JSON.stringify(vector), new Date().toISOString());
    },
    close() {
      database.close();
    },
  };
}

function assertVector(vector: readonly number[], label: string): void {
  if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
    throw new DkbError(`${label} must contain one or more finite values`);
  }
}

async function openRecoverableDatabase(target: string): Promise<DatabaseSync> {
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(target);
    initializeDatabase(database);
    return database;
  } catch (error) {
    try {
      database?.close();
    } catch {
      // A corrupt handle may not be closeable; quarantine remains best effort.
    }
    const present = await fs.stat(target).then((stat) => stat.isFile()).catch(() => false);
    if (!present) throw error;
    const quarantined = `${target}.corrupt-${Date.now().toString(36)}`;
    await fs.rename(target, quarantined);
    await Promise.all([
      fs.rm(`${target}-wal`, { force: true }),
      fs.rm(`${target}-shm`, { force: true }),
    ]);
    try {
      const replacement = new DatabaseSync(target);
      initializeDatabase(replacement);
      return replacement;
    } catch (retryError) {
      await fs.rename(quarantined, target).catch(() => undefined);
      throw retryError;
    }
  }
}

function initializeDatabase(database: DatabaseSync): void {
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA synchronous = NORMAL');
  database.exec('PRAGMA busy_timeout = 30000');
  database.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      space_digest TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (space_digest, text_hash)
    ) WITHOUT ROWID
  `);
}
