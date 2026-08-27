import path from 'node:path';
import { registerHostLibrary, registeredHostLibrary, selectedHostLibrary, selectedHostRuntime } from '../host/inventory.js';
import { nearestLibraryRoot, requireLibraryRoot } from '../library/root.js';
import { DkbError } from '../protocol/errors.js';

export interface ResolveCliLibraryOptions {
  explicit?: string;
  cwd?: string;
}

export async function resolveCliLibraryRoot(options: ResolveCliLibraryOptions = {}): Promise<string> {
  const cwd = path.resolve(options.cwd ?? process.cwd());

  if (options.explicit?.trim()) {
    return registerResolvedLibrary(await resolveNamedOrPathLibrary(options.explicit, cwd));
  }

  if (process.env.DKB_LIBRARY_PATH?.trim()) {
    return registerResolvedLibrary(await resolveNamedOrPathLibrary(process.env.DKB_LIBRARY_PATH, cwd));
  }

  const nearest = await nearestLibraryRoot(cwd);
  if (nearest) {
    return registerResolvedLibrary(nearest);
  }

  const selected = await selectedHostLibrary();
  if (selected) {
    try {
      return await requireLibraryRoot(selected.library.path);
    } catch {
      throw new DkbError(
        `Selected DKB Library ${selected.name} is unavailable at ${selected.library.path}. `
        + `Run: dkb library list`,
      );
    }
  }

  throw new DkbError(
    `No DKB Library found from ${cwd}, and this host has no selected Library. `
    + `Run dkb init, dkb library register <path>, or dkb library use <name>.`,
  );
}

export async function resolveCliRuntimeUrl(explicit?: string): Promise<string> {
  if (explicit?.trim()) {
    return explicit.trim();
  }

  if (process.env.DKB_RUNTIME_URL?.trim()) {
    return process.env.DKB_RUNTIME_URL.trim();
  }

  const selected = await selectedHostRuntime();

  return selected?.runtime.url ?? 'http://127.0.0.1:7331';
}

async function resolveNamedOrPathLibrary(value: string, cwd: string): Promise<string> {
  const registered = await registeredHostLibrary(value);
  if (registered) {
    return requireLibraryRoot(registered.library.path);
  }

  const candidate = path.resolve(cwd, value);
  return requireLibraryRoot(candidate);
}

async function registerResolvedLibrary(root: string): Promise<string> {
  await registerHostLibrary(root);
  return root;
}
