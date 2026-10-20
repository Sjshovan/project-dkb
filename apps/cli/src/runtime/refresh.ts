import path from 'node:path';
import type { DkbRuntimeClient } from '@sjshovan/dkb-runtime/runtime/client.js';
import { readHostInventory } from '../host/inventory.js';

export interface DkbServingRuntimeRefresh {
  name: string;
  url: string;
  status: 'refreshed' | 'stale';
  message: string;
  recovery?: string;
  warning?: string;
}

export async function refreshServingLocalRuntimes(
  libraryRoot: string,
  clientFor: (url: string) => Promise<Pick<DkbRuntimeClient, 'reload'>>,
): Promise<DkbServingRuntimeRefresh[]> {
  const inventory = await readHostInventory();
  const library = Object.entries(inventory.libraries).find(([, record]) => !record.storage && samePath(record.path, libraryRoot));
  if (!library) return [];
  return refreshLibraryRuntimes(library[0], clientFor);
}

/** Refresh by host identity, including Libraries that have no host path. */
export async function refreshLibraryRuntimes(
  libraryName: string,
  clientFor: (url: string) => Promise<Pick<DkbRuntimeClient, 'reload'>>,
): Promise<DkbServingRuntimeRefresh[]> {
  const inventory = await readHostInventory();
  const runtimes = Object.entries(inventory.runtimes)
    .filter(([, record]) => record.library === libraryName && record.kind !== 'remote');
  return Promise.all(runtimes.map(async ([name, runtime]) => {
    try {
      const result = await (await clientFor(runtime.url)).reload();
      return withManagedCleanupWarning({
        name,
        url: runtime.url,
        status: 'refreshed' as const,
        message: `Runtime ${name} now serves the current Library generation.`,
      }, result, `dkb runtime refresh ${name}`);
    } catch (error) {
      return {
        name,
        url: runtime.url,
        status: 'stale' as const,
        message: error instanceof Error ? error.message : String(error),
        recovery: `dkb runtime refresh ${name}`,
      };
    }
  }));
}

export function withRuntimeRefreshes<T extends object>(result: T, refreshes: DkbServingRuntimeRefresh[]): T & {
  runtimeRefreshes: DkbServingRuntimeRefresh[];
  warning?: string;
} {
  const stale = refreshes.filter((entry) => entry.status === 'stale');
  const currentWarning = 'warning' in result && typeof result.warning === 'string' ? result.warning : undefined;
  const refreshWarning = stale.length > 0
    ? `Library update succeeded, but ${stale.length} Runtime${stale.length === 1 ? ' remains' : 's remain'} stale: ${stale.map((entry) => `${entry.name} (${entry.recovery})`).join(', ')}.`
    : undefined;
  const cleanupWarnings = refreshes.flatMap(entry => entry.warning ? [entry.warning] : []);
  const warnings = [currentWarning, refreshWarning, ...cleanupWarnings].filter(Boolean);
  return {
    ...result,
    runtimeRefreshes: refreshes,
    ...(warnings.length ? { warning: warnings.join(' ') } : {}),
  };
}

/** Surface maintenance without treating a successfully refreshed activation as stale. */
export function withManagedCleanupWarning(refresh: DkbServingRuntimeRefresh, response: unknown, recovery: string): DkbServingRuntimeRefresh {
  if (!response || typeof response !== 'object') return refresh;
  const cleanup = (response as { indexCleanup?: { pending?: unknown } }).indexCleanup;
  if (!cleanup || typeof cleanup.pending !== 'number' || cleanup.pending <= 0) return refresh;
  // Do not echo arbitrary provider diagnostics or secret-bearing endpoint input.
  return { ...refresh, recovery,
    warning: `Runtime ${refresh.name} refreshed, but managed-index cleanup needs attention. ${recovery}.` };
}

function samePath(left: string, right: string): boolean {
  const first = path.resolve(left);
  const second = path.resolve(right);
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}
