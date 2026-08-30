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
