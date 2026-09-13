import fs from 'node:fs/promises';
import path from 'node:path';
import { loadLibraryManifest } from '@sjshovan/dkb-protocol/manifest.js';
import { verifyRegistryEndpoint } from '@sjshovan/dkb-registry-client/config.js';
import { loadRegistryCredentialSync } from '@sjshovan/dkb-registry-client/credentials.js';
import { runtimeClientForUrl } from './runtimeClient.js';
import { hostInventoryPath, readHostInventory } from './inventory.js';

export interface DkbHostLibraryListing {
  inventoryPath: string;
  selected?: string;
  libraries: Array<{
    name: string;
    selected: boolean;
    displayName: string;
    libraryId?: string;
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
    authenticated: boolean;
    credential?: {
      user?: string;
      team?: string;
      abilities?: string[];
      savedAt: string;
      expiresAt?: string | null;
    };
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
    target?: string;
    stale?: boolean;
    libraryId?: string;
    activationGeneration?: number;
    compatibilityDigest?: string;
    message?: string;
  }>;
}

export async function inspectHostLibraries(): Promise<DkbHostLibraryListing> {
  const inventory = await readHostInventory();
  const libraries = await Promise.all(Object.entries(inventory.libraries).map(async ([name, library]) => {
    const status = await inspectLibrary(library.path);

    return {
      name,
      selected: inventory.defaults.library === name,
      displayName: library.displayName,
      path: library.path,
      ...(library.registry ? { registry: library.registry } : {}),
      ...status,
    };
  }));

  return {
    inventoryPath: hostInventoryPath(),
    ...(inventory.defaults.library ? { selected: inventory.defaults.library } : {}),
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
    const credential = loadRegistryCredentialSync(registry.url);
    const auth = {
      authenticated: Boolean(credential && (!credential.expiresAt || Date.parse(credential.expiresAt) > Date.now())),
      ...(credential ? {
        credential: {
          ...(credential.user ? { user: credential.user } : {}),
          ...(credential.team ? { team: credential.team } : {}),
          ...(credential.abilities ? { abilities: credential.abilities } : {}),
          savedAt: credential.savedAt,
          ...(credential.expiresAt !== undefined ? { expiresAt: credential.expiresAt } : {}),
        },
      } : {}),
    };

    if (!checked) {
      return {
        name,
        selected: inventory.defaults.registry === name,
        url: registry.url,
        usedBy,
        status: 'known' as const,
        ...auth,
      };
    }

    const verification = await verifyRegistryEndpoint(registry.url);
    const reached = verification.checks.some((check) => typeof check.status === 'number');

    return {
      name,
      selected: inventory.defaults.registry === name,
      url: registry.url,
      usedBy,
      status: verification.ok ? 'ready' as const : reached ? 'degraded' as const : 'unavailable' as const,
      checks: verification.checks,
      ...auth,
    };
  }));

  return {
    inventoryPath: hostInventoryPath(),
    ...(inventory.defaults.registry ? { selected: inventory.defaults.registry } : {}),
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
      selected: inventory.defaults.runtime === name,
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
      const status = await (await runtimeClientForUrl(runtime.url, 5_000)).status();
      const record = isRecord(status) ? status : {};
      if (record.ok !== true) {
        return { ...common, status: 'incompatible' as const, message: 'Runtime status did not report ok=true.' };
      }

      return {
        ...common,
        status: 'online' as const,
        ...(typeof record.packageCount === 'number' ? { packageCount: record.packageCount } : {}),
        ...(typeof record.target === 'string' ? { target: record.target } : {}),
        ...(typeof record.stale === 'boolean' ? { stale: record.stale } : {}),
        ...(isRecord(record.library) && typeof record.library.id === 'string' ? { libraryId: record.library.id } : {}),
        ...(isRecord(record.activation) && typeof record.activation.generation === 'number'
          ? { activationGeneration: record.activation.generation }
          : {}),
        ...(isRecord(record.activation) && typeof record.activation.compatibilityDigest === 'string'
          ? { compatibilityDigest: record.activation.compatibilityDigest }
          : {}),
      };
    } catch (error) {
      return {
        ...common,
        status: error instanceof Error && 'code' in error && error.code === 'runtime_unauthorized'
          ? 'incompatible' as const : 'offline' as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }));

  return {
    inventoryPath: hostInventoryPath(),
    ...(inventory.defaults.runtime ? { selected: inventory.defaults.runtime } : {}),
    checked,
    runtimes: runtimes.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

async function inspectLibrary(root: string): Promise<{ status: 'ready' | 'missing' | 'invalid'; libraryId?: string; message?: string }> {
  const manifestPath = path.join(root, 'dkb.json');

  try {
    await fs.access(manifestPath);
    return { status: 'ready', libraryId: (await loadLibraryManifest(root)).id };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'missing', message: `No Library manifest at ${manifestPath}.` };
    }
    return { status: 'invalid', message: error instanceof Error ? error.message : String(error) };
  }

}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
