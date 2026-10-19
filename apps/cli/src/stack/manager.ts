import type { DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { readHostInventory } from '../host/inventory.js';
import { backupDkbStack, restoreDkbStack } from './backups.js';
import {
  pathExists,
  prepareDkbStack,
  readDkbStackControl,
  runtimeAdminTokenForUrl,
} from './context.js';
import {
  assertDockerAvailable,
  composeArguments,
  composeServices,
  probeStack,
  runComposeControl,
} from './docker.js';
import { upgradeDkbStackRelease } from './release.js';
import { upOwnedStack } from './ownedManager.js';
import { readOwnedStack } from './ownedContext.js';
import { withStackControl } from './control.js';
import type { DkbStackListing, DkbStackStatus, DkbStackTarget, DkbStackUpgrade } from './types.js';

export type {
  DkbStackBackup,
  DkbStackContext,
  DkbStackRestore,
  DkbStackListing,
  DkbStackStatus,
  DkbStackTarget,
  DkbStackUpgrade,
} from './types.js';
export { backupDkbStack, composeArguments, prepareDkbStack, restoreDkbStack, runtimeAdminTokenForUrl };

export async function listDkbStacks(distribution: DkbDistribution, check = false): Promise<DkbStackListing> {
  const inventory = await readHostInventory();
  const stacks = await Promise.all(Object.entries(inventory.stacks).map(async ([name, stack]) => {
    try {
      const context = await readOwnedStack(distribution, name);
      if (!check) {
        return {
          name,
          default: inventory.defaults.stack === name,
          stateRoot: stack.stateRoot,
          ...(stack.library ? { library: stack.library } : {}),
          ...(stack.registry ? { registry: stack.registry } : {}),
          ...(stack.runtime ? { runtime: stack.runtime } : {}),
          target: context.target,
          status: 'known' as const,
        };
      }
      const status = await statusDkbStack(distribution, name, true);
      const healthy = status.checks?.every((item) => item.status === 'ok') ?? false;
      return {
        name,
        default: inventory.defaults.stack === name,
        stateRoot: stack.stateRoot,
        ...(stack.library ? { library: stack.library } : {}),
        ...(stack.registry ? { registry: stack.registry } : {}),
        ...(stack.runtime ? { runtime: stack.runtime } : {}),
        target: status.target,
        status: healthy ? 'online' as const : 'offline' as const,
        ...(!healthy ? { message: status.checks?.filter((item) => item.status === 'failed').map((item) => item.message).join('; ') || 'One or more services are unavailable.' } : {}),
      };
    } catch (error) {
      const missing = !await pathExists(stack.stateRoot);
      return {
        name,
        default: inventory.defaults.stack === name,
        stateRoot: stack.stateRoot,
        ...(stack.library ? { library: stack.library } : {}),
        ...(stack.registry ? { registry: stack.registry } : {}),
        ...(stack.runtime ? { runtime: stack.runtime } : {}),
        status: missing ? 'missing' as const : check ? 'offline' as const : 'invalid' as const,
        message: errorMessage(error),
      };
    }
  }));

  return {
    checked: check,
    ...(inventory.defaults.stack ? { default: inventory.defaults.stack } : {}),
    stacks: stacks.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export async function upDkbStack(
  distribution: DkbDistribution,
  name = 'local',
  options: {
    compilerTarget?: DkbStackTarget;
    runtimeTarget?: DkbStackTarget;
    libraryRoot?: string;
    library?: string;
  } = {},
): Promise<DkbStackStatus & {
  status: 'ready';
  registryName: string;
  runtimeName: string;
  libraryName: string;
}> {
  if (options.libraryRoot) throw new DkbError('Host Library paths cannot be mounted into a Docker Stack. Register a Docker-owned Library and select it with --library.', 'stack_library_owner_required');
  const context = await upOwnedStack(distribution, name, options);
  const inventory = await readHostInventory();
  const registration = inventory.stacks[context.name]!;
  return { ...await statusDkbStack(distribution, context.name, true), status: 'ready',
    registryName: registration.registry!, runtimeName: registration.runtime!, libraryName: registration.library! };
}

export async function downDkbStack(
  distribution: DkbDistribution,
  name = 'local',
): Promise<{ status: 'stopped'; name: string; stateRoot: string; preserved: string[] }> {
  return withStackControl(name, () => stopStack(distribution, name));
}

async function stopStack(distribution: DkbDistribution, name: string): Promise<{
  status: 'stopped'; name: string; stateRoot: string; preserved: string[];
}> {
  const context = await readDkbStackControl(distribution, name);
  assertDockerAvailable();
  runComposeControl(context, ['down', '--remove-orphans']);
  return {
    status: 'stopped',
    name: context.name,
    stateRoot: context.root,
    preserved: ['Registry data', 'Runtime Library', 'stack secrets', 'host inventory entries'],
  };
}

export async function statusDkbStack(
  distribution: DkbDistribution,
  name = 'local',
  check = false,
): Promise<DkbStackStatus> {
  const context = await readOwnedStack(distribution, name);
  assertDockerAvailable();
  return {
    name: context.name,
    target: context.target,
    runtimeTarget: context.runtimeTarget,
    stateRoot: context.root,
    composeFile: context.composeFile,
    registryUrl: context.registryUrl,
    runtimeUrl: context.runtimeUrl,
    ...(context.version ? { version: context.version } : {}),
    services: composeServices(context),
    ...(check ? { checks: await probeStack(context) } : {}),
  };
}

export async function doctorDkbStack(
  distribution: DkbDistribution,
  name = 'local',
): Promise<DkbStackStatus & { ok: boolean; checks: Array<{ component: string; status: 'ok' | 'failed'; message: string }> }> {
  const context = await readOwnedStack(distribution, name);
  const checks: Array<{ component: string; status: 'ok' | 'failed'; message: string }> = [];
  let dockerReady = false;
  try {
    assertDockerAvailable();
    dockerReady = true;
    checks.push({ component: 'docker', status: 'ok', message: 'Docker Compose is available.' });
  } catch (error) {
    checks.push({ component: 'docker', status: 'failed', message: errorMessage(error) });
  }
  checks.push({ component: 'compose', status: await pathExists(context.composeFile) ? 'ok' : 'failed', message: context.composeFile });
  checks.push({ component: 'secrets', status: await pathExists(context.envFile) ? 'ok' : 'failed', message: context.envFile });
  checks.push(...await probeStack(context));
  const fallbackStatus = {
    name: context.name,
    target: context.target,
    runtimeTarget: context.runtimeTarget,
    stateRoot: context.root,
    composeFile: context.composeFile,
    registryUrl: context.registryUrl,
    runtimeUrl: context.runtimeUrl,
    services: [],
  };
  const status = dockerReady
    ? await statusDkbStack(distribution, context.name, false).catch(() => fallbackStatus)
    : fallbackStatus;
  return { ...status, ok: checks.every((item) => item.status === 'ok'), checks };
}

export async function logsDkbStack(
  distribution: DkbDistribution,
  name = 'local',
  service?: string,
  follow = false,
): Promise<void> {
  const context = await readDkbStackControl(distribution, name);
  assertDockerAvailable();
  runComposeControl(context, ['logs', ...(follow ? ['--follow'] : []), '--tail', follow ? '100' : '200', ...(service ? [service] : [])], true);
}

export async function upgradeDkbStack(
  distribution: DkbDistribution,
  name: string,
  lockPath: string,
): Promise<DkbStackUpgrade> {
  assertDockerAvailable();
  return upgradeDkbStackRelease(
    distribution,
    name,
    lockPath,
    async (stackName, target) => upDkbStack(distribution, stackName, { compilerTarget: target }),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
