import fs from 'node:fs/promises';
import path from 'node:path';
import { loadLibrary } from '@sjshovan/dkb-protocol/manifest.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import {
  DKB_RUNTIME_ACTIVATION_FORMAT,
  DKB_RUNTIME_BINDING_FORMAT,
  validateRuntimeActivation,
  validateRuntimeBinding,
  type DkbRuntimeActivation,
  type DkbRuntimeBinding,
} from '@sjshovan/dkb-protocol/runtimeActivation.js';
import {
  defaultRuntimeStateRoot,
  ensureRuntimeStateDirectories,
  safeRuntimeId,
  writeJsonAtomic,
  type DkbRuntimeStatePaths,
} from './paths.js';

export interface DkbRuntimeInstance extends DkbRuntimeStatePaths {
  runtimeId: string;
  libraryRoot: string;
  vendorDir: string;
  packagesDir: string;
  target: string;
  binding: DkbRuntimeBinding;
  activation: DkbRuntimeActivation | null;
}

export interface EnsureRuntimeStateOptions {
  libraryRoot?: string;
  runtimeId?: string;
  target?: string;
}

export async function ensureRuntimeState(
  stateRoot = defaultRuntimeStateRoot(),
  options: EnsureRuntimeStateOptions = {},
): Promise<DkbRuntimeInstance> {
  const paths = await ensureRuntimeStateDirectories(stateRoot);
  const existing = await maybeReadRuntimeBinding(paths.bindingPath);
  const explicitLibrary = options.libraryRoot ?? process.env.DKB_LIBRARY_PATH;
  let binding = existing;

  if (!binding) {
    if (!explicitLibrary) {
      throw new DkbError(
        `Runtime ${paths.stateRoot} is not bound to a Library. `
        + 'Run dkb runtime library use <library> --runtime <runtime>, or set DKB_LIBRARY_PATH for first start.',
      );
    }
    binding = await writeRuntimeBinding(paths.stateRoot, {
      runtimeId: options.runtimeId ?? process.env.DKB_RUNTIME_ID ?? safeRuntimeId(path.basename(paths.stateRoot)),
      libraryRoot: explicitLibrary,
      target: options.target ?? process.env.DKB_PIPELINE_TARGET ?? 'default',
    });
  } else if (explicitLibrary) {
    if (binding.library.kind !== 'local') {
      throw new DkbError(
        `Runtime ${binding.runtimeId} is bound to remote Library handle ${binding.library.handle}; `
        + 'remove DKB_LIBRARY_PATH or use the authenticated Runtime Library switch operation.',
      );
    }
    if (path.resolve(explicitLibrary) !== path.resolve(binding.library.path)) {
      throw new DkbError(
        `Runtime ${binding.runtimeId} is bound to ${binding.library.path}; `
        + `use dkb runtime library use ${path.resolve(explicitLibrary)} --runtime ${binding.runtimeId} to change it atomically.`,
      );
    }
  }

  const libraryRoot = binding.library.kind === 'local'
    ? path.resolve(binding.library.path)
    : await resolveRuntimeLibraryHandle(binding.library.handle);
  await loadLibrary(libraryRoot);
  const activation = await maybeReadRuntimeActivation(paths.activationPath);
  if (activation && activation.runtimeId !== binding.runtimeId) {
    throw new DkbError(`Runtime activation belongs to ${activation.runtimeId}, not ${binding.runtimeId}`);
  }

  return {
    ...paths,
    runtimeId: binding.runtimeId,
    libraryRoot,
    vendorDir: path.join(libraryRoot, 'vendor'),
    packagesDir: path.join(libraryRoot, 'vendor'),
    target: binding.target,
    binding,
    activation,
  };
}

export async function writeRuntimeBinding(stateRoot: string, input: {
  runtimeId: string;
  libraryRoot: string;
  libraryName?: string;
  target: string;
}): Promise<DkbRuntimeBinding> {
  const paths = await ensureRuntimeStateDirectories(stateRoot);
  const libraryRoot = path.resolve(input.libraryRoot);
  await loadLibrary(libraryRoot);
  const binding = validateRuntimeBinding({
    format: DKB_RUNTIME_BINDING_FORMAT,
    runtimeId: safeRuntimeId(input.runtimeId),
    library: {
      kind: 'local',
      path: libraryRoot,
      ...(input.libraryName ? { name: input.libraryName } : {}),
    },
    target: input.target,
    updatedAt: new Date().toISOString(),
  });
  await writeJsonAtomic(paths.bindingPath, binding);
  return binding;
}

export async function writeRuntimeActivation(stateRoot: string, input: DkbRuntimeActivation): Promise<DkbRuntimeActivation> {
  const paths = await ensureRuntimeStateDirectories(stateRoot);
  const activation = validateRuntimeActivation(input);
  await writeJsonAtomic(paths.activationPath, activation);
  return activation;
}

export async function writeRuntimeSelection(
  stateRoot: string,
  bindingInput: DkbRuntimeBinding,
  activationInput: DkbRuntimeActivation,
): Promise<{ binding: DkbRuntimeBinding; activation: DkbRuntimeActivation }> {
  const paths = await ensureRuntimeStateDirectories(stateRoot);
  const binding = validateRuntimeBinding(bindingInput);
  const activation = validateRuntimeActivation(activationInput);
  if (binding.runtimeId !== activation.runtimeId || binding.target !== activation.target) {
    throw new DkbError('Runtime binding and activation must select the same Runtime identity and Pipeline target');
  }
  const stamp = `${process.pid}-${Date.now().toString(36)}`;
  const entries = [
    { target: paths.bindingPath, value: binding },
    { target: paths.activationPath, value: activation },
  ];
  const backups: Array<{ target: string; backup: string; existed: boolean }> = [];
  const temps: string[] = [];
  try {
    for (const entry of entries) {
      const temp = `${entry.target}.stage-${stamp}`;
      await fs.writeFile(temp, `${JSON.stringify(entry.value, null, 2)}\n`, 'utf8');
      temps.push(temp);
    }
    for (const entry of entries) {
      const backup = `${entry.target}.replace-${stamp}`;
      const existed = await fs.access(entry.target).then(() => true, () => false);
      if (existed) await fs.rename(entry.target, backup);
      backups.push({ target: entry.target, backup, existed });
    }
    for (let index = 0; index < entries.length; index += 1) {
      await fs.rename(temps[index]!, entries[index]!.target);
    }
    await Promise.all(backups.map((entry) => fs.rm(entry.backup, { force: true })));
    return { binding, activation };
  } catch (error) {
    await Promise.all(entries.map((entry) => fs.rm(entry.target, { force: true }).catch(() => undefined)));
    for (const entry of backups) {
      if (entry.existed) await fs.rename(entry.backup, entry.target).catch(() => undefined);
    }
    throw error;
  } finally {
    await Promise.all(temps.map((temp) => fs.rm(temp, { force: true }).catch(() => undefined)));
    await Promise.all(backups.map((entry) => fs.rm(entry.backup, { force: true }).catch(() => undefined)));
  }
}

export async function maybeReadRuntimeBinding(source: string): Promise<DkbRuntimeBinding | null> {
  return maybeReadValidated(source, validateRuntimeBinding);
}

export async function maybeReadRuntimeActivation(source: string): Promise<DkbRuntimeActivation | null> {
  return maybeReadValidated(source, validateRuntimeActivation);
}

export function createRuntimeActivation(input: Omit<DkbRuntimeActivation, 'format'>): DkbRuntimeActivation {
  return validateRuntimeActivation({ format: DKB_RUNTIME_ACTIVATION_FORMAT, ...input });
}

function localLibraryPath(binding: DkbRuntimeBinding): string {
  if (binding.library.kind !== 'local') throw new DkbError(`Runtime ${binding.runtimeId} does not expose a local Library path`);
  return binding.library.path;
}

export async function resolveRuntimeLibraryHandle(handle: string): Promise<string> {
  let mappings: unknown;
  try {
    mappings = JSON.parse(process.env.DKB_RUNTIME_LIBRARY_HANDLES ?? '{}');
  } catch {
    throw new DkbError('DKB_RUNTIME_LIBRARY_HANDLES must be a JSON object mapping Runtime-local handles to mounted Library paths.');
  }
  if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) {
    throw new DkbError('DKB_RUNTIME_LIBRARY_HANDLES must be a JSON object mapping Runtime-local handles to mounted Library paths.');
  }
  const value = (mappings as Record<string, unknown>)[handle];
  if (typeof value !== 'string' || !value.trim()) {
    throw new DkbError(`Runtime Library handle ${handle} is not configured on this Runtime host.`);
  }
  const resolved = path.resolve(value);
  await loadLibrary(resolved);
  return resolved;
}

async function maybeReadValidated<T>(source: string, validate: (value: unknown, source?: string) => T): Promise<T | null> {
  try {
    return validate(JSON.parse(await fs.readFile(source, 'utf8')), source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
