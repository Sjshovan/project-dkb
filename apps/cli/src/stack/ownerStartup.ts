import fs from 'node:fs/promises';
import path from 'node:path';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { replaceFileAtomically } from '@sjshovan/dkb-protocol/atomicFile.js';
import { assertLocalLibraryStorage } from '@sjshovan/dkb-library/storageAccess.js';
import type { DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import { withStackControl } from './control.js';
import { stackControlRoot, stackName, stackStateRoot } from './paths.js';
import { parseEnvironmentFile } from './context.js';
import { configureDockerStackOwner } from './owner.js';
import { planStackOwnerRequest, stackOwnerScopeDigest, validateDockerStackOwner, validateStackOwnerInspection,
  STACK_OWNER_FORMAT, type DockerStackOwner, type StackOwnerConfigureRequest } from './ownerContract.js';

export const STACK_OWNER_STARTUP_JOURNAL = 'owner-startup.json';
export interface StackOwnerStartupPlan {
  owner: DockerStackOwner;
  configuration: StackOwnerConfigureRequest;
  composeFile: string;
  composeDigest: string;
  before: string | null;
  after: string;
  wasRunning: boolean;
  registration: { library: string; runtime: string; registry: string };
}
interface Journal {
  format: 'dkb.stack-owner-startup.v1';
  name: string;
  plan: StackOwnerStartupPlan;
  servicesChanging: boolean;
}
/** Internal topology operations, never browser commands. All four must be retry-safe. */
export interface StackOwnerStartupActions {
  start(plan: StackOwnerStartupPlan): Promise<void>;
  stop(plan: StackOwnerStartupPlan): Promise<void>;
  activate(plan: StackOwnerStartupPlan): Promise<void>;
  register(plan: StackOwnerStartupPlan): Promise<void>;
}
type Transport = typeof configureDockerStackOwner;
const LIMIT = 1024 * 1024;

/** Persist host intent before owner dispatch. Library/Runtime bytes never cross this boundary. */
export async function startOwnedStack(distribution: DkbDistribution, name: string, value: StackOwnerStartupPlan,
  actions: StackOwnerStartupActions, transport: Transport = configureDockerStackOwner): Promise<'committed'> {
  return withStackControl(name, async () => {
    const normalized = stackName(name), file = journalPath(normalized);
    await assertHostPaths(normalized);
    if (await read(file) !== null) recovery(normalized, 'A previous startup still needs settlement.');
    const plan = validatePlan(distribution, normalized, value);
    const journal: Journal = { format: 'dkb.stack-owner-startup.v1', name: normalized, plan, servicesChanging: false };
    await assertTopology(journal, true);
    await save(file, journal);
    try {
      await transport(structuredClone(plan.owner), structuredClone(plan.configuration));
      await assertTopology(journal, true);
      // Save before changing either the environment or Compose. A crash can occur between them.
      journal.servicesChanging = true;
      await save(file, journal);
      await replace(environmentPath(normalized), plan.after);
      await actions.start(structuredClone(plan));
      await assertTopology(journal);
      let activationFailure: unknown;
      try { await actions.activate(structuredClone(plan)); } catch (error) { activationFailure = error; }
      // Lost activation replies are settled from the actual owner state, not inferred from HTTP.
      try {
        await transport(plan.owner, { format: STACK_OWNER_FORMAT, command: 'configuration.commit', input: identity(plan) });
      } catch (error) { throw activationFailure ?? error; }
      await finish(journal, 'committed', actions);
      return 'committed';
    } catch {
      const outcome = await recover(distribution, journal, actions, transport);
      if (outcome === 'committed') return outcome;
      throw new DkbError(`Stack ${normalized} startup failed. Its previous configuration and service topology were restored; no Library or activation was copied. Check: dkb stack doctor ${normalized}`, 'stack_startup_failed');
    }
  });
}

/** Must run before planning another startup. A saved receipt is revalidated by Linux on every retry. */
export async function recoverOwnedStackStartup(distribution: DkbDistribution, name: string,
  actions: StackOwnerStartupActions, transport: Transport = configureDockerStackOwner): Promise<'none' | 'committed' | 'rolled_back'> {
  return withStackControl(name, async () => {
    const normalized = stackName(name);
    await assertHostPaths(normalized);
    const source = await read(journalPath(normalized));
    if (source === null) return 'none';
    return recover(distribution, parseJournal(distribution, normalized, source), actions, transport);
  });
}

async function recover(distribution: DkbDistribution, journal: Journal, actions: StackOwnerStartupActions, transport: Transport) {
  try {
    // Do not restore Linux configuration under an unrelated host topology or changed Compose program.
    validatePlan(distribution, journal.name, journal.plan);
    await assertTopology(journal);
    const { plan } = journal;
    const receipt = await transport(plan.owner, { format: STACK_OWNER_FORMAT, command: 'configuration.cancel',
      input: { ...identity(plan), expected: plan.configuration.input.expected } });
    if (receipt.status === 'prepared') recovery(journal.name, 'The owner did not acknowledge settlement.');
    await finish(journal, receipt.status, actions);
    return receipt.status;
  } catch (error) {
    const code = error instanceof DkbError && /^[a-z_]{1,80}$/u.test(error.code) ? ` (${error.code})` : '';
    recovery(journal.name, `Owner or host settlement could not be confirmed${code}. The exact recovery record was preserved.`);
  }
}

async function finish(journal: Journal, outcome: 'committed' | 'rolled_back', actions: StackOwnerStartupActions) {
  const { plan, name } = journal;
  await assertTopology(journal);
  if (outcome === 'committed') {
    if (await read(environmentPath(name)) !== plan.after) recovery(name, 'The activated owner has a different host topology.');
    // Register only after owner confirmation. Keep the journal if registration fails part way through.
    await actions.register(structuredClone(plan));
  } else {
    if (journal.servicesChanging) await actions.stop(structuredClone(plan));
    await assertTopology(journal);
    if (plan.before === null) {
      await read(`${environmentPath(name)}.owner-startup.tmp`);
      await fs.rm(`${environmentPath(name)}.owner-startup.tmp`, { force: true });
      await fs.rm(environmentPath(name), { force: true });
    }
    else await replace(environmentPath(name), plan.before);
    if (journal.servicesChanging && plan.wasRunning) await actions.start({ ...structuredClone(plan), after: plan.before! });
  }
  // A callback may not silently change topology and then erase the only recovery record.
  await assertHostPaths(name);
  const expected = outcome === 'committed' ? plan.after : plan.before;
  if (await read(environmentPath(name)) !== expected) recovery(name, 'Host topology changed during settlement.');
  await fs.unlink(journalPath(name));
}

function validatePlan(distribution: DkbDistribution, name: string, value: StackOwnerStartupPlan): StackOwnerStartupPlan {
  const plan = structuredClone(value);
  exact(plan, ['owner', 'configuration', 'composeFile', 'composeDigest', 'before', 'after', 'wasRunning', 'registration']);
  validateDockerStackOwner(plan.owner);
  const request = planStackOwnerRequest(plan.configuration);
  if (request.command !== 'configure' || request.input.scopeDigest !== stackOwnerScopeDigest(plan.owner)) invalid();
  validateStackOwnerInspection(request.input.expected, distribution);
  if (typeof plan.composeFile !== 'string' || !path.isAbsolute(plan.composeFile) || plan.composeFile.includes('\0')
    || !/^sha256:[a-f0-9]{64}$/u.test(plan.composeDigest) || typeof plan.wasRunning !== 'boolean') invalid();
  if (plan.before !== null && (typeof plan.before !== 'string' || Buffer.byteLength(plan.before) > LIMIT)) invalid();
  if (typeof plan.after !== 'string' || Buffer.byteLength(plan.after) > LIMIT || (plan.wasRunning && plan.before === null)) invalid();
  exact(plan.registration, ['library', 'runtime', 'registry']);
  if (Object.values(plan.registration).some(item => typeof item !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(item))) invalid();
  const environment = parseEnvironmentFile(plan.after);
  const required: Record<string, string> = { DKB_STACK_NAME: name, DKB_DOCKER_CONTEXT: plan.owner.context, DKB_CLI_IMAGE: plan.owner.image,
    DKB_LIBRARY_VOLUME: plan.owner.libraryVolume, DKB_RUNTIME_VOLUME: plan.owner.runtimeVolume, DKB_COMPILER_CONTEXT_VOLUME: plan.owner.compilerVolume,
    DKB_COMPILER_DEFAULT_TARGET: request.input.expected.plan.compilerTarget, DKB_RUNTIME_PIPELINE_TARGET: request.input.expected.plan.runtimeTarget };
  if (Object.entries(required).some(([key, item]) => environment[key] !== item)) invalid();
  return plan;
}
async function assertTopology(journal: Journal, beforeOnly = false) {
  await assertHostPaths(journal.name);
  const { plan } = journal;
  const current = await read(environmentPath(journal.name));
  if (current !== plan.before && (beforeOnly || current !== plan.after)) recovery(journal.name, 'Host configuration changed outside this startup.');
  const compose = await read(plan.composeFile);
  if (compose === null || stableHash(compose) !== plan.composeDigest) recovery(journal.name, 'The saved Compose distribution changed or is missing.');
}
function parseJournal(distribution: DkbDistribution, name: string, source: string): Journal {
  try {
    const envelope = JSON.parse(source), journal = envelope.journal as Journal;
    exact(envelope, ['journal', 'digest']); exact(journal, ['format', 'name', 'plan', 'servicesChanging']);
    if (journal.format !== 'dkb.stack-owner-startup.v1' || journal.name !== name || typeof journal.servicesChanging !== 'boolean'
      || envelope.digest !== stableHash(journal)) invalid();
    validatePlan(distribution, name, journal.plan);
    return journal;
  } catch { recovery(name, 'The startup recovery record is invalid; preserve it for inspection.'); }
}
async function save(file: string, journal: Journal) { await replace(file, `${JSON.stringify({ journal, digest: stableHash(journal) })}\n`); }
async function read(file: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * LIMIT) invalid();
    return await fs.readFile(file, 'utf8');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function replace(file: string, source: string) {
  await assertLocalLibraryStorage(stackStateRoot(), [file, `${file}.owner-startup.tmp`]);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // One host lease owns this sibling. On process death, the previous complete journal remains authoritative.
  const staged = `${file}.owner-startup.tmp`;
  await read(staged);
  await fs.rm(staged, { force: true });
  const handle = await fs.open(staged, 'wx', 0o600);
  try { await handle.writeFile(source); await handle.sync(); } finally { await handle.close(); }
  await replaceFileAtomically(staged, file);
}
function identity(plan: StackOwnerStartupPlan) { return { id: plan.configuration.input.id, scopeDigest: plan.configuration.input.scopeDigest }; }
const environmentPath = (name: string) => path.join(stackStateRoot(), name, 'stack.env');
const journalPath = (name: string) => path.join(stackControlRoot(name), STACK_OWNER_STARTUP_JOURNAL);
async function assertHostPaths(name: string): Promise<void> {
  const files = [environmentPath(name), journalPath(name)];
  try {
    // Reuse fresh ancestor/storage checks. No Library manifest or database is opened here.
    await assertLocalLibraryStorage(stackStateRoot(), files.flatMap(file => [file, `${file}.owner-startup.tmp`]));
  } catch {
    recovery(name, 'Host startup paths must remain ordinary files under the original local Stack directory. Linked or redirected paths were not followed.');
  }
}
function exact(value: unknown, keys: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys.sort().join(',')) invalid();
}
function invalid(): never { throw new DkbError('Invalid owner-side Stack startup plan. No Library or Runtime state was opened by the host.', 'invalid_stack_startup_plan'); }
function recovery(name: string, reason: string): never {
  throw new DkbError(`Stack ${name} requires recovery. ${reason} Retry: dkb stack up ${name}. Recovery record: ${journalPath(name)}`, 'stack_recovery_required');
}
