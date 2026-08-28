import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DKB_ARTIFACTS_DIR, resolveFrom } from '@dkb/protocol/paths.js';
import { capabilitiesForSourceType, type IndexedSourceUnit } from './sourceIndex.js';
import { tokenize } from './scoring.js';
import type { LoadedDkb } from '@dkb/protocol/types.js';
import type { LlamaIndexCompilerRecord, LlamaIndexCompilerResult } from './llamaindex.js';
import { evidenceIdentityForRecord } from '@dkb/protocol/evidence/ir.js';

export const LLAMAINDEX_COMPILER_BUNDLE_MANIFEST_PATH = `${DKB_ARTIFACTS_DIR}/llamaindex.compiler.manifest.json`;
export const LLAMAINDEX_COMPILER_RECORDS_DIR = `${DKB_ARTIFACTS_DIR}/llamaindex.records`;

export interface LlamaIndexCompilerBundleSource {
  key: string;
  storeId: string;
  type: LlamaIndexCompilerRecord['type'];
  dkbPath: string;
  sourceHash: string;
  recordsPath: string;
  recordsHash: string;
  recordCount: number;
}

export interface LlamaIndexCompilerBundleManifest {
  format: 'dkb.llamaindex.bundle.v1';
  compiler: LlamaIndexCompilerResult['compiler'];
  execution?: LlamaIndexCompilerResult['execution'];
  recordCount: number;
  sources: LlamaIndexCompilerBundleSource[];
  generatedAt: string;
}

export interface WriteLlamaIndexCompilerBundleResult {
  manifest: LlamaIndexCompilerBundleManifest;
  changedRecordPaths: string[];
  removedRecordPaths: string[];
}

export async function writeLlamaIndexCompilerBundle(
  root: string,
  result: LlamaIndexCompilerResult,
  options: {
    changedSourceKeys?: string[];
  } = {},
): Promise<WriteLlamaIndexCompilerBundleResult> {
  const resolvedRoot = path.resolve(root);
  const previous = await readLlamaIndexCompilerBundleManifest(resolvedRoot).catch(() => null);
  const previousByKey = new Map((previous?.sources ?? []).map((source) => [source.key, source]));
  const grouped = groupRecordsBySource(result.records);
  const changedKeys = options.changedSourceKeys ? new Set(options.changedSourceKeys) : null;
  const sources: LlamaIndexCompilerBundleSource[] = [];
  const changedRecordPaths: string[] = [];

  await fs.mkdir(resolveFrom(resolvedRoot, LLAMAINDEX_COMPILER_RECORDS_DIR), { recursive: true });

  for (const group of grouped) {
    const previousSource = previousByKey.get(group.key);
    const recordsPath = previousSource?.recordsPath ?? `${LLAMAINDEX_COMPILER_RECORDS_DIR}/${recordShardName(group.key)}.json`;
    const recordsHash = hashString(JSON.stringify(group.records.map(recordForSourceShardHash)));
    const canReuse = previousSource
      && previousSource.sourceHash === group.sourceHash
      && previousSource.recordsHash === recordsHash
      && (!changedKeys || !changedKeys.has(group.key));

    if (!canReuse) {
      await writeJsonAtomic(resolveFrom(resolvedRoot, recordsPath), {
        format: 'dkb.llamaindex.records.v1',
        source: {
          key: group.key,
          storeId: group.storeId,
          type: group.type,
          dkbPath: group.dkbPath,
          sourceHash: group.sourceHash,
        },
        records: group.records,
      });
      changedRecordPaths.push(recordsPath);
    }

    sources.push({
      key: group.key,
      storeId: group.storeId,
      type: group.type,
      dkbPath: group.dkbPath,
      sourceHash: group.sourceHash,
      recordsPath,
      recordsHash,
      recordCount: group.records.length,
    });
  }

  const currentPaths = new Set(sources.map((source) => source.recordsPath));
  const removedRecordPaths = (previous?.sources ?? [])
    .map((source) => source.recordsPath)
    .filter((recordsPath) => !currentPaths.has(recordsPath));
  const manifest: LlamaIndexCompilerBundleManifest = {
    format: 'dkb.llamaindex.bundle.v1',
    compiler: result.compiler,
    execution: result.execution,
    recordCount: result.records.length,
    sources: sources.sort((left, right) => left.key.localeCompare(right.key)),
    generatedAt: new Date().toISOString(),
  };

  await writeJsonAtomic(resolveFrom(resolvedRoot, LLAMAINDEX_COMPILER_BUNDLE_MANIFEST_PATH), manifest);

  return {
    manifest,
    changedRecordPaths,
    removedRecordPaths,
  };
}

export async function readLlamaIndexCompilerRecords(root: string): Promise<LlamaIndexCompilerRecord[]> {
  const bundle = await readLlamaIndexCompilerBundleManifest(root);
  const records = (await Promise.all(bundle.sources.map(async (source) => {
    const payload = JSON.parse(await fs.readFile(resolveFrom(root, source.recordsPath), 'utf8')) as {
      records?: unknown;
    };

    return Array.isArray(payload.records) ? payload.records as LlamaIndexCompilerRecord[] : [];
  }))).flat();

  return records.sort(compareRecords);
}

export async function readLlamaIndexCompilerBundleManifest(root: string): Promise<LlamaIndexCompilerBundleManifest> {
  const parsed = JSON.parse(await fs.readFile(resolveFrom(root, LLAMAINDEX_COMPILER_BUNDLE_MANIFEST_PATH), 'utf8')) as unknown;

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid LlamaIndex compiler bundle manifest');
  }
  const manifest = parsed as Partial<LlamaIndexCompilerBundleManifest>;

  if (manifest.format !== 'dkb.llamaindex.bundle.v1' || !Array.isArray(manifest.sources)) {
    throw new Error('Invalid LlamaIndex compiler bundle manifest');
  }

  return manifest as LlamaIndexCompilerBundleManifest;
}

export function sourceUnitFromLlamaIndexRecord(dkb: LoadedDkb, record: LlamaIndexCompilerRecord): IndexedSourceUnit {
  const keywords = [...new Set(tokenize(`${record.title} ${record.text}`))].slice(0, 24);
  const identity = evidenceIdentityForRecord(record);

  return {
    id: record.id,
    evidenceId: identity.evidenceId,
    assetId: record.assetId,
    dkbId: dkb.manifest.id,
    storeId: record.storeId,
    type: record.type,
    locator: record.locator,
    assetLocator: record.assetLocator,
    title: record.title,
    text: record.text,
    keywords,
    capabilities: capabilitiesForSourceType(record.type),
    hash: record.hash,
    updatedAt: record.updatedAt,
    chunkOrdinal: record.chunkOrdinal,
    chunkStart: record.chunkStart,
    chunkEnd: record.chunkEnd,
  };
}

export function sourceKeyForLlamaIndexRecord(record: LlamaIndexCompilerRecord): string {
  const dkbPath = dkbPathForRecord(record);
  const dkbId = typeof record.metadata.dkb_package_id === 'string' ? record.metadata.dkb_package_id : '';
  const version = typeof record.metadata.dkb_package_version === 'string' ? record.metadata.dkb_package_version : '';

  return `${dkbId}:${version}:${record.storeId}:${record.type}:${dkbPath}`;
}

function groupRecordsBySource(records: LlamaIndexCompilerRecord[]): Array<{
  key: string;
  storeId: string;
  type: LlamaIndexCompilerRecord['type'];
  dkbPath: string;
  sourceHash: string;
  records: LlamaIndexCompilerRecord[];
}> {
  const groups = new Map<string, {
    key: string;
    storeId: string;
    type: LlamaIndexCompilerRecord['type'];
    dkbPath: string;
    sourceHash: string;
    records: LlamaIndexCompilerRecord[];
  }>();

  for (const record of records) {
    const key = sourceKeyForLlamaIndexRecord(record);
    const group = groups.get(key) ?? {
      key,
      storeId: record.storeId,
      type: record.type,
      dkbPath: dkbPathForRecord(record),
      sourceHash: typeof record.metadata.dkb_source_hash === 'string' ? record.metadata.dkb_source_hash : record.hash,
      records: [],
    };

    group.records.push(record);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({ ...group, records: group.records.sort(compareRecords) }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function dkbPathForRecord(record: LlamaIndexCompilerRecord): string {
  return typeof record.metadata.dkb_path === 'string'
    ? record.metadata.dkb_path
    : JSON.stringify(record.assetLocator);
}

function recordShardName(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

function recordForSourceShardHash(record: LlamaIndexCompilerRecord): Record<string, unknown> {
  return {
    id: record.id,
    assetId: record.assetId,
    text: record.text,
    hash: record.hash,
    metadata: record.metadata,
    embedding: record.embedding ? Array.from(record.embedding) : [],
  };
}

function compareRecords(left: LlamaIndexCompilerRecord, right: LlamaIndexCompilerRecord): number {
  return left.id.localeCompare(right.id);
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const tempPath = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(tempPath, `${JSON.stringify(value, float32JsonReplacer, 2)}\n`, 'utf8');
  await fs.rm(target, { force: true });
  await fs.rename(tempPath, target);
}

function float32JsonReplacer(_key: string, value: unknown): unknown {
  return value instanceof Float32Array ? Array.from(value) : value;
}

function hashString(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
