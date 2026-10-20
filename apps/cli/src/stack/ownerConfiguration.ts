import fs from 'node:fs/promises';
import path from 'node:path';
import { withDkbFileLock } from '@sjshovan/dkb-library/locks.js';
import { captureLibraryReadFence, assertLibraryReadFence } from '@sjshovan/dkb-library/mutation.js';
import { libraryStateIdentity } from '@sjshovan/dkb-library/state.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { replaceFileAtomically } from '@sjshovan/dkb-protocol/atomicFile.js';
import { DKB_CONFIG_PATH } from '@sjshovan/dkb-pipeline/config.js';
import type { DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import { withRuntimeMutation } from '@sjshovan/dkb-runtime/runtime/mutation.js';
import { inspectRuntimeSelection } from '@sjshovan/dkb-runtime/runtime/state.js';
import { inspectStackOwnerState } from './ownerInspection.js';
import { planStackOwnerRequest, STACK_OWNER_FORMAT, validateStackOwnerInspection,
  type StackOwnerConfigureRequest, type StackOwnerConfigurationResult, type StackOwnerSettleRequest, type StackOwnerCancelRequest } from './ownerContract.js';
import { resolveStackSelection, type StackRecipePaths } from './recipes.js';
import { prepareIdentityConfig } from './recipeConfiguration.js';

export const STACK_CONFIGURATION_JOURNAL = '.dkb/stack-configuration.json';
export const STACK_CONFIGURATION_RECEIPT = '.dkb/stack-configuration.result.json';
type Files = { compiler: string | null; runtime: string | null };
interface Completion extends StackOwnerConfigurationResult {
  scopeDigest: string;
  filesDigest: string;
  selectionDigest: string;
  libraryDigest: string;
  expectedDigest: string;
}
interface Journal {
  format: 'dkb.stack-configuration.v1';
  id: string;
  scopeDigest: string;
  expected: StackOwnerConfigureRequest['input']['expected'];
  before: Files;
  after: Files;
}
const LIMIT = 1024 * 1024;

/** Owner-local configuration only. No binding, activation, Library or service is changed. */
export async function configureStackOwner(distribution: DkbDistribution, paths: StackRecipePaths, value: unknown): Promise<StackOwnerConfigurationResult> {
  const request = planStackOwnerRequest(value);
  if (request.command === 'inspect' || request.command === 'binding.initialize') throw new DkbError('Configuration requires an explicit operation.', 'invalid_stack_owner_request');
  // The compiler context may be shared. Always acquire it before this Runtime.
  return withDkbFileLock(paths.compilerRoot, 'stack-control', () => withRuntimeMutation(paths.runtimeRoot, async () => {
    return request.command === 'configure'
      ? prepare(distribution, paths, request)
      : request.command === 'configuration.cancel' ? cancel(distribution, paths, request) : settle(paths, request);
  }));
}

async function prepare(distribution: DkbDistribution, paths: StackRecipePaths, request: StackOwnerConfigureRequest) {
  const file = path.join(paths.runtimeRoot, STACK_CONFIGURATION_JOURNAL);
  if (await readOptional(file, 8 * LIMIT) !== null) fail('Previous Stack configuration requires settlement before another preparation.', 'stack_owner_recovery_required');
  const { id, scopeDigest, expected, images } = request.input;
  if ((await readCompletion(paths))?.id === id) fail('This Stack operation already settled. Inspect current state and use a new operation identity.', 'stack_owner_already_settled');
  const inspectionRequest = { format: STACK_OWNER_FORMAT, command: 'inspect', input: {
    compilerTarget: expected.plan.compilerTarget, runtimeTarget: expected.plan.runtimeTarget, allowedTargets: expected.plan.compilerTargets,
  } };
  if (stableHash(await inspectStackOwnerState(distribution, paths, inspectionRequest)) !== stableHash(expected)) {
    fail('Library, Runtime or recipe changed after planning. Inspect again; no configuration was changed.', 'stack_owner_config_drift');
  }
  const fence = await captureLibraryReadFence(paths.libraryRoot);
  const before = await readFiles(paths);
  const selection = await resolveStackSelection(distribution, paths, {
    compilerTarget: expected.plan.compilerTarget, runtimeTarget: expected.plan.runtimeTarget,
    allowedTargets: expected.plan.compilerTargets.join(','),
  });
  const environment: Record<string, string> = {}, digests: Record<string, string> = {};
  for (const [name, image] of Object.entries(images)) {
    const service = selection.requiredServices.find(item => item.id === name);
    if (!service?.stack) fail('Image identity names an unselected Stack service.', 'invalid_stack_owner_request');
    environment[service.stack.imageEnvironment] = image.reference;
    digests[name] = image.digest;
  }
  const compiler = await prepareIdentityConfig(configPath(paths, 'compiler'), selection.target, selection.compiler,
    selection.compilerServices, selection, digests, environment);
  const runtime = await prepareIdentityConfig(configPath(paths, 'runtime'), selection.runtimeTarget, selection.runtime,
    selection.runtimeServices, selection, digests, environment);
  compiler.config.activeTarget = selection.target;
  if (expected.runtime.state === 'unbound') runtime.config.activeTarget = selection.runtimeTarget;
  const after = { compiler: encode(compiler.config), runtime: encode(runtime.config) };
  if (Object.values(after).some(source => Buffer.byteLength(source) > LIMIT)) fail('Prepared configuration exceeds its size limit.', 'stack_owner_config_invalid');
  const journal: Journal = { format: 'dkb.stack-configuration.v1', id, scopeDigest, expected, before, after };
  if (stableHash(before) !== stableHash(await readFiles(paths))) fail('Operator configuration changed during preparation.', 'stack_owner_config_drift');
  await assertLibraryReadFence(paths.libraryRoot, fence);
  // Publish the complete recovery record before either file changes. Never replace an existing journal.
  const document = encode({ journal, digest: stableHash(journal) });
  if (Buffer.byteLength(document) > 8 * LIMIT) fail('Stack recovery record exceeds its size limit.', 'stack_owner_config_invalid');
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(document); await handle.sync(); }
  finally { await handle.close(); }
  // After a failure the journal remains authoritative. Settlement checks every file before restoring any.
  for (const key of ['compiler', 'runtime'] as const) {
    if (await readOptional(configPath(paths, key)) !== before[key]) fail('Operator configuration changed after staging. Recover before retrying.', 'stack_owner_config_drift');
    await replace(configPath(paths, key), after[key], id);
  }
  await assertLibraryReadFence(paths.libraryRoot, fence);
  return result(id, 'prepared');
}

/** Cancel a saved host plan even if it never reached this owner. Absence alone is not evidence. */
async function cancel(distribution: DkbDistribution, paths: StackRecipePaths, request: StackOwnerCancelRequest) {
  const { id, scopeDigest, expected } = request.input;
  const source = await readOptional(path.join(paths.runtimeRoot, STACK_CONFIGURATION_JOURNAL), 8 * LIMIT);
  const completed = await readCompletion(paths);
  if (source !== null || completed?.id === id) {
    const pending = source === null ? null : parseJournal(source);
    const previous = pending ?? completed!;
    if (previous.id !== id || previous.scopeDigest !== scopeDigest) fail('Another Stack operation or storage binding owns this recovery state.', 'stack_owner_scope_mismatch');
    if ((pending ? stableHash(pending.expected) : completed!.expectedDigest) !== stableHash(expected)) {
      fail('Cancellation does not match the original Stack observation.', 'stack_owner_config_drift');
    }
    return settle(paths, { format: STACK_OWNER_FORMAT, command: 'configuration.rollback', input: { id, scopeDigest } });
  }
  const fence = await captureLibraryReadFence(paths.libraryRoot);
  const observed = await inspectStackOwnerState(distribution, paths, { format: STACK_OWNER_FORMAT, command: 'inspect', input: {
    compilerTarget: expected.plan.compilerTarget, runtimeTarget: expected.plan.runtimeTarget, allowedTargets: expected.plan.compilerTargets,
  } });
  if (stableHash(observed) !== stableHash(expected)) fail('An unstarted operation cannot be cancelled against changed Stack state.', 'stack_owner_config_drift');
  const current = await readFiles(paths);
  await removeStaged(paths, id);
  await assertLibraryReadFence(paths.libraryRoot, fence);
  // A durable receipt rejects a delayed configure request using this same operation ID.
  return finish(paths, { format: 'dkb.stack-configuration.v1', id, scopeDigest, expected, before: current, after: current }, 'rolled_back', true);
}

async function settle(paths: StackRecipePaths, request: StackOwnerSettleRequest) {
  const file = path.join(paths.runtimeRoot, STACK_CONFIGURATION_JOURNAL);
  const source = await readOptional(file, 8 * LIMIT);
  const completed = await readCompletion(paths);
  if (completed?.id === request.input.id) {
    if (completed.scopeDigest !== request.input.scopeDigest) fail('Stack completion belongs to another storage binding.', 'stack_owner_scope_mismatch');
    if (source !== null) {
      const pending = parseJournal(source);
      if (pending.id !== completed.id || pending.scopeDigest !== completed.scopeDigest) fail('Another Stack operation is pending. Its journal was preserved.', 'stack_owner_recovery_required');
    }
    const fence = await captureLibraryReadFence(paths.libraryRoot);
    if (completed.libraryDigest !== stableHash(await libraryStateIdentity(paths.libraryRoot))
      || completed.filesDigest !== stableHash(await readFiles(paths))
      || completed.selectionDigest !== stableHash(await inspectRuntimeSelection(paths.runtimeRoot))) {
      fail('Stack state changed after completion. Inspect current state; the previous receipt does not authorize rollback.', 'stack_owner_selection_drift');
    }
    if (request.command === 'configuration.commit' && completed.status !== 'committed') fail('This operation rolled back without activation.', 'stack_owner_activation_pending');
    await assertLibraryReadFence(paths.libraryRoot, fence);
    await removeStaged(paths, completed.id);
    if (source !== null) await fs.unlink(file);
    return result(completed.id, completed.status);
  }
  if (source === null) fail('Stack configuration journal is missing; settlement was not assumed successful.', 'stack_owner_recovery_required');
  const journal = parseJournal(source);
  if (journal.id !== request.input.id || journal.scopeDigest !== request.input.scopeDigest) {
    fail('Stack configuration belongs to another operation or storage binding. Nothing was restored.', 'stack_owner_scope_mismatch');
  }
  const current = await readFiles(paths);
  for (const key of ['compiler', 'runtime'] as const) {
    if (current[key] !== journal.before[key] && current[key] !== journal.after[key]) {
      fail('Operator configuration changed outside this operation. Its bytes and recovery journal were preserved.', 'stack_owner_config_drift');
    }
  }
  const selection = await inspectRuntimeSelection(paths.runtimeRoot);
  const same = stableHash(selection) === journal.expected.runtime.selectionDigest;
  if (!same) {
    const { binding, activation } = selection;
    const fence = await captureLibraryReadFence(paths.libraryRoot);
    const library = await libraryStateIdentity(paths.libraryRoot);
    await assertLibraryReadFence(paths.libraryRoot, fence);
    const committed = activation && binding && binding.library.kind === 'local'
      && (journal.expected.runtime.id === null || binding.runtimeId === journal.expected.runtime.id)
      && path.resolve(binding.library.path) === path.resolve(paths.libraryRoot)
      && activation.target === journal.expected.plan.runtimeTarget && binding.target === activation.target
      && stableHash(library) === stableHash(journal.expected.library)
      && activation.library.id === library.id && activation.library.generation === library.generation
      && activation.library.stateDigest === library.stateDigest;
    if (!committed || stableHash(current) !== stableHash(journal.after)) {
      fail('Runtime selection changed concurrently. Its activation and configuration were not rolled back.', 'stack_owner_selection_drift');
    }
    // A timed-out host request may already have committed. Retain the ready selection, even on rollback.
    await removeStaged(paths, journal.id);
    return finish(paths, journal, 'committed');
  }
  if (request.command === 'configuration.commit') fail('Requested Runtime activation has not committed. Configuration and journal were retained.', 'stack_owner_activation_pending');
  await removeStaged(paths, journal.id);
  for (const key of ['compiler', 'runtime'] as const) {
    if (await readOptional(configPath(paths, key)) !== current[key]) fail('Configuration changed during recovery.', 'stack_owner_config_drift');
    if (journal.before[key] === null) await fs.rm(configPath(paths, key), { force: true });
    else await replace(configPath(paths, key), journal.before[key], journal.id);
  }
  return finish(paths, journal, 'rolled_back');
}

/** Publish a bounded acknowledgement before discarding recovery; retry never guesses from absence. */
async function finish(paths: StackRecipePaths, journal: Journal, status: 'committed' | 'rolled_back', unstarted = false) {
  const fence = await captureLibraryReadFence(paths.libraryRoot);
  const libraryDigest = stableHash(await libraryStateIdentity(paths.libraryRoot));
  if ((status === 'committed' || unstarted) && libraryDigest !== stableHash(journal.expected.library)) fail('Library changed before completion. Recovery was not acknowledged.', 'stack_owner_selection_drift');
  const completion: Completion = { ...result(journal.id, status), scopeDigest: journal.scopeDigest,
    expectedDigest: stableHash(journal.expected), libraryDigest, filesDigest: stableHash(await readFiles(paths)), selectionDigest: stableHash(await inspectRuntimeSelection(paths.runtimeRoot)) };
  await replace(path.join(paths.runtimeRoot, STACK_CONFIGURATION_RECEIPT), encode({ completion, digest: stableHash(completion) }), journal.id);
  await assertLibraryReadFence(paths.libraryRoot, fence);
  if (!unstarted) await fs.unlink(path.join(paths.runtimeRoot, STACK_CONFIGURATION_JOURNAL));
  return result(journal.id, status);
}

async function readCompletion(paths: StackRecipePaths): Promise<Completion | null> {
  const source = await readOptional(path.join(paths.runtimeRoot, STACK_CONFIGURATION_RECEIPT), 4096);
  if (source === null) return null;
  try {
    const envelope = JSON.parse(source), value = envelope.completion as Completion;
    if (!value || Object.keys(envelope).sort().join(',') !== 'completion,digest'
      || Object.keys(value).sort().join(',') !== 'expectedDigest,filesDigest,format,id,libraryDigest,scopeDigest,selectionDigest,status'
      || value.format !== 'dkb.stack-owner-configuration.v1' || !['committed', 'rolled_back'].includes(value.status)
      || !/^sha256:[a-f0-9]{64}$/u.test(value.filesDigest) || !/^sha256:[a-f0-9]{64}$/u.test(value.selectionDigest)
      || !/^sha256:[a-f0-9]{64}$/u.test(value.libraryDigest)
      || !/^sha256:[a-f0-9]{64}$/u.test(value.expectedDigest)
      || envelope.digest !== stableHash(value)) throw new Error();
    planStackOwnerRequest({ format: STACK_OWNER_FORMAT, command: 'configuration.rollback', input: { id: value.id, scopeDigest: value.scopeDigest } });
    return value;
  } catch { fail('Invalid Stack completion receipt. Preserve it for inspection; no configuration was changed.', 'stack_owner_recovery_required'); }
}

function parseJournal(source: string): Journal {
  try {
    const envelope = JSON.parse(source), value = envelope.journal as Journal;
    if (!value || value.format !== 'dkb.stack-configuration.v1' || envelope.digest !== stableHash(value)) throw new Error();
    planStackOwnerRequest({ format: STACK_OWNER_FORMAT, command: 'configuration.rollback', input: { id: value.id, scopeDigest: value.scopeDigest } });
    validateStackOwnerInspection(value.expected);
    for (const files of [value.before, value.after]) {
      if (!files || Object.keys(files).sort().join(',') !== 'compiler,runtime'
        || Object.values(files).some(item => item !== null && (typeof item !== 'string' || Buffer.byteLength(item) > LIMIT))) throw new Error();
    }
    if (value.after.compiler === null || value.after.runtime === null) throw new Error();
    return value;
  } catch { fail('Invalid Stack configuration recovery journal. Preserve it for inspection; no configuration was changed.', 'stack_owner_recovery_required'); }
}
function configPath(paths: StackRecipePaths, key: keyof Files) { return path.join(key === 'compiler' ? paths.compilerRoot : paths.runtimeRoot, DKB_CONFIG_PATH); }
async function readFiles(paths: StackRecipePaths): Promise<Files> {
  return { compiler: await readOptional(configPath(paths, 'compiler')), runtime: await readOptional(configPath(paths, 'runtime')) };
}
async function readOptional(file: string, limit = LIMIT): Promise<string | null> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) fail('Stack configuration must be a bounded regular owner-local file.', 'stack_owner_config_invalid');
    return await fs.readFile(file, 'utf8');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function removeStaged(paths: StackRecipePaths, id: string): Promise<void> {
  const staged = (['compiler', 'runtime'] as const).map(key => `${configPath(paths, key)}.stack-${id}.tmp`);
  staged.push(`${path.join(paths.runtimeRoot, STACK_CONFIGURATION_RECEIPT)}.stack-${id}.tmp`);
  // Validate every retained transaction-owned sibling before removing any of them.
  for (const file of staged) await readOptional(file);
  for (const file of staged) await fs.rm(file, { force: true });
}
async function replace(file: string, source: string, id: string): Promise<void> {
  if (await readOptional(file) === source) return;
  const staged = `${file}.stack-${id}.tmp`;
  let created = false;
  try {
    const handle = await fs.open(staged, 'wx', 0o600);
    created = true;
    try { await handle.writeFile(source); await handle.sync(); } finally { await handle.close(); }
    await replaceFileAtomically(staged, file);
  } finally { if (created) await fs.rm(staged, { force: true }); }
}
function encode(value: unknown) { return `${JSON.stringify(value, null, 2)}\n`; }
function result(id: string, status: StackOwnerConfigurationResult['status']): StackOwnerConfigurationResult {
  return { format: 'dkb.stack-owner-configuration.v1', id, status };
}
function fail(message: string, code: string): never { throw new DkbError(message, code); }
