import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DkbError } from '../protocol/errors.js';

export const DEFAULT_REGISTRY_URL = 'http://127.0.0.1:8000';

export type RegistryUrlSource = 'argument' | 'environment' | 'config' | 'default';

export interface ConfiguredRegistry {
  url: string;
  source: RegistryUrlSource;
  configPath: string;
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

export function cliConfigPath(): string {
  return process.env.DKB_CLI_CONFIG
    ? path.resolve(process.env.DKB_CLI_CONFIG)
    : path.join(os.homedir(), '.dkb', 'config.json');
}

export function normalizeRegistryUrl(value: string): string {
  const raw = value.trim();

  if (!raw) {
    throw new DkbError('Registry URL cannot be empty.');
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

export async function configuredRegistry(options: { url?: string } = {}): Promise<ConfiguredRegistry> {
  const configPath = cliConfigPath();

  if (options.url) {
    return { url: normalizeRegistryUrl(options.url), source: 'argument', configPath };
  }

  if (process.env.DKB_REGISTRY_URL) {
    return { url: normalizeRegistryUrl(process.env.DKB_REGISTRY_URL), source: 'environment', configPath };
  }

  const config = await readCliConfig(configPath);
  const configuredUrl = config.registry?.url;

  if (configuredUrl) {
    return { url: normalizeRegistryUrl(configuredUrl), source: 'config', configPath };
  }

  return { url: DEFAULT_REGISTRY_URL, source: 'default', configPath };
}

export async function writeConfiguredRegistryUrl(url: string): Promise<ConfiguredRegistry> {
  const configPath = cliConfigPath();
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

  return { url: normalized, source: 'config', configPath };
}

export async function verifyRegistryEndpoint(url: string): Promise<RegistryVerification> {
  const normalized = normalizeRegistryUrl(url);
  const checks: RegistryVerificationCheck[] = [];

  checks.push(await jsonCheck(normalized, '/.well-known/dkb-registry-keys.json', 'public signing keys', true, (body) => {
    if (!isObject(body) || !Array.isArray(body.keys)) {
      return 'expected a keys array';
    }

    return null;
  }));

  checks.push(await jsonCheck(normalized, '/api/registry/packages', 'package listing API', true, (body) => {
    if (!isObject(body) || !Array.isArray(body.data)) {
      return 'expected a data array';
    }

    return null;
  }));

  checks.push(await jsonCheck(normalized, '/health', 'health endpoint', false, () => null));

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

async function jsonCheck(
  baseUrl: string,
  endpoint: string,
  name: string,
  required: boolean,
  validate: (body: unknown) => string | null,
): Promise<RegistryVerificationCheck> {
  try {
    const response = await fetch(`${baseUrl}${endpoint}`);
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
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
