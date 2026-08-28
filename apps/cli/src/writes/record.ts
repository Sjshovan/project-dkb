import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import type { DkbWriteIntent } from '@sjshovan/dkb-protocol/writeGate.js';
import type { DkbRecord } from '@sjshovan/dkb-protocol/types.js';
import type { QueuedWrite } from './types.js';

export function recordFromQueuedWrite(item: QueuedWrite): DkbRecord {
  const payload = payloadObject(item.intent.payload);
  const claim = stringValue(payload.claim) ?? stringValue(payload.content) ?? JSON.stringify(item.intent.payload ?? {});
  const title = stringValue(payload.title) ?? titleFor(item.intent);
  const recordId = recordIdFor(item);

  return {
    id: recordId,
    title,
    content: claim,
    source: `write:${item.writeId}`,
    topics: [item.intent.subject, item.intent.lane].filter((value): value is string => Boolean(value)),
    entities: [item.target.dkbId, item.intent.intent].filter((value): value is string => Boolean(value)),
    updatedAt: new Date().toISOString(),
    aliases: [
      item.intent.recordType ?? 'knowledge.record.v1',
      item.writeId,
      ...item.evidenceRefs,
      item.payloadHash,
      stringValue(payload.supersedes),
    ].filter((value): value is string => Boolean(value)),
  };
}

function recordIdFor(item: QueuedWrite): string {
  const prefix = item.intent.lane ? `memory-${item.intent.lane}` : 'write-record';

  return `${prefix}-${stableHash({
    writeId: item.writeId,
    target: item.target.dkbId,
    payloadHash: item.payloadHash,
  }).slice(7, 19)}`;
}

function titleFor(intent: DkbWriteIntent): string {
  const parts = [intent.lane, intent.subject, intent.intent].filter(Boolean);

  return parts.length > 0 ? `Memory ${parts.join(' ')}` : 'Queued write record';
}

function payloadObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
