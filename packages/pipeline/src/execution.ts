import type { DkbJsonValue } from '@sjshovan/dkb-protocol/json.js';
import type { DkbProviderOptions } from './types.js';

/** Operational recovery state, never artifact provenance or recipe identity. */
export interface DkbExecutionContext {
  /** Persist before dispatching work that may outlive this process or request. */
  registerPending(state: Record<string, DkbJsonValue>): Promise<string>;
  /** Call only after the owned worker has acknowledged that writes have stopped. */
  settlePending(id: string): Promise<void>;
}

export interface DkbPendingExecutionInput {
  state: Record<string, DkbJsonValue>;
  options: DkbProviderOptions;
  signal?: AbortSignal;
}

export interface DkbPendingExecutionResult {
  safeToCleanup: boolean;
}
