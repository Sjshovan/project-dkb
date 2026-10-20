import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CliLibraryReference } from './context.js';
import {
  hostInventoryPath,
  registeredHostLibrary,
  registeredHostRegistry,
  selectedHostRegistry,
} from '../host/inventory.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { isLibraryRoot, nearestLibraryRoot } from '@sjshovan/dkb-library/root.js';
import { DEFAULT_REGISTRY_URL, normalizeRegistryUrl } from '@sjshovan/dkb-registry-client/config.js';
import {
  DKB_CONFIG_FORMAT,
  readDkbContextConfig,
  writeDkbContextConfig,
  validateContextConfig,
  type DkbContextConfig,
} from '@sjshovan/dkb-pipeline/config.js';

export { DEFAULT_REGISTRY_URL, normalizeRegistryUrl, verifyRegistryEndpoint } from '@sjshovan/dkb-registry-client/config.js';
export type { RegistryVerification, RegistryVerificationCheck } from '@sjshovan/dkb-registry-client/config.js';

export const DKB_FOLDER_CONFIG_PATH = '.dkb/config.json';

export type RegistryUrlSource = 'argument' | 'environment' | 'project' | 'host-library' | 'host' | 'user' | 'default';

export interface ConfiguredRegistry {
  url: string;
  source: RegistryUrlSource;
  configPath: string;
  root?: string;
}

interface RegistryConfigurationOptions {
  url?: string;
  root?: string;
  cwd?: string;
  library?: CliLibraryReference;
}

export function cliConfigPath(): string {
  return process.env.DKB_CLI_CONFIG
    ? path.resolve(process.env.DKB_CLI_CONFIG)
    : path.join(os.homedir(), '.dkb', 'config.json');
}

export function libraryRegistryConfigPath(root: string): string {
  return path.join(path.resolve(root), ...DKB_FOLDER_CONFIG_PATH.split('/'));
}

export async function configuredRegistry(options: RegistryConfigurationOptions = {}): Promise<ConfiguredRegistry> {
  if (options.library?.kind === 'docker') {
    if (options.root) throw new DkbError('A Docker Library reference cannot also specify a host root.');
    if (options.url || process.env.DKB_REGISTRY_URL) return resolveConfiguredRegistry(options, null);
    const { readDockerLibraryCommand } = await import('../host/libraryOwnerResult.js');
    const { dockerLibraryOwner } = await import('../host/libraryLocation.js');
    // The existing owner CLI supplies manifest/config precedence. Ignore its
    // isolated user/default fallback; host associations and credentials stay here.
    const state = await readDockerLibraryCommand<{ registryUrl: string; registrySource: RegistryUrlSource }>(
      dockerLibraryOwner(options.library.storage), 'library.packages', {}, { libraryName: options.library.name });
    if (state.registrySource === 'project') return configuredResult(normalizeRegistryUrl(state.registryUrl), 'project', hostInventoryPath(), null);
    const registered = await registeredHostLibrary(options.library.name);
    const associated = registered?.library.registry ? await registeredHostRegistry(registered.library.registry) : null;
    if (associated) return configuredResult(associated.registry.url, 'host-library', hostInventoryPath(), null);
    return resolveConfiguredRegistry(options, null);
  }
  if (options.library?.kind === 'local') options = { ...options, root: options.library.path };
  const projectRoot = options.root
    ? path.resolve(options.root)
    : await nearestLibraryRoot(options.cwd ?? process.cwd(), { includeInterrupted: true });
  if (!projectRoot || await nearestLibraryRoot(projectRoot, { includeInterrupted: true }) !== projectRoot) {
    return resolveConfiguredRegistry(options, projectRoot);
  }
  const { captureLibraryReadFence, withLibraryReadSnapshot } = await import('@sjshovan/dkb-library/mutation.js');
  return withLibraryReadSnapshot(async () => {
    if (projectRoot) await captureLibraryReadFence(projectRoot);
    return resolveConfiguredRegistry(options, projectRoot);
  });
}

async function resolveConfiguredRegistry(options: RegistryConfigurationOptions, projectRoot: string | null): Promise<ConfiguredRegistry> {
  const projectConfigPath = projectRoot ? libraryRegistryConfigPath(projectRoot) : null;
  const userConfigPath = cliConfigPath();
  const preferredConfigPath = projectConfigPath ?? userConfigPath;

  if (options.url) {
    return configuredResult(normalizeRegistryUrl(options.url), 'argument', preferredConfigPath, projectRoot);
  }

  if (process.env.DKB_REGISTRY_URL) {
    return configuredResult(normalizeRegistryUrl(process.env.DKB_REGISTRY_URL), 'environment', preferredConfigPath, projectRoot);
  }

  if (projectConfigPath) {
    const manifestUrl = await libraryManifestRegistryUrl(projectRoot!);
    if (manifestUrl) {
      return configuredResult(normalizeRegistryUrl(manifestUrl), 'project', projectConfigPath, projectRoot);
    }
    const projectConfig = await readCliConfig(projectConfigPath);
    const projectUrl = projectConfig.registry?.url;

    if (projectUrl) {
      return configuredResult(normalizeRegistryUrl(projectUrl), 'project', projectConfigPath, projectRoot);
    }

    const hostLibrary = await registeredHostLibrary(projectRoot!);
    if (hostLibrary?.library.registry) {
      const associatedRegistry = await registeredHostRegistry(hostLibrary.library.registry);
      if (associatedRegistry) {
        return configuredResult(associatedRegistry.registry.url, 'host-library', hostInventoryPath(), projectRoot);
      }
    }
  }

  const selected = await selectedHostRegistry();
  if (selected) {
    return configuredResult(selected.registry.url, 'host', hostInventoryPath(), projectRoot);
  }

  const userConfig = await readCliConfig(userConfigPath);
  const userUrl = userConfig.registry?.url;

  if (userUrl) {
    return configuredResult(normalizeRegistryUrl(userUrl), 'user', userConfigPath, projectRoot);
  }

  return configuredResult(DEFAULT_REGISTRY_URL, 'default', preferredConfigPath, projectRoot);
}

export async function writeConfiguredRegistryUrl(url: string, options: {
  root?: string;
  cwd?: string;
  global?: boolean;
} = {}): Promise<ConfiguredRegistry & { changed: boolean }> {
  if (options.global && options.root) {
    throw new DkbError('Registry configuration cannot use --global and --root together.');
  }

  const normalized = normalizeRegistryUrl(url);
  const projectRoot = options.global
    ? null
    : await nearestLibraryRoot(options.root ?? options.cwd ?? process.cwd(), { includeInterrupted: true });
  if (options.root && projectRoot !== path.resolve(options.root)) {
    throw new DkbError(`Not a DKB Library: ${path.resolve(options.root)}. Expected a Library dkb.json.`);
  }
  const configPath = projectRoot ? libraryRegistryConfigPath(projectRoot) : cliConfigPath();
  let changed = false;
  const nextConfig = async () => {
    const config = await readCliConfig(configPath);
    const updated = validateContextConfig({ ...config, format: DKB_CONFIG_FORMAT,
      registry: { ...(config.registry ?? {}), url: normalized } }, configPath);
    return { config, updated };
  };
  if (projectRoot) {
    const { withDkbFileLock } = await import('@sjshovan/dkb-library/locks.js');
    const { captureLibraryReadFence, withLibraryMutation, writeLibraryMutationFile, writeLibraryConfigurationFile } = await import('@sjshovan/dkb-library/mutation.js');
    // Queue behind a live writer before reading a possibly displaced manifest.
    await withDkbFileLock(projectRoot, 'library-mutation', async () => {
      await captureLibraryReadFence(projectRoot);
      if (!(await isLibraryRoot(projectRoot))) throw new DkbError(`Not a DKB Library: ${projectRoot}. Expected a Library dkb.json.`);
      const manifestPath = path.join(projectRoot, 'dkb.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      const { config, updated } = await nextConfig();
      const registry = isObject(manifest.registry) ? manifest.registry : {};
      if (registry.url === normalized && config.registry?.url === normalized) return;
      await withLibraryMutation(projectRoot, async () => {
        await writeLibraryConfigurationFile(projectRoot, `${JSON.stringify(updated, null, 2)}\n`);
        await writeLibraryMutationFile(projectRoot, manifestPath, `${JSON.stringify({ ...manifest, registry: { ...registry, url: normalized } }, null, 2)}\n`);
      });
      changed = true;
    });
  } else {
    const { config, updated } = await nextConfig();
    if (config.registry?.url !== normalized) {
      await writeDkbContextConfig(configPath, updated);
      changed = true;
    }
  }

  return { ...configuredResult(normalized, projectRoot ? 'project' : 'user', configPath, projectRoot), changed };
}

async function readCliConfig(configPath: string): Promise<DkbContextConfig> {
  return readDkbContextConfig(configPath);
}

async function libraryManifestRegistryUrl(root: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'dkb.json'), 'utf8')) as unknown;
    if (!isObject(manifest) || manifest.type !== 'library' || !isObject(manifest.registry)) return null;
    return typeof manifest.registry.url === 'string' ? manifest.registry.url : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function configuredResult(
  url: string,
  source: RegistryUrlSource,
  configPath: string,
  root: string | null,
): ConfiguredRegistry {
  return {
    url,
    source,
    configPath,
    ...(root ? { root } : {}),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
