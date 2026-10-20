import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeRuntimeBinding, maybeReadRuntimeActivation, maybeReadRuntimeBindingFromStateRoot } from '@sjshovan/dkb-runtime/runtime/state.js';
import { DKB_RUNTIME_ACTIVATION_PATH } from '@sjshovan/dkb-protocol/paths.js';
import { replaceFileAtomically } from '@sjshovan/dkb-protocol/atomicFile.js';
import type { DkbDistribution, DkbDistributionService } from '@sjshovan/dkb-pipeline/host.js';
import { DKB_CONFIG_PATH, readDkbContextConfig } from '@sjshovan/dkb-pipeline/config.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbStackContext, DkbStackControlContext, DkbStackTarget } from './types.js';
import { stackName, stackStateRoot } from './paths.js';
import { withStackControl } from './control.js';
import { resolveStackSelection, selectedServiceEnvironment, stackSelectionDigest, type StackSelection } from './recipes.js';
import { prepareIdentityConfig } from './recipeConfiguration.js';

export { stackName, stackStateRoot } from './paths.js';

export async function prepareDkbStack(
  distribution: DkbDistribution,
  name = 'local',
  options: {
    compilerTarget?: DkbStackTarget;
    runtimeTarget?: DkbStackTarget;
    libraryRoot?: string;
  } = {},
): Promise<DkbStackContext> {
  return withStackControl(name, () => prepareStack(distribution, name, options));
}

async function prepareStack(distribution: DkbDistribution, name: string, options: {
  compilerTarget?: DkbStackTarget; runtimeTarget?: DkbStackTarget; libraryRoot?: string;
}): Promise<DkbStackContext> {
  const normalizedName = stackName(name);
  const root = path.join(stackStateRoot(), normalizedName);
  await assertNativeStackContext(root);
  if (await pathExists(path.join(root, 'runtime', 'dkb.json'))) {
    throw new DkbError(`Stack ${normalizedName} still stores its Library inside Runtime state. Stop its writers and perform an explicit copy-and-verify migration before starting it with this version. Existing source, locks, builds and Runtime data were preserved.`, 'stack_migration_required');
  }
  const composeFile = await resolveComposeFile();
  const envFile = path.join(root, 'stack.env');
  const existing = await readEnvironmentFile(envFile);
  const runtimeRoot = path.join(root, 'runtime');
  const libraryRoot = path.resolve(options.libraryRoot ?? existing.DKB_LIBRARY_HOST_PATH ?? path.join(root, 'library'));
  const activeRuntimeBuild = await maybeReadStackRuntimeActivation(runtimeRoot);
  const existingBinding = await maybeReadRuntimeBindingFromStateRoot(runtimeRoot);
  const selection = await resolveStackSelection(distribution, { compilerRoot: path.join(root, 'compiler-context'), runtimeRoot, libraryRoot }, {
    compilerTarget: options.compilerTarget ?? (process.env.DKB_COMPILER_DEFAULT_TARGET?.trim()
      || existing.DKB_COMPILER_DEFAULT_TARGET || existing.DKB_PIPELINE_TARGET),
    runtimeTarget: options.runtimeTarget ?? activeRuntimeBuild?.target ?? existing.DKB_RUNTIME_PIPELINE_TARGET,
    allowedTargets: process.env.DKB_COMPILER_ALLOWED_TARGETS ?? existing.DKB_COMPILER_ALLOWED_TARGETS ?? '',
  });
  const { target, runtimeTarget, requiredServices } = selection;
  const serviceEnvironment = selectedServiceEnvironment(selection);
  await ensureStackLibrary(libraryRoot, `${normalizedName} Library`);

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

  const values = stackEnvironment(distribution, normalizedName, root, existing, selection, serviceEnvironment);
  values.DKB_LIBRARY_HOST_PATH = libraryRoot.replace(/\\/gu, '/');

  await writeEnvironmentFile(envFile, values);
  await writePipelineConfig(path.join(root, 'compiler-context', '.dkb', 'config.json'), target);
  // A requested Stack target is not an activated Runtime selection. In particular,
  // changing this default before Docker starts invalidates the still-serving host.
  if (!existingBinding) await writePipelineConfig(path.join(runtimeRoot, '.dkb', 'config.json'), runtimeTarget);
  await initializeRuntimeBinding(runtimeRoot, {
    runtimeId: `${normalizedName}-runtime`,
    libraryRoot,
    runtimeLibraryRoot: '/library',
    libraryName: path.basename(libraryRoot),
    target: runtimeTarget,
  });

  return contextFrom(distribution, root, libraryRoot, runtimeRoot, composeFile, envFile, values, selection);
}

export async function writeStackProviderIdentityConfig(
  context: DkbStackContext,
  imageDigests: Readonly<Record<string, string>>,
  distribution: DkbDistribution,
): Promise<void> {
  const values = await readEnvironmentFile(context.envFile);
  const selection = await resolveStackSelection(distribution, { compilerRoot: path.join(context.root, 'compiler-context'), runtimeRoot: context.runtimeStateRoot, libraryRoot: context.libraryRoot }, {
    compilerTarget: context.target, runtimeTarget: context.runtimeTarget,
    allowedTargets: values.DKB_COMPILER_ALLOWED_TARGETS ?? '',
  });
  const selectedServices = selection.requiredServices.map((service) => service.id).sort().join(',');
  if (stackSelectionDigest(distribution, selection) !== context.recipeDigest
    || selectedServices !== context.requiredServices.map((service) => service.id).sort().join(',')
    || Object.entries(selectedServiceEnvironment(selection)).some(([key, value]) => values[key] !== value)) {
    throw new DkbError('Stack provider configuration changed while images were being verified. Prepare the Stack again; existing recipe configuration was preserved.');
  }
  const updates = await Promise.all([
    prepareIdentityConfig(path.join(context.root, 'compiler-context', DKB_CONFIG_PATH), context.target, selection.compiler, selection.compilerServices, context, imageDigests, values),
    prepareIdentityConfig(path.join(context.runtimeStateRoot, DKB_CONFIG_PATH), context.runtimeTarget, selection.runtime, selection.runtimeServices, context, imageDigests, values),
  ]);
  for (const update of updates) await writeAtomic(update.path, `${JSON.stringify(update.config, null, 2)}\n`);
}

export async function readDkbStack(distribution: DkbDistribution, name: string): Promise<DkbStackContext> {
  const root = path.join(stackStateRoot(), stackName(name));
  await assertNativeStackContext(root);
  const envFile = path.join(root, 'stack.env');
  const values = await readEnvironmentFile(envFile);
  if (Object.keys(values).length === 0) {
    throw new DkbError(`Unknown DKB stack ${name}. Create it with: dkb stack up ${name}`);
  }
  const libraryRoot = path.resolve(values.DKB_LIBRARY_HOST_PATH ?? path.join(root, 'library'));
  const selection = await resolveStackSelection(distribution, { compilerRoot: path.join(root, 'compiler-context'), runtimeRoot: path.join(root, 'runtime'), libraryRoot }, {
    compilerTarget: values.DKB_COMPILER_DEFAULT_TARGET || values.DKB_PIPELINE_TARGET,
    runtimeTarget: (await maybeReadStackRuntimeActivation(path.join(root, 'runtime')))?.target ?? values.DKB_RUNTIME_PIPELINE_TARGET,
    allowedTargets: values.DKB_COMPILER_ALLOWED_TARGETS ?? '',
  });
  return contextFrom(distribution, root, libraryRoot, path.join(root, 'runtime'), await resolveComposeFile(), envFile, values, selection);
}

/** Stop/log controls need project topology, never a valid or healthy retrieval recipe. */
export async function readDkbStackControl(distribution: DkbDistribution, name: string): Promise<DkbStackControlContext> {
  const normalized = stackName(name);
  const root = path.join(stackStateRoot(), normalized);
  const envFile = path.join(root, 'stack.env');
  const values = await readEnvironmentFile(envFile);
  if (!Object.keys(values).length) throw new DkbError(`Unknown DKB stack ${normalized}.`);
  if (values.DKB_STACK_NAME && values.DKB_STACK_NAME !== normalized) throw new DkbError(`Stack control identity mismatch for ${normalized}; inspect ${envFile} before controlling services.`);
  return { name: normalized, projectName: `dkb-${normalized}`, root, envFile,
    ...(values.DKB_DOCKER_CONTEXT ? { dockerContext: values.DKB_DOCKER_CONTEXT } : {}),
    composeFile: await resolveComposeFile(), allProfiles: serviceProfiles(distribution.services) };
}

export async function runtimeAdminTokenForUrl(runtimeUrl: string): Promise<string | undefined> {
  return (await runtimeTokensForUrl(runtimeUrl)).adminToken;
}

export async function runtimeTokensForUrl(runtimeUrl: string): Promise<{ adminToken?: string; readToken?: string }> {
  const overrides = {
    ...(process.env.DKB_RUNTIME_ADMIN_TOKEN !== undefined ? { adminToken: process.env.DKB_RUNTIME_ADMIN_TOKEN } : {}),
    ...(process.env.DKB_RUNTIME_READ_TOKEN !== undefined ? { readToken: process.env.DKB_RUNTIME_READ_TOKEN } : {}),
  };
  if (new URL(runtimeUrl).pathname.replace(/\/+$/u, '') !== '') return overrides;
  let entries: string[];
  try {
    entries = await fs.readdir(stackStateRoot());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return overrides;
    throw error;
  }

  const expected = normalizedOrigin(runtimeUrl);
  for (const entry of entries) {
    const values = await readEnvironmentFile(path.join(stackStateRoot(), entry, 'stack.env'));
    if (!values.DKB_RUNTIME_PORT || !values.DKB_RUNTIME_ADMIN_TOKEN) continue;
    if (normalizedOrigin(`http://127.0.0.1:${values.DKB_RUNTIME_PORT}`) === expected) {
      return { adminToken: values.DKB_RUNTIME_ADMIN_TOKEN, readToken: values.DKB_RUNTIME_READ_TOKEN, ...overrides };
    }
  }
  return overrides;
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
  if (await fs.readFile(target, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }) === source) return;
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.writeFile(temporary, source, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await replaceFileAtomically(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function maybeReadStackRuntimeActivation(runtimeRoot: string) {
  return maybeReadRuntimeActivation(path.join(runtimeRoot, ...DKB_RUNTIME_ACTIVATION_PATH.split('/')));
}

function contextFrom(
  distribution: DkbDistribution,
  root: string,
  libraryRoot: string,
  runtimeStateRoot: string,
  composeFile: string,
  envFile: string,
  values: Record<string, string>,
  selection: StackSelection,
): DkbStackContext {
  const { target, runtimeTarget, requiredServices } = selection;
  const name = stackName(values.DKB_STACK_NAME ?? path.basename(root));
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
    runtimeTarget,
    compilerTargets: selection.compilerTargets,
    recipeDigest: stackSelectionDigest(distribution, selection),
    root,
    libraryRoot,
    runtimeStateRoot,
    composeFile,
    envFile,
    registryUrl: `http://127.0.0.1:${registryPort}`,
    runtimeUrl: `http://127.0.0.1:${runtimePort}`,
    registryPort,
    runtimePort,
    requiredServices,
    profiles: serviceProfiles(requiredServices),
    allProfiles: serviceProfiles(distribution.services),
    inactiveComposeServices: distribution.services.flatMap((service) => (
      service.stack?.composeProfile && !requiredServices.includes(service)
        ? [service.stack.composeService ?? service.id]
        : []
    )),
    servicePorts,
    ...(values.DKB_STACK_VERSION ? { version: values.DKB_STACK_VERSION } : {}),
  };
}

async function ensureStackLibrary(libraryRoot: string, name: string): Promise<void> {
  const manifestPath = path.join(libraryRoot, 'dkb.json');
  if (await pathExists(manifestPath)) return;
  await fs.mkdir(libraryRoot, { recursive: true });
  await writeAtomic(manifestPath, `${JSON.stringify({
    manifestVersion: 1,
    type: 'library',
    name,
    description: 'Local DKB Library.',
    roots: {},
  }, null, 2)}\n`);
}

async function writePipelineConfig(
  targetPath: string,
  target: DkbStackTarget,
): Promise<void> {
  const existing = await readDkbContextConfig(targetPath);
  await writeAtomic(targetPath, `${JSON.stringify({
    ...existing,
    activeTarget: target,
  }, null, 2)}\n`);
}

export async function resolveComposeFile(): Promise<string> {
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


export function serviceProfiles(services: readonly DkbDistributionService[]): string[] {
  return [...new Set(services.flatMap((service) => service.stack?.composeProfile ? [service.stack.composeProfile] : []))];
}

function requiredServicePort(distribution: DkbDistribution, ports: Record<string, number>, id: string): number {
  const port = ports[id];
  if (port === undefined) throw new DkbError(`Distribution ${distribution.id} does not define a health port for required service ${id}.`);
  return port;
}


export function positivePort(value: string | undefined, label: string): number {
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

async function assertNativeStackContext(root: string): Promise<void> {
  if (await pathExists(path.join(root, 'stack-storage.json'))) {
    throw new DkbError('This Stack is Linux-owned. Native Stack preparation cannot open it; use dkb stack up or owner-aware inspection.', 'stack_owner_required');
  }
}

/** Pure host topology and secret preparation; never opens Library or Runtime storage. */
export function stackEnvironment(distribution: DkbDistribution, normalizedName: string, root: string,
  existing: Record<string, string>, selection: { target: string; runtimeTarget: string; allowedTargets: string[] },
  serviceEnvironment: Record<string, string>): Record<string, string> {
  const { target, runtimeTarget } = selection;
  const values: Record<string, string> = {
    ...existing,
    DKB_STACK_NAME: normalizedName,
    DKB_STACK_STATE: root.replace(/\\/gu, '/'),
    DKB_PIPELINE_TARGET: target,
    DKB_COMPILER_ALLOWED_TARGETS: selection.allowedTargets.join(','),
    DKB_COMPILER_DEFAULT_TARGET: target,
    DKB_RUNTIME_PIPELINE_TARGET: runtimeTarget,
    DKB_BUILD_COMMIT: existing.DKB_BUILD_COMMIT ?? process.env.DKB_BUILD_COMMIT ?? 'development',
    DKB_REGISTRY_APP_KEY: existing.DKB_REGISTRY_APP_KEY ?? `base64:${randomBytes(32).toString('base64')}`,
    DKB_REGISTRY_BOOTSTRAP_NAMESPACE: existing.DKB_REGISTRY_BOOTSTRAP_NAMESPACE ?? namespaceForStack(normalizedName),
    DKB_REGISTRY_BOOTSTRAP_TOKEN: existing.DKB_REGISTRY_BOOTSTRAP_TOKEN ?? `dkb_${randomBytes(48).toString('base64url')}`,
    DKB_MCP_BEARER_TOKEN: existing.DKB_MCP_BEARER_TOKEN ?? randomBytes(32).toString('base64url'),
    DKB_RUNTIME_ADMIN_TOKEN: existing.DKB_RUNTIME_ADMIN_TOKEN ?? randomBytes(32).toString('base64url'),
    DKB_RUNTIME_READ_TOKEN: existing.DKB_RUNTIME_READ_TOKEN ?? randomBytes(32).toString('base64url'),
    DKB_COMPILER_SERVICE_TOKEN: existing.DKB_COMPILER_SERVICE_TOKEN ?? randomBytes(32).toString('base64url'),
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
  }
  Object.assign(values, serviceEnvironment);

  const runtimePort = values.DKB_RUNTIME_PORT ?? '7331';
  values.DKB_RUNTIME_READ_ACCESS = process.env.DKB_RUNTIME_READ_ACCESS ?? existing.DKB_RUNTIME_READ_ACCESS ?? 'authenticated';
  values.DKB_RUNTIME_ALLOWED_HOSTS = process.env.DKB_RUNTIME_ALLOWED_HOSTS ?? existing.DKB_RUNTIME_ALLOWED_HOSTS
    ?? `127.0.0.1:${runtimePort},localhost:${runtimePort},dkb-runtime:7331`;
  values.DKB_RUNTIME_ALLOWED_ORIGINS = process.env.DKB_RUNTIME_ALLOWED_ORIGINS ?? existing.DKB_RUNTIME_ALLOWED_ORIGINS ?? '';
  values.DKB_PUBLIC_URL = process.env.DKB_PUBLIC_URL
    ?? existing.DKB_PUBLIC_URL
    ?? `http://127.0.0.1:${runtimePort}`;
  values.DKB_MCP_PUBLIC_BASE_URL = process.env.DKB_MCP_PUBLIC_BASE_URL
    ?? existing.DKB_MCP_PUBLIC_BASE_URL
    ?? values.DKB_PUBLIC_URL;
  values.DKB_MCP_PUBLIC_DOCUMENTS = process.env.DKB_MCP_PUBLIC_DOCUMENTS
    ?? existing.DKB_MCP_PUBLIC_DOCUMENTS
    ?? 'false';
  values.DKB_MCP_ALLOW_INSECURE_NO_AUTH = process.env.DKB_MCP_ALLOW_INSECURE_NO_AUTH
    ?? existing.DKB_MCP_ALLOW_INSECURE_NO_AUTH
    ?? 'false';
  values.DKB_MCP_ALLOWED_HOSTS = process.env.DKB_MCP_ALLOWED_HOSTS
    ?? existing.DKB_MCP_ALLOWED_HOSTS
    ?? '127.0.0.1,localhost';
  values.DKB_MCP_ALLOWED_ORIGINS = process.env.DKB_MCP_ALLOWED_ORIGINS
    ?? existing.DKB_MCP_ALLOWED_ORIGINS
    ?? '127.0.0.1,localhost';

  return values;
}
