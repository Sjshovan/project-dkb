import type { DkbHostRuntimeRecord } from './inventory.js';

/** Pure routing: a saved path is not storage authority for Docker/remote Runtimes. */
export function nativeRuntimeStateRoot(runtime: Pick<DkbHostRuntimeRecord, 'kind' | 'stateRoot'>): string | undefined {
  return runtime.kind === 'process' ? runtime.stateRoot : undefined;
}
