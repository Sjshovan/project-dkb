import path from 'node:path';
import { registerHostLibrary, registeredHostLibrary, selectedHostLibrary, selectedHostRuntime } from '../host/inventory.js';
import { nearestLibraryRoot, requireLibraryRoot } from '@sjshovan/dkb-library/root.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { localHostLibraryPath, type DockerLibraryStorage } from '../host/libraryLocation.js';

export interface ResolveCliLibraryOptions {
  explicit?: string;
  cwd?: string;
  /** Locate only; recovery/writes must admit state under their ownership gate. */
  allowUnavailableManifest?: boolean;
}

export type CliLibraryReference = { kind: 'local'; path: string }
  | { kind: 'docker'; name: string; storage: DockerLibraryStorage };

/** Resolve identity before choosing filesystem access or owner-side execution. */
export async function resolveCliLibraryReference(options: ResolveCliLibraryOptions = {}): Promise<CliLibraryReference> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const recovery = options.allowUnavailableManifest === true;

  if (options.explicit?.trim()) {
    return resolveNamedOrPathLibrary(options.explicit, cwd, recovery);
  }

  if (process.env.DKB_LIBRARY_PATH?.trim()) {
    return resolveNamedOrPathLibrary(process.env.DKB_LIBRARY_PATH, cwd, recovery);
  }

  const nearest = await nearestLibraryRoot(cwd, { includeInterrupted: recovery });
  if (nearest) {
    return { kind: 'local', path: recovery ? nearest : await registerResolvedLibrary(nearest) };
  }

  const selected = await selectedHostLibrary();
  if (selected) {
    if (selected.library.storage) return { kind: 'docker', name: selected.name, storage: selected.library.storage };
    if (recovery) return { kind: 'local', path: path.resolve(selected.library.path) };
    await assertLibraryReadable(selected.library.path);
    try {
      return { kind: 'local', path: await requireLibraryRoot(selected.library.path) };
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

/** Filesystem-only consumers fail closed instead of treating a volume as a path. */
export async function resolveCliLibraryRoot(options: ResolveCliLibraryOptions = {}): Promise<string> {
  const reference = await resolveCliLibraryReference(options);
  return localHostLibraryPath(reference.kind === 'local' ? { path: reference.path } : { storage: reference.storage });
}

/** Queue writes before read-side preflight; live writers are not failed recovery. */
export async function withCliLibraryWriteContext<T>(
  options: Omit<ResolveCliLibraryOptions, 'allowUnavailableManifest'>,
  operation: (root: string) => Promise<T>,
): Promise<T> {
  const candidate = await resolveCliLibraryRoot({ ...options, allowUnavailableManifest: true });
  const root = await nearestLibraryRoot(candidate, { includeInterrupted: true });
  if (!root) throw new DkbError(`No DKB Library found from ${candidate}. Run dkb init to create one.`);
  const { withDkbFileLock } = await import('@sjshovan/dkb-library/locks.js');
  return withDkbFileLock(root, 'library-mutation', async () => {
    await assertLibraryReadable(root);
    const validated = await requireLibraryRoot(root);
    if (path.resolve(validated) !== path.resolve(root)) {
      throw new DkbError('Library identity changed while waiting for ownership. Retry with an explicit Library root.', 'library_busy');
    }
    await registerResolvedLibrary(root);
    return operation(root);
  });
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

async function resolveNamedOrPathLibrary(value: string, cwd: string, recovery = false): Promise<CliLibraryReference> {
  const registered = await registeredHostLibrary(value);
  if (registered?.library.storage) return { kind: 'docker', name: registered.name, storage: registered.library.storage };
  const candidate = path.resolve(registered?.library.path ?? path.resolve(cwd, value));
  if (!recovery) await assertLibraryReadable(candidate);
  return { kind: 'local', path: recovery ? candidate : await registerResolvedLibrary(await requireLibraryRoot(candidate)) };
}

async function assertLibraryReadable(root: string): Promise<void> {
  const { captureLibraryReadFence } = await import('@sjshovan/dkb-library/mutation.js');
  await captureLibraryReadFence(root);
}

async function registerResolvedLibrary(root: string): Promise<string> {
  await registerHostLibrary(root);
  return root;
}
