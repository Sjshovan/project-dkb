import fs from 'node:fs/promises';
import path from 'node:path';
import { stableHash } from '../contracts/hash.js';
import { DkbError } from '../errors.js';
import { DKB_ARTIFACTS_DIR, resolveFrom } from '../paths.js';

export const DKB_EVIDENCE_IR_PATH = `${DKB_ARTIFACTS_DIR}/evidence.ir.json`;
export const DKB_EVIDENCE_IR_FORMAT = 'dkb.evidence.ir.v3';

export interface DkbEvidenceSourceRecord {
  id: string;
  assetId: string;
  storeId: string;
  type: 'filesystem' | 'sqlite' | 'database';
  locator: Record<string, unknown>;
  assetLocator: Record<string, unknown>;
  title: string;
  text: string;
  hash: string;
  updatedAt: string;
  chunkOrdinal: number;
  chunkStart: number;
  chunkEnd: number;
  metadata: Record<string, unknown>;
}

export interface DkbEvidenceIrRecord {
  evidenceId: string;
  sourceId: string;
  packageId: string;
  packageVersion: string;
  storeId: string;
  sourceType: DkbEvidenceSourceRecord['type'];
  sourceHash: string;
  assetId: string;
  assetLocator: Record<string, unknown>;
  locator: Record<string, unknown>;
  title: string;
  text: string;
  textHash: string;
  provenance: Record<string, unknown>;
}

export interface DkbEvidenceIrChunk {
  chunkId: string;
  evidenceId: string;
  evidenceProfileDigest: string;
  ordinal: number;
  start: number;
  end: number;
}

export interface DkbEvidenceIr {
  format: typeof DKB_EVIDENCE_IR_FORMAT;
  evidenceProfileDigest: string;
  evidenceDigest: string;
  evidence: DkbEvidenceIrRecord[];
  chunks: DkbEvidenceIrChunk[];
}

export interface DkbEvidenceIdentity {
  sourceId: string;
  evidenceId: string;
  packageId: string;
  packageVersion: string;
  sourceHash: string;
}

export function evidenceIdentityForRecord(record: DkbEvidenceSourceRecord): DkbEvidenceIdentity {
  const packageId = stringMetadata(record, 'dkb_package_id');
  const packageVersion = stringMetadata(record, 'dkb_package_version');
  const sourceHash = stringMetadata(record, 'dkb_source_hash') || record.hash;
  const sourceId = stableHash({
    packageId,
    packageVersion,
    storeId: record.storeId,
    sourceType: record.type,
    assetLocator: record.assetLocator,
    sourceHash,
  });

  return {
    sourceId,
    evidenceId: stableHash({
      sourceId,
      locator: record.locator,
      textHash: record.hash,
    }),
    packageId,
    packageVersion,
    sourceHash,
  };
}

export function buildEvidenceIr(
  results: ReadonlyArray<{ records: readonly DkbEvidenceSourceRecord[] }>,
  profile: { evidenceProfileDigest?: string; profileDigest?: string },
): DkbEvidenceIr {
  const evidenceProfileDigest = profile.evidenceProfileDigest ?? profile.profileDigest;

  if (!evidenceProfileDigest) {
    throw new DkbError('Evidence IR requires an Evidence Profile digest');
  }
  const evidence = new Map<string, DkbEvidenceIrRecord>();
  const chunks: DkbEvidenceIrChunk[] = [];

  for (const result of results) {
    for (const record of result.records) {
      const { packageId, packageVersion, sourceHash, sourceId, evidenceId: sourceEvidenceId } = evidenceIdentityForRecord(record);
      const evidenceId = stableHash({ sourceEvidenceId, evidenceProfileDigest });

      evidence.set(evidenceId, {
        evidenceId,
        sourceId,
        packageId,
        packageVersion,
        storeId: record.storeId,
        sourceType: record.type,
        sourceHash,
        assetId: record.assetId,
        assetLocator: record.assetLocator,
        locator: record.locator,
        title: record.title,
        text: record.text,
        textHash: record.hash,
        provenance: {
          ...provenanceFor(record.metadata),
          dkb_updated_at: record.metadata.dkb_updated_at ?? record.updatedAt,
        },
      });
      chunks.push({
        chunkId: stableHash({
          evidenceId,
          evidenceProfileDigest,
          ordinal: record.chunkOrdinal,
          start: record.chunkStart,
          end: record.chunkEnd,
        }),
        evidenceId,
        evidenceProfileDigest,
        ordinal: record.chunkOrdinal,
        start: record.chunkStart,
        end: record.chunkEnd,
      });
    }
  }

  const sortedEvidence = [...evidence.values()].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  const sortedChunks = chunks.sort((left, right) => left.chunkId.localeCompare(right.chunkId));
  const evidenceDigest = stableHash({
    format: DKB_EVIDENCE_IR_FORMAT,
    evidenceProfileDigest,
    evidence: sortedEvidence,
    chunks: sortedChunks,
  });

  return {
    format: DKB_EVIDENCE_IR_FORMAT,
    evidenceProfileDigest,
    evidenceDigest,
    evidence: sortedEvidence,
    chunks: sortedChunks,
  };
}

export async function writeEvidenceIr(root: string, ir: DkbEvidenceIr): Promise<void> {
  validateEvidenceIr(ir, DKB_EVIDENCE_IR_PATH);
  const target = resolveFrom(root, DKB_EVIDENCE_IR_PATH);
  const temp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temp, `${JSON.stringify(ir, null, 2)}\n`, 'utf8');
  await fs.rm(target, { force: true });
  await fs.rename(temp, target);
}

export async function readEvidenceIr(root: string): Promise<DkbEvidenceIr> {
  const target = resolveFrom(root, DKB_EVIDENCE_IR_PATH);
  const parsed = JSON.parse(await fs.readFile(target, 'utf8')) as unknown;

  return validateEvidenceIr(parsed, target);
}

export function validateEvidenceIr(value: unknown, source = DKB_EVIDENCE_IR_PATH): DkbEvidenceIr {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DkbError(`Invalid Evidence IR at ${source}: expected object`);
  }

  const candidate = value as Partial<DkbEvidenceIr>;

  if (candidate.format !== DKB_EVIDENCE_IR_FORMAT
    || typeof candidate.evidenceProfileDigest !== 'string'
    || typeof candidate.evidenceDigest !== 'string'
    || !Array.isArray(candidate.evidence)
    || !Array.isArray(candidate.chunks)) {
    throw new DkbError(`Invalid Evidence IR at ${source}: unsupported format or missing arrays`);
  }

  const evidenceIds = new Set(candidate.evidence.map((record) => record.evidenceId));

  for (const chunk of candidate.chunks) {
    if (!chunk || typeof chunk.chunkId !== 'string' || typeof chunk.evidenceId !== 'string' || !evidenceIds.has(chunk.evidenceId)) {
      throw new DkbError(`Invalid Evidence IR at ${source}: chunk references missing evidence`);
    }
    if (chunk.evidenceProfileDigest !== candidate.evidenceProfileDigest) {
      throw new DkbError(`Invalid Evidence IR at ${source}: chunk profile does not match document profile`);
    }
  }

  const actualDigest = stableHash({
    format: candidate.format,
    evidenceProfileDigest: candidate.evidenceProfileDigest,
    evidence: candidate.evidence,
    chunks: candidate.chunks,
  });

  if (candidate.evidenceDigest !== actualDigest) {
    throw new DkbError(`Invalid Evidence IR at ${source}: expected digest ${actualDigest}, got ${candidate.evidenceDigest}`);
  }

  return candidate as DkbEvidenceIr;
}

function stringMetadata(record: DkbEvidenceSourceRecord, key: string): string {
  const value = record.metadata[key];

  return typeof value === 'string' ? value : '';
}

function provenanceFor(metadata: Record<string, unknown>): Record<string, unknown> {
  const provenance = Object.fromEntries(Object.entries(metadata)
    .filter(([key]) => key.startsWith('dkb_') || key === 'docling')
    .sort(([left], [right]) => left.localeCompare(right)));
  if (typeof metadata.updatedAt === 'string') provenance.dkb_updated_at = metadata.updatedAt;
  if (typeof metadata.heading === 'string') provenance.dkb_heading = metadata.heading;
  return provenance;
}
