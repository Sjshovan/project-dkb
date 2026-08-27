import path from 'node:path';
import { adapterFor } from '@dkb/library/adapters/index.js';
import { canWrite } from '@dkb/library/adapters/adapter.js';
import { loadDkb } from '@dkb/protocol/manifest.js';
import { evaluateDkbWriteIntent } from '@dkb/protocol/writeGate.js';
import { DkbError } from '@dkb/protocol/errors.js';
import { listQueuedWrites, updateQueuedWrite, writeQueueItem, defaultWriteQueueRoot } from './queue.js';
import { recordFromQueuedWrite } from './record.js';
import type { ProcessWriteQueueInput, ProcessWriteQueueResult, QueuedWrite } from './types.js';

export async function processWriteQueue(input: ProcessWriteQueueInput = {}): Promise<ProcessWriteQueueResult> {
  const queueRoot = path.resolve(input.queueRoot ?? defaultWriteQueueRoot());
  const candidates = (await listQueuedWrites(queueRoot, input.status ?? 'pending')).slice(0, input.limit ?? 100);
  const processed: QueuedWrite[] = [];

  for (const item of candidates) {
    processed.push(await processQueuedWrite(queueRoot, item));
  }

  return {
    queueRoot,
    processed,
  };
}

export async function processQueuedWrite(queueRoot: string, item: QueuedWrite): Promise<QueuedWrite> {
  if (item.status !== 'pending') {
    return item;
  }

  let dkb;

  try {
    dkb = await loadDkb(item.target.dkbRoot);
  } catch (error) {
    return updateQueuedWrite(queueRoot, item, 'failed', messageFor(error));
  }

  const gate = evaluateDkbWriteIntent(dkb, item.intent);

  if (gate.status === 'blocked') {
    return updateQueuedWrite(queueRoot, { ...item, gate }, 'blocked', gate.reason ?? 'blocked');
  }

  if (item.intent.operation !== 'append') {
    return updateQueuedWrite(queueRoot, { ...item, gate }, 'blocked', 'alpha_append_only');
  }

  const adapter = await adapterFor(dkb.manifest.adapter);

  if (!canWrite(adapter)) {
    return updateQueuedWrite(queueRoot, { ...item, gate }, 'failed', `Adapter ${dkb.manifest.adapter} does not support writes`);
  }

  try {
    const record = await adapter.appendRecord(dkb, recordFromQueuedWrite(item));
    const committed: QueuedWrite = {
      ...item,
      gate,
      record,
    };
    const updated = await updateQueuedWrite(queueRoot, committed, 'committed');

    await writeQueueItem(queueRoot, updated);

    return updated;
  } catch (error) {
    if (messageFor(error).includes('UNIQUE constraint failed') || messageFor(error).includes('EEXIST')) {
      return updateQueuedWrite(queueRoot, { ...item, gate }, 'blocked', 'duplicate_record_id');
    }

    return updateQueuedWrite(queueRoot, { ...item, gate }, 'failed', messageFor(error));
  }
}

function messageFor(error: unknown): string {
  if (error instanceof DkbError || error instanceof Error) {
    return error.message;
  }

  return String(error);
}
