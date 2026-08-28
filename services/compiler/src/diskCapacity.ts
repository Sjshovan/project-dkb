import fs from 'node:fs/promises';
import path from 'node:path';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbCorpusStatistics } from './buildStatistics.js';

const MEBIBYTE = 1024 ** 2;
const DEFAULT_RESERVE_BYTES = 512 * MEBIBYTE;
const MIN_WORKING_BYTES = 256 * MEBIBYTE;

export interface DkbDiskCapacityCheck {
  path: string;
  freeBytes: number;
  reserveBytes: number;
  estimatedWorkingBytes: number;
  requiredFreeBytes: number;
}

export function estimateIngestionWorkingBytes(sourceBytes: number): number {
  return Math.max(MIN_WORKING_BYTES, Math.ceil(sourceBytes * 12));
}

export function estimateRetrievalWorkingBytes(
  corpus: Pick<DkbCorpusStatistics, 'sourceBytes' | 'evidenceTextBytes' | 'evidenceRecords'>,
  dimensions: number,
): number {
  const rawVectorBytes = corpus.evidenceRecords * dimensions * Float32Array.BYTES_PER_ELEMENT;
  // Compilation temporarily holds JSON vectors, the FAISS segment/catalog, the
  // active artifact tree, and immutable Retrieval Build copies concurrently.
  const vectorWorkingBytes = rawVectorBytes * 16;
  const evidenceWorkingBytes = corpus.evidenceTextBytes * 6;
  const sourceWorkingBytes = corpus.sourceBytes * 2;

  return Math.max(MIN_WORKING_BYTES, Math.ceil(vectorWorkingBytes + evidenceWorkingBytes + sourceWorkingBytes));
}

export function evaluateDiskCapacity(input: {
  path: string;
  freeBytes: number;
  reserveBytes: number;
  estimatedWorkingBytes: number;
}): DkbDiskCapacityCheck {
  return {
    ...input,
    requiredFreeBytes: input.reserveBytes + input.estimatedWorkingBytes,
  };
}

export async function assertDiskCapacity(
  target: string,
  estimatedWorkingBytes: number,
  stage: string,
): Promise<DkbDiskCapacityCheck> {
  const existing = await nearestExistingPath(target);
  const stat = await fs.statfs(existing, { bigint: true });
  const freeBytes = safeNumber(stat.bavail * stat.bsize, 'available disk capacity');
  const reserveBytes = configuredReserveBytes();
  const result = evaluateDiskCapacity({
    path: existing,
    freeBytes,
    reserveBytes,
    estimatedWorkingBytes,
  });

  if (result.freeBytes < result.requiredFreeBytes) {
    throw new DkbError(
      `Insufficient disk space for ${stage}: ${formatBytes(result.freeBytes)} free; `
      + `${formatBytes(result.requiredFreeBytes)} required (${formatBytes(result.estimatedWorkingBytes)} estimated working space `
      + `plus ${formatBytes(result.reserveBytes)} safety reserve). Free disk space and retry.`,
    );
  }

  return result;
}

function configuredReserveBytes(): number {
  const configured = process.env.DKB_MIN_FREE_DISK_BYTES;
  if (configured === undefined || configured === '') return DEFAULT_RESERVE_BYTES;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DkbError('DKB_MIN_FREE_DISK_BYTES must be a non-negative integer');
  }
  return parsed;
}

async function nearestExistingPath(target: string): Promise<string> {
  let candidate = path.resolve(target);

  while (true) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) throw new DkbError(`Cannot resolve a filesystem for disk preflight at ${target}`);
      candidate = parent;
    }
  }
}

function safeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new DkbError(`${label} exceeds the supported numeric range`);
  return Number(value);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let amount = value;
  let unit = -1;
  do {
    amount /= 1024;
    unit += 1;
  } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`;
}
