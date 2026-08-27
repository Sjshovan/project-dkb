import fs from 'node:fs/promises';
import path from 'node:path';
import { verifyRegistryEndpoint } from '@dkb/registry-client/config.js';
import { DkbRuntimeClient } from '@dkb/runtime/runtime/client.js';
import { hostInventoryPath, readHostInventory } from './inventory.js';

export interface DkbHostLibraryListing {
  inventoryPath: string;
  selected?: string;
  libraries: Array<{
    name: string;
    selected: boolean;
    displayName: string;
    path: string;
    registry?: string;
    status: 'ready' | 'missing' | 'invalid';
    message?: string;
  }>;
}

export interface DkbHostRegistryListing {
  inventoryPath: string;
  selected?: string;
  checked: boolean;
  registries: Array<{
    name: string;
    selected: boolean;
    url: string;
    usedBy: string[];
    status: 'known' | 'ready' | 'degraded' | 'unavailable';
    checks?: Awaited<ReturnType<typeof verifyRegistryEndpoint>>['checks'];
  }>;
}

export interface DkbHostRuntimeListing {
  inventoryPath: string;
  selected?: string;
  checked: boolean;
  runtimes: Array<{
    name: string;
    selected: boolean;
    kind: 'process' | 'docker' | 'remote';
    url: string;
    library?: string;
    stateRoot?: string;
    composeFile?: string;
    status: 'known' | 'online' | 'offline' | 'incompatible';
    packageCount?: number;
    message?: string;
  }>;
}

export async function inspectHostLibraries(): Promise<DkbHostLibraryListing> {
  const inventory = await readHostInventory();
  const libraries = await Promise.all(Object.entries(inventory.libraries).map(async ([name, library]) => {
    const status = await inspectLibrary(library.path);

    return {
      name,
      selected: inventory.selected.library === name,
      displayName: library.displayName,
      path: library.path,
      ...(library.registry ? { registry: library.registry } : {}),
      ...status,
    };
  }));

  return {
    inventoryPath: hostInventoryPath(),
    ...(inventory.selected.library ? { selected: inventory.selected.library } : {}),
    libraries: libraries.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export async function inspectHostRegistries(options: { check?: boolean } = {}): Promise<DkbHostRegistryListing> {
  const inventory = await readHostInventory();
  const checked = Boolean(options.check);
  const registries = await Promise.all(Object.entries(inventory.registries).map(async ([name, registry]) => {
    const usedBy = Object.entries(inventory.libraries)
      .filter(([, library]) => library.registry === name)
      .map(([libraryName]) => libraryName)
      .sort();

    if (!checked) {
      return {
        name,
        selected: inventory.selected.registry === name,
        url: registry.url,
        usedBy,
        status: 'known' as const,
      };
    }

    const verification = await verifyRegistryEndpoint(registry.url);
    const reached = verification.checks.some((check) => typeof check.status === 'number');

    return {
      name,
      selected: inventory.selected.registry === name,
      url: registry.url,
      usedBy,
      status: verification.ok ? 'ready' as const : reached ? 'degraded' as const : 'unavailable' as const,
      checks: verification.checks,
    };
  }));

  return {
    inventoryPath: hostInventoryPath(),
    ...(inventory.selected.registry ? { selected: inventory.selected.registry } : {}),
    checked,
    registries: registries.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export async function inspectHostRuntimes(options: { check?: boolean } = {}): Promise<DkbHostRuntimeListing> {
  const inventory = await readHostInventory();
  const checked = Boolean(options.check);
  const runtimes = await Promise.all(Object.entries(inventory.runtimes).map(async ([name, runtime]) => {
    const common = {
      name,
      selected: inventory.selected.runtime === name,
      kind: runtime.kind,
      url: runtime.url,
      ...(runtime.library ? { library: runtime.library } : {}),
      ...(runtime.stateRoot ? { stateRoot: runtime.stateRoot } : {}),
      ...(runtime.composeFile ? { composeFile: runtime.composeFile } : {}),
    };

    if (!checked) {
      return { ...common, status: 'known' as const };
    }

    try {
      const status = await new DkbRuntimeClient({ baseUrl: runtime.url, timeoutMs: 5_000 }).status();
      const record = isRecord(status) ? status : {};
      if (record.ok !== true) {
        return { ...common, status: 'incompatible' as const, message: 'Runtime status did not report ok=true.' };
      }

      return {
        ...common,
        status: 'online' as const,
        ...(typeof record.packageCount === 'number' ? { packageCount: record.packageCount } : {}),
      };
    } catch (error) {
      return {
        ...common,
        status: 'offline' as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }));

  return {
    inventoryPath: hostInventoryPath(),
    ...(inventory.selected.runtime ? { selected: inventory.selected.runtime } : {}),
    checked,
    runtimes: runtimes.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

async function inspectLibrary(root: string): Promise<{ status: 'ready' | 'missing' | 'invalid'; message?: string }> {
  const manifestPath = path.join(root, 'dkb.json');
  let manifest: unknown;

  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'missing', message: `No Library manifest at ${manifestPath}.` };
    }
    return { status: 'invalid', message: error instanceof Error ? error.message : String(error) };
  }

  return isRecord(manifest) && manifest.type === 'library'
    ? { status: 'ready' }
    : { status: 'invalid', message: `Expected ${manifestPath} to have type "library".` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
