import { resolveDkbCapabilities, type DkbCapabilities } from './capabilities.js';
import { stableHash } from '../contracts/hash.js';
import type { DkbWriteOperation, LoadedDkb } from './types.js';

export type DkbWriteGateStatus = 'accepted' | 'queued' | 'blocked';
export type DkbWriteBlockReason =
  | 'read_only_dkb'
  | 'capability_disabled'
  | 'unavailable_dkb'
  | 'alpha_append_only'
  | 'operation_not_supported'
  | 'lane_not_accepted'
  | 'subject_not_accepted'
  | 'intent_not_accepted'
  | 'record_type_not_accepted'
  | 'missing_evidence';

export interface DkbWriteIntent {
  operation: DkbWriteOperation;
  lane?: string;
  subject?: string;
  intent?: string;
  recordType?: string;
  payload?: unknown;
  evidenceRefs?: string[];
  targetHint?: {
    registryId?: string;
    collectionId?: string | null;
    dkbId?: string;
    regionId?: string;
    reason?: string;
  };
}

export interface DkbWriteGateResult {
  target: {
    dkbId: string;
    root: string;
  };
  operation: DkbWriteOperation;
  status: DkbWriteGateStatus;
  reason: DkbWriteBlockReason | null;
  capabilities: DkbCapabilities;
}

export interface DkbWriteIntentResult extends DkbWriteGateResult {
  writeId: string;
  intent: DkbWriteIntent;
  acceptedBy: {
    operations: DkbWriteOperation[];
    lanes: string[];
    subjects: string[];
    intents: string[];
    recordTypes: string[];
  };
  checks: Array<{
    name: string;
    ok: boolean;
    detail: string;
  }>;
}

export function evaluateDkbWrite(dkb: LoadedDkb, operation: DkbWriteOperation): DkbWriteGateResult {
  const capabilities = resolveDkbCapabilities(dkb.manifest);
  const accessOperation = accessOperationFor(operation);
  const base = {
    target: {
      dkbId: dkb.manifest.id,
      root: dkb.root,
    },
    operation,
    capabilities,
  };

  if (capabilities.state.availability !== 'ready') {
    return {
      ...base,
      status: 'blocked',
      reason: 'unavailable_dkb',
    };
  }

  if (operation !== 'append') {
    return {
      ...base,
      status: 'blocked',
      reason: 'alpha_append_only',
    };
  }

  if (capabilities.writePolicy.mode === 'read_only') {
    return {
      ...base,
      status: 'blocked',
      reason: 'read_only_dkb',
    };
  }

  if (!capabilities.access[accessOperation]) {
    return {
      ...base,
      status: 'blocked',
      reason: 'capability_disabled',
    };
  }

  if (!(dkb.manifest.write?.operations ?? []).includes(operation)) {
    return {
      ...base,
      status: 'blocked',
      reason: 'operation_not_supported',
    };
  }

  if (capabilities.writePolicy.queueRequired) {
    return {
      ...base,
      status: 'queued',
      reason: null,
    };
  }

  return {
    ...base,
    status: 'accepted',
    reason: null,
  };
}

export function evaluateDkbWriteIntent(dkb: LoadedDkb, intent: DkbWriteIntent): DkbWriteIntentResult {
  const gate = evaluateDkbWrite(dkb, intent.operation);
  const acceptedBy = acceptedByFor(dkb);
  const checks: DkbWriteIntentResult['checks'] = [
    {
      name: 'capability',
      ok: gate.status !== 'blocked',
      detail: gate.reason ?? gate.status,
    },
  ];
  const blocked = (reason: DkbWriteBlockReason, name: string, detail: string): DkbWriteIntentResult => {
    checks.push({ name, ok: false, detail });

    return {
      ...gate,
      status: 'blocked',
      reason,
      operation: intent.operation,
      writeId: writeIdFor(dkb, intent),
      intent,
      acceptedBy,
      checks,
    };
  };

  if (gate.status === 'blocked') {
    return {
      ...gate,
      operation: intent.operation,
      writeId: writeIdFor(dkb, intent),
      intent,
      acceptedBy,
      checks,
    };
  }

  if (!acceptedBy.operations.includes(intent.operation)) {
    return blocked('operation_not_supported', 'operation', `${intent.operation} is not declared by write.operations`);
  }

  if (intent.lane && acceptedBy.lanes.length > 0 && !acceptedBy.lanes.includes(intent.lane)) {
    return blocked('lane_not_accepted', 'lane', `${intent.lane} is not declared by accepts.lanes`);
  }

  if (intent.subject && acceptedBy.subjects.length > 0 && !acceptedBy.subjects.includes(intent.subject)) {
    return blocked('subject_not_accepted', 'subject', `${intent.subject} is not declared by accepts.subjects`);
  }

  if (intent.intent && acceptedBy.intents.length > 0 && !acceptedBy.intents.includes(intent.intent)) {
    return blocked('intent_not_accepted', 'intent', `${intent.intent} is not declared by accepts.intents`);
  }

  if (intent.recordType && acceptedBy.recordTypes.length > 0 && !acceptedBy.recordTypes.includes(intent.recordType)) {
    return blocked('record_type_not_accepted', 'recordType', `${intent.recordType} is not declared by accepts.recordTypes`);
  }

  if ((intent.operation === 'append' || intent.operation === 'write') && (!intent.evidenceRefs || intent.evidenceRefs.length === 0)) {
    return blocked('missing_evidence', 'evidenceRefs', 'write intents must include at least one evidence reference');
  }

  checks.push(
    { name: 'operation', ok: true, detail: intent.operation },
    { name: 'accepts', ok: true, detail: 'intent matches declared accepts rules' },
    { name: 'evidenceRefs', ok: true, detail: `${intent.evidenceRefs?.length ?? 0} evidence refs` },
  );

  return {
    ...gate,
    operation: intent.operation,
    writeId: writeIdFor(dkb, intent),
    intent,
    acceptedBy,
    checks,
  };
}

function accessOperationFor(operation: DkbWriteOperation): 'write' | 'append' | 'delete' {
  if (operation === 'append') {
    return 'append';
  }

  if (operation === 'delete') {
    return 'delete';
  }

  return 'write';
}

function acceptedByFor(dkb: LoadedDkb): DkbWriteIntentResult['acceptedBy'] {
  return {
    operations: (dkb.manifest.write?.operations ?? []).filter((operation) => operation === 'append'),
    lanes: dkb.manifest.write?.accepts?.lanes ?? [],
    subjects: dkb.manifest.write?.accepts?.subjects ?? [],
    intents: dkb.manifest.write?.accepts?.intents ?? [],
    recordTypes: dkb.manifest.write?.accepts?.recordTypes ?? [],
  };
}

function writeIdFor(dkb: LoadedDkb, intent: DkbWriteIntent): string {
  return `write_${stableHash({
    dkbId: dkb.manifest.id,
    operation: intent.operation,
    lane: intent.lane ?? null,
    subject: intent.subject ?? null,
    recordType: intent.recordType ?? null,
    evidenceRefs: intent.evidenceRefs ?? [],
    payload: intent.payload ?? null,
  }).slice(7, 19)}`;
}
