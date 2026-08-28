import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { loadDkb } from '@sjshovan/dkb-protocol/manifest.js';
import { DKB_WRITE_QUEUE_DIR } from '@sjshovan/dkb-protocol/paths.js';
import { evaluateDkbWriteIntent } from '@sjshovan/dkb-protocol/writeGate.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { EnqueueWriteInput, EnqueueWriteResult, QueuedWrite, QueuedWriteStatus } from './types.js';

export function defaultWriteQueueRoot(baseRoot = process.cwd()): string {
  return path.resolve(process.env.DKB_QUEUE_ROOT || process.env.DKB_WRITE_QUEUE_ROOT || path.join(baseRoot, DKB_WRITE_QUEUE_DIR));
}

export async function enqueueWrite(input: EnqueueWriteInput): Promise<EnqueueWriteResult> {
  const queueRoot = path.resolve(input.queueRoot ?? defaultWriteQueueRoot(input.target.dkbRoot));
  const dkb = await loadDkb(input.target.dkbRoot);
  const gate = input.gate ?? evaluateDkbWriteIntent(dkb, input.intent);
  const now = new Date().toISOString();
  const payloadHash = stableHash(input.intent.payload ?? null);
  const dedupe = dkb.manifest.write?.dedupe ?? 'required';
  const writeId = writeIdFor(dedupe, gate.writeId, input.target, input.intent, payloadHash);
  const existing = dedupe === 'none'
    ? null
    : await findDuplicate(queueRoot, input.target.dkbId, input.intent.recordType ?? null, payloadHash, input.intent.evidenceRefs ?? [], input.intent.lane ?? null);

  if (existing) {
    return {
      item: existing,
      duplicateOf: existing.writeId,
      persisted: false,
    };
  }

  const status = input.status ?? defaultStatusFor(gate, dkb.manifest.write?.confirmationRequired ?? false);
  const item: QueuedWrite = {
    writeId,
    status,
    target: input.target,
    intent: input.intent,
    payloadHash,
    evidenceRefs: input.intent.evidenceRefs ?? [],
    gate,
    selection: input.selection,
    failureReason: gate.status === 'blocked' ? gate.reason ?? 'blocked' : undefined,
    history: [
      {
        status,
        at: now,
        reason: gate.status === 'blocked' ? gate.reason ?? 'blocked' : undefined,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };

  await writeQueueItem(queueRoot, item);

  return {
    item,
    duplicateOf: null,
    persisted: true,
  };
}

function writeIdFor(
  dedupe: 'required' | 'optional' | 'none',
  gateWriteId: string | undefined,
  target: EnqueueWriteInput['target'],
  intent: EnqueueWriteInput['intent'],
  payloadHash: string,
): string {
  if (dedupe !== 'none' && gateWriteId) {
    return gateWriteId;
  }

  return `write_${stableHash({
    type: 'queued-write',
    target,
    intent,
    payloadHash,
    nonce: dedupe === 'none' ? randomUUID() : null,
  }).slice(7, 19)}`;
}

function defaultStatusFor(gate: EnqueueWriteInput['gate'], confirmationRequired: boolean): QueuedWriteStatus {
  if (gate?.status === 'blocked') {
    return 'blocked';
  }

  return confirmationRequired ? 'needs_review' : 'pending';
}

export async function listQueuedWrites(queueRoot = defaultWriteQueueRoot(), status?: QueuedWriteStatus): Promise<QueuedWrite[]> {
  const root = path.resolve(queueRoot);
  const directory = itemsDirectory(root);
  let entries: string[];

  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }

    throw error;
  }

  const items = await Promise.all(
    entries
      .filter((entry) => entry.endsWith('.json'))
      .sort((a, b) => a.localeCompare(b))
      .map((entry) => readQueueItem(path.join(directory, entry))),
  );

  return status ? items.filter((item) => item.status === status) : items;
}

export async function loadQueuedWrite(writeId: string, queueRoot = defaultWriteQueueRoot()): Promise<QueuedWrite> {
  return readQueueItem(queueFile(path.resolve(queueRoot), writeId));
}

export async function updateQueuedWrite(queueRoot: string, item: QueuedWrite, status: QueuedWriteStatus, reason?: string): Promise<QueuedWrite> {
  const now = new Date().toISOString();
  const updated: QueuedWrite = {
    ...item,
    status,
    failureReason: reason ?? item.failureReason,
    history: [
      ...item.history,
      {
        status,
        at: now,
        reason,
      },
    ],
    updatedAt: now,
  };

  await writeQueueItem(queueRoot, updated);

  return updated;
}

export async function writeQueueItem(queueRoot: string, item: QueuedWrite): Promise<void> {
  const root = path.resolve(queueRoot);

  await fs.mkdir(itemsDirectory(root), { recursive: true });
  await fs.writeFile(queueFile(root, item.writeId), `${JSON.stringify(item, null, 2)}\n`, 'utf8');
}

async function findDuplicate(
  queueRoot: string,
  dkbId: string,
  recordType: string | null,
  payloadHash: string,
  evidenceRefs: string[],
  lane: string | null,
): Promise<QueuedWrite | null> {
  const items = await listQueuedWrites(queueRoot);

  return items.find((item) => {
    if (item.status === 'failed' || item.status === 'superseded') {
      return false;
    }

    const samePayload = item.target.dkbId === dkbId
      && (item.intent.recordType ?? null) === recordType
      && item.payloadHash === payloadHash;
    const sameEvidence = item.target.dkbId === dkbId
      && (item.intent.lane ?? null) === lane
      && arraysEqual(item.evidenceRefs, evidenceRefs);

    return samePayload || sameEvidence;
  }) ?? null;
}

async function readQueueItem(source: string): Promise<QueuedWrite> {
  try {
    return JSON.parse(await fs.readFile(source, 'utf8')) as QueuedWrite;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    throw new DkbError(`Unable to read queued write at ${source}: ${reason}`);
  }
}

function queueFile(queueRoot: string, writeId: string): string {
  return path.join(itemsDirectory(queueRoot), `${safeFileStem(writeId)}.json`);
}

function itemsDirectory(queueRoot: string): string {
  return path.join(queueRoot, 'items');
}

function arraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function safeFileStem(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, '-');
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
