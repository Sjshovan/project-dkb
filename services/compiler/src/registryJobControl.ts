import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

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

  constructor(contextRoot: string) {
    this.root = path.join(path.resolve(contextRoot), '.dkb', 'compiler-cancellations');
  }

  async run<T>(input: RegistryCompileControl, operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const control = validateControl(input);
    const key = controlKey(control);
    if (this.active.has(key)) throw new DkbError('This compile execution is already running.', 'compile_already_running');
    const controller = new AbortController();
    this.active.set(key, controller);
    const expiresIn = Date.parse(control.execution.expiresAt) - Date.now();
    const deadline = setTimeout(() => controller.abort(expired()), Math.max(0, expiresIn));
    deadline.unref();
    const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    try {
      if (expiresIn <= 0) throw expired();
      await this.prune();
      if (await this.cancelled(key)) throw cancelled();
      combined.throwIfAborted();
      const result = await operation(combined);
      combined.throwIfAborted();
      return result;
    } catch (error) {
      // Provider transports often throw their own AbortError; retain the job control outcome on the wire.
      if (combined.aborted) throw combined.reason;
      throw error;
    } finally {
      clearTimeout(deadline);
      this.active.delete(key);
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
    return { jobId: control.jobId, executionId: control.execution.id, status: active ? 'cancelling' : 'cancelled' };
  }

  close(): void {
    for (const controller of this.active.values()) {
      controller.abort(new DkbError('Compiler is shutting down; retry this compile request.', 'compiler_stopping'));
    }
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
