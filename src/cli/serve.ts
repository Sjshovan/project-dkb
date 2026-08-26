import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { compileComposeProject } from '../compiler/compile.js';
import { DkbError } from '../protocol/errors.js';
import { loadRegistry } from '../protocol/manifest.js';
import {
  configuredRegistry,
  normalizeRegistryUrl,
  verifyRegistryEndpoint,
  writeConfiguredRegistryUrl,
  type ConfiguredRegistry,
  type RegistryVerification,
} from '../registry/config.js';

export interface PrepareServeOptions {
  cwd?: string;
  root?: string;
  yes?: boolean;
  registryUrl?: string;
  verifyRegistry?: boolean;
  stdin?: NodeJS.ReadStream;
  stderr?: NodeJS.WriteStream;
  createPrompt?: (input: NodeJS.ReadStream, output: NodeJS.WriteStream) => Pick<Interface, 'question' | 'close'>;
}

export interface PreparedServeRegistry {
  root: string;
  initialized: boolean;
  compiled: boolean;
  registry: ConfiguredRegistry;
  verification?: RegistryVerification;
  warning?: string;
  retryCommand?: string;
  compileResult?: Awaited<ReturnType<typeof compileComposeProject>>;
}

export interface ResolvedRegistryInitialization {
  url: string;
  configured?: ConfiguredRegistry;
  verification?: RegistryVerification;
  warning?: string;
  retryCommand?: string;
}

const DKB_MANIFEST_FILENAME = 'dkb.json';

export async function prepareServeRegistry(options: PrepareServeOptions = {}): Promise<PreparedServeRegistry> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const explicitRoot = options.root ? path.resolve(cwd, options.root) : null;
  const targetRoot = explicitRoot
    ? await isRegistryRoot(explicitRoot) ? explicitRoot : null
    : await nearestRegistryRoot(cwd);

  if (targetRoot) {
    const registry = await configuredRegistry({ root: targetRoot });
    const compileResult = await compileRegistryForServe(targetRoot);

    return {
      root: targetRoot,
      initialized: false,
      compiled: true,
      registry,
      compileResult,
    };
  }

  const root = explicitRoot ?? cwd;
  await confirmServeInitialization(root, options);
  const selectedRegistry = await resolveRegistryInitializationConfiguration({
    root,
    registryUrl: options.registryUrl,
    yes: Boolean(options.yes),
    verify: options.verifyRegistry !== false,
    stdin: options.stdin,
    stderr: options.stderr,
    createPrompt: options.createPrompt,
  });
  await initializeRegistryManifest(root);
  const registry = selectedRegistry.configured ?? await writeConfiguredRegistryUrl(selectedRegistry.url, { root });
  const compileResult = await compileRegistryForServe(root);

  return {
    root,
    initialized: true,
    compiled: true,
    registry,
    compileResult,
    ...(selectedRegistry.verification ? { verification: selectedRegistry.verification } : {}),
    ...(selectedRegistry.warning
      ? {
          warning: selectedRegistry.warning,
          retryCommand: selectedRegistry.retryCommand,
        }
      : {}),
  };
}

export async function resolveRegistryInitializationConfiguration(options: {
  root: string;
  registryUrl?: string;
  yes: boolean;
  verify: boolean;
  stdin?: NodeJS.ReadStream;
  stderr?: NodeJS.WriteStream;
  createPrompt?: (input: NodeJS.ReadStream, output: NodeJS.WriteStream) => Pick<Interface, 'question' | 'close'>;
}): Promise<ResolvedRegistryInitialization> {
  const current = await configuredRegistry({ root: options.root });

  if (!options.registryUrl && current.source === 'project') {
    return {
      url: current.url,
      configured: current,
    };
  }

  let registryUrl = options.registryUrl?.trim();

  if (!registryUrl) {
    const stdin = options.stdin ?? process.stdin;
    const stderr = options.stderr ?? process.stderr;

    if (options.yes || !stdin.isTTY) {
      registryUrl = current.url;
    } else {
      const prompt = options.createPrompt
        ? options.createPrompt(stdin, stderr)
        : createInterface({ input: stdin, output: stderr });

      try {
        registryUrl = (await prompt.question(`Upstream package registry URL [${current.url}]: `)).trim() || current.url;
      } finally {
        prompt.close();
      }
    }
  }

  const normalized = normalizeRegistryUrl(registryUrl);
  const verification = options.verify ? await verifyRegistryEndpoint(normalized) : undefined;
  const warning = verification && !verification.ok
    ? `Upstream registry ${normalized} could not be verified. The local registry was still created and can be used offline.`
    : !options.verify
      ? `Upstream registry ${normalized} was not verified because verification was skipped.`
      : undefined;

  return {
    url: normalized,
    ...(verification ? { verification } : {}),
    ...(warning
      ? {
          warning,
          retryCommand: `dkb registry use ${normalized}`,
        }
      : {}),
  };
}

export async function nearestRegistryRoot(start: string): Promise<string | null> {
  let current = path.resolve(start);

  while (true) {
    if (await isRegistryRoot(current)) {
      return current;
    }

    const parent = path.dirname(current);

    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

export async function initializeRegistryManifest(root: string): Promise<string> {
  const manifestPath = path.join(root, DKB_MANIFEST_FILENAME);

  if (await exists(manifestPath)) {
    throw new DkbError(`Cannot initialize registry because ${DKB_MANIFEST_FILENAME} already exists at ${manifestPath}`);
  }

  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(registryManifestForFolder(root), null, 2)}\n`, 'utf8');

  return manifestPath;
}

export function registryManifestForFolder(root: string) {
  const name = titleFromId(path.basename(path.resolve(root)) || 'Local Registry');

  return {
    manifestVersion: 1,
    type: 'registry',
    name,
    version: '0.0.0-local',
    description: 'Local DKB registry.',
    localSources: {
      enabled: true,
      root: '.',
    },
    dependencies: {},
  };
}

async function compileRegistryForServe(root: string): Promise<Awaited<ReturnType<typeof compileComposeProject>>> {
  try {
    return await compileComposeProject(root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (/compile lock/i.test(message)) {
      throw new DkbError(`Unable to prepare DKB registry at ${root}: another compile appears to be running. ${message}`);
    }

    throw new DkbError(`Unable to prepare DKB registry at ${root}: ${message}`);
  }
}

async function confirmServeInitialization(root: string, options: PrepareServeOptions): Promise<void> {
  if (options.yes) {
    return;
  }

  const stdin = options.stdin ?? process.stdin;
  const stderr = options.stderr ?? process.stderr;

  if (!stdin.isTTY) {
    throw new DkbError(`No DKB registry found from ${root}. Noninteractive dkb serve will not create files. Run: dkb init --yes`);
  }

  const prompt = options.createPrompt
    ? options.createPrompt(stdin, stderr)
    : createInterface({ input: stdin, output: stderr });

  try {
    const first = await prompt.question(`No DKB registry was found. Initialize ${root} as a DKB registry? [y/N] `);

    if (!isAffirmative(first)) {
      throw new DkbError('DKB registry initialization cancelled.');
    }

    if (await isNonEmptyDirectory(root)) {
      const second = await prompt.question('This folder is not empty. No existing files will be moved or deleted; eligible sources will be compiled. Continue? [y/N] ');

      if (!isAffirmative(second)) {
        throw new DkbError('DKB registry initialization cancelled.');
      }
    }
  } finally {
    prompt.close();
  }
}

async function isRegistryRoot(root: string): Promise<boolean> {
  const manifestPath = path.join(root, DKB_MANIFEST_FILENAME);

  if (!(await isRegistryManifestFile(manifestPath))) {
    return false;
  }

  try {
    await loadRegistry(root);

    return true;
  } catch {
    return false;
  }
}

async function isRegistryManifestFile(manifestPath: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { type?: unknown; dependencies?: unknown };

    return manifest.type === 'registry'
      || (manifest.dependencies !== undefined && typeof manifest.dependencies === 'object' && !Array.isArray(manifest.dependencies));
  } catch {
    return false;
  }
}

async function isNonEmptyDirectory(root: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(root);

    return entries.length > 0;
  } catch {
    return false;
  }
}

function isAffirmative(value: string): boolean {
  return ['y', 'yes'].includes(value.trim().toLowerCase());
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);

    return true;
  } catch {
    return false;
  }
}

function titleFromId(value: string): string {
  return value
    .split(/[-_.]+/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ') || value;
}
