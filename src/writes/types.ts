import type { DkbWriteIntent, DkbWriteIntentResult } from '../protocol/writeGate.js';
import type { DkbRecord } from '../protocol/types.js';

export type QueuedWriteStatus = 'pending' | 'needs_review' | 'blocked' | 'committed' | 'failed' | 'superseded';

export interface WriteTarget {
  registryId?: string;
  collectionId?: string | null;
  dkbId: string;
  dkbRoot: string;
}

export interface WriteStatusEvent {
  status: QueuedWriteStatus;
  at: string;
  reason?: string;
}

export interface QueuedWrite {
  writeId: string;
  status: QueuedWriteStatus;
  target: WriteTarget;
  intent: DkbWriteIntent;
  payloadHash: string;
  evidenceRefs: string[];
  gate: DkbWriteIntentResult;
  selection?: unknown;
  record?: DkbRecord;
  failureReason?: string;
  history: WriteStatusEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueWriteInput {
  queueRoot?: string;
  target: WriteTarget;
  intent: DkbWriteIntent;
  gate?: DkbWriteIntentResult;
  selection?: unknown;
  status?: QueuedWriteStatus;
}

export interface EnqueueWriteResult {
  item: QueuedWrite;
  duplicateOf: string | null;
  persisted: boolean;
}

export interface ProcessWriteQueueInput {
  queueRoot?: string;
  status?: QueuedWriteStatus;
  limit?: number;
}

export interface ProcessWriteQueueResult {
  queueRoot: string;
  processed: QueuedWrite[];
}
