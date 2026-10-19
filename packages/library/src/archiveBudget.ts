import fs from 'node:fs/promises';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

/** Operator limits, never values supplied by an archive or its unsigned metadata. */
export interface DkbArchiveLimits {
  maxExpandedBytes?: number;
  maxEntries?: number;
}

export function validateArchiveLimits(limits: DkbArchiveLimits = {}): Required<DkbArchiveLimits> {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)
    || Object.keys(limits).some(key => !['maxExpandedBytes', 'maxEntries'].includes(key))) {
    throw new DkbError('Archive limits must contain only maxExpandedBytes and maxEntries.', 'invalid_archive_limits');
  }
  const result = {
    maxExpandedBytes: limits.maxExpandedBytes === undefined ? Number.MAX_SAFE_INTEGER : limits.maxExpandedBytes,
    maxEntries: limits.maxEntries === undefined ? 100_000 : limits.maxEntries,
  };
  for (const value of Object.values(result)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new DkbError('Archive limits must be positive safe integers.', 'invalid_archive_limits');
    }
  }
  return result;
}

/** One header admission pass; payloads continue streaming through node-tar. */
export async function archiveBudget(target: string, limits: Required<DkbArchiveLimits>): Promise<(entryPath: string, size: number) => void> {
  let block: bigint;
  let available: bigint;
  try {
    const capacity = await fs.statfs(target, { bigint: true });
    block = capacity.bsize;
    available = capacity.bavail * block;
    if (block <= 0n || available < 0n) throw new Error('Invalid filesystem capacity');
  } catch {
    throw new DkbError('Cannot verify archive destination capacity. Check storage availability and retry; no archive payload was extracted.', 'archive_capacity_unavailable');
  }
  // Leave half the observed free space for promotion, rollback and other work.
  // This is a per-extraction admission budget, not a cross-process disk quota.
  const workingBudget = available / 2n;
  let expanded = 0n, allocated = 0n, entries = 0;
  return (entryPath, size) => {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new DkbError('Archive contains an invalid expanded file size.', 'invalid_archive_entry');
    }
    if (++entries > limits.maxEntries) {
      throw new DkbError(`Archive exceeds the ${limits.maxEntries} entry limit. Split the package or set a reviewed operator limit and retry.`, 'archive_entry_limit');
    }
    expanded += BigInt(size);
    if (expanded > BigInt(limits.maxExpandedBytes)) {
      throw new DkbError(`Archive exceeds the ${limits.maxExpandedBytes} expanded-byte limit. Split the package or set a reviewed operator limit and retry.`, 'archive_size_limit');
    }
    // Charge file blocks and a conservative block per path component, including
    // implied directories. Duplicate entries never refund the working budget.
    const components = Math.max(1, entryPath.replace(/\\/gu, '/').split('/').filter(part => part && part !== '.').length);
    allocated += ((BigInt(size) + block - 1n) / block + BigInt(components)) * block;
    if (allocated > workingBudget) {
      throw new DkbError('Archive expansion exceeds half the destination free space. Free space or choose a larger destination and retry.', 'archive_capacity_exceeded');
    }
  };
}
