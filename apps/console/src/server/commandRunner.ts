import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { parseDkbCommandEvent as parseEvent, type DkbCommandEvent } from '@sjshovan/dkb-protocol/command-events.js';
import { consoleCommand, parseConsoleCommandInput, type ConsoleCommandId } from './commandCatalog.js';
import type { ConsoleActivityStore } from './activity.js';

export interface ConsoleOperation {
  id: string;
  commandId: ConsoleCommandId;
  resourceKey: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  events: DkbCommandEvent[];
  result?: unknown;
}

type OperationListener = (event: DkbCommandEvent) => void;

export const CONSOLE_OPERATION_RETENTION = Object.freeze({
  completedLimit: 100,
  completedTtlMs: 30 * 60_000,
  completedBytes: 32 * 1024 * 1024,
  replayEvents: 256,
  replayBytes: 8 * 1024 * 1024,
  activeLimit: 32,
});
export const CONSOLE_OUTPUT_LINE_BYTES = 2_000_000;
export const CONSOLE_RESULT_EXPIRED = 'Result expired or unavailable; check Activity/current resource before retrying.';

type Retention = { [Key in keyof typeof CONSOLE_OPERATION_RETENTION]: number };
type SyntheticEvent =
  | { event: 'failure'; error: { code: string; message: string } }
  | { event: 'cancellation'; reason: string }
  | { event: 'completion'; status: 'succeeded' | 'failed' | 'cancelled' };
interface RetainedOperation {
  operation: ConsoleOperation;
  eventBytes: number;
  lastSequence: number;
  latest: Partial<Record<'result' | 'failure' | 'completion', DkbCommandEvent>>;
  trimmed?: Extract<DkbCommandEvent, { event: 'warning' }>;
  completedAt?: number;
  completedBytes?: number;
}

export class ConsoleRunnerBusyError extends Error {}

export class ConsoleCommandRunner {
  readonly #cliEntrypoint: string;
  readonly #cwd: string;
  readonly #activity: ConsoleActivityStore;
  readonly #operations = new Map<string, RetainedOperation>();
  readonly #listeners = new Map<string, Set<OperationListener>>();
  readonly #mutationTails = new Map<string, Promise<void>>();
  readonly #children = new Map<string, ChildProcess>();
  readonly #cooperativeChildren = new WeakSet<ChildProcess>();
  readonly #terminationTimers = new WeakMap<ChildProcess, NodeJS.Timeout>();
  readonly #tasks = new Set<Promise<void>>();
  readonly #retention: Retention;
  readonly #now: () => number;
  readonly #sweep: NodeJS.Timeout;
  #closing = false;

  constructor(input: { cliEntrypoint: string; cwd: string; activity: ConsoleActivityStore; retention?: Partial<Retention>; now?: () => number }) {
    this.#cliEntrypoint = input.cliEntrypoint;
    this.#cwd = input.cwd;
    this.#activity = input.activity;
    this.#retention = { ...CONSOLE_OPERATION_RETENTION, ...input.retention };
    for (const [key, value] of Object.entries(this.#retention)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid Console retention limit: ${key}.`);
    }
    // Three complete terminal records plus the replay warning must always fit.
    if (this.#retention.replayEvents < 4 || this.#retention.replayBytes < 3 * CONSOLE_OUTPUT_LINE_BYTES + 1024) {
      throw new Error('Console replay limits must preserve complete result, failure, and completion records.');
    }
    this.#now = input.now ?? Date.now;
    this.#sweep = setInterval(() => this.#prune(), Math.min(60_000, this.#retention.completedTtlMs));
    this.#sweep.unref();
  }

  start(commandId: string, rawInput: unknown): ConsoleOperation {
    const definition = consoleCommand(commandId);
    const input = parseConsoleCommandInput(definition, rawInput);
    this.#prune();
    if (this.#closing || [...this.#operations.values()].filter((entry) => entry.completedAt === undefined).length >= this.#retention.activeLimit) {
      throw new ConsoleRunnerBusyError('Console is busy or closing. No command was started; check Activity/current resource before retrying.');
    }
    const operation: ConsoleOperation = {
      id: randomUUID(),
      commandId: definition.id,
      resourceKey: definition.resourceKey(input),
      status: 'queued',
      events: [],
    };
    this.#activity.begin(operation.id, operation.commandId, operation.resourceKey);
    const entry: RetainedOperation = { operation, eventBytes: 0, lastSequence: -1, latest: {} };
    this.#operations.set(operation.id, entry);

    const execute = async () => {
      try { await this.#execute(entry, definition.argv(input), definition.timeoutMs); }
      catch (error) { this.#finishFailure(entry, 'CONSOLE_COMMAND_FAILED', error instanceof Error ? error.message : String(error)); }
    };
    const task = definition.mutation ? this.#serialized(operation.resourceKey, execute) : execute();
    this.#track(task);
    return operation;
  }

  async run(commandId: string, input: unknown): Promise<ConsoleOperation> {
    const operation = this.start(commandId, input);
    if (isTerminal(operation.status)) return operation;
    await new Promise<void>((resolve) => {
      const unsubscribe = this.subscribe(operation.id, (event) => {
        if (event.event === 'completion') {
          unsubscribe();
          resolve();
        }
      });
    });
    return operation;
  }

  get(id: string): ConsoleOperation | undefined {
    this.#prune();
    return this.#operations.get(id)?.operation;
  }

  subscribe(id: string, listener: OperationListener): () => void {
    this.#prune();
    const entry = this.#operations.get(id);
    if (!entry || entry.completedAt !== undefined || this.#closing) return () => undefined;
    const listeners = this.#listeners.get(id) ?? new Set<OperationListener>();
    listeners.add(listener);
    this.#listeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(id);
    };
  }

  cancel(id: string): boolean {
    const child = this.#children.get(id);
    if (!child) return false;
    this.#stopChild(child);
    return true;
  }

  async close(): Promise<void> {
    this.#closing = true;
    clearInterval(this.#sweep);
    for (const child of this.#children.values()) this.#stopChild(child);
    await Promise.allSettled([...this.#tasks]);
    this.#children.clear();
    this.#listeners.clear();
    this.#operations.clear();
    this.#mutationTails.clear();
  }

  #track(task: Promise<void>): void {
    this.#tasks.add(task);
    void task.then(() => this.#tasks.delete(task), () => this.#tasks.delete(task));
  }

  async #serialized(key: string, action: () => Promise<void>): Promise<void> {
    const previous = this.#mutationTails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    this.#mutationTails.set(key, current);
    try { await current; } finally { if (this.#mutationTails.get(key) === current) this.#mutationTails.delete(key); }
  }

  async #execute(entry: RetainedOperation, argv: string[], timeoutMs: number): Promise<void> {
    const { operation } = entry;
    if (this.#closing) {
      this.#publish(entry, this.#synthetic(entry, { event: 'cancellation', reason: 'Console closed before this queued command started.' }));
      this.#finish(entry, this.#synthetic(entry, { event: 'completion', status: 'cancelled' }));
      return;
    }
    operation.status = 'running';
    const child = spawn(process.execPath, [this.#cliEntrypoint, '--json-stream', ...argv], {
      cwd: this.#cwd,
      env: commandEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.on('message', value => {
      if (value && typeof value === 'object' && 'format' in value && value.format === 'dkb.cli-control.v1'
        && 'event' in value && value.event === 'ready') this.#cooperativeChildren.add(child);
    });
    this.#children.set(operation.id, child);
    child.stderr!.setEncoding('utf8');
    let stderr = '';
    child.stderr!.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8_192); });
    const timeout = setTimeout(() => this.#stopChild(child), timeoutMs);
    timeout.unref();
    let outputFailure: { code: string; message: string } | undefined;
    let completion: Extract<DkbCommandEvent, { event: 'completion' }> | undefined;
    let parts: Buffer[] = [];
    let lineBytes = 0;
    const failOutput = (code: string, message: string) => {
      outputFailure ??= { code, message };
      parts = [];
      lineBytes = 0;
      this.#stopChild(child);
    };
    const acceptLine = () => {
      const buffer = Buffer.concat(parts, lineBytes);
      parts = [];
      lineBytes = 0;
      if (!isUtf8(buffer)) {
        failOutput('CONSOLE_INVALID_OUTPUT', 'CLI emitted invalid UTF-8. Check Activity/current resource before retrying.');
        return;
      }
      const line = buffer.toString('utf8').replace(/\r$/u, '');
      const event = parseEvent(line);
      if (!event || event.sequence <= entry.lastSequence || completion) {
        failOutput('CONSOLE_INVALID_OUTPUT', 'CLI emitted an invalid or out-of-order command event. Check Activity/current resource before retrying.');
        return;
      }
      entry.lastSequence = event.sequence;
      // Child closure, not a buffered completion line, releases its admission slot.
      if (event.event === 'completion') completion = event;
      else this.#publish(entry, event);
    };
    child.stdout!.on('data', (chunk: Buffer) => {
      if (outputFailure) return;
      let start = 0;
      while (start < chunk.length && !outputFailure) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? chunk.length : newline;
        const bytes = end - start;
        if (lineBytes + bytes > CONSOLE_OUTPUT_LINE_BYTES) {
          failOutput('CONSOLE_OUTPUT_TOO_LARGE', `CLI event exceeds the ${CONSOLE_OUTPUT_LINE_BYTES}-byte UTF-8 output limit. The result was not truncated; check Activity/current resource before retrying.`);
          return;
        }
        if (bytes) parts.push(chunk.subarray(start, end));
        lineBytes += bytes;
        if (newline >= 0) acceptLine();
        start = end + 1;
      }
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      outputFailure ??= { code: 'CONSOLE_COMMAND_FAILED', message };
      return 1;
    });
    clearTimeout(timeout);
    clearTimeout(this.#terminationTimers.get(child));
    this.#children.delete(operation.id);
    if (lineBytes && !outputFailure) acceptLine();
    if (outputFailure) this.#finishFailure(entry, outputFailure.code, outputFailure.message);
    else if (!completion || (completion.status === 'succeeded' && exitCode !== 0)) {
      this.#finishFailure(entry, 'CONSOLE_COMMAND_FAILED', stderr.trim() || `CLI exited with status ${String(exitCode)} without a successful completion.`);
    } else this.#finish(entry, completion);
  }

  #stopChild(child: ChildProcess): void {
    if (this.#terminationTimers.has(child)) return;
    if (!this.#cooperativeChildren.has(child) || !child.connected) { child.kill('SIGTERM'); return; }
    // Let the CLI settle owner-side cleanup before releasing the operation slot.
    // Bound a broken child; an abrupt exit cannot be reported as successful.
    const timer = setTimeout(() => child.kill('SIGTERM'), 45_000);
    timer.unref();
    this.#terminationTimers.set(child, timer);
    child.send({ format: 'dkb.cli-control.v1', event: 'cancel' }, error => {
      if (error) child.kill('SIGTERM');
    });
  }

  #synthetic<Event extends SyntheticEvent>(entry: RetainedOperation, event: Event): Event & { format: 'dkb.command-event.v1'; sequence: number; timestamp: string } {
    return { ...event, format: 'dkb.command-event.v1', sequence: ++entry.lastSequence, timestamp: new Date(this.#now()).toISOString() };
  }

  #finishFailure(entry: RetainedOperation, code: string, message: string): void {
    this.#publish(entry, this.#synthetic(entry, { event: 'failure', error: { code, message } }));
    this.#finish(entry, this.#synthetic(entry, { event: 'completion', status: 'failed' }));
  }

  #finish(entry: RetainedOperation, completion: Extract<DkbCommandEvent, { event: 'completion' }>): void {
    const { operation } = entry;
    operation.status = completion.status;
    try { this.#activity.finish(operation.id, completion.status, summarize(operation)); }
    catch (error) {
      this.#publish(entry, this.#synthetic(entry, { event: 'failure', error: { code: 'CONSOLE_ACTIVITY_FAILED', message: `Could not record command activity: ${error instanceof Error ? error.message : String(error)}` } }));
      completion = this.#synthetic(entry, { event: 'completion', status: 'failed' });
      operation.status = 'failed';
    }
    this.#publish(entry, completion);
    entry.completedAt = this.#now();
    entry.completedBytes = serializedBytes(operation);
    // Map order breaks equal-clock ties by completion, not admission order.
    this.#operations.delete(operation.id);
    this.#operations.set(operation.id, entry);
    this.#listeners.delete(operation.id);
    this.#prune();
  }

  #publish(entry: RetainedOperation, event: DkbCommandEvent): void {
    const { operation } = entry;
    operation.events.push(event);
    entry.eventBytes += serializedBytes(event);
    if (event.event === 'result') operation.result = event.value;
    if (event.event === 'result' || event.event === 'failure' || event.event === 'completion') entry.latest[event.event] = event;
    while (operation.events.length > this.#retention.replayEvents || entry.eventBytes + operation.events.length + 1 > this.#retention.replayBytes) {
      const index = operation.events.findIndex((item) => item !== entry.trimmed && !Object.values(entry.latest).includes(item));
      if (index < 0) throw new Error('Console terminal events exceeded the replay budget.');
      const removed = operation.events.splice(index, 1)[0]!;
      entry.eventBytes -= serializedBytes(removed);
      if (!entry.trimmed) {
        entry.trimmed = { format: 'dkb.command-event.v1', event: 'warning', sequence: removed.sequence, timestamp: new Date(this.#now()).toISOString(), message: 'Earlier Console replay events were discarded by retention limits. The current result, failure, and completion are retained.' };
        entry.eventBytes += serializedBytes(entry.trimmed);
        operation.events.splice(index, 0, entry.trimmed);
      } else if (removed.sequence < entry.trimmed.sequence) {
        entry.eventBytes -= serializedBytes(entry.trimmed);
        operation.events.splice(operation.events.indexOf(entry.trimmed), 1);
        entry.trimmed.sequence = removed.sequence;
        entry.eventBytes += serializedBytes(entry.trimmed);
        operation.events.splice(index, 0, entry.trimmed);
      }
    }
    // Replay trimming never changes the original live stream.
    const listeners = this.#listeners.get(operation.id);
    for (const listener of listeners ?? []) {
      try { listener(event); }
      catch (error) {
        listeners?.delete(listener);
        process.emitWarning(error instanceof Error ? error : new Error(String(error)), { code: 'CONSOLE_LISTENER_FAILED' });
      }
    }
  }

  #prune(): void {
    const completed = [...this.#operations.values()].filter((entry) => entry.completedAt !== undefined)
      .sort((left, right) => left.completedAt! - right.completedAt!);
    let count = completed.length;
    let bytes = completed.reduce((total, entry) => total + entry.completedBytes!, 0);
    const now = this.#now();
    for (const entry of completed) {
      if (now - entry.completedAt! < this.#retention.completedTtlMs && count <= this.#retention.completedLimit && bytes <= this.#retention.completedBytes) break;
      this.#operations.delete(entry.operation.id);
      this.#listeners.delete(entry.operation.id);
      count -= 1;
      bytes -= entry.completedBytes!;
    }
  }
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function commandEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    'PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE',
    'LOCALAPPDATA', 'APPDATA', 'DKB_HOST_INVENTORY', 'DKB_CLI_CONFIG', 'DKB_STACK_STATE_ROOT',
    'DKB_REGISTRY_CREDENTIALS',
    'DKB_RUNTIME_CREDENTIALS_ROOT', 'DKB_RUNTIME_ADMIN_TOKEN', 'DKB_RUNTIME_READ_TOKEN',
    'NO_COLOR', 'NODE_DISABLE_COLORS',
  ];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
}

function isTerminal(status: ConsoleOperation['status']): status is 'succeeded' | 'failed' | 'cancelled' {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function summarize(operation: ConsoleOperation): string {
  const failure = [...operation.events].reverse().find((event) => event.event === 'failure');
  if (failure?.event === 'failure') return failure.error.message;
  if (operation.result && typeof operation.result === 'object' && !Array.isArray(operation.result)) {
    const result = operation.result as Record<string, unknown>;
    return String(result.status ?? result.name ?? `${operation.commandId} complete`);
  }
  return `${operation.commandId} ${operation.status}`;
}
