import { DKB_COMMAND_EVENT_FORMAT, type DkbCommandEvent } from '@sjshovan/dkb-protocol/command-events.js';
import type { DkbProgressEvent } from '@sjshovan/dkb-protocol/progress.js';

type DkbCommandEventPayload<T = DkbCommandEvent> = T extends DkbCommandEvent
  ? Omit<T, 'format' | 'sequence' | 'timestamp'>
  : never;

export interface CliEventWriter {
  readonly completed: boolean;
  start(label: string): void;
  progress(event: DkbProgressEvent): void;
  result(value: unknown): void;
  failure(code: string, message: string): void;
  cancel(reason: string): void;
  complete(status: 'succeeded' | 'failed' | 'cancelled'): void;
}

export function createCliEventWriter(output: NodeJS.WritableStream = process.stdout): CliEventWriter {
  let sequence = 0;
  let completed = false;
  const write = (event: DkbCommandEventPayload): void => {
    output.write(`${JSON.stringify({
      format: DKB_COMMAND_EVENT_FORMAT,
      sequence: sequence++,
      timestamp: new Date().toISOString(),
      ...event,
    })}\n`);
  };

  return {
    get completed() { return completed; },
    start(label) { write({ event: 'start', label }); },
    progress(event) {
      if (event.status === 'start' || event.status === 'finish') {
        write({ event: 'stage', phase: event.phase, label: event.label, status: event.status });
      }
      write({
        event: 'progress',
        phase: event.phase,
        label: event.label,
        value: event.value,
        total: event.total,
        unit: event.unit,
      });
    },
    result(value) {
      for (const message of warningsFrom(value)) write({ event: 'warning', message });
      write({ event: 'result', value });
    },
    failure(code, message) { write({ event: 'failure', error: { code, message } }); },
    cancel(reason) { write({ event: 'cancellation', reason }); },
    complete(status) {
      if (completed) return;
      completed = true;
      write({ event: 'completion', status });
    },
  };
}

function warningsFrom(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const warnings = [
    ...(typeof record.warning === 'string' ? [record.warning] : []),
    ...(Array.isArray(record.warnings) ? record.warnings.filter((item): item is string => typeof item === 'string') : []),
  ];
  return [...new Set(warnings)];
}
