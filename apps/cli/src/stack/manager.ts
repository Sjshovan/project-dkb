import path from 'node:path';
import type { DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { readHostInventory, registerHostLibrary, registerHostRegistry, registerHostRuntime, registerHostStack } from '../host/inventory.js';
import { backupDkbStack, restoreDkbStack } from './backups.js';
import {
  pathExists,
  prepareDkbStack,
  readDkbStack,
  runtimeAdminTokenForUrl,
} from './context.js';
import {
  assertDockerAvailable,
  assertPortAvailable,
  assertRequiredImages,
  composeArguments,
  composeContainerIds,
  composeServices,
  migrateLegacyRegistryVolume,
  probeStack,
  runCompose,
} from './docker.js';
import { upgradeDkbStackRelease } from './release.js';
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
      const context = await readDkbStack(distribution, name);
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
  target?: DkbStackTarget,
): Promise<DkbStackStatus & {
  status: 'ready';
  registryName: string;
  runtimeName: string;
  libraryName: string;
  legacyRegistryVolume?: { status: 'copied'; volume: string; preserved: true };
}> {
  const context = await prepareDkbStack(distribution, name, target);
  assertDockerAvailable();
  assertRequiredImages(context);
  const legacyRegistryVolume = await migrateLegacyRegistryVolume(context);

  if ((await composeContainerIds(context)).length === 0) {
    await assertPortAvailable(context.registryPort, 'Registry');
    await assertPortAvailable(context.runtimePort, 'Runtime');
    for (const service of context.requiredServices) {
      const port = context.servicePorts[service.id];
      if (port !== undefined && port !== context.registryPort && port !== context.runtimePort) {
        await assertPortAvailable(port, service.stack?.health?.component ?? service.id);
      }
    }
  }

  if (context.inactiveComposeServices.length > 0) {
    runCompose(
      context,
      ['rm', '--force', '--stop', ...context.inactiveComposeServices],
      false,
      false,
      'all',
    );
  }
  runCompose(context, ['up', '-d', '--remove-orphans', '--wait', '--wait-timeout', '240']);
  const checks = await probeStack(context);
  const failed = checks.filter((check) => check.status === 'failed');
  if (failed.length > 0) {
    throw new DkbError(
      `DKB stack ${context.name} started but is not healthy: ${failed.map((check) => `${check.component}: ${check.message}`).join('; ')}. `
      + `Run: dkb stack logs ${context.name} ${failed[0]!.component}`,
    );
  }

  const inventory = await readHostInventory();
  const runtimeStateRoot = path.resolve(context.root, 'runtime');
  const existingLibrary = Object.entries(inventory.libraries).find(([, item]) => samePath(item.path, runtimeStateRoot));
  const existingRegistry = Object.entries(inventory.registries).find(([, item]) => item.url === context.registryUrl);
  const existingRuntime = Object.entries(inventory.runtimes).find(([, item]) => item.url === context.runtimeUrl);
  const registry = await registerHostRegistry(existingRegistry?.[0] ?? `${context.name}-registry`, context.registryUrl, { select: 'if-empty' });
  const library = await registerHostLibrary(runtimeStateRoot, {
    name: existingLibrary?.[0] ?? `${context.name}-library`,
    registryName: registry.name,
    registryUrl: context.registryUrl,
    select: 'if-empty',
  });
  const runtime = await registerHostRuntime(existingRuntime?.[0] ?? `${context.name}-runtime`, context.runtimeUrl, {
    kind: 'docker',
    library: library.name,
    stateRoot: runtimeStateRoot,
    composeFile: context.composeFile,
    select: 'if-empty',
  });
  await registerHostStack(context.name, context.root, {
    library: library.name,
    registry: registry.name,
    runtime: runtime.name,
    select: 'if-empty',
  });

  return {
    ...await statusDkbStack(distribution, context.name, true),
    status: 'ready',
    registryName: registry.name,
    runtimeName: runtime.name,
    libraryName: library.name,
    ...(legacyRegistryVolume ? { legacyRegistryVolume } : {}),
  };
}

export async function downDkbStack(
  distribution: DkbDistribution,
  name = 'local',
): Promise<{ status: 'stopped'; name: string; stateRoot: string; preserved: string[] }> {
  const context = await readDkbStack(distribution, name);
  assertDockerAvailable();
  runCompose(context, ['down', '--remove-orphans']);
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
  const context = await readDkbStack(distribution, name);
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
  const context = await readDkbStack(distribution, name);
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
  const context = await readDkbStack(distribution, name);
  assertDockerAvailable();
  runCompose(context, ['logs', ...(follow ? ['--follow'] : []), '--tail', follow ? '100' : '200', ...(service ? [service] : [])], true);
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
    async (stackName, target) => upDkbStack(distribution, stackName, target),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function samePath(left: string, right: string): boolean {
  const first = path.resolve(left);
  const second = path.resolve(right);
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}
