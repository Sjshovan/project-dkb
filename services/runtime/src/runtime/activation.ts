import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadLibrary, loadLibraryManifest } from '@sjshovan/dkb-protocol/manifest.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { assertLibraryReadFence, captureLibraryReadFence } from '@sjshovan/dkb-library/mutation.js';
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
  runtimePaths,
  safeRuntimeId,
  writeJsonAtomic,
  type DkbRuntimeStatePaths,
} from './paths.js';
import { withRuntimeMutation, withRuntimeQuery } from './mutation.js';

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

export interface InitializeRuntimeBindingOptions {
  runtimeId: string;
  libraryRoot: string;
  runtimeLibraryRoot?: string;
  libraryName?: string;
  target: string;
}

export const DKB_RUNTIME_SELECTION_TRANSACTION = '.dkb/runtime-selection.transaction.json';
const DKB_RUNTIME_SELECTION_TRANSACTION_FORMAT = 'dkb.runtime-selection.transaction.v1';

interface RuntimeSelectionTransaction {
  format: typeof DKB_RUNTIME_SELECTION_TRANSACTION_FORMAT;
  stamp: string;
  phase: 'staged' | 'backed-up' | 'promoted';
  existed: { binding: boolean; activation: boolean };
}

export async function ensureRuntimeState(
  stateRoot = defaultRuntimeStateRoot(),
  options: EnsureRuntimeStateOptions = {},
): Promise<DkbRuntimeInstance> {
  return withRuntimeMutation(stateRoot, () => ensureRuntimeStateWithinMutation(stateRoot, options));
}

async function ensureRuntimeStateWithinMutation(
  stateRoot: string,
  options: EnsureRuntimeStateOptions,
): Promise<DkbRuntimeInstance> {
  const paths = await ensureRuntimeStateDirectories(stateRoot);
  await recoverRuntimeSelectionTransaction(paths);
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
    binding = await initializeRuntimeBinding(paths.stateRoot, {
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

  return readRuntimeInstance(paths, binding);
}

/** Queries read a completed selection; they never initialize or repair state. */
export async function readRuntimeState(stateRoot = defaultRuntimeStateRoot()): Promise<DkbRuntimeInstance> {
  const paths = runtimePaths(stateRoot);
  const journalName = path.basename(DKB_RUNTIME_SELECTION_TRANSACTION);
  const entries = await fs.readdir(paths.stateDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (entries.some((name) => name === journalName || name.startsWith(`${journalName}.replace-`))) {
    throw new DkbError('Runtime activation is being changed or requires recovery. Run dkb runtime refresh before querying.', 'runtime_busy');
  }
  const binding = await maybeReadRuntimeBinding(paths.bindingPath);
  if (!binding) {
    throw new DkbError('Runtime is not bound to a Library. Run dkb runtime library use <library> --runtime <runtime>.', 'runtime_activation_required');
  }
  return readRuntimeInstance(paths, binding);
}

async function readRuntimeInstance(paths: DkbRuntimeStatePaths, binding: DkbRuntimeBinding): Promise<DkbRuntimeInstance> {
  const libraryRoot = binding.library.kind === 'local'
    ? path.resolve(binding.library.path)
    : await resolveRuntimeLibraryHandle(binding.library.handle);
  const libraryFence = await captureLibraryReadFence(libraryRoot);
  // Reading a binding validates its Library identity, not every source file.
  // Activation/context admission owns the exact installed package/build graph.
  await loadLibraryManifest(libraryRoot);
  const activation = await maybeReadRuntimeActivation(paths.activationPath);
  if (activation && activation.runtimeId !== binding.runtimeId) {
    throw new DkbError(`Runtime activation belongs to ${activation.runtimeId}, not ${binding.runtimeId}`);
  }
  if (activation && activation.target !== binding.target) {
    throw new DkbError(
      `Runtime selection is inconsistent: binding target ${binding.target} does not match activation target ${activation.target}. `
      + `Run dkb runtime refresh ${binding.runtimeId}.`,
      'runtime_activation_invalid',
    );
  }

  await assertLibraryReadFence(libraryRoot, libraryFence);
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

/**
 * Create the first Runtime binding without exposing the activation writer.
 * Once a binding exists, its Pipeline target remains unchanged until the
 * Runtime activation service promotes a complete binding/activation pair.
 */
export async function initializeRuntimeBinding(
  stateRoot: string,
  input: InitializeRuntimeBindingOptions,
): Promise<DkbRuntimeBinding> {
  const libraryRoot = path.resolve(input.libraryRoot);
  const runtimeLibraryRoot = input.runtimeLibraryRoot?.trim() || libraryRoot;
  const candidate = validateRuntimeBinding({
    format: DKB_RUNTIME_BINDING_FORMAT,
    runtimeId: safeRuntimeId(input.runtimeId),
    library: {
      kind: 'local',
      path: runtimeLibraryRoot,
      ...(input.libraryName ? { name: input.libraryName } : {}),
    },
    target: input.target,
    updatedAt: new Date().toISOString(),
  });

  return withRuntimeMutation(stateRoot, async () => {
    const paths = await ensureRuntimeStateDirectories(stateRoot);
    await recoverRuntimeSelectionTransaction(paths);
    const existing = await maybeReadRuntimeBinding(paths.bindingPath);
    if (existing) {
      if (existing.runtimeId !== candidate.runtimeId
        || existing.library.kind !== 'local'
        || existing.library.path !== runtimeLibraryRoot) {
        throw new DkbError(
          `Runtime ${existing.runtimeId} is already initialized with another Library binding. `
          + 'Change its Library through the Runtime activation service.',
        );
      }
      return existing;
    }

    const libraryFence = await captureLibraryReadFence(libraryRoot);
    await loadLibrary(libraryRoot);
    await assertLibraryReadFence(libraryRoot, libraryFence);
    await writeJsonAtomic(paths.bindingPath, candidate);
    return candidate;
  });
}

export async function promoteRuntimeSelection(
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
  await recoverRuntimeSelectionTransaction(paths);
  const stamp = `${process.pid}-${Date.now().toString(36)}-${randomUUID()}`;
  const existed = {
    binding: await fileExists(paths.bindingPath),
    activation: await fileExists(paths.activationPath),
  };
  const transaction: RuntimeSelectionTransaction = {
    format: DKB_RUNTIME_SELECTION_TRANSACTION_FORMAT,
    stamp,
    phase: 'staged',
    existed,
  };
  const entries = runtimeSelectionEntries(paths, transaction, binding, activation);
  const transactionPath = runtimeSelectionTransactionPath(paths);
  try {
    for (const entry of entries) {
      await fs.writeFile(entry.temp, `${JSON.stringify(entry.value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    }
    await writeJsonAtomic(transactionPath, transaction);
    for (const entry of entries) {
      if (entry.existed) await fs.rename(entry.target, entry.backup);
    }
    for (const entry of entries) {
      await fs.rename(entry.temp, entry.target);
    }
    const promotedBinding = await maybeReadRuntimeBinding(paths.bindingPath);
    const promotedActivation = await maybeReadRuntimeActivation(paths.activationPath);
    if (!promotedBinding || !promotedActivation
      || promotedBinding.runtimeId !== promotedActivation.runtimeId
      || promotedBinding.target !== promotedActivation.target) {
      throw new DkbError('Runtime selection promotion did not produce a matching binding and activation');
    }
    await fs.writeFile(runtimeSelectionCommitPath(paths, transaction), '', { encoding: 'utf8', flag: 'wx' });
    await cleanupRuntimeSelectionTransaction(paths, transaction);
    return { binding, activation };
  } catch (error) {
    const rollbackErrors = await rollbackRuntimeSelectionTransaction(paths, transaction);
    if (rollbackErrors.length > 0) {
      throw new DkbError(
        `Runtime selection failed (${errorMessage(error)}) and automatic rollback needs recovery: ${rollbackErrors.join('; ')}. `
        + `Restart the Runtime or run dkb runtime refresh after inspecting ${transactionPath}.`,
        'runtime_activation_recovery_required',
      );
    }
    throw error;
  }
}

export async function maybeReadRuntimeBinding(source: string): Promise<DkbRuntimeBinding | null> {
  return maybeReadValidated(source, validateRuntimeBinding);
}

export async function maybeReadRuntimeBindingFromStateRoot(stateRoot: string): Promise<DkbRuntimeBinding | null> {
  return maybeReadRuntimeBinding(runtimePaths(stateRoot).bindingPath);
}

/** Observe a complete committed pair without repairing a journal or changing activation. */
export async function inspectRuntimeSelection(stateRoot: string): Promise<{ binding: DkbRuntimeBinding | null; activation: DkbRuntimeActivation | null }> {
  return withRuntimeQuery(stateRoot, async () => {
    const paths = runtimePaths(stateRoot);
    const journal = runtimeSelectionTransactionPath(paths);
    const names = await fs.readdir(path.dirname(journal)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    if (names.some(name => name === path.basename(journal) || name.startsWith(`${path.basename(journal)}.replace-`))) {
      throw new DkbError('Runtime activation recovery is pending. Start or refresh it through its owning environment before inspecting a committed selection.', 'runtime_activation_recovery_required');
    }
    const binding = await maybeReadRuntimeBinding(paths.bindingPath);
    const activation = await maybeReadRuntimeActivation(paths.activationPath);
    if (activation && (!binding || activation.runtimeId !== binding.runtimeId || activation.target !== binding.target)) {
      throw new DkbError('Runtime binding and activation do not describe one committed selection. Recover the Runtime before retrying.', 'runtime_activation_invalid');
    }
    return { binding, activation };
  });
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
  const libraryFence = await captureLibraryReadFence(resolved);
  await loadLibrary(resolved);
  await assertLibraryReadFence(resolved, libraryFence);
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

async function recoverRuntimeSelectionTransaction(paths: DkbRuntimeStatePaths): Promise<void> {
  const transactionPath = runtimeSelectionTransactionPath(paths);
  const transaction = await readRuntimeSelectionTransaction(transactionPath);
  if (!transaction) return;
  if (transaction.phase === 'promoted' || await fileExists(runtimeSelectionCommitPath(paths, transaction))) {
    const binding = await maybeReadRuntimeBinding(paths.bindingPath).catch(() => null);
    const activation = await maybeReadRuntimeActivation(paths.activationPath).catch(() => null);
    if (binding && activation && binding.runtimeId === activation.runtimeId && binding.target === activation.target) {
      await cleanupRuntimeSelectionTransaction(paths, transaction);
      return;
    }
  }
  const errors = await rollbackRuntimeSelectionTransaction(paths, transaction);
  if (errors.length > 0) {
    throw new DkbError(
      `Runtime selection recovery failed: ${errors.join('; ')}. Inspect ${transactionPath} before retrying.`,
      'runtime_activation_recovery_required',
    );
  }
}

async function readRuntimeSelectionTransaction(source: string): Promise<RuntimeSelectionTransaction | null> {
  await restoreRuntimeSelectionTransactionJournal(source);
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(source, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new DkbError(`Runtime selection transaction is unreadable at ${source}: ${errorMessage(error)}`, 'runtime_activation_recovery_required');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DkbError(`Runtime selection transaction is invalid at ${source}`, 'runtime_activation_recovery_required');
  }
  const candidate = value as Partial<RuntimeSelectionTransaction>;
  if (candidate.format !== DKB_RUNTIME_SELECTION_TRANSACTION_FORMAT
    || typeof candidate.stamp !== 'string' || !/^\d+-[a-z0-9]+-[a-f0-9-]{36}$/u.test(candidate.stamp)
    || !['staged', 'backed-up', 'promoted'].includes(String(candidate.phase))
    || !candidate.existed || typeof candidate.existed.binding !== 'boolean' || typeof candidate.existed.activation !== 'boolean') {
    throw new DkbError(`Runtime selection transaction is invalid at ${source}`, 'runtime_activation_recovery_required');
  }
  return candidate as RuntimeSelectionTransaction;
}

async function restoreRuntimeSelectionTransactionJournal(source: string): Promise<void> {
  if (await fileExists(source)) return;
  const directory = path.dirname(source);
  const prefix = `${path.basename(source)}.replace-`;
  const backups = await fs.readdir(directory, { withFileTypes: true })
    .then((entries) => entries.filter((entry) => entry.isFile() && entry.name.startsWith(prefix)).map((entry) => entry.name), (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
  if (backups.length === 0) return;
  if (backups.length > 1) {
    throw new DkbError(
      `Runtime selection recovery found multiple transaction journal backups at ${directory}`,
      'runtime_activation_recovery_required',
    );
  }
  try {
    await fs.rename(path.join(directory, backups[0]), source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw new DkbError(
      `Runtime selection transaction journal could not be restored at ${source}: ${errorMessage(error)}`,
      'runtime_activation_recovery_required',
    );
  }
}

function runtimeSelectionEntries(
  paths: DkbRuntimeStatePaths,
  transaction: RuntimeSelectionTransaction,
  binding?: DkbRuntimeBinding,
  activation?: DkbRuntimeActivation,
) {
  return [
    {
      target: paths.bindingPath,
      temp: `${paths.bindingPath}.stage-${transaction.stamp}`,
      backup: `${paths.bindingPath}.replace-${transaction.stamp}`,
      existed: transaction.existed.binding,
      value: binding,
    },
    {
      target: paths.activationPath,
      temp: `${paths.activationPath}.stage-${transaction.stamp}`,
      backup: `${paths.activationPath}.replace-${transaction.stamp}`,
      existed: transaction.existed.activation,
      value: activation,
    },
  ];
}

async function rollbackRuntimeSelectionTransaction(
  paths: DkbRuntimeStatePaths,
  transaction: RuntimeSelectionTransaction,
): Promise<string[]> {
  const errors: string[] = [];
  for (const entry of runtimeSelectionEntries(paths, transaction)) {
    const backupExists = await fileExists(entry.backup);
    if (backupExists) {
      await fs.rm(entry.target, { force: true }).catch((error) => errors.push(`${entry.target}: ${errorMessage(error)}`));
      await fs.rename(entry.backup, entry.target).catch((error) => errors.push(`${entry.backup}: ${errorMessage(error)}`));
    } else if (!entry.existed) {
      await fs.rm(entry.target, { force: true }).catch((error) => errors.push(`${entry.target}: ${errorMessage(error)}`));
    }
    await fs.rm(entry.temp, { force: true }).catch((error) => errors.push(`${entry.temp}: ${errorMessage(error)}`));
  }
  if (errors.length === 0) {
    await fs.rm(runtimeSelectionTransactionPath(paths), { force: true }).catch((error) => errors.push(errorMessage(error)));
  }
  if (errors.length === 0) {
    await fs.rm(runtimeSelectionCommitPath(paths, transaction), { force: true }).catch((error) => errors.push(errorMessage(error)));
  }
  return errors;
}

async function cleanupRuntimeSelectionTransaction(paths: DkbRuntimeStatePaths, transaction: RuntimeSelectionTransaction): Promise<void> {
  const entries = runtimeSelectionEntries(paths, transaction);
  await Promise.all(entries.flatMap((entry) => [
    fs.rm(entry.temp, { force: true }).catch(() => undefined),
    fs.rm(entry.backup, { force: true }).catch(() => undefined),
  ]));
  let journalRemoved = false;
  await fs.rm(runtimeSelectionTransactionPath(paths), { force: true })
    .then(() => { journalRemoved = true; }, () => undefined);
  if (journalRemoved) {
    await fs.rm(runtimeSelectionCommitPath(paths, transaction), { force: true }).catch(() => undefined);
  }
}

function runtimeSelectionTransactionPath(paths: DkbRuntimeStatePaths): string {
  return path.join(paths.stateRoot, ...DKB_RUNTIME_SELECTION_TRANSACTION.split('/'));
}

function runtimeSelectionCommitPath(paths: DkbRuntimeStatePaths, transaction: RuntimeSelectionTransaction): string {
  return `${runtimeSelectionTransactionPath(paths)}.commit-${transaction.stamp}`;
}

async function fileExists(target: string): Promise<boolean> {
  return fs.access(target).then(() => true, () => false);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
