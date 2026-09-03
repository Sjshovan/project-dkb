import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import {
  DKB_EVIDENCE_CATALOG_FILENAME,
  DKB_EVIDENCE_CATALOG_FORMAT,
  type DkbEvidenceCatalogAsset,
  type DkbEvidenceCatalogRecord,
  type DkbEvidenceCatalogSnapshot,
} from '@sjshovan/dkb-protocol/evidence/catalog.js';
import { validateEvidenceIr, type DkbEvidenceIr } from '@sjshovan/dkb-protocol/evidence/ir.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbStoreType, KnowledgeCapabilityProfile, KnowledgeQueryable } from '@sjshovan/dkb-protocol/types.js';

const EPOCH = '1970-01-01T00:00:00.000Z';

export async function materializeEvidenceCatalog(evidenceRoot: string, input: DkbEvidenceIr): Promise<string> {
  const snapshot = catalogSnapshotForEvidence(input);
  const target = path.join(evidenceRoot, DKB_EVIDENCE_CATALOG_FILENAME);
  const temporary = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;

  await fs.mkdir(evidenceRoot, { recursive: true });
  await fs.rm(temporary, { force: true });
  const database = new DatabaseSync(path.toNamespacedPath(temporary));

  try {
    database.exec(`
      pragma journal_mode = delete;
      create table catalog_meta (key text primary key, value text not null);
      create table evidence_assets (
        package_id text not null,
        asset_id text not null,
        store_id text not null,
        source_type text not null,
        locator_json text not null,
        title text not null,
        source_hash text not null,
        updated_at text not null,
        primary key (package_id, asset_id)
      );
      create table evidence_records (
        evidence_id text primary key,
        source_id text not null,
        package_id text not null,
        package_version text not null,
        asset_id text not null,
        store_id text not null,
        source_type text not null,
        locator_json text not null,
        asset_locator_json text not null,
        title text not null,
        evidence_text text not null,
        text_hash text not null,
        source_hash text not null,
        provenance_json text not null,
        keywords_json text not null,
        capabilities_json text not null,
        queryable_json text,
        chunk_ordinal integer not null,
        chunk_start integer not null,
        chunk_end integer not null,
        heading text,
        updated_at text not null
      );
      create index evidence_records_asset_idx on evidence_records (package_id, asset_id);
      create index evidence_records_source_idx on evidence_records (source_id);
    `);
    const insertMeta = database.prepare('insert into catalog_meta (key, value) values (?, ?)');
    insertMeta.run('format', DKB_EVIDENCE_CATALOG_FORMAT);
    insertMeta.run('evidenceProfileDigest', snapshot.evidenceProfileDigest);
    insertMeta.run('evidenceDigest', snapshot.evidenceDigest);
    const insertAsset = database.prepare(`insert or ignore into evidence_assets
      (package_id, asset_id, store_id, source_type, locator_json, title, source_hash, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertRecord = database.prepare(`insert into evidence_records
      (evidence_id, source_id, package_id, package_version, asset_id, store_id, source_type,
       locator_json, asset_locator_json, title, evidence_text, text_hash, source_hash,
       provenance_json, keywords_json, capabilities_json, queryable_json, chunk_ordinal,
       chunk_start, chunk_end, heading, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    database.exec('begin');
    try {
      for (const asset of snapshot.assets) {
        insertAsset.run(
          asset.packageId,
          asset.id,
          asset.storeId,
          asset.type,
          JSON.stringify(asset.locator),
          asset.title,
          asset.sourceHash,
          asset.updatedAt,
        );
      }
      for (const record of snapshot.records) {
        insertRecord.run(
          record.evidenceId,
          record.sourceId,
          record.packageId,
          record.packageVersion,
          record.assetId,
          record.storeId,
          record.sourceType,
          JSON.stringify(record.locator),
          JSON.stringify(record.assetLocator),
          record.title,
          record.text,
          record.textHash,
          record.sourceHash,
          JSON.stringify(record.provenance),
          JSON.stringify(record.keywords),
          JSON.stringify(record.capabilities),
          record.queryable ? JSON.stringify(record.queryable) : null,
          record.chunkOrdinal,
          record.chunkStart,
          record.chunkEnd,
          record.heading ?? null,
          record.updatedAt,
        );
      }
      database.exec('commit');
    } catch (error) {
      database.exec('rollback');
      throw error;
    }
  } finally {
    database.close();
  }

  await fs.rm(target, { force: true });
  await fs.rename(temporary, target);
  return target;
}

export function readEvidenceCatalog(evidenceRoot: string): DkbEvidenceCatalogSnapshot {
  const target = path.join(evidenceRoot, DKB_EVIDENCE_CATALOG_FILENAME);
  const evidencePath = path.join(evidenceRoot, 'evidence.ir.json');
  const canonical = catalogSnapshotForEvidence(JSON.parse(readFileSync(evidencePath, 'utf8')), evidencePath);
  const database = new DatabaseSync(path.toNamespacedPath(target), { readOnly: true });

  try {
    const meta = new Map((database.prepare('select key, value from catalog_meta').all() as Array<{ key: string; value: string }>)
      .map((entry) => [entry.key, entry.value]));
    if (meta.get('format') !== DKB_EVIDENCE_CATALOG_FORMAT) {
      throw new DkbError(`Unsupported Evidence catalog at ${target}`);
    }
    const assets = (database.prepare('select * from evidence_assets order by package_id, asset_id').all() as CatalogAssetRow[])
      .map(assetFromRow);
    const records = (database.prepare('select * from evidence_records order by evidence_id').all() as CatalogRecordRow[])
      .map(recordFromRow);

    const snapshot: DkbEvidenceCatalogSnapshot = {
      format: DKB_EVIDENCE_CATALOG_FORMAT,
      evidenceProfileDigest: requiredMeta(meta, 'evidenceProfileDigest', target),
      evidenceDigest: requiredMeta(meta, 'evidenceDigest', target),
      assets,
      records,
    };
    if (!isDeepStrictEqual(snapshot, canonical)) {
      throw new DkbError(
        `Evidence catalog at ${target} does not match canonical Evidence IR. Reinstall the package or rebuild its local Evidence Build.`,
        'invalid_evidence_catalog',
      );
    }
    return snapshot;
  } finally {
    database.close();
  }
}

function catalogSnapshotForEvidence(input: unknown, source?: string): DkbEvidenceCatalogSnapshot {
  const evidence = validateEvidenceIr(input, source);
  const chunks = new Map(evidence.chunks.map((chunk) => [chunk.evidenceId, chunk]));
  const assets = new Map<string, DkbEvidenceCatalogAsset>();
  const records = evidence.evidence.map((record): DkbEvidenceCatalogRecord => {
    const chunk = chunks.get(record.evidenceId);
    if (!chunk) throw new DkbError(`Evidence catalog is missing chunk metadata for ${record.evidenceId}`);
    const type = sourceType(record.sourceType);
    const updatedAt = stringProvenance(record.provenance, 'dkb_updated_at') ?? EPOCH;
    const heading = stringProvenance(record.provenance, 'dkb_heading');
    const assetKey = JSON.stringify([record.packageId, record.assetId]);
    if (!assets.has(assetKey)) {
      assets.set(assetKey, {
        id: record.assetId,
        packageId: record.packageId,
        storeId: record.storeId,
        type,
        locator: record.assetLocator,
        title: record.title,
        sourceHash: record.sourceHash,
        updatedAt,
      });
    }
    return {
      evidenceId: record.evidenceId,
      sourceId: record.sourceId,
      packageId: record.packageId,
      packageVersion: record.packageVersion,
      assetId: record.assetId,
      storeId: record.storeId,
      sourceType: type,
      locator: record.locator,
      assetLocator: record.assetLocator,
      title: record.title,
      text: record.text,
      textHash: record.textHash,
      sourceHash: record.sourceHash,
      provenance: record.provenance,
      keywords: tokenize(`${record.title} ${record.text}`).slice(0, 24),
      capabilities: capabilitiesFor(type),
      chunkOrdinal: chunk.ordinal,
      chunkStart: chunk.start,
      chunkEnd: chunk.end,
      ...(heading ? { heading } : {}),
      updatedAt,
    };
  });
  return {
    format: DKB_EVIDENCE_CATALOG_FORMAT,
    evidenceProfileDigest: evidence.evidenceProfileDigest,
    evidenceDigest: evidence.evidenceDigest,
    assets: [...assets.values()].sort((left, right) => compareSqliteText(left.packageId, right.packageId) || compareSqliteText(left.id, right.id)),
    records: records.sort((left, right) => compareSqliteText(left.evidenceId, right.evidenceId)),
  };
}

function compareSqliteText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

type CatalogAssetRow = {
  package_id: string; asset_id: string; store_id: string; source_type: string;
  locator_json: string; title: string; source_hash: string; updated_at: string;
};

type CatalogRecordRow = {
  evidence_id: string; source_id: string; package_id: string; package_version: string;
  asset_id: string; store_id: string; source_type: string; locator_json: string;
  asset_locator_json: string; title: string; evidence_text: string; text_hash: string;
  source_hash: string; provenance_json: string; keywords_json: string;
  capabilities_json: string; queryable_json: string | null; chunk_ordinal: number;
  chunk_start: number; chunk_end: number; heading: string | null; updated_at: string;
};

function assetFromRow(row: CatalogAssetRow): DkbEvidenceCatalogAsset {
  return {
    id: row.asset_id,
    packageId: row.package_id,
    storeId: row.store_id,
    type: sourceType(row.source_type),
    locator: jsonRecord(row.locator_json),
    title: row.title,
    sourceHash: row.source_hash,
    updatedAt: row.updated_at,
  };
}

function recordFromRow(row: CatalogRecordRow): DkbEvidenceCatalogRecord {
  return {
    evidenceId: row.evidence_id,
    sourceId: row.source_id,
    packageId: row.package_id,
    packageVersion: row.package_version,
    assetId: row.asset_id,
    storeId: row.store_id,
    sourceType: sourceType(row.source_type),
    locator: jsonRecord(row.locator_json),
    assetLocator: jsonRecord(row.asset_locator_json),
    title: row.title,
    text: row.evidence_text,
    textHash: row.text_hash,
    sourceHash: row.source_hash,
    provenance: jsonRecord(row.provenance_json),
    keywords: jsonArray(row.keywords_json),
    capabilities: jsonRecord(row.capabilities_json) as unknown as KnowledgeCapabilityProfile,
    ...(row.queryable_json ? { queryable: jsonRecord(row.queryable_json) as unknown as KnowledgeQueryable } : {}),
    chunkOrdinal: row.chunk_ordinal,
    chunkStart: row.chunk_start,
    chunkEnd: row.chunk_end,
    ...(row.heading ? { heading: row.heading } : {}),
    updatedAt: row.updated_at,
  };
}

function capabilitiesFor(type: DkbStoreType): KnowledgeCapabilityProfile {
  if (type === 'database' || type === 'sqlite' || type === 'postgres') {
    return {
      evidence: 'full', records: 'full', exactCount: 'full', approximateCount: 'none',
      structuredFilter: 'full', operations: ['lookup', 'search', 'aggregate'],
    };
  }
  return {
    evidence: 'full', records: 'none', exactCount: 'none', approximateCount: 'partial',
    structuredFilter: 'none', operations: ['fetch', 'search'],
  };
}

function sourceType(value: string): DkbStoreType {
  if (value === 'filesystem' || value === 'sqlite' || value === 'postgres' || value === 'database') return value;
  throw new DkbError(`Unsupported Evidence source type ${value}`);
}

function tokenize(value: string): string[] {
  const stopwords = new Set([
    'and', 'are', 'but', 'for', 'from', 'has', 'have', 'into', 'not', 'that', 'the',
    'their', 'then', 'there', 'these', 'they', 'this', 'was', 'were', 'what', 'when',
    'where', 'which', 'who', 'will', 'with', 'you', 'your',
  ]);
  const tokens = (value.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [])
    .flatMap((token) => token.includes('-') ? [token, ...token.split('-')] : [token])
    .filter((token) => token.length > 2 && !stopwords.has(token));
  return [...new Set(tokens)];
}

function stringProvenance(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === 'string' && value[key].length > 0 ? value[key] : undefined;
}

function jsonRecord(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new DkbError('Evidence catalog contains invalid object JSON');
  return parsed as Record<string, unknown>;
}

function jsonArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) throw new DkbError('Evidence catalog contains invalid string-array JSON');
  return parsed;
}

function requiredMeta(meta: Map<string, string>, key: string, source: string): string {
  const value = meta.get(key);
  if (!value) throw new DkbError(`Evidence catalog ${source} is missing ${key}`);
  return value;
}
