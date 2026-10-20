import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbExecutionContext } from '@sjshovan/dkb-pipeline/execution.js';
import { bindProviderExecution, type PendingProviderExecution, type ProviderExecutionFactory } from './providerExecution.js';
import { RegistryExecutionJournal, terminationUnconfirmed } from './registryExecutionJournal.js';

export const REGISTRY_COMPILE_DEADLINE_MS = 24 * 60 * 60 * 1_000;

export interface RegistryCompileExecution {
  id: string;
  expiresAt: string;
}

export interface RegistryCompileControl {
  registryId: string;
  jobId: string;
  execution: RegistryCompileExecution;
}

/** Operator-owned cancellation state. It never enters a knowledge archive or build receipt. */
export class RegistryJobControl {
  private readonly active = new Map<string, AbortController>();
  private readonly root: string;
  private lastPrune = 0;

  constructor(contextRoot: string, private readonly reconcile?: (pending: PendingProviderExecution) => Promise<boolean>) {
    this.root = path.join(path.resolve(contextRoot), '.dkb', 'compiler-cancellations');
  }

  async run<T>(input: RegistryCompileControl, operation: (signal: AbortSignal, execution: ProviderExecutionFactory) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const control = validateControl(input);
    const key = controlKey(control);
    if (this.active.has(key)) throw new DkbError('This compile execution is already running.', 'compile_already_running');
    const controller = new AbortController();
    this.active.set(key, controller);
    const expiresIn = Date.parse(control.execution.expiresAt) - Date.now();
    const deadline = setTimeout(() => controller.abort(expired()), Math.max(0, expiresIn));
    deadline.unref();
    const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const journal = this.journal(key);
    let owned = false;
    let unconfirmedWork = false;
    let poll: NodeJS.Timeout | undefined;
    const execution: ProviderExecutionFactory = Object.assign((host: Parameters<ProviderExecutionFactory>[0], kind: 'evidence'): DkbExecutionContext => {
      const identity = bindProviderExecution(host, kind);
      const ids = new Set<string>();
      return {
        registerPending: async (state) => {
          combined.throwIfAborted();
          if (await this.cancelled(key)) throw cancelled();
          const id = await journal.register({ ...identity, state });
          ids.add(id);
          return id;
        },
        settlePending: async (id) => {
          if (!ids.has(id)) throw new DkbError('Pending execution belongs to another provider invocation.', 'invalid_compile_execution');
          await journal.settle(id);
          ids.delete(id);
        },
      };
    }, {
      hasPending: async () => (await journal.entries()).length > 0,
      registerWorkspace: (root: string) => journal.registerWorkspace(root),
    });
    try {
      if (expiresIn <= 0) throw expired();
      await this.prune();
      if (await this.cancelled(key)) throw cancelled();
      await journal.begin();
      owned = true;
      if (await this.cancelled(key)) throw cancelled();
      poll = setInterval(() => {
        void this.cancelled(key).then((requested) => {
          if (requested) controller.abort(cancelled());
        }).catch(() => controller.abort(terminationUnconfirmed()));
      }, 100);
      poll.unref();
      combined.throwIfAborted();
      const result = await operation(combined, execution);
      if ((await journal.entries()).length) throw terminationUnconfirmed();
      if (await this.cancelled(key)) throw cancelled();
      combined.throwIfAborted();
      return result;
    } catch (error) {
      // Provider transports often throw their own AbortError; retain the job control outcome on the wire.
      if (error instanceof DkbError && error.code === 'compile_termination_unconfirmed') {
        unconfirmedWork = true;
        throw error;
      }
      if (owned && (await journal.entries()).length) {
        unconfirmedWork = true;
        throw terminationUnconfirmed();
      }
      if (combined.aborted) throw combined.reason;
      throw error;
    } finally {
      clearTimeout(deadline);
      if (poll) clearInterval(poll);
      try {
        if (owned) {
          if (unconfirmedWork && !(await journal.entries()).length) await journal.retainUntrackedWork();
          await journal.finish();
          await journal.removeIfSettled();
        }
      } catch {
        throw terminationUnconfirmed();
      } finally {
        journal.releaseOwner();
        this.active.delete(key);
      }
    }
  }

  async cancel(input: RegistryCompileControl): Promise<{ jobId: string; executionId: string; status: 'cancelling' | 'cancelled' }> {
    const control = validateControl(input);
    const key = controlKey(control);
    await this.prune();
    if (Date.parse(control.execution.expiresAt) > Date.now()) {
      await fs.mkdir(this.root, { recursive: true });
      // The unique execution ID prevents numeric job IDs reused after a development reset from colliding.
      await fs.writeFile(path.join(this.root, `${key}.json`), `${JSON.stringify(control)}\n`, { flag: 'wx' }).catch((error: unknown) => {
        if (!isMissingOrExisting(error, 'EEXIST')) throw error;
      });
    }
    const active = this.active.get(key);
    active?.abort(cancelled());
    let status: 'cancelling' | 'cancelled' = active ? 'cancelling' : 'cancelled';
    const journal = this.journal(key);
    if (!active && await journal.exists()) {
      if (!await journal.ownerHasStopped()) status = 'cancelling';
      else {
        try {
          const entries = await journal.entries();
          for (const entry of entries) {
            if (!this.reconcile || !await this.reconcile(entry.pending)) throw terminationUnconfirmed();
          }
          // Persist recovery authority before deleting its last pending handle.
          // An empty, unfinished journal never proves that unknown work stopped.
          if (entries.length) await journal.finish();
          for (const entry of entries) {
            await journal.settle(entry.id);
          }
          if (!await journal.removeIfSettled()) throw terminationUnconfirmed();
        } catch { throw terminationUnconfirmed(); }
      }
    }
    return { jobId: control.jobId, executionId: control.execution.id, status };
  }

  close(): void {
    for (const controller of this.active.values()) {
      controller.abort(new DkbError('Compiler is shutting down; retry this compile request.', 'compiler_stopping'));
    }
  }

  private journal(key: string): RegistryExecutionJournal {
    return new RegistryExecutionJournal(path.join(this.root, `${key}.execution`));
  }

  private async cancelled(key: string): Promise<boolean> {
    try {
      await fs.access(path.join(this.root, `${key}.json`));
      return true;
    } catch (error) {
      if (isMissingOrExisting(error, 'ENOENT')) return false;
      throw error;
    }
  }

  private async prune(): Promise<void> {
    if (Date.now() - this.lastPrune < 60_000) return;
    this.lastPrune = Date.now();
    const names = await fs.readdir(this.root).catch((error: unknown) => {
      if (isMissingOrExisting(error, 'ENOENT')) return [];
      throw error;
    });
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
      const file = path.join(this.root, name);
      try {
        const marker = JSON.parse(await fs.readFile(file, 'utf8')) as RegistryCompileControl;
        const expiry = Date.parse(marker.execution?.expiresAt);
        if (Number.isFinite(expiry) && expiry <= Date.now()) await fs.unlink(file);
      } catch (error) {
        if (!isMissingOrExisting(error, 'ENOENT')) throw error;
      }
    }
  }
}

function validateControl(input: RegistryCompileControl): RegistryCompileControl {
  if (!input || typeof input.registryId !== 'string' || !input.registryId.trim() || input.registryId.length > 256
    || /[\x00-\x1f\x7f]/u.test(input.registryId)
    || typeof input.jobId !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/u.test(input.jobId)
    || !input.execution || typeof input.execution.id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.execution.id)
    || typeof input.execution.expiresAt !== 'string') {
    throw new DkbError('Registry compilation requires its Registry ID, job ID, unique execution ID, and deadline.', 'invalid_compile_execution');
  }
  const expiry = Date.parse(input.execution.expiresAt);
  if (!Number.isFinite(expiry) || expiry > Date.now() + REGISTRY_COMPILE_DEADLINE_MS + 60_000) {
    throw new DkbError('Compile execution deadline must be a valid timestamp no more than 24 hours in the future.', 'invalid_compile_execution');
  }
  return { registryId: input.registryId, jobId: input.jobId, execution: { id: input.execution.id, expiresAt: new Date(expiry).toISOString() } };
}

function controlKey(control: RegistryCompileControl): string {
  return createHash('sha256').update(JSON.stringify([control.registryId, control.jobId, control.execution.id])).digest('hex');
}

function cancelled(): DkbError {
  return new DkbError('Registry compilation was cancelled; no build was published.', 'compile_cancelled');
}

function expired(): DkbError {
  return new DkbError('Compile execution deadline expired; request a new build.', 'compile_expired');
}

function isMissingOrExisting(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
