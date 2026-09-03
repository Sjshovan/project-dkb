import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeRuntimeBinding, maybeReadRuntimeActivation, maybeReadRuntimeBindingFromStateRoot } from '@sjshovan/dkb-runtime/runtime/state.js';
import { DKB_RUNTIME_ACTIVATION_PATH, resolveContainedPath } from '@sjshovan/dkb-protocol/paths.js';
import { replaceFileAtomically } from '@sjshovan/dkb-protocol/atomicFile.js';
import { readLibraryState } from '@sjshovan/dkb-library/state.js';
import type { DkbDistribution, DkbDistributionService } from '@sjshovan/dkb-pipeline/host.js';
import { resolvePluginSource } from '@sjshovan/dkb-pipeline/host.js';
import { DKB_CONFIG_FORMAT, DKB_CONFIG_PATH, readDkbContextConfig, resolveContextConfigDocuments, type DkbContextConfig, type DkbResolvedContextConfig } from '@sjshovan/dkb-pipeline/config.js';
import { isSha256Digest } from '@sjshovan/dkb-pipeline/validation.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbStackContext, DkbStackControlContext, DkbStackTarget } from './types.js';

export async function prepareDkbStack(
  distribution: DkbDistribution,
  name = 'local',
  options: {
    compilerTarget?: DkbStackTarget;
    runtimeTarget?: DkbStackTarget;
    libraryRoot?: string;
  } = {},
): Promise<DkbStackContext> {
  const normalizedName = stackName(name);
  const root = path.join(stackStateRoot(), normalizedName);
  const composeFile = await resolveComposeFile();
  const envFile = path.join(root, 'stack.env');
  const existing = await readEnvironmentFile(envFile);
  const runtimeRoot = path.join(root, 'runtime');
  const libraryRoot = path.resolve(options.libraryRoot ?? existing.DKB_LIBRARY_HOST_PATH ?? path.join(root, 'library'));
  const activeRuntimeBuild = await maybeReadStackRuntimeActivation(runtimeRoot);
  const existingBinding = await maybeReadRuntimeBindingFromStateRoot(runtimeRoot);
  const selection = await resolveStackSelection(distribution, root, libraryRoot, {
    compilerTarget: options.compilerTarget ?? (process.env.DKB_COMPILER_DEFAULT_TARGET?.trim()
      || existing.DKB_COMPILER_DEFAULT_TARGET || existing.DKB_PIPELINE_TARGET),
    runtimeTarget: options.runtimeTarget ?? activeRuntimeBuild?.target ?? existing.DKB_RUNTIME_PIPELINE_TARGET,
    allowedTargets: process.env.DKB_COMPILER_ALLOWED_TARGETS ?? existing.DKB_COMPILER_ALLOWED_TARGETS ?? '',
  });
  const { target, runtimeTarget, requiredServices } = selection;
  const serviceEnvironment = selectedServiceEnvironment(selection);
  await migrateLegacyStackLibrary(root);
  await ensureStackLibrary(libraryRoot, `${normalizedName} Library`);
  await removeLegacyPackageRuntimeLocks(libraryRoot);

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

  const values: Record<string, string> = {
    ...existing,
    DKB_STACK_NAME: normalizedName,
    DKB_STACK_STATE: root.replace(/\\/gu, '/'),
    DKB_PIPELINE_TARGET: target,
    DKB_COMPILER_ALLOWED_TARGETS: selection.allowedTargets.join(','),
    DKB_COMPILER_DEFAULT_TARGET: target,
    DKB_RUNTIME_PIPELINE_TARGET: runtimeTarget,
    DKB_LIBRARY_HOST_PATH: libraryRoot.replace(/\\/gu, '/'),
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
  }
  Object.assign(values, serviceEnvironment);

  const runtimePort = values.DKB_RUNTIME_PORT ?? '7331';
  values.DKB_PUBLIC_URL = process.env.DKB_PUBLIC_URL
    ?? existing.DKB_PUBLIC_URL
    ?? `http://127.0.0.1:${runtimePort}`;
  values.DKB_MCP_PUBLIC_BASE_URL = process.env.DKB_MCP_PUBLIC_BASE_URL
    ?? existing.DKB_MCP_PUBLIC_BASE_URL
    ?? values.DKB_PUBLIC_URL;
  values.DKB_MCP_ALLOW_INSECURE_NO_AUTH = process.env.DKB_MCP_ALLOW_INSECURE_NO_AUTH
    ?? existing.DKB_MCP_ALLOW_INSECURE_NO_AUTH
    ?? 'false';
  values.DKB_MCP_ALLOWED_HOSTS = process.env.DKB_MCP_ALLOWED_HOSTS
    ?? existing.DKB_MCP_ALLOWED_HOSTS
    ?? '127.0.0.1,localhost';
  values.DKB_MCP_ALLOWED_ORIGINS = process.env.DKB_MCP_ALLOWED_ORIGINS
    ?? existing.DKB_MCP_ALLOWED_ORIGINS
    ?? '127.0.0.1,localhost';

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
  const selection = await resolveStackSelection(distribution, context.root, context.libraryRoot, {
    compilerTarget: context.target, runtimeTarget: context.runtimeTarget,
    allowedTargets: values.DKB_COMPILER_ALLOWED_TARGETS ?? '',
  });
  const selectedServices = selection.requiredServices.map((service) => service.id).sort().join(',');
  if (selectedServices !== context.requiredServices.map((service) => service.id).sort().join(',')
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
  const envFile = path.join(root, 'stack.env');
  const values = await readEnvironmentFile(envFile);
  if (Object.keys(values).length === 0) {
    throw new DkbError(`Unknown DKB stack ${name}. Create it with: dkb stack up ${name}`);
  }
  const libraryRoot = path.resolve(values.DKB_LIBRARY_HOST_PATH ?? path.join(root, 'library'));
  const selection = await resolveStackSelection(distribution, root, libraryRoot, {
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
    composeFile: await resolveComposeFile(), allProfiles: serviceProfiles(distribution.services) };
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

async function migrateLegacyStackLibrary(root: string): Promise<void> {
  const legacyRoot = path.join(root, 'runtime');
  const libraryRoot = path.join(root, 'library');
  if (!await pathExists(path.join(legacyRoot, 'dkb.json')) || await pathExists(path.join(libraryRoot, 'dkb.json'))) return;
  const staged = path.join(root, `runtime-library-split-${process.pid}-${Date.now().toString(36)}`);
  await fs.rename(legacyRoot, staged);
  try {
    await fs.rename(staged, libraryRoot);
    await Promise.all([
      fs.rm(path.join(libraryRoot, '.dkb', 'runtime.lock.json'), { force: true }),
      fs.rm(path.join(libraryRoot, '.dkb', 'runtime.json'), { force: true }),
      fs.rm(path.join(libraryRoot, '.dkb', 'activation.lock.json'), { force: true }),
      fs.rm(path.join(libraryRoot, '.dkb', 'cache', 'runtime'), { recursive: true, force: true }),
      fs.rm(path.join(libraryRoot, '.dkb', 'traces'), { recursive: true, force: true }),
      fs.rm(path.join(libraryRoot, '.dkb', 'audit'), { recursive: true, force: true }),
    ]);
    await fs.mkdir(path.join(legacyRoot, '.dkb'), { recursive: true });
  } catch (error) {
    if (!await pathExists(legacyRoot) && await pathExists(libraryRoot)) await fs.rename(libraryRoot, legacyRoot).catch(() => undefined);
    if (!await pathExists(legacyRoot) && await pathExists(staged)) await fs.rename(staged, legacyRoot).catch(() => undefined);
    throw error;
  }
}

async function removeLegacyPackageRuntimeLocks(libraryRoot: string): Promise<void> {
  const state = await readLibraryState(libraryRoot);
  await Promise.all(Object.values(state.entries)
    .filter((entry) => entry.kind === 'dkb' && entry.status === 'installed')
    .map(async (entry) => {
      const packageRoot = resolveContainedPath(libraryRoot, entry.path, `Installed DKB ${entry.identity}`);
      await fs.rm(path.join(packageRoot, '.dkb', 'runtime.lock.json'), { force: true });
    }));
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

async function prepareIdentityConfig(
  configPath: string,
  activeTarget: string,
  recipes: Record<string, DkbResolvedContextConfig>,
  bindings: Record<string, string[]>,
  context: DkbStackContext,
  imageDigests: Readonly<Record<string, string>>,
  environment: Readonly<Record<string, string>>,
): Promise<{ path: string; config: DkbContextConfig }> {
  const config = structuredClone(await readDkbContextConfig(configPath));
  for (const [name, services] of Object.entries(bindings)) {
    for (const serviceId of services) {
      const service = context.requiredServices.find((candidate) => candidate.id === serviceId);
      if (!service?.providerId) continue;
      const recipeImage = recipes[name]!.target.options?.[service.providerId]?.image;
      const deployedImage = service.stack ? environment[service.stack.imageEnvironment] ?? service.image : service.image;
      if (recipeImage !== undefined && recipeImage !== deployedImage) {
        if (name === activeTarget) throw new DkbError(`Pipeline "${name}" configures a different ${service.id} image than the prepared Stack. Prepare the Stack again before attesting it.`);
        continue;
      }
      for (const identity of service.providerExternalIdentities ?? []) {
        if (identity.kind !== 'image') continue;
        const digest = imageDigests[service.id];
        if (!isSha256Digest(digest)) throw new DkbError(`Immutable OCI digest for required provider service ${service.id} was not resolved`);
        const configured = recipes[name]!.target.options?.[service.providerId]?.[identity.option];
        if (configured !== undefined) {
          if (name === activeTarget && (!isSha256Digest(configured) || configured !== digest)) {
            throw new DkbError(`Pipeline "${name}" pins ${service.providerId}.${identity.option} to a different or invalid image identity. `
              + `The Stack resolved ${digest}. Update the trusted recipe explicitly or restore its pinned image; DKB will not overwrite operator options.`);
          }
          continue;
        }
        const targets = config.targets ??= {};
        const target = targets[name] ??= {};
        const options = target.options ??= {};
        options[service.providerId] = { ...options[service.providerId], [identity.option]: digest };
      }
    }
  }
  return { path: configPath, config };
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

interface StackSelection {
  target: string;
  runtimeTarget: string;
  compilerTargets: string[];
  allowedTargets: string[];
  compiler: Record<string, DkbResolvedContextConfig>;
  runtime: Record<string, DkbResolvedContextConfig>;
  compilerServices: Record<string, string[]>;
  runtimeServices: Record<string, string[]>;
  requiredServices: DkbDistributionService[];
}

async function resolveStackSelection(distribution: DkbDistribution, root: string, libraryRoot: string, input: {
  compilerTarget?: string; runtimeTarget?: string; allowedTargets: string;
}): Promise<StackSelection> {
  const compilerScope = await stackScope(distribution, path.join(root, 'compiler-context'));
  const compilerDefault = compilerScope.resolve(input.compilerTarget);
  const allowedTargets = [...new Set(input.allowedTargets.split(',').map((value) => value.trim()).filter(Boolean))].sort();
  if (allowedTargets.length > 128) throw new DkbError('DKB_COMPILER_ALLOWED_TARGETS must contain at most 128 Pipeline names.');
  const compilerNames = allowedTargets.length ? allowedTargets : compilerScope.names;
  for (const name of compilerNames) {
    if (!compilerScope.names.includes(name)) throw new DkbError(`DKB_COMPILER_ALLOWED_TARGETS contains unknown target "${name}". Available targets: ${compilerScope.names.join(', ')}`);
  }
  const target = compilerDefault.activeTarget;
  if (!compilerNames.includes(target)) throw new DkbError(`Registry compiler default target "${target}" is not allowed by DKB_COMPILER_ALLOWED_TARGETS. Select an allowed default or explicitly update the restriction.`);
  const runtimeScope = await stackScope(distribution, path.join(root, 'runtime'), libraryRoot);
  const runtimeDefault = runtimeScope.resolve(input.runtimeTarget ?? runtimeScope.local.activeTarget ?? runtimeScope.library.activeTarget ?? target);
  const resolvable = (scope: typeof compilerScope, names: string[], active: DkbResolvedContextConfig) => {
    const recipes: Record<string, DkbResolvedContextConfig> = { [active.activeTarget]: active };
    for (const name of names) {
      if (name === active.activeTarget) continue;
      try { recipes[name] = scope.resolve(name); } catch {
        // An unresolved inactive recipe remains allowed. The compiler catalog reports its failure;
        // Stack startup does not rewrite it or replace it with a bundled recipe.
      }
    }
    return recipes;
  };
  const compiler = resolvable(compilerScope, compilerNames, compilerDefault);
  const runtime = resolvable(runtimeScope, runtimeScope.names, runtimeDefault);
  const services = async (recipes: Record<string, DkbResolvedContextConfig>, active: string) => Object.fromEntries(await Promise.all(
    Object.entries(recipes).map(async ([name, config]) => {
      const ids = new Set([config.target.evidence, config.target.parser, config.target.chunker,
        config.target.embedding, config.target.index, config.target.retrieval,
        ...(config.target.processors ?? []), ...(config.target.observers ?? [])].filter(Boolean));
      const selected: string[] = [];
      for (const service of distribution.services) {
        if (!service.providerId || !ids.has(service.providerId)) continue;
        try {
          if ((await resolvePluginSource(config, distribution, service.providerId)).source === 'bundled') selected.push(service.id);
        } catch (error) {
          if (name === active) throw error;
          // Do not attest an unresolved inactive implementation. Its catalog row remains visible.
        }
      }
      return [name, selected];
    }),
  ));
  const compilerServices = await services(compiler, target);
  const runtimeServices = await services(runtime, runtimeDefault.activeTarget);
  const selected = new Set([...compilerServices[target]!, ...runtimeServices[runtimeDefault.activeTarget]!]);
  // Unbound services are Stack infrastructure; provider services belong to selected implementations, never target labels.
  const requiredServices = distribution.services.filter((service) => !service.providerId || selected.has(service.id));
  return { target, runtimeTarget: runtimeDefault.activeTarget, compilerTargets: compilerNames, allowedTargets, compiler, runtime, compilerServices, runtimeServices, requiredServices };
}

async function stackScope(distribution: DkbDistribution, root: string, libraryRoot?: string) {
  const local = await readDkbContextConfig(path.join(root, DKB_CONFIG_PATH));
  const library = libraryRoot ? await readDkbContextConfig(path.join(libraryRoot, DKB_CONFIG_PATH)) : { format: DKB_CONFIG_FORMAT } as DkbContextConfig;
  // Containers mount their trusted context and (for Runtime) Library, not the host's user-global directory.
  // Reusing the already-searched local plugin directory as the empty global scope keeps planning inside those mounts.
  const globalRoot = path.join(root, '.dkb');
  const resolve = (target?: string) => resolveContextConfigDocuments(root, globalRoot, distribution.defaults,
    { format: DKB_CONFIG_FORMAT }, local, target, library, libraryRoot);
  const names = [...new Set([...Object.keys(distribution.defaults.targets ?? {}), ...Object.keys(library.targets ?? {}), ...Object.keys(local.targets ?? {})])].sort();
  return { names, local, library, resolve };
}

function selectedServiceEnvironment(selection: StackSelection): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [recipe, bindings] of [
    [selection.compiler[selection.target]!, selection.compilerServices[selection.target]!],
    [selection.runtime[selection.runtimeTarget]!, selection.runtimeServices[selection.runtimeTarget]!],
  ] as const) {
    for (const service of selection.requiredServices) {
      if (!service.providerId || !bindings.includes(service.id)) continue;
      const mappedOptions = { ...service.stack?.optionEnvironment,
        ...(service.stack ? { image: service.stack.imageEnvironment } : {}) };
      for (const [option, environment] of Object.entries(mappedOptions)) {
        const value = recipe.target.options?.[service.providerId]?.[option];
        if (value === undefined) continue;
        const encoded = environmentValue(value, service.id, option);
        if (result[environment] !== undefined && result[environment] !== encoded) {
          throw new DkbError(`Compiler and Runtime recipes require different ${service.id}.${option} values for one shared Stack service. Use separately configured services or Stacks; neither recipe was changed.`);
        }
        result[environment] = encoded;
      }
    }
  }
  return result;
}

function serviceProfiles(services: readonly DkbDistributionService[]): string[] {
  return [...new Set(services.flatMap((service) => service.stack?.composeProfile ? [service.stack.composeProfile] : []))];
}

function requiredServicePort(distribution: DkbDistribution, ports: Record<string, number>, id: string): number {
  const port = ports[id];
  if (port === undefined) throw new DkbError(`Distribution ${distribution.id} does not define a health port for required service ${id}.`);
  return port;
}

function environmentValue(value: unknown, serviceId: string, option: string): string {
  if ((typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') && !/[\r\n]/u.test(String(value))) return String(value);
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
