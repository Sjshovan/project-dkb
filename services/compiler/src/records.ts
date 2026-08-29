import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbEvidenceSourceRecord } from '@sjshovan/dkb-protocol/evidence/ir.js';
import type { DkbReadOperation, DkbStoreType, KnowledgeCapabilityProfile, LoadedDkb } from '@sjshovan/dkb-protocol/types.js';
import type {
  DkbPipelineChunk,
  DkbPipelineDocument,
  DkbPipelineRecord,
  IndexedSourceUnit,
} from '@sjshovan/dkb-pipeline/types.js';

const EPOCH = '1970-01-01T00:00:00.000Z';

export function evidenceSourceRecordFromPipelineRecord(
  dkb: LoadedDkb,
  record: DkbPipelineRecord,
): DkbEvidenceSourceRecord {
  const unit = indexedSourceUnitFromPipelineRecord(dkb, record);
  const sourceMetadata = recordValue(record.metadata.sourceMetadata);
  return {
    id: unit.id,
    assetId: unit.assetId,
    storeId: unit.storeId,
    type: unit.type === 'postgres' ? 'database' : unit.type,
    locator: unit.locator,
    assetLocator: unit.assetLocator,
    title: unit.title,
    text: unit.text,
    hash: unit.hash,
    updatedAt: unit.updatedAt,
    chunkOrdinal: unit.chunkOrdinal,
    chunkStart: unit.chunkStart,
    chunkEnd: unit.chunkEnd,
    metadata: {
      ...sourceMetadata,
      dkb_package_id: dkb.manifest.id,
      dkb_package_version: dkb.manifest.version,
      dkb_path: typeof sourceMetadata.dkb_path === 'string'
        ? sourceMetadata.dkb_path
        : JSON.stringify(unit.assetLocator),
      dkb_source_hash: typeof sourceMetadata.dkb_source_hash === 'string'
        ? sourceMetadata.dkb_source_hash
        : unit.hash,
    },
  };
}

export function indexedSourceUnitFromPipelineRecord(dkb: LoadedDkb, record: DkbPipelineRecord): IndexedSourceUnit {
  const metadata = record.metadata;
  const type = sourceType(metadata.type, `${record.id}.type`);
  const sourceMetadata = recordValue(metadata.sourceMetadata);
  return {
    id: record.id,
    assetId: stringValue(metadata.assetId, `${record.id}.assetId`),
    dkbId: dkb.manifest.id,
    storeId: stringValue(metadata.storeId, `${record.id}.storeId`),
    type,
    locator: recordValue(metadata.locator),
    assetLocator: recordValue(metadata.assetLocator),
    title: stringValue(metadata.title, `${record.id}.title`),
    text: record.text,
    keywords: tokenize(`${String(metadata.title ?? '')} ${record.text}`).slice(0, 24),
    capabilities: capabilitiesForSourceType(type),
    hash: stringValue(metadata.hash, `${record.id}.hash`),
    updatedAt: stringValue(metadata.updatedAt, `${record.id}.updatedAt`),
    chunkOrdinal: numberValue(metadata.chunkOrdinal, `${record.id}.chunkOrdinal`),
    chunkStart: numberValue(metadata.chunkStart, `${record.id}.chunkStart`),
    chunkEnd: numberValue(metadata.chunkEnd, `${record.id}.chunkEnd`),
    evidenceId: typeof sourceMetadata.dkb_evidence_id === 'string' ? sourceMetadata.dkb_evidence_id : undefined,
  };
}

export function pipelineRecordMetadata(
  dkb: LoadedDkb,
  document: DkbPipelineDocument | undefined,
  chunk: DkbPipelineChunk,
  ordinal: number,
): Record<string, unknown> {
  const metadata = { ...(document?.metadata ?? {}), ...chunk.metadata };
  const documentText = document?.text ?? chunk.text;
  const sourcePath = document?.path || `${chunk.documentId}.txt`;
  const sourceHash = optionalString(recordValue(metadata.sourceMetadata).dkb_source_hash) ?? stableHash(documentText);
  const type = optionalSourceType(metadata.type) ?? sourceTypeForDkb(dkb);
  const chunkStart = optionalNumber(metadata.chunkStart) ?? 0;
  const chunkEnd = optionalNumber(metadata.chunkEnd) ?? chunkStart + chunk.text.length;
  return {
    ...metadata,
    assetId: optionalString(metadata.assetId) ?? document?.id ?? chunk.documentId,
    storeId: optionalString(metadata.storeId) ?? dkb.manifest.stores?.[0]?.id ?? dkb.manifest.adapter,
    type,
    locator: optionalRecord(metadata.locator) ?? { path: sourcePath, chunk: ordinal },
    assetLocator: optionalRecord(metadata.assetLocator) ?? { path: sourcePath },
    title: optionalString(metadata.title) ?? sourcePath.split(/[\\/]/).at(-1) ?? document?.id ?? chunk.id,
    hash: optionalString(metadata.hash) ?? stableHash(chunk.text),
    updatedAt: optionalString(metadata.updatedAt) ?? EPOCH,
    chunkOrdinal: optionalNumber(metadata.chunkOrdinal) ?? ordinal,
    chunkStart,
    chunkEnd,
    sourceMetadata: {
      ...recordValue(metadata.sourceMetadata),
      dkb_package_id: dkb.manifest.id,
      dkb_package_version: dkb.manifest.version,
      dkb_path: sourcePath.replace(/\\/g, '/'),
      dkb_source_hash: sourceHash,
    },
  };
}

export function refreshMutatedRecordHashes(
  before: readonly DkbPipelineRecord[],
  after: readonly DkbPipelineRecord[],
): DkbPipelineRecord[] {
  const originalText = new Map(before.map((record) => [record.id, record.text]));
  return after.map((record) => originalText.get(record.id) === record.text
    ? record
    : { ...record, metadata: { ...record.metadata, hash: stableHash(record.text) } });
}

function capabilitiesForSourceType(type: DkbStoreType): KnowledgeCapabilityProfile {
  return type === 'sqlite' || type === 'postgres' || type === 'database'
    ? { evidence: 'full', records: 'full', exactCount: 'full', approximateCount: 'none', structuredFilter: 'full', operations: ['lookup', 'search', 'aggregate'] satisfies DkbReadOperation[] }
    : { evidence: 'full', records: 'none', exactCount: 'none', approximateCount: 'partial', structuredFilter: 'none', operations: ['fetch', 'search'] satisfies DkbReadOperation[] };
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [])];
}

function sourceTypeForDkb(dkb: LoadedDkb): DkbStoreType {
  if (dkb.manifest.adapter === 'sqlite') return 'sqlite';
  if (dkb.manifest.adapter === 'postgres') return 'database';
  return 'filesystem';
}

function sourceType(value: unknown, label: string): DkbStoreType {
  const type = optionalSourceType(value);
  if (!type) throw new DkbError(`${label} must be filesystem, sqlite, or database`);
  return type;
}

function optionalSourceType(value: unknown): DkbStoreType | undefined {
  return value === 'filesystem' || value === 'sqlite' || value === 'database' ? value : undefined;
}

function stringValue(value: unknown, label: string): string {
  const result = optionalString(value);
  if (!result) throw new DkbError(`${label} must be a non-empty string`);
  return result;
}

function numberValue(value: unknown, label: string): number {
  const result = optionalNumber(value);
  if (result === undefined) throw new DkbError(`${label} must be a non-negative number`);
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return optionalRecord(value) ?? {};
}
