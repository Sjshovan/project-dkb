import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { DkbCommandEvent } from '@sjshovan/dkb-protocol/command-events.js';
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

export class ConsoleCommandRunner {
  readonly #cliEntrypoint: string;
  readonly #cwd: string;
  readonly #activity: ConsoleActivityStore;
  readonly #operations = new Map<string, ConsoleOperation>();
  readonly #listeners = new Map<string, Set<OperationListener>>();
  readonly #mutationTails = new Map<string, Promise<void>>();
  readonly #children = new Map<string, ChildProcess>();
  readonly #tasks = new Set<Promise<void>>();

  constructor(input: { cliEntrypoint: string; cwd: string; activity: ConsoleActivityStore }) {
    this.#cliEntrypoint = input.cliEntrypoint;
    this.#cwd = input.cwd;
    this.#activity = input.activity;
  }

  start(commandId: string, rawInput: unknown): ConsoleOperation {
    const definition = consoleCommand(commandId);
    const input = parseConsoleCommandInput(definition, rawInput);
    const operation: ConsoleOperation = {
      id: randomUUID(),
      commandId: definition.id,
      resourceKey: definition.resourceKey(input),
      status: 'queued',
      events: [],
    };
    this.#operations.set(operation.id, operation);
    this.#activity.begin(operation.id, operation.commandId, operation.resourceKey);

    const execute = async () => this.#execute(operation, definition.argv(input), definition.timeoutMs);
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
    return this.#operations.get(id);
  }

  subscribe(id: string, listener: OperationListener): () => void {
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
    child.kill('SIGINT');
    return true;
  }

  async close(): Promise<void> {
    for (const child of this.#children.values()) child.kill('SIGTERM');
    await Promise.allSettled([...this.#tasks]);
    this.#children.clear();
  }

  #track(task: Promise<void>): void {
    this.#tasks.add(task);
    void task.finally(() => this.#tasks.delete(task));
  }

  async #serialized(key: string, action: () => Promise<void>): Promise<void> {
    const previous = this.#mutationTails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    this.#mutationTails.set(key, current);
    try { await current; } finally { if (this.#mutationTails.get(key) === current) this.#mutationTails.delete(key); }
  }

  async #execute(operation: ConsoleOperation, argv: string[], timeoutMs: number): Promise<void> {
    operation.status = 'running';
    const child = spawn(process.execPath, [this.#cliEntrypoint, '--json-stream', ...argv], {
      cwd: this.#cwd,
      env: commandEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.#children.set(operation.id, child);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stderr = '';
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8_192); });
    const timeout = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    timeout.unref();
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (line.length > 2_000_000) {
        child.kill('SIGTERM');
        return;
      }
      const event = parseEvent(line);
      if (!event) {
        child.kill('SIGTERM');
        return;
      }
      operation.events.push(event);
      if (event.event === 'result') operation.result = event.value;
      if (event.event === 'completion') operation.status = event.status === 'succeeded' ? 'succeeded' : event.status === 'cancelled' ? 'cancelled' : 'failed';
      for (const listener of this.#listeners.get(operation.id) ?? []) listener(event);
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.#appendSyntheticFailure(operation, message);
      return 1;
    });
    clearTimeout(timeout);
    this.#children.delete(operation.id);

    if (!isTerminal(operation.status)) {
      this.#appendSyntheticFailure(operation, stderr.trim() || `CLI exited with status ${String(exitCode)} without a completion event.`);
    }
    this.#activity.finish(operation.id, isTerminal(operation.status) ? operation.status : 'failed', summarize(operation));
  }

  #appendSyntheticFailure(operation: ConsoleOperation, message: string): void {
    const base = { format: 'dkb.command-event.v1' as const, timestamp: new Date().toISOString() };
    const failure: DkbCommandEvent = { ...base, sequence: operation.events.length, event: 'failure', error: { code: 'CONSOLE_COMMAND_FAILED', message } };
    const completion: DkbCommandEvent = { ...base, sequence: operation.events.length + 1, event: 'completion', status: 'failed' };
    operation.events.push(failure, completion);
    operation.status = 'failed';
    for (const listener of this.#listeners.get(operation.id) ?? []) { listener(failure); listener(completion); }
  }
}

function commandEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    'PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE',
    'LOCALAPPDATA', 'APPDATA', 'DKB_HOST_INVENTORY', 'DKB_CLI_CONFIG', 'DKB_STACK_STATE_ROOT',
    'NO_COLOR', 'NODE_DISABLE_COLORS',
  ];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
}

function parseEvent(line: string): DkbCommandEvent | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.format !== 'dkb.command-event.v1' || typeof value.event !== 'string' || typeof value.sequence !== 'number' || typeof value.timestamp !== 'string') return null;
    if (!['start', 'stage', 'progress', 'warning', 'result', 'failure', 'cancellation', 'completion'].includes(value.event)) return null;
    return value as unknown as DkbCommandEvent;
  } catch {
    return null;
  }
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
