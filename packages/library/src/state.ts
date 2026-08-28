import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { resolveContainedPath } from '@sjshovan/dkb-protocol/paths.js';
import { validateDkbLibraryLockManifest } from '@sjshovan/dkb-protocol/validation.js';
import type { DkbEntryStatus, DkbLibraryLockEntry, DkbLibraryLockManifest } from '@sjshovan/dkb-protocol/types.js';

export const DKB_LIBRARY_LOCK_FILENAME = 'dkb-lock.json';
export const DKB_LIBRARY_STATE_PATH = '.dkb/state.sqlite';

export interface DkbLibraryStateEntry extends DkbLibraryLockEntry {
  status: DkbEntryStatus;
  generation: number;
}

export interface DkbLibraryStateSnapshot {
  generation: number;
  entries: Record<string, DkbLibraryStateEntry>;
}

interface StateRow {
  identity: string;
  kind: DkbLibraryLockEntry['kind'];
  source: DkbLibraryLockEntry['source'];
  version: string | null;
  revision: number | null;
  digest: string | null;
  path: string;
  registry_url: string | null;
  required_by: string;
  installed_at: string;
  status: DkbEntryStatus;
  generation: number;
}

export function libraryLockPath(libraryRoot: string): string {
  return path.join(path.resolve(libraryRoot), DKB_LIBRARY_LOCK_FILENAME);
}

export function libraryStatePath(libraryRoot: string): string {
  return path.join(path.resolve(libraryRoot), ...DKB_LIBRARY_STATE_PATH.split('/'));
}

export async function maybeReadLibraryLock(libraryRoot: string): Promise<DkbLibraryLockManifest | null> {
  const source = libraryLockPath(libraryRoot);

  try {
    return validateDkbLibraryLockManifest(JSON.parse(await fs.readFile(source, 'utf8')) as unknown, source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;

    // A compiler artifact lock from before the hard cutover is not a Library
    // lock. Callers can still rebuild it, but must not infer installation state
    // from its package map.
    const value = await maybeReadJson(source);
    if (isRecord(value) && 'artifacts' in value && 'packages' in value) return null;
    throw error;
  }
}

export async function readLibraryState(libraryRoot: string): Promise<DkbLibraryStateSnapshot> {
  const databasePath = libraryStatePath(libraryRoot);

  try {
    await fs.access(databasePath);
  } catch {
    return { generation: 0, entries: {} };
  }

  const database = openLibraryState(databasePath);
  try {
    const generation = Number((database.prepare("SELECT value FROM metadata WHERE key = 'generation'").get() as { value?: string } | undefined)?.value ?? 0);
    const rows = database.prepare('SELECT * FROM entries ORDER BY identity').all() as unknown as StateRow[];
    const entries: Record<string, DkbLibraryStateEntry> = {};

    for (const row of rows) {
      const resolved = resolveContainedPath(libraryRoot, row.path, `Installed entry ${row.identity} path`);
      const present = await exists(path.join(resolved, 'dkb.json'));
      entries[row.identity] = {
        identity: row.identity,
        kind: row.kind,
        source: row.source,
        ...(row.version ? { version: row.version } : {}),
        ...(row.revision ? { revision: row.revision } : {}),
        ...(row.digest ? { digest: row.digest } : {}),
        path: row.path,
        ...(row.registry_url ? { registryUrl: row.registry_url } : {}),
        requiredBy: parseRequiredBy(row.required_by, row.identity),
        installedAt: row.installed_at,
        status: present ? row.status : 'broken',
        generation: row.generation,
      };
    }

    return { generation, entries };
  } finally {
    database.close();
  }
}

export async function applyLibraryLock(libraryRoot: string, input: DkbLibraryLockManifest): Promise<DkbLibraryStateSnapshot> {
  const root = path.resolve(libraryRoot);
  const lock = validateDkbLibraryLockManifest(input, `${libraryLockPath(root)}#candidate`);
  await assertLockPaths(root, lock);
  await fs.mkdir(path.dirname(libraryStatePath(root)), { recursive: true });

  const target = libraryLockPath(root);
  const temp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await fs.writeFile(temp, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');

  const database = openLibraryState(libraryStatePath(root));
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec('DELETE FROM entries');
    const insert = database.prepare(`
      INSERT INTO entries (
        identity, kind, source, version, revision, digest, path,
        registry_url, required_by, installed_at, status, generation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'installed', ?)
    `);

    for (const entry of Object.values(lock.entries).sort((left, right) => left.identity.localeCompare(right.identity))) {
      insert.run(
        entry.identity,
        entry.kind,
        entry.source,
        entry.version ?? null,
        entry.revision ?? null,
        entry.digest ?? null,
        normalizeRelativePath(entry.path),
        entry.registryUrl ?? null,
        JSON.stringify([...entry.requiredBy].sort()),
        entry.installedAt,
        lock.generation,
      );
    }

    database.prepare(`
      INSERT INTO metadata (key, value) VALUES ('generation', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(lock.generation));

    await replaceFile(temp, target);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    await fs.rm(temp, { force: true });
    throw error;
  } finally {
    database.close();
  }

  return readLibraryState(root);
}

export async function assertLibraryStateConsistent(libraryRoot: string): Promise<void> {
  const lock = await maybeReadLibraryLock(libraryRoot);
  const state = await readLibraryState(libraryRoot);

  if (!lock) {
    if (Object.keys(state.entries).length > 0) {
      throw new DkbError('Library state exists without a valid dkb-lock.json; run dkb library repair');
    }
    return;
  }

  if (lock.generation !== state.generation) {
    throw new DkbError(`Library state generation mismatch: lock=${lock.generation}, state=${state.generation}`);
  }

  const lockIdentities = Object.keys(lock.entries).sort();
  const stateIdentities = Object.keys(state.entries).sort();
  if (JSON.stringify(lockIdentities) !== JSON.stringify(stateIdentities)) {
    throw new DkbError('Library lock and applied-state ledger contain different entries');
  }

  const broken = Object.values(state.entries).filter((entry) => entry.status === 'broken');
  if (broken.length > 0) {
    throw new DkbError(`Library has missing installed content: ${broken.map((entry) => entry.identity).join(', ')}`);
  }
}

function openLibraryState(databasePath: string): DatabaseSync {
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS entries (
      identity TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('dkb', 'collection')),
      source TEXT NOT NULL CHECK (source IN ('local', 'registry')),
      version TEXT,
      revision INTEGER,
      digest TEXT,
      path TEXT NOT NULL,
      registry_url TEXT,
      required_by TEXT NOT NULL,
      installed_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('installed', 'broken')),
      generation INTEGER NOT NULL,
      CHECK ((kind = 'dkb' AND version IS NOT NULL AND revision IS NULL)
        OR (kind = 'collection' AND version IS NULL))
    );
  `);
  return database;
}

async function assertLockPaths(root: string, lock: DkbLibraryLockManifest): Promise<void> {
  for (const entry of Object.values(lock.entries)) {
    const target = resolveContainedPath(root, entry.path, `Installed entry ${entry.identity} path`);
    if (!(await exists(path.join(target, 'dkb.json')))) {
      throw new DkbError(`Cannot activate ${entry.identity}; manifest is missing at ${target}`);
    }
  }
}

async function replaceFile(temp: string, target: string): Promise<void> {
  const backup = `${target}.replace-${process.pid}-${Date.now().toString(36)}`;
  const hadTarget = await exists(target);

  if (hadTarget) await fs.rename(target, backup);
  try {
    await fs.rename(temp, target);
    await fs.rm(backup, { force: true });
  } catch (error) {
    await fs.rm(target, { force: true });
    if (hadTarget && await exists(backup)) await fs.rename(backup, target);
    throw error;
  }
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function parseRequiredBy(value: string, identity: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed;
  } catch {
    // Report a deterministic corruption error below.
  }
  throw new DkbError(`Invalid requiredBy state for ${identity}`);
}

async function maybeReadJson(source: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(source, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
