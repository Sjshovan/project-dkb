import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import type { DkbEvidenceSourceRecord } from '@sjshovan/dkb-protocol/evidence/ir.js';
import type { DkbReadOperation, DkbStoreType, KnowledgeCapabilityProfile, LoadedDkb } from '@sjshovan/dkb-protocol/types.js';
import type {
  DkbJsonValue,
  DkbLocatedChunk,
  DkbParsedDocument,
  DkbPipelineRecord,
  IndexedSourceUnit,
} from '@sjshovan/dkb-pipeline/types.js';

export function evidenceSourceRecordFromPipelineRecord(
  dkb: LoadedDkb,
  record: DkbPipelineRecord,
): DkbEvidenceSourceRecord {
  const unit = indexedSourceUnitFromPipelineRecord(dkb, record);
  const sourceMetadata = customMetadata(record.metadata);
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
      dkb_path: canonicalSourcePath(record.provenance),
      dkb_source_hash: record.provenance.sourceHash,
      dkb_text_hash: stableHash(record.text),
    },
  };
}

export function indexedSourceUnitFromPipelineRecord(dkb: LoadedDkb, record: DkbPipelineRecord): IndexedSourceUnit {
  const provenance = record.provenance;
  const type = provenance.sourceType;
  const sourceMetadata = record.metadata;
  return {
    id: record.id,
    assetId: provenance.assetId,
    dkbId: dkb.manifest.id,
    storeId: provenance.storeId,
    type,
    locator: provenance.locator,
    assetLocator: provenance.assetLocator,
    title: provenance.title,
    text: record.text,
    keywords: tokenize(`${provenance.title} ${record.text}`).slice(0, 24),
    capabilities: capabilitiesForSourceType(type),
    hash: stableHash(record.text),
    updatedAt: provenance.updatedAt,
    chunkOrdinal: provenance.chunkOrdinal,
    chunkStart: provenance.chunkStart,
    chunkEnd: provenance.chunkEnd,
    evidenceId: typeof sourceMetadata.dkb_evidence_id === 'string' ? sourceMetadata.dkb_evidence_id : undefined,
  };
}

export function pipelineRecordFields(
  dkb: LoadedDkb,
  document: DkbParsedDocument,
  chunk: DkbLocatedChunk,
): Pick<DkbPipelineRecord, 'provenance' | 'metadata'> {
  const metadata = customMetadata({ ...document.metadata, ...chunk.metadata });
  return {
    provenance: { ...document.provenance, ...chunk.provenance },
    metadata: {
      ...metadata,
      dkb_package_id: dkb.manifest.id,
      dkb_package_version: dkb.manifest.version,
      dkb_path: document.path,
      dkb_source_hash: document.provenance.sourceHash,
      dkb_text_hash: stableHash(chunk.text),
    },
  };
}

export function normalizeDkbOwnedRecordMetadata(
  dkb: LoadedDkb,
  records: readonly DkbPipelineRecord[],
): DkbPipelineRecord[] {
  return records.map((record) => ({
    ...record,
    metadata: {
      ...customMetadata(record.metadata),
      dkb_package_id: dkb.manifest.id,
      dkb_package_version: dkb.manifest.version,
      dkb_path: canonicalSourcePath(record.provenance),
      dkb_source_hash: record.provenance.sourceHash,
      dkb_text_hash: stableHash(record.text),
    },
  }));
}

function customMetadata(metadata: Record<string, DkbJsonValue>): Record<string, DkbJsonValue> {
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !key.startsWith('dkb_')));
}

function canonicalSourcePath(provenance: DkbPipelineRecord['provenance']): string {
  const assetPath = provenance.assetLocator.path;
  if (typeof assetPath === 'string' && assetPath.trim()) return assetPath.replace(/\\/gu, '/');
  const locatorPath = provenance.locator.path;
  if (typeof locatorPath === 'string' && locatorPath.trim()) return locatorPath.replace(/\\/gu, '/');
  return JSON.stringify(provenance.assetLocator);
}

function capabilitiesForSourceType(type: DkbStoreType): KnowledgeCapabilityProfile {
  return type === 'sqlite' || type === 'postgres' || type === 'database'
    ? { evidence: 'full', records: 'full', exactCount: 'full', approximateCount: 'none', structuredFilter: 'full', operations: ['lookup', 'search', 'aggregate'] satisfies DkbReadOperation[] }
    : { evidence: 'full', records: 'none', exactCount: 'none', approximateCount: 'partial', structuredFilter: 'none', operations: ['fetch', 'search'] satisfies DkbReadOperation[] };
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [])];
}
