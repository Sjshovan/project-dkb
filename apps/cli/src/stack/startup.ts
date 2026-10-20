import fs from 'node:fs/promises';
import path from 'node:path';
import { libraryStateIdentity, type DkbLibraryStateIdentity } from '@sjshovan/dkb-library/state.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { canonicalJson } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { validateRuntimeActivation, validateRuntimeBinding } from '@sjshovan/dkb-protocol/runtimeActivation.js';
import { withRuntimeMutation } from '@sjshovan/dkb-runtime/runtime/mutation.js';
import { inspectRuntimeSelection } from '@sjshovan/dkb-runtime/runtime/state.js';
import type { DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import { readDkbStack, readDkbStackControl, stackName, stackStateRoot, writeAtomic } from './context.js';
import { composeContainerIds, runCompose, runComposeControl } from './docker.js';
import type { DkbStackContext } from './types.js';
import { withStackControl } from './control.js';

const FILES = ['stack.env', 'compiler-context/.dkb/config.json', 'runtime/.dkb/config.json'] as const;
const JOURNAL = 'startup-recovery.json';
type Files = Record<typeof FILES[number], string | null>;
type Selection = { binding: string | null; activation: string | null };
interface Recovery {
  format: 'dkb.stack-startup.v1';
  files: Files;
  written: Files;
  selection: Selection;
  servicesChanged: boolean;
  wasRunning: boolean;
  expected: { target: string; library: DkbLibraryStateIdentity } | null;
}

export interface StackStartup {
  /** Config changes are serialized with Runtime mutations, not with the HTTP activation request. */
  configure<T>(operation: () => Promise<T>): Promise<T>;
  changeServices(context: DkbStackContext, operation: () => void): Promise<void>;
  activate(context: DkbStackContext, operation: () => Promise<unknown>): Promise<void>;
}

/** Stack rollback owns configuration and mounts only. Runtime selection is never restored by file copying. */
export async function withStackStartup<T>(distribution: DkbDistribution, name: string, operation: (startup: StackStartup) => Promise<T>): Promise<T> {
  const root = path.join(stackStateRoot(), stackName(name));
  const runtimeRoot = path.join(root, 'runtime');
  return withStackControl(name, async () => {
    const recoveryPath = path.join(root, JOURNAL);
    const pending = await readOptional(recoveryPath);
    if (pending !== null) {
      const recovery = parseRecovery(pending);
      await restoreOrRetain(distribution, name, root, recovery);
      await fs.rm(recoveryPath);
    }
    const initial = await withRuntimeMutation(runtimeRoot, async () => ({ files: await readFiles(root), selection: await readSelection(runtimeRoot) }));
    const existing = initial.files['stack.env'] !== null;
    const recovery: Recovery = { format: 'dkb.stack-startup.v1', ...initial, written: initial.files, servicesChanged: false, wasRunning: false, expected: null };
    const save = () => existing ? writeAtomic(recoveryPath, `${JSON.stringify(recovery, null, 2)}\n`) : Promise.resolve();
    let committed = false;
    await save();
    try {
      return await operation({
        configure: (action) => withRuntimeMutation(runtimeRoot, async () => {
          if (existing) await assertUnchangedSelection(runtimeRoot, recovery.selection);
          try { return await action(); } finally { recovery.written = await readFiles(root); await save(); }
        }),
        changeServices: async (context, action) => {
          await withRuntimeMutation(runtimeRoot, async () => {
            if (existing) await assertUnchangedSelection(runtimeRoot, recovery.selection);
            recovery.wasRunning = existing && (await composeContainerIds(context)).length > 0;
            recovery.servicesChanged = true;
            await save();
          });
          // Starting Runtime also acquires its mutation lock. Do not hold that
          // lock across Compose --wait; revalidate selection before activation.
          action();
        },
        activate: async (context, action) => {
          await withRuntimeMutation(runtimeRoot, async () => {
            if (existing) await assertUnchangedSelection(runtimeRoot, recovery.selection);
            recovery.expected = { target: context.runtimeTarget, library: await libraryStateIdentity(context.libraryRoot) };
            await save();
          });
          let failure: unknown;
          try { await action(); } catch (error) { failure = error; }
          // A timeout is not proof of failure. Wait for the owning mutation gate,
          // then observe its committed selection before deciding whether to roll back.
          committed = await withRuntimeMutation(runtimeRoot, () => requestedSelectionCommitted(runtimeRoot, recovery));
          if (!committed) throw failure ?? new DkbError(`Stack ${name} Runtime did not persist the requested activation. Run: dkb stack doctor ${name}`);
          if (existing) await fs.rm(recoveryPath);
        },
      });
    } catch (error) {
      if (existing && !committed) {
        try {
          await restoreOrRetain(distribution, name, root, recovery);
          await fs.rm(recoveryPath);
        } catch (restoreError) {
          throw new DkbError(`Stack ${name} startup failed: ${message(error)} Recovery was not completed: ${message(restoreError)} `
            + `Previous configuration is retained in ${recoveryPath}. Resolve the reported issue, then retry: dkb stack up ${name}`, 'stack_recovery_required');
        }
      }
      throw error;
    }
  });
}

async function restoreOrRetain(distribution: DkbDistribution, name: string, root: string, recovery: Recovery): Promise<void> {
  let restart: DkbStackContext | undefined;
  await withRuntimeMutation(path.join(root, 'runtime'), async () => {
    if (await requestedSelectionCommitted(path.join(root, 'runtime'), recovery)) return;
    await assertUnchangedSelection(path.join(root, 'runtime'), recovery.selection);
    const current = await readFiles(root);
    for (const file of FILES) {
      if (current[file] !== recovery.written[file] && current[file] !== recovery.files[file]) {
        throw new DkbError(`${file} changed outside this Stack operation; it was not overwritten. Compare it with ${JOURNAL} before retrying.`);
      }
    }
    if (recovery.servicesChanged) runComposeControl(await readDkbStackControl(distribution, name), ['down', '--remove-orphans']);
    for (const file of FILES) {
      if (recovery.files[file] === null) await fs.rm(path.join(root, file), { force: true });
      else await writeAtomic(path.join(root, file), recovery.files[file]);
    }
    if (recovery.servicesChanged && recovery.wasRunning) {
      restart = await readDkbStack(distribution, name);
    }
  });
  if (restart) runCompose(restart, ['up', '-d', '--remove-orphans', '--wait', '--wait-timeout', '240']);
}

async function requestedSelectionCommitted(root: string, recovery: Recovery): Promise<boolean> {
  if (!recovery.expected) return false;
  const current = await readSelection(root);
  if (current.activation === null || current.binding === null || sameSelection(current, recovery.selection)) return false;
  const activation = validateRuntimeActivation(JSON.parse(current.activation));
  const binding = validateRuntimeBinding(JSON.parse(current.binding));
  const expected = recovery.expected;
  return activation.runtimeId === binding.runtimeId && binding.target === expected.target && activation.target === expected.target
    && activation.library.id === expected.library.id && activation.library.generation === expected.library.generation
    && activation.library.stateDigest === expected.library.stateDigest;
}

async function assertUnchangedSelection(root: string, previous: Selection): Promise<void> {
  if (!sameSelection(await readSelection(root), previous)) throw new DkbError('Runtime selection changed concurrently; its activation, configuration and Library mount were not rolled back. Inspect the Runtime before retrying.');
}

const sameSelection = (left: Selection, right: Selection) => left.binding === right.binding && left.activation === right.activation;
async function readSelection(root: string): Promise<Selection> {
  const { binding, activation } = await inspectRuntimeSelection(root);
  return { binding: binding === null ? null : canonicalJson(binding), activation: activation === null ? null : canonicalJson(activation) };
}
async function readFiles(root: string): Promise<Files> {
  return Object.fromEntries(await Promise.all(FILES.map(async (file) => [file, await readOptional(path.join(root, file))]))) as Files;
}
async function readOptional(file: string): Promise<string | null> {
  try { return await fs.readFile(file, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function parseRecovery(source: string): Recovery {
  let value: Recovery;
  try { value = JSON.parse(source) as Recovery; } catch {
    throw new DkbError('Invalid Stack startup recovery journal. Back it up and inspect it before retrying; no state was changed.');
  }
  if (!value || value.format !== 'dkb.stack-startup.v1' || typeof value.servicesChanged !== 'boolean' || typeof value.wasRunning !== 'boolean'
    || !value.selection || !value.files || !value.written || !('expected' in value)
    || FILES.some((file) => ![value.files[file], value.written[file]].every((item) => item === null || typeof item === 'string'))
    || ![value.selection.activation, value.selection.binding].every((item) => item === null || typeof item === 'string')) {
    throw new DkbError('Invalid Stack startup recovery journal. Back it up and inspect it before retrying; no state was changed.');
  }
  if (value.expected !== null && (typeof value.expected !== 'object' || Array.isArray(value.expected)
    || typeof value.expected.target !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/u.test(value.expected.target)
    || !value.expected.library || typeof value.expected.library !== 'object' || Array.isArray(value.expected.library)
    || typeof value.expected.library.id !== 'string' || value.expected.library.id.trim().length === 0
    || !Number.isInteger(value.expected.library.generation) || value.expected.library.generation < 0
    || !/^sha256:[a-f0-9]{64}$/u.test(value.expected.library.stateDigest))) throw new DkbError('Invalid Stack startup recovery expectation; no state was changed.');
  value.selection = {
    binding: value.selection.binding === null ? null : canonicalJson(validateRuntimeBinding(JSON.parse(value.selection.binding))),
    activation: value.selection.activation === null ? null : canonicalJson(validateRuntimeActivation(JSON.parse(value.selection.activation))),
  };
  return value;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
