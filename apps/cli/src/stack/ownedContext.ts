import fs from 'node:fs/promises';
import path from 'node:path';
import type { DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { parseEnvironmentFile, positivePort, resolveComposeFile, serviceProfiles } from './context.js';
import { stackName, stackStateRoot } from './paths.js';
import { readStackStorage, storageEnvironment } from './ownedStorage.js';
import type { DockerStackOwner } from './ownerContract.js';
import type { DkbStackServiceContext } from './types.js';

export interface OwnedStackContext extends DkbStackServiceContext { owner: DockerStackOwner }

/** Host topology only. Current activation is observed by the owner or Runtime API, never read from Windows. */
export async function readOwnedStack(distribution: DkbDistribution, name: string): Promise<OwnedStackContext> {
  const storage = await readStackStorage(name);
  if (!storage || storage.phase !== 'ready') throw new DkbError(`Stack ${name} has no ready Linux storage owner. Run dkb stack up ${name}; existing host-mounted Stacks require explicit migration.`, 'stack_owner_required');
  const source = await fs.readFile(path.join(stackStateRoot(), stackName(name), 'stack.env'), 'utf8');
  const values = parseEnvironmentFile(source);
  if (Object.entries(storageEnvironment(storage)).some(([key, value]) => values[key] !== value)) {
    throw new DkbError(`Stack ${name} topology does not match its storage descriptor. Preserve both for recovery; no volumes were remounted.`, 'stack_storage_mismatch');
  }
  return ownedStackContext(distribution, storage.owner, source, await resolveComposeFile());
}

export function ownedStackContext(distribution: DkbDistribution, owner: DockerStackOwner, source: string, composeFile: string): OwnedStackContext {
  const values = parseEnvironmentFile(source), name = stackName(values.DKB_STACK_NAME ?? '');
  if (values.DKB_DOCKER_CONTEXT !== owner.context || values.DKB_CLI_IMAGE !== owner.image
    || values.DKB_LIBRARY_VOLUME !== owner.libraryVolume || values.DKB_RUNTIME_VOLUME !== owner.runtimeVolume
    || values.DKB_COMPILER_CONTEXT_VOLUME !== owner.compilerVolume || values.DKB_LIBRARY_HOST_PATH) {
    throw new DkbError('Stack environment and Linux owner do not agree; no host Library path is supported.', 'stack_storage_mismatch');
  }
  const ids = (values.DKB_STACK_REQUIRED_SERVICES ?? '').split(',');
  if (!ids.length || ids.some(id => !distribution.services.some(service => service.id === id)) || new Set(ids).size !== ids.length) {
    throw new DkbError('Stack service topology is invalid. Replan it with dkb stack up.', 'invalid_stack_topology');
  }
  const requiredServices = distribution.services.filter(service => ids.includes(service.id));
  if (distribution.services.some(service => !service.providerId && !ids.includes(service.id))) {
    throw new DkbError('Stack topology is missing infrastructure services.', 'invalid_stack_topology');
  }
  const servicePorts = Object.fromEntries(distribution.services.flatMap(service => service.stack?.health
    ? [[service.id, positivePort(values[service.stack.health.portEnvironment], service.id)]] : []));
  const registryPort = servicePorts.registry!, runtimePort = servicePorts.runtime!;
  const root = path.join(stackStateRoot(), name);
  return { owner, name, projectName: `dkb-${name}`, root, dockerContext: owner.context, composeFile, envFile: path.join(root, 'stack.env'),
    target: values.DKB_COMPILER_DEFAULT_TARGET!, runtimeTarget: values.DKB_RUNTIME_PIPELINE_TARGET!,
    compilerTargets: (values.DKB_COMPILER_ALLOWED_TARGETS ?? '').split(',').filter(Boolean), recipeDigest: values.DKB_STACK_RECIPE_DIGEST!,
    registryPort, runtimePort, registryUrl: `http://127.0.0.1:${registryPort}`, runtimeUrl: `http://127.0.0.1:${runtimePort}`,
    requiredServices, servicePorts, profiles: serviceProfiles(requiredServices), allProfiles: serviceProfiles(distribution.services),
    inactiveComposeServices: distribution.services.flatMap(service => service.stack?.composeProfile && !requiredServices.includes(service)
      ? [service.stack.composeService ?? service.id] : []),
    ...(values.DKB_STACK_VERSION ? { version: values.DKB_STACK_VERSION } : {}) };
}

export function encodeStackEnvironment(values: Record<string, string>): string {
  if (Object.entries(values).some(([key, value]) => !/^[A-Z][A-Z0-9_]*$/u.test(key) || /[\0\r\n]/u.test(value))) {
    throw new DkbError('Stack environment contains an invalid key or multiline value.', 'invalid_stack_environment');
  }
  return `${Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}
