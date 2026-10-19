import { StringDecoder } from 'node:string_decoder';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { parseDkbCommandEvent, type DkbCommandEvent } from '@sjshovan/dkb-protocol/command-events.js';
import type { DkbProgressReporter } from '@sjshovan/dkb-protocol/progress.js';
import { runDockerLibraryOwner, type DockerLibraryOwner } from './libraryOwner.js';
import { LIBRARY_OWNER_FORMAT, LIBRARY_OWNER_ROOT, type LibraryOwnerCommand } from './libraryOwnerContract.js';
import { withOwnerCancellation } from './libraryOwnerCancellation.js';

/** Reuse the CLI event protocol, but let the host emit its own single final result. */
export function ownerResultReader(progress?: DkbProgressReporter, libraryName?: string) {
  const decoder = new StringDecoder('utf8');
  let buffer = '', sequence = -1, started = false, hasResult = false;
  let value: unknown, failure: DkbError | undefined;
  let completion: Extract<DkbCommandEvent, { event: 'completion' }> | undefined;
  const stages = new Map<string, 'start' | 'finish'>();
  const invalid = () => new DkbError('Library owner returned invalid or incomplete CLI events. Check Library status before retrying.', 'library_owner_invalid_output');
  const line = (text: string) => {
    const event = parseDkbCommandEvent(text);
    if (!event || event.sequence !== sequence + 1 || completion) throw invalid();
    sequence = event.sequence;
    if (event.event === 'start') { if (started) throw invalid(); started = true; }
    else if (event.event === 'result') {
      if (!started || hasResult || failure) throw invalid();
      hasResult = true; value = event.value;
    } else if (event.event === 'failure') {
      failure = new DkbError(event.error.message, event.error.code);
    } else if (event.event === 'cancellation') {
      failure = new DkbError(event.reason, 'library_owner_cancelled');
    } else if (event.event === 'completion') { completion = event; }
    else if (event.event === 'stage') { stages.set(event.phase, event.status); }
    else if (event.event === 'progress') {
      progress?.({ event: 'progress', phase: event.phase, label: event.label,
        status: stages.get(event.phase) ?? 'update', value: event.value, total: event.total, unit: event.unit });
      stages.delete(event.phase);
    }
    // Warning fields are retained in the result and emitted by the host presenter.
  };
  const accept = (text: string) => {
    buffer += text;
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
  };
  return {
    output(channel: 'stdout' | 'stderr', bytes: Buffer) { if (channel === 'stdout') accept(decoder.write(bytes)); },
    finish(code: number): unknown {
      accept(decoder.end());
      if (buffer.trim()) line(buffer);
      if (failure) {
        if (libraryName && failure.code === 'library_recovery_required') {
          const ownerCommand = `dkb library recover --library "${LIBRARY_OWNER_ROOT}"`;
          const hostCommand = `dkb library recover --library ${JSON.stringify(libraryName)}`;
          const message = failure.message.includes(ownerCommand)
            ? failure.message.replaceAll(ownerCommand, hostCommand)
            : `${failure.message} Run: ${hostCommand}`;
          throw new DkbError(message, failure.code);
        }
        throw failure;
      }
      if (!started || !hasResult || code !== 0 || completion?.status !== 'succeeded') throw invalid();
      return value;
    },
  };
}

export async function readDockerLibraryCommand<T>(owner: DockerLibraryOwner, command: LibraryOwnerCommand,
  input: Record<string, unknown> = {}, options: { progress?: DkbProgressReporter; signal?: AbortSignal; libraryName?: string } = {}): Promise<T> {
  const reader = ownerResultReader(options.progress, options.libraryName);
  const result = await withOwnerCancellation(options.signal, signal => runDockerLibraryOwner(owner,
    { format: LIBRARY_OWNER_FORMAT, command, input, output: 'json-stream' }, { signal, onOutput: reader.output }));
  return reader.finish(result.code) as T;
}
