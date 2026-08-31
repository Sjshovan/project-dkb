import path from 'node:path';
import type { DkbRuntimeClient } from '@sjshovan/dkb-runtime/runtime/client.js';
import { readHostInventory } from '../host/inventory.js';

export interface DkbServingRuntimeRefresh {
  name: string;
  url: string;
  status: 'refreshed' | 'stale';
  message: string;
  recovery?: string;
}

export async function refreshServingLocalRuntimes(
  libraryRoot: string,
  clientFor: (url: string) => Promise<DkbRuntimeClient>,
): Promise<DkbServingRuntimeRefresh[]> {
  const inventory = await readHostInventory();
  const library = Object.entries(inventory.libraries).find(([, record]) => samePath(record.path, libraryRoot));
  if (!library) return [];

  const runtimes = Object.entries(inventory.runtimes)
    .filter(([, record]) => record.library === library[0] && record.kind !== 'remote');
  return Promise.all(runtimes.map(async ([name, runtime]) => {
    try {
      await (await clientFor(runtime.url)).reload();
      return {
        name,
        url: runtime.url,
        status: 'refreshed' as const,
        message: `Runtime ${name} now serves the current Library generation.`,
      };
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
    ? `Library update succeeded, but ${stale.length} Runtime${stale.length === 1 ? '' : 's'} remain stale: ${stale.map((entry) => `${entry.name} (${entry.recovery})`).join(', ')}.`
    : undefined;
  return {
    ...result,
    runtimeRefreshes: refreshes,
    ...(currentWarning || refreshWarning ? { warning: [currentWarning, refreshWarning].filter(Boolean).join(' ') } : {}),
  };
}

function samePath(left: string, right: string): boolean {
  const first = path.resolve(left);
  const second = path.resolve(right);
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}
