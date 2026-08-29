import fs from 'node:fs/promises';
import path from 'node:path';
import { DKB_CACHE_DIR, resolveFrom } from '@sjshovan/dkb-protocol/paths.js';
import type { LoadedDkb } from '@sjshovan/dkb-protocol/types.js';
import { LLAMAINDEX_COMPILER_ID } from './compilerConstants.js';
import type {
  LlamaIndexCompileCheckpoint,
  LlamaIndexCompilerRecord,
  LlamaIndexRecordCache,
  SourceCandidate,
} from './compiler.js';

export async function readRecordCache(cachePath: string, dkb: LoadedDkb, model: string): Promise<LlamaIndexRecordCache | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath, 'utf8')) as unknown;

    if (!isRecordCache(parsed) || parsed.dkbId !== dkb.manifest.id || parsed.dkbVersion !== dkb.manifest.version || parsed.model !== model) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export async function writeRecordCache(
  cachePath: string,
  dkb: LoadedDkb,
  model: string,
  candidates: SourceCandidate[],
  records: LlamaIndexCompilerRecord[],
): Promise<void> {
  const entries: LlamaIndexRecordCache['entries'] = {};
  const candidatesByPath = new Map(candidates.map((candidate) => [`${candidate.storeId}:${candidate.type}:${candidate.path}`, candidate]));

  for (const record of records) {
    const sourcePath = typeof record.metadata.dkb_path === 'string' ? record.metadata.dkb_path : undefined;
    const candidate = sourcePath ? candidatesByPath.get(`${record.storeId}:${record.type}:${sourcePath}`) : undefined;

    if (!candidate) {
      continue;
    }

    const entry = entries[candidate.key] ?? {
      sourceHash: candidate.hash,
      records: [],
    };
    entry.records.push(record);
    entries[candidate.key] = entry;
  }

  const cache: LlamaIndexRecordCache = {
    version: 1,
    compilerId: LLAMAINDEX_COMPILER_ID,
    model,
    dkbId: dkb.manifest.id,
    dkbVersion: dkb.manifest.version,
    entries,
    updatedAt: new Date().toISOString(),
  };

  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await writeJsonAtomic(cachePath, cache);
}

function isRecordCache(value: unknown): value is LlamaIndexRecordCache {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<LlamaIndexRecordCache>;

  return candidate.version === 1
    && candidate.compilerId === LLAMAINDEX_COMPILER_ID
    && typeof candidate.model === 'string'
    && typeof candidate.dkbId === 'string'
    && typeof candidate.dkbVersion === 'string'
    && Boolean(candidate.entries)
    && typeof candidate.entries === 'object'
    && !Array.isArray(candidate.entries);
}

export async function readCheckpoint(checkpointPath: string): Promise<LlamaIndexCompileCheckpoint | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(checkpointPath, 'utf8')) as unknown;

    return isCheckpoint(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function checkpointFor(
  dkb: LoadedDkb,
  model: string,
  changedSources: SourceCandidate[],
  reusedSources: string[],
  status: LlamaIndexCompileCheckpoint['status'],
): LlamaIndexCompileCheckpoint {
  const now = new Date().toISOString();

  return {
    version: 1,
    compilerId: LLAMAINDEX_COMPILER_ID,
    model,
    dkbId: dkb.manifest.id,
    dkbVersion: dkb.manifest.version,
    status,
    startedAt: now,
    updatedAt: now,
    changedSources: changedSources.map(({ key, type, storeId, path, hash }) => ({ key, type, storeId, path, hash })),
    reusedSources,
  };
}

export async function writeCheckpoint(checkpointPath: string, checkpoint: LlamaIndexCompileCheckpoint): Promise<void> {
  await fs.mkdir(path.dirname(checkpointPath), { recursive: true });
  await writeJsonAtomic(checkpointPath, checkpoint);
}

function isCheckpoint(value: unknown): value is LlamaIndexCompileCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<LlamaIndexCompileCheckpoint>;

  return candidate.version === 1
    && candidate.compilerId === LLAMAINDEX_COMPILER_ID
    && (candidate.status === 'running' || candidate.status === 'completed')
    && Array.isArray(candidate.changedSources)
    && Array.isArray(candidate.reusedSources);
}

export function llamaIndexCachePath(root: string): string {
  return resolveFrom(root, `${DKB_CACHE_DIR}/llamaindex-record-cache.json`);
}

export function llamaIndexCheckpointPath(root: string): string {
  return resolveFrom(root, `${DKB_CACHE_DIR}/llamaindex-job.json`);
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const tempPath = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;

  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rm(target, { force: true });
  await fs.rename(tempPath, target);
}
