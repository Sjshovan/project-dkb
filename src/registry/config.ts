import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hostInventoryPath, selectedHostRegistry } from '../host/inventory.js';
import { DkbError } from '../protocol/errors.js';

export const DEFAULT_REGISTRY_URL = 'http://127.0.0.1:8000';
export const DKB_FOLDER_CONFIG_PATH = '.dkb/config.json';

export type RegistryUrlSource = 'argument' | 'environment' | 'project' | 'host' | 'user' | 'default';

export interface ConfiguredRegistry {
  url: string;
  source: RegistryUrlSource;
  configPath: string;
  root?: string;
}

export interface RegistryVerificationCheck {
  name: string;
  ok: boolean;
  required: boolean;
  status?: number;
  message?: string;
}

export interface RegistryVerification {
  ok: boolean;
  url: string;
  checks: RegistryVerificationCheck[];
}

interface DkbCliConfig {
  registry?: {
    url?: string;
  };
}

interface RegistryConfigurationOptions {
  url?: string;
  root?: string;
  cwd?: string;
}

export function cliConfigPath(): string {
  return process.env.DKB_CLI_CONFIG
    ? path.resolve(process.env.DKB_CLI_CONFIG)
    : path.join(os.homedir(), '.dkb', 'config.json');
}

export function libraryRegistryConfigPath(root: string): string {
  return path.join(path.resolve(root), ...DKB_FOLDER_CONFIG_PATH.split('/'));
}

export function normalizeRegistryUrl(value: string): string {
  const raw = value.trim();

  if (!raw) {
    throw new DkbError('Registry URL cannot be empty.');
  }

  const markdownLink = raw.match(/^\[([^\]]+)]\([^)]+\)$/);

  if (markdownLink) {
    throw new DkbError(`Registry URL was pasted as a Markdown link. Use the plain URL instead: ${markdownLink[1]}`);
  }

  const withProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;

  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new DkbError(`Invalid registry URL: ${value}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new DkbError(`Registry URL must use http or https: ${value}`);
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/g, '');
  parsed.search = '';
  parsed.hash = '';

  return parsed.toString().replace(/\/+$/g, '');
}

export async function configuredRegistry(options: RegistryConfigurationOptions = {}): Promise<ConfiguredRegistry> {
  const projectRoot = options.root
    ? path.resolve(options.root)
    : await nearestLibraryRoot(options.cwd ?? process.cwd());
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
} = {}): Promise<ConfiguredRegistry> {
  if (options.global && options.root) {
    throw new DkbError('Registry configuration cannot use --global and --root together.');
  }

  const projectRoot = options.global
    ? null
    : options.root
      ? await requireLibraryRoot(options.root)
      : await nearestLibraryRoot(options.cwd ?? process.cwd());
  const configPath = projectRoot ? libraryRegistryConfigPath(projectRoot) : cliConfigPath();
  const normalized = normalizeRegistryUrl(url);
  const config = await readCliConfig(configPath);
  const updated: DkbCliConfig = {
    ...config,
    registry: {
      ...(config.registry ?? {}),
      url: normalized,
    },
  };

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
  if (projectRoot) {
    await writeLibraryManifestRegistryUrl(projectRoot, normalized);
  }

  return configuredResult(normalized, projectRoot ? 'project' : 'user', configPath, projectRoot);
}

export async function verifyRegistryEndpoint(url: string): Promise<RegistryVerification> {
  const normalized = normalizeRegistryUrl(url);
  const checks = await Promise.all([
    jsonCheck(normalized, '/.well-known/dkb-registry-keys.json', 'public signing keys', true, (body) => {
      if (!isObject(body) || !Array.isArray(body.keys)) {
        return 'expected a keys array';
      }

      return null;
    }),
    jsonCheck(normalized, '/api/registry/packages', 'package listing API', true, (body) => {
      if (!isObject(body) || !Array.isArray(body.data)) {
        return 'expected a data array';
      }

      return null;
    }),
    jsonCheck(normalized, '/health', 'health endpoint', false, () => null),
  ]);

  return {
    ok: checks.every((check) => check.ok || !check.required),
    url: normalized,
    checks,
  };
}

async function readCliConfig(configPath: string): Promise<DkbCliConfig> {
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;

    return isObject(parsed) ? parsed as DkbCliConfig : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }

    if (error instanceof SyntaxError) {
      throw new DkbError(`Invalid DKB CLI config JSON: ${configPath}`);
    }

    throw error;
  }
}

async function libraryManifestRegistryUrl(root: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'dkb.json'), 'utf8')) as unknown;
    if (!isObject(manifest) || manifest.type !== 'library' || !isObject(manifest.registry)) return null;
    return typeof manifest.registry.url === 'string' ? manifest.registry.url : null;
  } catch {
    return null;
  }
}

async function writeLibraryManifestRegistryUrl(root: string, url: string): Promise<void> {
  const target = path.join(root, 'dkb.json');
  const manifest = JSON.parse(await fs.readFile(target, 'utf8')) as unknown;
  if (!isObject(manifest) || manifest.type !== 'library') {
    throw new DkbError(`Not a DKB Library: ${root}`);
  }
  const temp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
  const backup = `${target}.replace-${process.pid}-${Date.now().toString(36)}`;
  await fs.writeFile(temp, `${JSON.stringify({ ...manifest, registry: { url } }, null, 2)}\n`, 'utf8');
  await fs.rename(target, backup);
  try {
    await fs.rename(temp, target);
    await fs.rm(backup, { force: true });
  } catch (error) {
    await fs.rm(target, { force: true });
    await fs.rename(backup, target);
    throw error;
  }
}

async function nearestLibraryRoot(start: string): Promise<string | null> {
  let current = path.resolve(start);

  while (true) {
    if (await isLibraryRoot(current)) {
      return current;
    }

    const parent = path.dirname(current);

    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

async function requireLibraryRoot(root: string): Promise<string> {
  const resolved = path.resolve(root);

  if (!(await isLibraryRoot(resolved))) {
    throw new DkbError(`Not a DKB Library: ${resolved}. Expected a Library dkb.json.`);
  }

  return resolved;
}

async function isLibraryRoot(root: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'dkb.json'), 'utf8')) as unknown;

    return isObject(manifest) && manifest.type === 'library';
  } catch {
    return false;
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

async function jsonCheck(
  baseUrl: string,
  endpoint: string,
  name: string,
  required: boolean,
  validate: (body: unknown) => string | null,
): Promise<RegistryVerificationCheck> {
  try {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();

    if (!response.ok) {
      return {
        name,
        ok: false,
        required,
        status: response.status,
        message: `HTTP ${response.status}`,
      };
    }

    const body = text ? JSON.parse(text) as unknown : null;
    const validationMessage = validate(body);

    return {
      name,
      ok: validationMessage === null,
      required,
      status: response.status,
      ...(validationMessage ? { message: validationMessage } : {}),
    };
  } catch (error) {
    return {
      name,
      ok: false,
      required,
      message: registryFetchFailureMessage(error),
    };
  }
}

function registryFetchFailureMessage(error: unknown): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'request timed out';
  }

  const cause = error instanceof Error ? error.cause : undefined;
  if (isObject(cause)) {
    if (cause.code === 'ECONNREFUSED') {
      return 'connection refused';
    }
    if (cause.code === 'ENOTFOUND') {
      return 'host not found';
    }
    if (cause.code === 'ECONNRESET') {
      return 'connection reset';
    }
    if (typeof cause.message === 'string' && cause.message.trim()) {
      return cause.message.trim();
    }
  }

  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
