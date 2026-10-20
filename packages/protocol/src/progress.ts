export type DkbProgressUnit = 'bytes' | 'files' | 'chunks' | 'steps';

export interface DkbProgressEvent {
  event: 'progress';
  phase: string;
  status: 'start' | 'update' | 'finish';
  label: string;
  value: number;
  total: number;
  unit: DkbProgressUnit;
}

export type DkbProgressReporter = (event: DkbProgressEvent) => void;

export function progressStart(input: Omit<DkbProgressEvent, 'event' | 'status' | 'value'>): DkbProgressEvent {
  return {
    event: 'progress',
    status: 'start',
    value: 0,
    ...input,
  };
}

export function progressUpdate(input: Omit<DkbProgressEvent, 'event' | 'status'>): DkbProgressEvent {
  return {
    event: 'progress',
    status: 'update',
    ...input,
  };
}

export function progressFinish(input: Omit<DkbProgressEvent, 'event' | 'status' | 'value'>): DkbProgressEvent {
  return {
    event: 'progress',
    status: 'finish',
    value: input.total,
    ...input,
  };
}
