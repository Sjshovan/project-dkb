import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { LoadedDkb } from '@sjshovan/dkb-protocol/types.js';
import type {
  LlamaIndexCompilerRecord,
  LlamaIndexCompilerRequest,
  LlamaIndexDatabaseSourceRequest,
  LlamaIndexRecordCache,
  SourceCandidate,
} from './compiler.js';

export function requestFor(dkb: LoadedDkb): {
  dkbId: string;
  version: string;
  stores: Array<{
    id: string;
    type: 'filesystem' | 'sqlite';
    path: string;
    includePaths?: string[];
    excludePaths?: string[];
  }>;
  externalSources: LlamaIndexDatabaseSourceRequest[];
} {
  const stores = (dkb.manifest.stores ?? []).flatMap((store) => {
    if ((store.type !== 'filesystem' && store.type !== 'sqlite') || !store.path || store.permissions?.read === false) {
      return [];
    }

    const includePaths = Array.isArray(store.meta?.includePaths)
      ? store.meta.includePaths.filter((item): item is string => typeof item === 'string')
      : undefined;
    const excludePaths = Array.isArray(store.meta?.claimedByAdapters)
      ? store.meta.claimedByAdapters.filter((item): item is string => typeof item === 'string')
      : undefined;

    return [{
      id: store.id,
      type: store.type,
      path: store.path.replace(/^\.\//, '').replace(/\\/g, '/'),
      ...(includePaths && includePaths.length > 0 ? { includePaths } : {}),
      ...(excludePaths && excludePaths.length > 0 ? { excludePaths } : {}),
    }];
  });

  const externalSources = externalDatabaseSourcesFor(dkb);

  if (stores.length === 0 && externalSources.length === 0) {
    throw new DkbError(`DKB ${dkb.manifest.id} has no readable local sources or configured LlamaIndex database sources`);
  }

  return {
    dkbId: dkb.manifest.id,
    version: dkb.manifest.version,
    stores,
    externalSources,
  };
}

export async function cachePlanFor(
  dkb: LoadedDkb,
  request: LlamaIndexCompilerRequest,
  cache: LlamaIndexRecordCache | null,
): Promise<{
  candidates: SourceCandidate[];
  changed: SourceCandidate[];
  reused: SourceCandidate[];
  reusedRecords: LlamaIndexCompilerRecord[];
}> {
  const candidates = (await Promise.all(request.stores.map((store) => sourceCandidatesForStore(dkb, store)))).flat()
    .sort((left, right) => left.key.localeCompare(right.key));
  const changed: SourceCandidate[] = [];
  const reused: SourceCandidate[] = [];
  const reusedRecords: LlamaIndexCompilerRecord[] = [];

  for (const candidate of candidates) {
    const entry = cache?.entries[candidate.key];

    if (entry && entry.sourceHash === candidate.hash) {
      reused.push(candidate);
      reusedRecords.push(...entry.records);
    } else {
      changed.push(candidate);
    }
  }

  return {
    candidates,
    changed,
    reused,
    reusedRecords,
  };
}

async function sourceCandidatesForStore(
  dkb: LoadedDkb,
  store: LlamaIndexCompilerRequest['stores'][number],
): Promise<SourceCandidate[]> {
  const absolute = path.resolve(dkb.root, store.path);

  if (store.type === 'sqlite') {
    return [{
      key: sourceCacheKey(dkb, store.id, store.type, store.path),
      type: store.type,
      storeId: store.id,
      path: store.path,
      hash: await hashFile(absolute),
    }];
  }

  const included = store.includePaths?.length
    ? store.includePaths.map((item) => path.resolve(dkb.root, item))
    : await listSourceFiles(absolute);
  const excluded = new Set(
    (store.excludePaths ?? []).map((item) => path.resolve(dkb.root, item)),
  );

  return Promise.all(included.filter((file) => !excluded.has(path.resolve(file))).map(async (file) => {
    const relative = path.relative(dkb.root, file).replace(/\\/g, '/');

    return {
      key: sourceCacheKey(dkb, store.id, store.type, relative),
      type: store.type,
      storeId: store.id,
      path: relative,
      hash: await hashFile(file),
    };
  }));
}

export function requestForChangedSources(
  request: LlamaIndexCompilerRequest,
  changed: SourceCandidate[],
): LlamaIndexCompilerRequest {
  const changedByStore = new Map<string, SourceCandidate[]>();

  for (const candidate of changed) {
    const existing = changedByStore.get(candidate.storeId) ?? [];
    existing.push(candidate);
    changedByStore.set(candidate.storeId, existing);
  }

  const stores = request.stores.flatMap((store) => {
    const changedForStore = changedByStore.get(store.id) ?? [];

    if (changedForStore.length === 0) {
      return [];
    }

    if (store.type === 'filesystem') {
      return [{
        ...store,
        includePaths: changedForStore.map((item) => item.path).sort((left, right) => left.localeCompare(right)),
      }];
    }

    return [store];
  });

  if (stores.length === 0 && request.externalSources.length === 0) {
    throw new DkbError('LlamaIndex compiler cache plan selected no changed sources to compile');
  }

  return {
    ...request,
    stores,
  };
}

async function listSourceFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.flatMap(async (entry) => {
    if (isExcludedSourceEntry(entry.name)) {
      return [];
    }
    const target = path.join(root, entry.name);

    if (entry.isDirectory()) {
      return listSourceFiles(target);
    }

    return entry.isFile() ? [target] : [];
  }));

  return nested.flat().sort((left, right) => left.localeCompare(right));
}

function isExcludedSourceEntry(name: string): boolean {
  return name.startsWith('.')
    || name === 'dkb.json'
    || name === 'dkb-lock.json'
    || name === 'dkb-profile.lock.json'
    || name === 'dkb-release.json'
    || name === '.dkb-package.json';
}

function sourceCacheKey(dkb: LoadedDkb, storeId: string, type: SourceCandidate['type'], sourcePath: string): string {
  return `${dkb.manifest.id}:${dkb.manifest.version}:${storeId}:${type}:${sourcePath.replace(/\\/g, '/')}`;
}

function externalDatabaseSourcesFor(dkb: LoadedDkb): LlamaIndexDatabaseSourceRequest[] {
  const config = dkb.manifest.meta?.llamaIndex;
  const sources = config && typeof config === 'object' && Array.isArray((config as { sources?: unknown }).sources)
    ? (config as { sources: unknown[] }).sources
    : [];

  return sources.map((value, index) => {
    if (!value || typeof value !== 'object') {
      throw new DkbError(`meta.llamaIndex.sources[${index}] must be an object`);
    }
    const source = value as Record<string, unknown>;
    if (source.kind !== 'database' || typeof source.id !== 'string' || source.id.length === 0) {
      throw new DkbError(`meta.llamaIndex.sources[${index}] must declare id and kind: "database"`);
    }
    const envName = typeof source.connectionEnv === 'string' ? source.connectionEnv : undefined;
    const direct = typeof source.connection === 'string' ? source.connection : undefined;
    const connection = envName ? process.env[envName] : direct;
    if (!connection) {
      throw new DkbError(`Database source ${source.id} requires ${envName ? `environment variable ${envName}` : 'connectionEnv'}`);
    }
    if (direct && !envName && source.developmentOnly !== true) {
      throw new DkbError(`Database source ${source.id} has an inline connection. Use connectionEnv, or set developmentOnly: true for local-only testing.`);
    }
    const includeTables = Array.isArray(source.includeTables)
      ? source.includeTables.filter((item): item is string => typeof item === 'string')
      : undefined;

    return {
      id: source.id,
      kind: 'database' as const,
      connection: connectionForCompiler(dkb.root, connection),
      ...(typeof source.query === 'string' ? { query: source.query } : {}),
      ...(includeTables?.length ? { includeTables } : {}),
    };
  });
}

function connectionForCompiler(root: string, connection: string): string {
  const localSqlite = /^sqlite:\/\/\/(.+)$/i.exec(connection);
  if (!localSqlite) {
    return connection;
  }
  const sourcePath = path.resolve(localSqlite[1]!.replace(/^\//, ''));
  const relative = path.relative(root, sourcePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return connection;
  }

  return `sqlite:////input/${relative.replace(/\\/g, '/')}`;
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');

  hash.update(await fs.readFile(file));

  return `sha256:${hash.digest('hex')}`;
}
