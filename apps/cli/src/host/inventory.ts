import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { hostLibraryLocation, validateDockerLibraryStorage, type HostLibraryLocation, type DockerLibraryStorage } from './libraryLocation.js';

export const DKB_HOST_INVENTORY_FORMAT = 'dkb.host.v2';
const LEGACY_DKB_HOST_INVENTORY_FORMAT = 'dkb.host.v1';

const processMutationTails = new Map<string, Promise<void>>();

export type DkbHostRuntimeKind = 'process' | 'docker' | 'remote';

interface DkbHostLibraryMetadata {
  displayName: string;
  registry?: string;
  registeredAt: string;
  updatedAt: string;
}

export type DkbHostLibraryRecord = DkbHostLibraryMetadata & HostLibraryLocation;
export type DkbHostLocalLibraryRecord = DkbHostLibraryMetadata & { path: string; storage?: never };

export interface DkbHostRegistryRecord {
  url: string;
  registeredAt: string;
  updatedAt: string;
}

export interface DkbHostRuntimeRecord {
  kind: DkbHostRuntimeKind;
  url: string;
  library?: string;
  stateRoot?: string;
  composeFile?: string;
  registeredAt: string;
  updatedAt: string;
}

export interface DkbHostStackRecord {
  stateRoot: string;
  library?: string;
  registry?: string;
  runtime?: string;
  registeredAt: string;
  updatedAt: string;
}

export interface DkbHostInventory {
  format: typeof DKB_HOST_INVENTORY_FORMAT;
  defaults: {
    library?: string;
    registry?: string;
    runtime?: string;
    stack?: string;
  };
  libraries: Record<string, DkbHostLibraryRecord>;
  registries: Record<string, DkbHostRegistryRecord>;
  runtimes: Record<string, DkbHostRuntimeRecord>;
  stacks: Record<string, DkbHostStackRecord>;
}

export interface RegisterHostLibraryOptions {
  name?: string;
  registryName?: string;
  registryUrl?: string;
  select?: boolean | 'if-empty';
}

export interface RegisterHostRegistryOptions {
  select?: boolean | 'if-empty';
}

export interface RegisterHostRuntimeOptions {
  kind?: DkbHostRuntimeKind;
  library?: string;
  stateRoot?: string;
  composeFile?: string;
  select?: boolean | 'if-empty';
}

export interface RegisterHostStackOptions {
  library?: string;
  registry?: string;
  runtime?: string;
  select?: boolean | 'if-empty';
}

export function hostInventoryPath(): string {
  return process.env.DKB_HOST_INVENTORY
    ? path.resolve(process.env.DKB_HOST_INVENTORY)
    : path.join(os.homedir(), '.dkb', 'host.json');
}

export async function readHostInventory(target = hostInventoryPath()): Promise<DkbHostInventory> {
  try {
    const source = await fs.readFile(target, 'utf8');
    let parsed: unknown;

    try {
      parsed = JSON.parse(source) as unknown;
    } catch (error) {
      throw new DkbError(
        `Invalid DKB host inventory JSON at ${target}: ${errorMessage(error)} `
        + `Repair the file or move it aside; DKB will not overwrite malformed host inventory.`,
      );
    }

    try {
      if (isRecord(parsed) && parsed.format === LEGACY_DKB_HOST_INVENTORY_FORMAT) {
        const migrated = migrateHostInventoryV1(parsed, target);
        await writeHostInventory(target, migrated);
        return migrated;
      }
      return validateHostInventory(parsed, target);
    } catch (error) {
      if (error instanceof DkbError) {
        throw new DkbError(
          `${error.message} Repair the file or move it aside; DKB will not overwrite malformed host inventory.`,
        );
      }
      throw error;
    }
  } catch (error) {
    if (isMissing(error)) {
      return emptyHostInventory();
    }

    throw error;
  }
}

export async function registerHostLibrary(
  libraryPath: string,
  options: RegisterHostLibraryOptions = {},
): Promise<{ name: string; library: DkbHostLocalLibraryRecord; registry?: { name: string; registry: DkbHostRegistryRecord } }> {
  const library = await inspectLibraryPath(libraryPath);

  return mutateHostInventory(async (inventory) => {
    const existing = entryByPath(inventory.libraries, library.path);
    if (existing && options.name && existing.name !== normalizeHostName(options.name, 'Library name')) {
      throw new DkbError(`Library ${library.path} is already registered as ${existing.name}. Unregister it before assigning another name.`);
    }

    const name = existing?.name ?? availableName(
      inventory.libraries,
      options.name,
      library.displayName || path.basename(library.path),
      library.path,
      'Library name',
    );
    const now = new Date().toISOString();
    let registryResult: { name: string; registry: DkbHostRegistryRecord } | undefined;
    let registryName = existing?.record.registry;
    const registryUrl = options.registryUrl ?? library.registryUrl;

    if (registryUrl) {
      registryResult = ensureRegistryRecord(inventory, registryUrl, options.registryName, now);
      registryName = registryResult.name;
    }

    const record: DkbHostLocalLibraryRecord = {
      path: library.path,
      displayName: library.displayName,
      ...(registryName ? { registry: registryName } : {}),
      registeredAt: existing?.record.registeredAt ?? now,
      updatedAt: now,
    };
    inventory.libraries[name] = record;
    applyDefault(inventory.defaults, 'library', name, options.select);

    return {
      value: {
        name,
        library: record,
        ...(registryResult ? { registry: registryResult } : {}),
      },
      inventory,
    };
  });
}

/** Register a previously verified owner handle; inventory remains convenience state. */
export async function registerDockerHostLibrary(
  storage: DockerLibraryStorage,
  options: RegisterHostLibraryOptions & { displayName: string },
): Promise<{ name: string; library: DkbHostLibraryRecord }> {
  const owner = validateDockerLibraryStorage(storage);
  const displayName = requiredString(options.displayName, 'Library display name');
  return mutateHostInventory(async inventory => {
    const existing = Object.entries(inventory.libraries).find(([, record]) =>
      record.storage?.context === owner.context && record.storage.volume === owner.volume);
    if (existing && options.name && existing[0] !== normalizeHostName(options.name, 'Library name')) {
      throw new DkbError(`Docker Library ${owner.volume} is already registered as ${existing[0]}. Unregister it before assigning another name.`);
    }
    const name = existing?.[0] ?? availableName(inventory.libraries, options.name, displayName,
      `${owner.context}/${owner.volume}`, 'Library name');
    const now = new Date().toISOString();
    const registry = options.registryUrl
      ? ensureRegistryRecord(inventory, options.registryUrl, options.registryName, now).name
      : existing?.[1].registry;
    const library: DkbHostLibraryRecord = {
      storage: owner, displayName,
      ...(registry ? { registry } : {}),
      registeredAt: existing?.[1].registeredAt ?? now, updatedAt: now,
    };
    inventory.libraries[name] = library;
    applyDefault(inventory.defaults, 'library', name, options.select);
    return { inventory, value: { name, library } };
  });
}

export async function rebindMigratedStackLibrary(
  stackName: string,
  libraryName: string,
  libraryPath: string,
): Promise<{ name: string; library: DkbHostLibraryRecord }> {
  const normalizedStackName = normalizeHostName(stackName, 'Stack name');
  const normalizedLibraryName = normalizeHostName(libraryName, 'Library name');
  const library = await inspectLibraryPath(libraryPath);

  return mutateHostInventory(async (inventory) => {
    const stack = inventory.stacks[normalizedStackName];
    const existing = inventory.libraries[normalizedLibraryName];
    if (!stack || stack.library !== normalizedLibraryName || !existing) {
      throw new DkbError(`Stack ${normalizedStackName} does not own Library ${normalizedLibraryName}; its host entry cannot be rebound.`);
    }

    const expectedLegacyPath = path.join(stack.stateRoot, 'runtime');
    const expectedLibraryPath = path.join(stack.stateRoot, 'library');
    if (existing.storage || comparablePath(existing.path) !== comparablePath(expectedLegacyPath)
      || comparablePath(library.path) !== comparablePath(expectedLibraryPath)) {
      throw new DkbError(`Stack ${normalizedStackName} Library migration does not match its legacy Runtime and Library paths.`);
    }

    const duplicate = entryByPath(inventory.libraries, library.path);
    if (duplicate && duplicate.name !== normalizedLibraryName) {
      throw new DkbError(`Library ${library.path} is already registered as ${duplicate.name}.`);
    }

    const record: DkbHostLibraryRecord = {
      ...existing,
      path: library.path,
      displayName: library.displayName,
      updatedAt: new Date().toISOString(),
    };
    inventory.libraries[normalizedLibraryName] = record;
    return { value: { name: normalizedLibraryName, library: record }, inventory };
  });
}

export async function unregisterHostLibrary(nameOrPath: string): Promise<{ name: string; path?: string; location: string; selectedCleared: boolean }> {
  return mutateHostInventory(async (inventory) => {
    const resolved = await resolveLibraryEntry(inventory, nameOrPath);

    if (!resolved) {
      throw new DkbError(`Unknown host Library: ${nameOrPath}. Run: dkb library list`);
    }

    delete inventory.libraries[resolved.name];
    const selectedCleared = inventory.defaults.library === resolved.name;
    if (selectedCleared) {
      delete inventory.defaults.library;
    }
    for (const runtime of Object.values(inventory.runtimes)) {
      if (runtime.library === resolved.name) {
        delete runtime.library;
        runtime.updatedAt = new Date().toISOString();
      }
    }
    for (const stack of Object.values(inventory.stacks)) {
      if (stack.library === resolved.name) {
        delete stack.library;
        stack.updatedAt = new Date().toISOString();
      }
    }

    return {
      value: { name: resolved.name, ...(resolved.record.path ? { path: resolved.record.path } : {}), location: hostLibraryLocation(resolved.record), selectedCleared },
      inventory,
    };
  });
}

export async function selectHostLibrary(nameOrPath: string): Promise<{ name: string; library: DkbHostLibraryRecord }> {
  return mutateHostInventory(async (inventory) => {
    const resolved = await resolveLibraryEntry(inventory, nameOrPath);

    if (!resolved) {
      throw new DkbError(`Unknown host Library: ${nameOrPath}. Register it with: dkb library register "${nameOrPath}"`);
    }

    if (!resolved.record.storage) await inspectLibraryPath(resolved.record.path);
    inventory.defaults.library = resolved.name;

    return { value: { name: resolved.name, library: resolved.record }, inventory };
  });
}

export async function selectedHostLibrary(): Promise<{ name: string; library: DkbHostLibraryRecord } | null> {
  const inventory = await readHostInventory();
  const name = inventory.defaults.library;

  return name && inventory.libraries[name] ? { name, library: inventory.libraries[name] } : null;
}

export async function registeredHostLibrary(nameOrPath: string): Promise<{ name: string; library: DkbHostLibraryRecord } | null> {
  const inventory = await readHostInventory();
  const resolved = await resolveLibraryEntry(inventory, nameOrPath);

  return resolved ? { name: resolved.name, library: resolved.record } : null;
}

export async function registerHostRegistry(
  name: string | undefined,
  url: string,
  options: RegisterHostRegistryOptions = {},
): Promise<{ name: string; registry: DkbHostRegistryRecord }> {
  return mutateHostInventory(async (inventory) => {
    const now = new Date().toISOString();
    const result = ensureRegistryRecord(inventory, url, name, now);
    applyDefault(inventory.defaults, 'registry', result.name, options.select);

    return { value: result, inventory };
  });
}

export async function unregisterHostRegistry(name: string): Promise<{ name: string; url: string; selectedCleared: boolean }> {
  const normalizedName = normalizeHostName(name, 'Registry name');

  return mutateHostInventory(async (inventory) => {
    const registry = inventory.registries[normalizedName];

    if (!registry) {
      throw new DkbError(`Unknown host Registry: ${name}. Run: dkb registry list`);
    }

    const usedBy = Object.entries(inventory.libraries)
      .filter(([, library]) => library.registry === normalizedName)
      .map(([libraryName]) => libraryName)
      .sort();
    const stacksUsing = Object.entries(inventory.stacks)
      .filter(([, stack]) => stack.registry === normalizedName)
      .map(([stackName]) => `stack:${stackName}`)
      .sort();

    if (usedBy.length > 0 || stacksUsing.length > 0) {
      throw new DkbError(`Registry ${normalizedName} is still used by ${[...usedBy, ...stacksUsing].join(', ')}. Reconfigure those resources first.`);
    }

    delete inventory.registries[normalizedName];
    const selectedCleared = inventory.defaults.registry === normalizedName;
    if (selectedCleared) {
      delete inventory.defaults.registry;
    }

    return { value: { name: normalizedName, url: registry.url, selectedCleared }, inventory };
  });
}

export async function selectHostRegistry(name: string): Promise<{ name: string; registry: DkbHostRegistryRecord }> {
  const normalizedName = normalizeHostName(name, 'Registry name');

  return mutateHostInventory(async (inventory) => {
    const registry = inventory.registries[normalizedName];

    if (!registry) {
      throw new DkbError(`Unknown host Registry: ${name}. Run: dkb registry list`);
    }

    inventory.defaults.registry = normalizedName;
    return { value: { name: normalizedName, registry }, inventory };
  });
}

export async function selectedHostRegistry(): Promise<{ name: string; registry: DkbHostRegistryRecord } | null> {
  const inventory = await readHostInventory();
  const name = inventory.defaults.registry;

  return name && inventory.registries[name] ? { name, registry: inventory.registries[name] } : null;
}

export async function registeredHostRegistry(name: string): Promise<{ name: string; registry: DkbHostRegistryRecord } | null> {
  const inventory = await readHostInventory();
  const normalizedName = normalizeHostName(name, 'Registry name');
  const registry = inventory.registries[normalizedName];

  return registry ? { name: normalizedName, registry } : null;
}

export async function registerHostRuntime(
  name: string,
  url: string,
  options: RegisterHostRuntimeOptions = {},
): Promise<{ name: string; runtime: DkbHostRuntimeRecord }> {
  const normalizedName = normalizeHostName(name, 'Runtime name');
  const normalizedUrl = normalizeEndpointUrl(url, 'Runtime URL');
  const stateRoot = options.stateRoot ? await canonicalExistingPath(options.stateRoot, 'Runtime state root') : undefined;
  const composeFile = options.composeFile ? path.resolve(options.composeFile) : undefined;

  return mutateHostInventory(async (inventory) => {
    const duplicateUrl = Object.entries(inventory.runtimes)
      .find(([candidateName, runtime]) => candidateName !== normalizedName && runtime.url === normalizedUrl);
    if (duplicateUrl) {
      throw new DkbError(`Runtime ${normalizedUrl} is already registered as ${duplicateUrl[0]}.`);
    }
    if (options.library && !inventory.libraries[options.library]) {
      throw new DkbError(`Unknown host Library for Runtime ${normalizedName}: ${options.library}. Run: dkb library list`);
    }

    const now = new Date().toISOString();
    const existing = inventory.runtimes[normalizedName];
    const record: DkbHostRuntimeRecord = {
      kind: options.kind ?? existing?.kind ?? 'remote',
      url: normalizedUrl,
      ...(options.library ? { library: options.library } : existing?.library ? { library: existing.library } : {}),
      ...(stateRoot ? { stateRoot } : existing?.stateRoot ? { stateRoot: existing.stateRoot } : {}),
      ...(composeFile ? { composeFile } : existing?.composeFile ? { composeFile: existing.composeFile } : {}),
      registeredAt: existing?.registeredAt ?? now,
      updatedAt: now,
    };
    inventory.runtimes[normalizedName] = record;
    applyDefault(inventory.defaults, 'runtime', normalizedName, options.select);

    return { value: { name: normalizedName, runtime: record }, inventory };
  });
}

export async function unregisterHostRuntime(name: string): Promise<{ name: string; url: string; selectedCleared: boolean }> {
  const normalizedName = normalizeHostName(name, 'Runtime name');

  return mutateHostInventory(async (inventory) => {
    const runtime = inventory.runtimes[normalizedName];

    if (!runtime) {
      throw new DkbError(`Unknown host Runtime: ${name}. Run: dkb runtime list`);
    }

    delete inventory.runtimes[normalizedName];
    const selectedCleared = inventory.defaults.runtime === normalizedName;
    if (selectedCleared) {
      delete inventory.defaults.runtime;
    }
    for (const stack of Object.values(inventory.stacks)) {
      if (stack.runtime === normalizedName) {
        delete stack.runtime;
        stack.updatedAt = new Date().toISOString();
      }
    }

    return { value: { name: normalizedName, url: runtime.url, selectedCleared }, inventory };
  });
}

export async function selectHostRuntime(name: string): Promise<{ name: string; runtime: DkbHostRuntimeRecord }> {
  const normalizedName = normalizeHostName(name, 'Runtime name');

  return mutateHostInventory(async (inventory) => {
    const runtime = inventory.runtimes[normalizedName];

    if (!runtime) {
      throw new DkbError(`Unknown host Runtime: ${name}. Run: dkb runtime list`);
    }

    inventory.defaults.runtime = normalizedName;
    return { value: { name: normalizedName, runtime }, inventory };
  });
}

export async function selectedHostRuntime(): Promise<{ name: string; runtime: DkbHostRuntimeRecord } | null> {
  const inventory = await readHostInventory();
  const name = inventory.defaults.runtime;

  return name && inventory.runtimes[name] ? { name, runtime: inventory.runtimes[name] } : null;
}

export async function registeredHostRuntime(name: string): Promise<{ name: string; runtime: DkbHostRuntimeRecord } | null> {
  const inventory = await readHostInventory();
  const normalizedName = normalizeHostName(name, 'Runtime name');
  const runtime = inventory.runtimes[normalizedName];
  return runtime ? { name: normalizedName, runtime } : null;
}

export async function registerHostStack(
  name: string,
  stateRoot: string,
  options: RegisterHostStackOptions = {},
): Promise<{ name: string; stack: DkbHostStackRecord }> {
  const normalizedName = normalizeHostName(name, 'Stack name');
  const normalizedRoot = await canonicalExistingPath(stateRoot, 'Stack state root');

  return mutateHostInventory(async (inventory) => {
    assertStackReferences(inventory, normalizedName, options);
    const duplicate = entryByStateRoot(inventory.stacks, normalizedRoot);
    if (duplicate && duplicate.name !== normalizedName) {
      throw new DkbError(`Stack ${normalizedRoot} is already registered as ${duplicate.name}.`);
    }

    const now = new Date().toISOString();
    const existing = inventory.stacks[normalizedName];
    const record: DkbHostStackRecord = {
      stateRoot: normalizedRoot,
      ...(options.library ? { library: options.library } : existing?.library ? { library: existing.library } : {}),
      ...(options.registry ? { registry: options.registry } : existing?.registry ? { registry: existing.registry } : {}),
      ...(options.runtime ? { runtime: options.runtime } : existing?.runtime ? { runtime: existing.runtime } : {}),
      registeredAt: existing?.registeredAt ?? now,
      updatedAt: now,
    };
    inventory.stacks[normalizedName] = record;
    applyDefault(inventory.defaults, 'stack', normalizedName, options.select);

    return { value: { name: normalizedName, stack: record }, inventory };
  });
}

export async function selectHostStack(name: string): Promise<{ name: string; stack: DkbHostStackRecord }> {
  const normalizedName = normalizeHostName(name, 'Stack name');
  return mutateHostInventory(async (inventory) => {
    const stack = inventory.stacks[normalizedName];
    if (!stack) throw new DkbError(`Unknown host Stack: ${name}. Run: dkb stack list`);
    inventory.defaults.stack = normalizedName;
    if (stack.library) inventory.defaults.library = stack.library;
    if (stack.registry) inventory.defaults.registry = stack.registry;
    if (stack.runtime) inventory.defaults.runtime = stack.runtime;
    return { value: { name: normalizedName, stack }, inventory };
  });
}

export async function defaultHostStack(): Promise<{ name: string; stack: DkbHostStackRecord } | null> {
  const inventory = await readHostInventory();
  const name = inventory.defaults.stack;
  return name && inventory.stacks[name] ? { name, stack: inventory.stacks[name] } : null;
}

export function normalizeHostName(value: string, label = 'Host resource name'): string {
  const normalized = value.trim().toLowerCase();

  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u.test(normalized)) {
    throw new DkbError(`${label} must use 1-64 lowercase letters, numbers, dots, dashes, or underscores.`);
  }

  return normalized;
}

export function normalizeEndpointUrl(value: string, label = 'Endpoint URL'): string {
  const raw = value.trim();
  const markdownLink = raw.match(/^\[([^\]]+)]\([^)]+\)$/);

  if (markdownLink) {
    throw new DkbError(`${label} was pasted as a Markdown link. Use the plain URL instead: ${markdownLink[1]}`);
  }

  let parsed: URL;

  try {
    parsed = new URL(raw);
  } catch {
    throw new DkbError(`Invalid ${label}: ${value}`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new DkbError(`${label} must use http or https: ${value}`);
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/gu, '');
  parsed.search = '';
  parsed.hash = '';

  return parsed.toString().replace(/\/+$/gu, '');
}

export function validateHostInventory(value: unknown, source = hostInventoryPath()): DkbHostInventory {
  if (!isRecord(value)) {
    throw new DkbError(`Invalid DKB host inventory at ${source}: expected an object.`);
  }
  assertOnlyKeys(value, ['format', 'defaults', 'libraries', 'registries', 'runtimes', 'stacks'], source);
  if (value.format !== DKB_HOST_INVENTORY_FORMAT) {
    throw new DkbError(`Invalid DKB host inventory at ${source}: format must be ${DKB_HOST_INVENTORY_FORMAT}.`);
  }
  if (!isRecord(value.defaults) || !isRecord(value.libraries) || !isRecord(value.registries) || !isRecord(value.runtimes) || !isRecord(value.stacks)) {
    throw new DkbError(`Invalid DKB host inventory at ${source}: defaults, libraries, registries, runtimes, and stacks must be objects.`);
  }
  assertOnlyKeys(value.defaults, ['library', 'registry', 'runtime', 'stack'], `${source} defaults`);

  const libraries: Record<string, DkbHostLibraryRecord> = {};
  for (const [name, item] of Object.entries(value.libraries)) {
    assertCanonicalHostKey(name, 'Library name');
    libraries[name] = validateLibraryRecord(item, `${source} Library ${name}`);
  }
  const registries: Record<string, DkbHostRegistryRecord> = {};
  for (const [name, item] of Object.entries(value.registries)) {
    assertCanonicalHostKey(name, 'Registry name');
    registries[name] = validateRegistryRecord(item, `${source} Registry ${name}`);
  }
  const runtimes: Record<string, DkbHostRuntimeRecord> = {};
  for (const [name, item] of Object.entries(value.runtimes)) {
    assertCanonicalHostKey(name, 'Runtime name');
    runtimes[name] = validateRuntimeRecord(item, `${source} Runtime ${name}`);
  }
  const stacks: Record<string, DkbHostStackRecord> = {};
  for (const [name, item] of Object.entries(value.stacks)) {
    assertCanonicalHostKey(name, 'Stack name');
    stacks[name] = validateStackRecord(item, `${source} Stack ${name}`);
  }
  for (const [name, library] of Object.entries(libraries)) {
    if (library.registry && !registries[library.registry]) {
      throw new DkbError(`Invalid DKB host inventory at ${source}: Library ${name} references unknown Registry ${library.registry}.`);
    }
  }
  for (const [name, runtime] of Object.entries(runtimes)) {
    if (runtime.library && !libraries[runtime.library]) {
      throw new DkbError(`Invalid DKB host inventory at ${source}: Runtime ${name} references unknown Library ${runtime.library}.`);
    }
  }
  for (const [name, stack] of Object.entries(stacks)) {
    if (stack.library && !libraries[stack.library]) throw new DkbError(`Invalid DKB host inventory at ${source}: Stack ${name} references unknown Library ${stack.library}.`);
    if (stack.registry && !registries[stack.registry]) throw new DkbError(`Invalid DKB host inventory at ${source}: Stack ${name} references unknown Registry ${stack.registry}.`);
    if (stack.runtime && !runtimes[stack.runtime]) throw new DkbError(`Invalid DKB host inventory at ${source}: Stack ${name} references unknown Runtime ${stack.runtime}.`);
  }
  const defaults = validateDefaults(value.defaults, { libraries, registries, runtimes, stacks }, source);

  return {
    format: DKB_HOST_INVENTORY_FORMAT,
    defaults,
    libraries,
    registries,
    runtimes,
    stacks,
  };
}

function emptyHostInventory(): DkbHostInventory {
  return {
    format: DKB_HOST_INVENTORY_FORMAT,
    defaults: {},
    libraries: {},
    registries: {},
    runtimes: {},
    stacks: {},
  };
}

async function mutateHostInventory<T>(
  mutation: (inventory: DkbHostInventory) => Promise<{ value: T; inventory: DkbHostInventory }>,
): Promise<T> {
  const target = hostInventoryPath();

  return withProcessMutationLock(target, async () => {
    const release = await acquireInventoryLock(target);

    try {
      const current = await readHostInventory(target);
      const { value, inventory } = await mutation(current);
      await writeHostInventory(target, validateHostInventory(inventory, target));

      return value;
    } finally {
      await release();
    }
  });
}

async function acquireInventoryLock(target: string): Promise<() => Promise<void>> {
  const lockPath = `${target}.lock`;
  const startedAt = Date.now();
  const token = randomUUID();
  await fs.mkdir(path.dirname(target), { recursive: true });

  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })}\n`, 'utf8');
      await handle.close();

      return async () => {
        const currentToken = await inventoryLockToken(lockPath);
        if (currentToken === token) {
          await fs.rm(lockPath, { force: true });
        }
      };
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
      const state = await inventoryLockState(lockPath);
      if (state === 'stale') {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      if (state === 'missing') {
        continue;
      }
      if (Date.now() - startedAt >= 5_000) {
        throw new DkbError(`Timed out waiting for DKB host inventory lock: ${lockPath}`);
      }
      await delay(25);
    }
  }
}

async function withProcessMutationLock<T>(target: string, action: () => Promise<T>): Promise<T> {
  const key = comparablePath(target);
  const previous = processMutationTails.get(key) ?? Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  processMutationTails.set(key, tail);

  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    releaseGate();
    if (processMutationTails.get(key) === tail) {
      processMutationTails.delete(key);
    }
  }
}

async function writeHostInventory(target: string, inventory: DkbHostInventory): Promise<void> {
  const temporary = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  const backup = `${target}.${process.pid}.${Date.now().toString(36)}.replace`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify(inventory, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  try {
    await fs.rename(temporary, target);
  } catch (error) {
    if (!await pathExists(target)) {
      await fs.rm(temporary, { force: true });
      throw error;
    }

    await fs.rename(target, backup);
    try {
      await fs.rename(temporary, target);
      await fs.rm(backup, { force: true });
    } catch (replacementError) {
      await fs.rm(target, { force: true });
      await fs.rename(backup, target);
      await fs.rm(temporary, { force: true });
      throw replacementError;
    }
  }

  await fs.chmod(target, 0o600).catch(() => undefined);
}

async function inspectLibraryPath(value: string): Promise<{ path: string; displayName: string; registryUrl?: string }> {
  const canonical = await canonicalExistingPath(value, 'Library path');
  const manifestPath = path.join(canonical, 'dkb.json');
  let manifest: unknown;

  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    throw new DkbError(`Invalid DKB Library manifest at ${manifestPath}: ${errorMessage(error)}`);
  }

  if (!isRecord(manifest) || manifest.type !== 'library' || typeof manifest.name !== 'string' || manifest.name.trim().length === 0) {
    throw new DkbError(`Not a DKB Library: ${canonical}. Expected dkb.json with type "library" and a name.`);
  }

  return {
    path: canonical,
    displayName: typeof manifest.displayName === 'string' && manifest.displayName.trim()
      ? manifest.displayName.trim()
      : manifest.name.trim(),
    ...(isRecord(manifest.registry) && typeof manifest.registry.url === 'string' && manifest.registry.url.trim()
      ? { registryUrl: normalizeEndpointUrl(manifest.registry.url, 'Registry URL') }
      : {}),
  };
}

function ensureRegistryRecord(
  inventory: DkbHostInventory,
  value: string,
  requestedName: string | undefined,
  now: string,
): { name: string; registry: DkbHostRegistryRecord } {
  const url = normalizeEndpointUrl(value, 'Registry URL');
  const existing = Object.entries(inventory.registries).find(([, registry]) => registry.url === url);
  if (existing) {
    if (requestedName && existing[0] !== normalizeHostName(requestedName, 'Registry name')) {
      throw new DkbError(`Registry ${url} is already registered as ${existing[0]}.`);
    }
    const record = { ...existing[1], updatedAt: now };
    inventory.registries[existing[0]] = record;
    return { name: existing[0], registry: record };
  }

  const parsed = new URL(url);
  const preferred = `${parsed.hostname}${parsed.port ? `-${parsed.port}` : ''}`;
  const name = availableName(inventory.registries, requestedName, preferred, url, 'Registry name');
  const record: DkbHostRegistryRecord = { url, registeredAt: now, updatedAt: now };
  inventory.registries[name] = record;

  return { name, registry: record };
}

function availableName<T>(
  records: Record<string, T>,
  requestedName: string | undefined,
  preferredName: string,
  identity: string,
  label: string,
): string {
  if (requestedName) {
    const name = normalizeHostName(requestedName, label);
    if (records[name]) {
      throw new DkbError(`${label.replace(/ name$/iu, '')} ${name} is already registered.`);
    }
    return name;
  }

  const base = slugifyHostName(preferredName);
  if (!records[base]) {
    return base;
  }

  return `${base.slice(0, 54)}-${createHash('sha256').update(identity).digest('hex').slice(0, 8)}`;
}

function slugifyHostName(value: string): string {
  const normalized = value.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, '')
    .slice(0, 64);

  return normalized || 'dkb-resource';
}

async function resolveLibraryEntry(
  inventory: DkbHostInventory,
  nameOrPath: string,
): Promise<{ name: string; record: DkbHostLibraryRecord } | null> {
  const byName = inventory.libraries[nameOrPath.trim().toLowerCase()];
  if (byName) {
    return { name: nameOrPath.trim().toLowerCase(), record: byName };
  }

  const candidate = path.resolve(nameOrPath);
  const canonical = await fs.realpath(candidate).catch(() => candidate);
  return entryByPath(inventory.libraries, canonical);
}

function entryByPath<T extends { path?: string }>(
  entries: Record<string, T>,
  candidate: string,
): { name: string; record: T } | null {
  const key = comparablePath(candidate);
  const found = Object.entries(entries).find(([, entry]) => entry.path !== undefined && comparablePath(entry.path) === key);

  return found ? { name: found[0], record: found[1] } : null;
}

function entryByStateRoot<T extends { stateRoot: string }>(
  entries: Record<string, T>,
  candidate: string,
): { name: string; record: T } | null {
  const key = comparablePath(candidate);
  const found = Object.entries(entries).find(([, entry]) => comparablePath(entry.stateRoot) === key);
  return found ? { name: found[0], record: found[1] } : null;
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function applyDefault(
  defaults: DkbHostInventory['defaults'],
  key: keyof DkbHostInventory['defaults'],
  name: string,
  selection: boolean | 'if-empty' | undefined,
): void {
  if (selection === true || (selection === 'if-empty' && !defaults[key])) {
    defaults[key] = name;
  }
}

function validateLibraryRecord(value: unknown, source: string): DkbHostLibraryRecord {
  assertRecord(value, source);
  assertOnlyKeys(value, ['path', 'storage', 'displayName', 'registry', 'registeredAt', 'updatedAt'], source);
  if (Object.hasOwn(value, 'storage') === Object.hasOwn(value, 'path')) {
    throw new DkbError(`Invalid DKB host inventory at ${source}: exactly one local path or Docker storage descriptor is required.`);
  }
  const location: HostLibraryLocation = Object.hasOwn(value, 'storage')
    ? { storage: validateDockerLibraryStorage(value.storage) }
    : { path: requiredString(value.path, `${source} path`) };
  return {
    ...location,
    displayName: requiredString(value.displayName, `${source} displayName`),
    ...(value.registry === undefined ? {} : { registry: normalizeHostName(requiredString(value.registry, `${source} registry`), 'Registry name') }),
    registeredAt: requiredTimestamp(value.registeredAt, `${source} registeredAt`),
    updatedAt: requiredTimestamp(value.updatedAt, `${source} updatedAt`),
  };
}

function validateRegistryRecord(value: unknown, source: string): DkbHostRegistryRecord {
  assertRecord(value, source);
  assertOnlyKeys(value, ['url', 'registeredAt', 'updatedAt'], source);
  return {
    url: normalizeEndpointUrl(requiredString(value.url, `${source} URL`), 'Registry URL'),
    registeredAt: requiredTimestamp(value.registeredAt, `${source} registeredAt`),
    updatedAt: requiredTimestamp(value.updatedAt, `${source} updatedAt`),
  };
}

function validateRuntimeRecord(value: unknown, source: string): DkbHostRuntimeRecord {
  assertRecord(value, source);
  assertOnlyKeys(value, ['kind', 'url', 'library', 'stateRoot', 'composeFile', 'registeredAt', 'updatedAt'], source);
  if (!['process', 'docker', 'remote'].includes(String(value.kind))) {
    throw new DkbError(`Invalid DKB host inventory at ${source}: invalid Runtime kind.`);
  }
  return {
    kind: value.kind as DkbHostRuntimeKind,
    url: normalizeEndpointUrl(requiredString(value.url, `${source} URL`), 'Runtime URL'),
    ...(value.library === undefined ? {} : { library: normalizeHostName(requiredString(value.library, `${source} library`), 'Library name') }),
    ...(value.stateRoot === undefined ? {} : { stateRoot: requiredString(value.stateRoot, `${source} stateRoot`) }),
    ...(value.composeFile === undefined ? {} : { composeFile: requiredString(value.composeFile, `${source} composeFile`) }),
    registeredAt: requiredTimestamp(value.registeredAt, `${source} registeredAt`),
    updatedAt: requiredTimestamp(value.updatedAt, `${source} updatedAt`),
  };
}

function validateStackRecord(value: unknown, source: string): DkbHostStackRecord {
  assertRecord(value, source);
  assertOnlyKeys(value, ['stateRoot', 'library', 'registry', 'runtime', 'registeredAt', 'updatedAt'], source);
  return {
    stateRoot: requiredString(value.stateRoot, `${source} stateRoot`),
    ...(value.library === undefined ? {} : { library: normalizeHostName(requiredString(value.library, `${source} library`), 'Library name') }),
    ...(value.registry === undefined ? {} : { registry: normalizeHostName(requiredString(value.registry, `${source} registry`), 'Registry name') }),
    ...(value.runtime === undefined ? {} : { runtime: normalizeHostName(requiredString(value.runtime, `${source} runtime`), 'Runtime name') }),
    registeredAt: requiredTimestamp(value.registeredAt, `${source} registeredAt`),
    updatedAt: requiredTimestamp(value.updatedAt, `${source} updatedAt`),
  };
}

function validateDefaults(
  value: Record<string, unknown>,
  records: Pick<DkbHostInventory, 'libraries' | 'registries' | 'runtimes' | 'stacks'>,
  source: string,
): DkbHostInventory['defaults'] {
  const defaults: DkbHostInventory['defaults'] = {};

  for (const key of ['library', 'registry', 'runtime', 'stack'] as const) {
    if (value[key] === undefined) continue;
    const name = normalizeHostName(requiredString(value[key], `${source} default ${key}`), `${key} name`);
    const collection = key === 'library'
      ? records.libraries
      : key === 'registry'
        ? records.registries
        : key === 'runtime'
          ? records.runtimes
          : records.stacks;
    if (!collection[name]) {
      throw new DkbError(`Invalid DKB host inventory at ${source}: default ${key} ${name} is not registered.`);
    }
    defaults[key] = name;
  }

  return defaults;
}

function assertStackReferences(inventory: DkbHostInventory, name: string, options: RegisterHostStackOptions): void {
  if (options.library && !inventory.libraries[options.library]) throw new DkbError(`Unknown host Library for Stack ${name}: ${options.library}.`);
  if (options.registry && !inventory.registries[options.registry]) throw new DkbError(`Unknown host Registry for Stack ${name}: ${options.registry}.`);
  if (options.runtime && !inventory.runtimes[options.runtime]) throw new DkbError(`Unknown host Runtime for Stack ${name}: ${options.runtime}.`);
}

function migrateHostInventoryV1(value: Record<string, unknown>, source: string): DkbHostInventory {
  assertOnlyKeys(value, ['format', 'selected', 'libraries', 'registries', 'runtimes'], source);
  if (!isRecord(value.selected) || !isRecord(value.libraries) || !isRecord(value.registries) || !isRecord(value.runtimes)) {
    throw new DkbError(`Invalid DKB host inventory at ${source}: selected, libraries, registries, and runtimes must be objects.`);
  }

  const migrated = validateHostInventory({
    format: DKB_HOST_INVENTORY_FORMAT,
    defaults: value.selected,
    libraries: value.libraries,
    registries: value.registries,
    runtimes: value.runtimes,
    stacks: {},
  }, source);
  const now = new Date().toISOString();
  for (const [runtimeName, runtime] of Object.entries(migrated.runtimes)) {
    if (runtime.kind !== 'docker' || !runtime.stateRoot) continue;
    const stateRoot = path.dirname(runtime.stateRoot);
    const name = normalizeHostName(path.basename(stateRoot), 'Stack name');
    migrated.stacks[name] = {
      stateRoot,
      ...(runtime.library ? { library: runtime.library } : {}),
      ...(runtime.library && migrated.libraries[runtime.library]?.registry ? { registry: migrated.libraries[runtime.library].registry } : {}),
      runtime: runtimeName,
      registeredAt: runtime.registeredAt ?? now,
      updatedAt: runtime.updatedAt ?? now,
    };
  }
  if (migrated.stacks.local) migrated.defaults.stack = 'local';
  else if (Object.keys(migrated.stacks).length === 1) migrated.defaults.stack = Object.keys(migrated.stacks)[0];
  return validateHostInventory(migrated, source);
}

function assertRecord(value: unknown, source: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new DkbError(`Invalid DKB host inventory at ${source}: expected an object.`);
  }
}

function assertCanonicalHostKey(value: string, label: string): void {
  const normalized = normalizeHostName(value, label);
  if (value !== normalized) {
    throw new DkbError(`${label} must be canonical lowercase: ${normalized}.`);
  }
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[], source: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new DkbError(`Invalid DKB host inventory at ${source}: unexpected fields ${unexpected.join(', ')}.`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DkbError(`Invalid DKB host inventory: ${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requiredTimestamp(value: unknown, label: string): string {
  const timestamp = requiredString(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new DkbError(`Invalid DKB host inventory: ${label} must be an ISO timestamp.`);
  }
  return timestamp;
}

async function canonicalExistingPath(value: string, label: string): Promise<string> {
  const resolved = path.resolve(value);
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      throw new DkbError(`${label} is not a directory: ${resolved}`);
    }
    return await fs.realpath(resolved);
  } catch (error) {
    if (error instanceof DkbError) throw error;
    throw new DkbError(`${label} does not exist: ${resolved}`);
  }
}

async function inventoryLockState(lockPath: string): Promise<'active' | 'stale' | 'missing'> {
  try {
    const stat = await fs.stat(lockPath);
    return Date.now() - stat.mtimeMs > 30_000 ? 'stale' : 'active';
  } catch (error) {
    if (isMissing(error)) {
      return 'missing';
    }
    throw error;
  }
}

async function inventoryLockToken(lockPath: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, 'utf8')) as unknown;
    return isRecord(parsed) && typeof parsed.token === 'string' ? parsed.token : null;
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
