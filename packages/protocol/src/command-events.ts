export const DKB_COMMAND_EVENT_FORMAT = 'dkb.command-event.v1' as const;

export type DkbCommandEvent =
  | DkbCommandStartEvent
  | DkbCommandStageEvent
  | DkbCommandProgressEvent
  | DkbCommandWarningEvent
  | DkbCommandResultEvent
  | DkbCommandFailureEvent
  | DkbCommandCancellationEvent
  | DkbCommandCompletionEvent;

interface DkbCommandEventBase {
  format: typeof DKB_COMMAND_EVENT_FORMAT;
  sequence: number;
  timestamp: string;
  event: string;
}

export interface DkbCommandStartEvent extends DkbCommandEventBase {
  event: 'start';
  label: string;
}

export interface DkbCommandStageEvent extends DkbCommandEventBase {
  event: 'stage';
  phase: string;
  label: string;
  status: 'start' | 'finish';
}

export interface DkbCommandProgressEvent extends DkbCommandEventBase {
  event: 'progress';
  phase: string;
  label: string;
  value: number;
  total: number;
  unit: 'bytes' | 'files' | 'chunks' | 'steps';
}

export interface DkbCommandWarningEvent extends DkbCommandEventBase {
  event: 'warning';
  message: string;
}

export interface DkbCommandResultEvent extends DkbCommandEventBase {
  event: 'result';
  value: unknown;
}

export interface DkbCommandFailureEvent extends DkbCommandEventBase {
  event: 'failure';
  error: { code: string; message: string };
}

export interface DkbCommandCancellationEvent extends DkbCommandEventBase {
  event: 'cancellation';
  reason: string;
}

export interface DkbCommandCompletionEvent extends DkbCommandEventBase {
  event: 'completion';
  status: 'succeeded' | 'failed' | 'cancelled';
}

/** Shared wire validation for CLI consumers; invalid output is never a result. */
export function parseDkbCommandEvent(line: string): DkbCommandEvent | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (!value || Array.isArray(value) || value.format !== DKB_COMMAND_EVENT_FORMAT
      || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0
      || typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))) return null;
    const text = (key: string) => typeof value[key] === 'string';
    switch (value.event) {
      case 'start': if (!text('label')) return null; break;
      case 'stage':
        if (!text('phase') || !text('label') || !['start', 'finish'].includes(String(value.status))) return null;
        break;
      case 'progress':
        if (!text('phase') || !text('label') || typeof value.value !== 'number' || !Number.isFinite(value.value) || value.value < 0
          || typeof value.total !== 'number' || !Number.isFinite(value.total) || value.total < 0
          || !['bytes', 'files', 'chunks', 'steps'].includes(String(value.unit))) return null;
        break;
      case 'warning': if (!text('message')) return null; break;
      case 'result': if (!Object.hasOwn(value, 'value')) return null; break;
      case 'failure': {
        const error = value.error as Record<string, unknown> | null;
        if (!error || Array.isArray(error) || typeof error.message !== 'string' || typeof error.code !== 'string') return null;
        break;
      }
      case 'cancellation': if (!text('reason')) return null; break;
      case 'completion': if (!['succeeded', 'failed', 'cancelled'].includes(String(value.status))) return null; break;
      default: return null;
    }
    return value as unknown as DkbCommandEvent;
  } catch { return null; }
}
