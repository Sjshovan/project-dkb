import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { maybeReadRuntimeLock } from '@sjshovan/dkb-library/builds.js';
import type { DkbDistribution, DkbDistributionService } from '@sjshovan/dkb-pipeline/host.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbStackContext, DkbStackTarget } from './types.js';

export async function prepareDkbStack(
  distribution: DkbDistribution,
  name = 'local',
  requestedTarget?: DkbStackTarget,
): Promise<DkbStackContext> {
  const normalizedName = stackName(name);
  const root = path.join(stackStateRoot(), normalizedName);
  const target = requestedTarget ?? distributionDefaultTarget(distribution);
  const recipe = targetRecipe(distribution, target);
  const composeFile = await resolveComposeFile();
  const envFile = path.join(root, 'stack.env');
  const requiredServices = requiredStackServices(distribution, target);

  await Promise.all([
    fs.mkdir(path.join(root, 'registry', 'data'), { recursive: true }),
    fs.mkdir(path.join(root, 'registry', 'storage'), { recursive: true }),
    fs.mkdir(path.join(root, 'compiler-context', '.dkb'), { recursive: true }),
    fs.mkdir(path.join(root, 'compiler-jobs'), { recursive: true }),
    fs.mkdir(path.join(root, 'runtime', '.dkb'), { recursive: true }),
    ...distribution.services.flatMap((service) => service.stack?.stateDirectory
      ? [fs.mkdir(path.join(root, service.stack.stateDirectory), { recursive: true })]
      : []),
  ]);

  const existing = await readEnvironmentFile(envFile);
  const runtimeRoot = path.join(root, 'runtime');
  const activeRuntimeBuild = await maybeReadRuntimeLock(runtimeRoot);
  const values: Record<string, string> = {
    ...existing,
    DKB_STACK_NAME: normalizedName,
    DKB_STACK_STATE: root.replace(/\\/gu, '/'),
    DKB_PIPELINE_TARGET: target,
    DKB_BUILD_COMMIT: existing.DKB_BUILD_COMMIT ?? process.env.DKB_BUILD_COMMIT ?? 'development',
    DKB_REGISTRY_APP_KEY: existing.DKB_REGISTRY_APP_KEY ?? `base64:${randomBytes(32).toString('base64')}`,
    DKB_REGISTRY_BOOTSTRAP_NAMESPACE: existing.DKB_REGISTRY_BOOTSTRAP_NAMESPACE ?? namespaceForStack(normalizedName),
    DKB_REGISTRY_BOOTSTRAP_TOKEN: existing.DKB_REGISTRY_BOOTSTRAP_TOKEN ?? `dkb_${randomBytes(48).toString('base64url')}`,
    DKB_MCP_BEARER_TOKEN: existing.DKB_MCP_BEARER_TOKEN ?? randomBytes(32).toString('base64url'),
    DKB_RUNTIME_ADMIN_TOKEN: existing.DKB_RUNTIME_ADMIN_TOKEN ?? randomBytes(32).toString('base64url'),
  };
  delete values.DKB_PROVIDER_IMAGE;

  for (const service of distribution.services) {
    const stack = service.stack;
    if (!stack) continue;
    if (service.image) {
      values[stack.imageEnvironment] = process.env[stack.imageEnvironment]
        ?? (!existing.DKB_STACK_VERSION && stack.build ? service.image : existing[stack.imageEnvironment] ?? service.image);
    }
    if (stack.health) {
      values[stack.health.portEnvironment] = existing[stack.health.portEnvironment]
        ?? String(hostPortFor(normalizedName, stack.health.defaultHostPort, stack.health.namedPortBase));
    }
    for (const environment of stack.secretEnvironment ?? []) {
      values[environment] = existing[environment] ?? randomBytes(32).toString('base64url');
    }
    if (!requiredServices.some((candidate) => candidate.id === service.id) || !service.providerId) continue;
    const providerOptions = recipe.options?.[service.providerId] ?? {};
    for (const [option, environment] of Object.entries(stack.optionEnvironment ?? {})) {
      const value = providerOptions[option];
      if (value !== undefined) values[environment] = environmentValue(value, service.id, option);
    }
  }

  await writeEnvironmentFile(envFile, values);
  await writePipelineConfig(path.join(root, 'compiler-context', '.dkb', 'config.json'), target);
  await writePipelineConfig(
    path.join(runtimeRoot, '.dkb', 'config.json'),
    parseStoredTarget(distribution, activeRuntimeBuild?.target ?? target),
  );

  return contextFrom(distribution, root, composeFile, envFile, values);
}

export async function readDkbStack(distribution: DkbDistribution, name: string): Promise<DkbStackContext> {
  const root = path.join(stackStateRoot(), stackName(name));
  const envFile = path.join(root, 'stack.env');
  const values = await readEnvironmentFile(envFile);
  if (Object.keys(values).length === 0) {
    throw new DkbError(`Unknown DKB stack ${name}. Create it with: dkb stack up ${name}`);
  }
  return contextFrom(distribution, root, await resolveComposeFile(), envFile, values);
}

export async function runtimeAdminTokenForUrl(runtimeUrl: string): Promise<string | undefined> {
  if (process.env.DKB_RUNTIME_ADMIN_TOKEN) return process.env.DKB_RUNTIME_ADMIN_TOKEN;
  let entries: string[];
  try {
    entries = await fs.readdir(stackStateRoot());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }

  const expected = normalizedOrigin(runtimeUrl);
  for (const entry of entries) {
    const values = await readEnvironmentFile(path.join(stackStateRoot(), entry, 'stack.env'));
    if (!values.DKB_RUNTIME_PORT || !values.DKB_RUNTIME_ADMIN_TOKEN) continue;
    if (normalizedOrigin(`http://127.0.0.1:${values.DKB_RUNTIME_PORT}`) === expected) {
      return values.DKB_RUNTIME_ADMIN_TOKEN;
    }
  }
  return undefined;
}

export function stackStateRoot(): string {
  return path.resolve(process.env.DKB_STACK_STATE_ROOT ?? path.join(os.homedir(), '.dkb', 'stacks'));
}

export function stackName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u.test(normalized)) {
    throw new DkbError('Stack name must use 1-64 lowercase letters, numbers, dots, dashes, or underscores.');
  }
  return normalized;
}

export async function readEnvironmentFile(target: string): Promise<Record<string, string>> {
  try {
    return parseEnvironmentFile(await fs.readFile(target, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export function readEnvironmentFileSync(target: string): Record<string, string> {
  try {
    return parseEnvironmentFile(readFileSync(target, 'utf8'));
  } catch {
    return {};
  }
}

export function parseEnvironmentFile(source: string): Record<string, string> {
  return Object.fromEntries(source.split(/\r?\n/u).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return [];
    const separator = trimmed.indexOf('=');
    return separator > 0 ? [[trimmed.slice(0, separator), trimmed.slice(separator + 1)]] : [];
  }));
}

export async function writeEnvironmentFile(target: string, values: Record<string, string>): Promise<void> {
  const source = `${Object.entries(values).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
  await writeAtomic(target, source);
  await fs.chmod(target, 0o600).catch(() => undefined);
}

export async function writeAtomic(target: string, source: string): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temporary, source, 'utf8');
  await fs.rm(target, { force: true });
  await fs.rename(temporary, target);
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function contextFrom(
  distribution: DkbDistribution,
  root: string,
  composeFile: string,
  envFile: string,
  values: Record<string, string>,
): DkbStackContext {
  const target = parseStoredTarget(distribution, values.DKB_PIPELINE_TARGET);
  const name = stackName(values.DKB_STACK_NAME ?? path.basename(root));
  const requiredServices = requiredStackServices(distribution, target);
  const servicePorts = Object.fromEntries(distribution.services.flatMap((service) => {
    const health = service.stack?.health;
    return health ? [[service.id, positivePort(values[health.portEnvironment], health.component)]] : [];
  }));
  const registryPort = requiredServicePort(distribution, servicePorts, 'registry');
  const runtimePort = requiredServicePort(distribution, servicePorts, 'runtime');

  return {
    name,
    projectName: `dkb-${name}`,
    target,
    root,
    composeFile,
    envFile,
    registryUrl: `http://127.0.0.1:${registryPort}`,
    runtimeUrl: `http://127.0.0.1:${runtimePort}`,
    registryPort,
    runtimePort,
    requiredServices,
    profiles: serviceProfiles(requiredServices),
    allProfiles: serviceProfiles(distribution.services),
    servicePorts,
    ...(values.DKB_STACK_VERSION ? { version: values.DKB_STACK_VERSION } : {}),
  };
}

async function writePipelineConfig(targetPath: string, target: DkbStackTarget): Promise<void> {
  await writeAtomic(targetPath, `${JSON.stringify({ format: 'dkb.config.v2', activeTarget: target }, null, 2)}\n`);
}

async function resolveComposeFile(): Promise<string> {
  const candidates = [
    process.env.DKB_STACK_COMPOSE_FILE,
    fileURLToPath(new URL('./compose.yaml', import.meta.url)),
    path.resolve('deploy', 'compose.yaml'),
  ].filter((value): value is string => Boolean(value)).map((value) => path.resolve(value));
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  throw new DkbError('DKB stack Compose distribution is missing. Reinstall @sjshovan/dkb-cli or set DKB_STACK_COMPOSE_FILE.');
}

function namespaceForStack(name: string): string {
  return name.replace(/[._]+/gu, '-').replace(/-+/gu, '-');
}

function hostPortFor(name: string, defaultPort: number, namedPortBase: number): number {
  if (name === 'local') return defaultPort;
  const offset = [...name].reduce((total, character) => (total * 31 + character.charCodeAt(0)) % 500, 0);
  return namedPortBase + offset;
}

function targetRecipe(distribution: DkbDistribution, target: DkbStackTarget) {
  const recipe = distribution.defaults.targets?.[target];
  if (!recipe) {
    const available = Object.keys(distribution.defaults.targets ?? {}).sort().join(', ');
    throw new DkbError(`Pipeline target ${target} is not available in ${distribution.id}. Available targets: ${available || 'none'}.`);
  }
  return recipe;
}

function requiredStackServices(distribution: DkbDistribution, target: DkbStackTarget): DkbDistributionService[] {
  targetRecipe(distribution, target);
  return distribution.services.filter((service) => service.requiredBy.includes(target));
}

function serviceProfiles(services: readonly DkbDistributionService[]): string[] {
  return [...new Set(services.flatMap((service) => service.stack?.composeProfile ? [service.stack.composeProfile] : []))];
}

function requiredServicePort(distribution: DkbDistribution, ports: Record<string, number>, id: string): number {
  const port = ports[id];
  if (port === undefined) throw new DkbError(`Distribution ${distribution.id} does not define a health port for required service ${id}.`);
  return port;
}

function parseStoredTarget(distribution: DkbDistribution, value: string | undefined): DkbStackTarget {
  const target = value ?? distributionDefaultTarget(distribution);
  targetRecipe(distribution, target);
  return target;
}

function distributionDefaultTarget(distribution: DkbDistribution): string {
  const target = distribution.defaults.activeTarget;
  if (!target) throw new DkbError(`Distribution ${distribution.id} does not define a default pipeline target.`);
  return target;
}

function environmentValue(value: unknown, serviceId: string, option: string): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new DkbError(`Stack option ${serviceId}.${option} must be a string, number, or boolean to map into a service environment variable.`);
}

function positivePort(value: string | undefined, label: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new DkbError(`${label} port is invalid: ${String(value)}`);
  return port;
}

function normalizedOrigin(value: string): string {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return value.replace(/\/+$/gu, '').toLowerCase();
  }
}
