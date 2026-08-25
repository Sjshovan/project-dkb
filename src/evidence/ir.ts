import fs from 'node:fs/promises';
import path from 'node:path';
import { stableHash } from '../contracts/hash.js';
import { DkbError } from '../protocol/errors.js';
import { DKB_ARTIFACTS_DIR, resolveFrom } from '../protocol/paths.js';
import type { LlamaIndexCompilerRecord, LlamaIndexCompilerResult } from '../compiler/llamaindex.js';
import type { DkbRetrievalProfileLock } from '../profiles/retrievalProfile.js';

export const DKB_EVIDENCE_IR_PATH = `${DKB_ARTIFACTS_DIR}/evidence.ir.json`;
export const DKB_EVIDENCE_IR_FORMAT = 'dkb.evidence.ir.v1';

export interface DkbEvidenceIrRecord {
  evidenceId: string;
  sourceId: string;
  packageId: string;
  packageVersion: string;
  storeId: string;
  sourceType: LlamaIndexCompilerRecord['type'];
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
  profileDigest: string;
  ordinal: number;
  start: number;
  end: number;
}

export interface DkbEvidenceIr {
  format: typeof DKB_EVIDENCE_IR_FORMAT;
  profileDigest: string;
  evidence: DkbEvidenceIrRecord[];
  chunks: DkbEvidenceIrChunk[];
  generatedAt: string;
}

export interface DkbEvidenceIdentity {
  sourceId: string;
  evidenceId: string;
  packageId: string;
  packageVersion: string;
  sourceHash: string;
}

export function evidenceIdentityForRecord(record: LlamaIndexCompilerRecord): DkbEvidenceIdentity {
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

export function buildEvidenceIr(results: LlamaIndexCompilerResult[], profile: DkbRetrievalProfileLock, generatedAt = new Date().toISOString()): DkbEvidenceIr {
  const evidence = new Map<string, DkbEvidenceIrRecord>();
  const chunks: DkbEvidenceIrChunk[] = [];

  for (const result of results) {
    for (const record of result.records) {
      const { packageId, packageVersion, sourceHash, sourceId, evidenceId } = evidenceIdentityForRecord(record);

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
        provenance: provenanceFor(record.metadata),
      });
      chunks.push({
        chunkId: record.id,
        evidenceId,
        profileDigest: profile.profileDigest,
        ordinal: record.chunkOrdinal,
        start: record.chunkStart,
        end: record.chunkEnd,
      });
    }
  }

  return {
    format: DKB_EVIDENCE_IR_FORMAT,
    profileDigest: profile.profileDigest,
    evidence: [...evidence.values()].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)),
    chunks: chunks.sort((left, right) => left.chunkId.localeCompare(right.chunkId)),
    generatedAt,
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

  if (candidate.format !== DKB_EVIDENCE_IR_FORMAT || typeof candidate.profileDigest !== 'string' || !Array.isArray(candidate.evidence) || !Array.isArray(candidate.chunks)) {
    throw new DkbError(`Invalid Evidence IR at ${source}: unsupported format or missing arrays`);
  }

  const evidenceIds = new Set(candidate.evidence.map((record) => record.evidenceId));

  for (const chunk of candidate.chunks) {
    if (!chunk || typeof chunk.chunkId !== 'string' || typeof chunk.evidenceId !== 'string' || !evidenceIds.has(chunk.evidenceId)) {
      throw new DkbError(`Invalid Evidence IR at ${source}: chunk references missing evidence`);
    }
    if (chunk.profileDigest !== candidate.profileDigest) {
      throw new DkbError(`Invalid Evidence IR at ${source}: chunk profile does not match document profile`);
    }
  }

  return candidate as DkbEvidenceIr;
}

function stringMetadata(record: LlamaIndexCompilerRecord, key: string): string {
  const value = record.metadata[key];

  return typeof value === 'string' ? value : '';
}

function provenanceFor(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata)
    .filter(([key]) => key.startsWith('dkb_') || key === 'docling')
    .sort(([left], [right]) => left.localeCompare(right)));
}
