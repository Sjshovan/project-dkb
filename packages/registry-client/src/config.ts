import fs from 'node:fs/promises';
import path from 'node:path';
import { DkbError } from '@dkb/protocol/errors.js';

export const DEFAULT_REGISTRY_URL = 'http://127.0.0.1:8000';

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

export interface ResolvedRegistryContext {
  url: string;
  source: 'argument' | 'environment' | 'project' | 'default';
}

export async function resolveRegistryContext(options: { url?: string; root?: string } = {}): Promise<ResolvedRegistryContext> {
  if (options.url) {
    return { url: normalizeRegistryUrl(options.url), source: 'argument' };
  }
  if (process.env.DKB_REGISTRY_URL) {
    return { url: normalizeRegistryUrl(process.env.DKB_REGISTRY_URL), source: 'environment' };
  }
  if (options.root) {
    const projectUrl = await registryUrlFromContext(path.resolve(options.root));
    if (projectUrl) {
      return { url: normalizeRegistryUrl(projectUrl), source: 'project' };
    }
  }

  return { url: DEFAULT_REGISTRY_URL, source: 'default' };
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

async function registryUrlFromContext(root: string): Promise<string | null> {
  for (const target of [path.join(root, 'dkb.json'), path.join(root, '.dkb', 'config.json')]) {
    try {
      const parsed = JSON.parse(await fs.readFile(target, 'utf8')) as unknown;
      if (isObject(parsed) && isObject(parsed.registry) && typeof parsed.registry.url === 'string') {
        return parsed.registry.url;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
  }

  return null;
}
