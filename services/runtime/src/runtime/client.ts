import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbRetrieveKnowledgeRequest } from '../read/runtime.js';
import type { DkbReadRequest } from '@sjshovan/dkb-protocol/types.js';
import type { DkbInstallPlan } from '@sjshovan/dkb-protocol/builds.js';

export interface DkbRuntimeClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  adminToken?: string;
  readToken?: string;
}

export class DkbRuntimeClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly adminToken?: string;
  readonly readToken?: string;

  constructor(options: DkbRuntimeClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.DKB_RUNTIME_URL ?? 'http://127.0.0.1:7331');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.adminToken = options.adminToken ?? process.env.DKB_RUNTIME_ADMIN_TOKEN;
    this.readToken = options.readToken ?? process.env.DKB_RUNTIME_READ_TOKEN;
  }

  status() {
    return this.get('/api/runtime');
  }

  health() {
    return this.request('GET', '/health', undefined, false, true);
  }

  library() {
    return this.get('/api/library', true);
  }

  pipelines() {
    return this.get('/api/runtime/pipelines', true);
  }

  audit(limit = 100) {
    return this.get(`/api/runtime/audit?limit=${encodeURIComponent(String(limit))}`, true);
  }

  reload() {
    return this.post('/api/runtime/reload', {}, true);
  }

  switchLibrary(input: ({ libraryPath: string } | { libraryHandle: string }) & { target?: string }) {
    return this.post('/api/runtime/library', input, true);
  }

  importArtifact(input: { sourcePath: string; id?: string; force?: boolean }) {
    return this.post('/api/dkbs/import-artifact', input, true);
  }

  installRegistryDkb(input: {
    registryUrl: string;
    installGrant: string;
    plan: DkbInstallPlan;
    force?: boolean;
  }) {
    return this.post('/api/dkbs/install-registry', input, true);
  }

  switchPipeline(input: {
    target: string;
    registryUrl?: string;
    grants?: Record<string, { plan: DkbInstallPlan; installGrant: string }>;
  }) {
    return this.post('/api/runtime/pipeline', input, true);
  }

  removeDkb(id: string) {
    return this.delete(`/api/dkbs/${encodeURIComponent(id)}`, true);
  }

  retrieve(request: DkbRetrieveKnowledgeRequest) {
    return this.post('/api/retrieve', request);
  }

  search(input: { query: string; limit?: number; dkbId?: string }) {
    return this.post('/api/search', input);
  }

  readTargets(input: { query: string; limit?: number }) {
    return this.post('/api/read-targets', input);
  }

  read(request: DkbReadRequest) {
    return this.post('/api/read', request);
  }

  private get(path: string, admin = false) {
    return this.request('GET', path, undefined, admin);
  }

  private post(path: string, body: unknown, admin = false) {
    return this.request('POST', path, body, admin);
  }

  private delete(path: string, admin = false) {
    return this.request('DELETE', path, undefined, admin);
  }

  private async request(method: string, path: string, body?: unknown, admin = false, anonymous = false): Promise<unknown> {
    let response: Response;
    const token = anonymous ? undefined : admin ? this.adminToken : this.readToken ?? this.adminToken;

    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      throw new DkbError(`Unable to reach DKB Runtime ${this.baseUrl}: ${detail}`);
    }
    const text = await response.text();
    const parsed = parseJson(text);

    if (!response.ok) {
      const message = parsed && typeof parsed === 'object' && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : `${method} ${path} failed with HTTP ${response.status}`;

      throw new DkbError(response.status === 401 || response.status === 403
        ? 'Runtime authentication is required. Use the credential for this endpoint through DKB_RUNTIME_READ_TOKEN (knowledge) or DKB_RUNTIME_ADMIN_TOKEN (management).'
        : redactCredentials(message, [this.adminToken, this.readToken]), response.status === 401 || response.status === 403 ? 'runtime_unauthorized' : 'DKB_ERROR');
    }

    if (text && parsed === null) {
      throw new DkbError(`DKB Runtime returned invalid JSON for ${method} ${path}.`);
    }

    return parsed;
  }
}

function normalizeBaseUrl(value: string): string {
  const raw = value.trim();
  const markdownLink = raw.match(/^\[([^\]]+)]\([^)]+\)$/);

  if (markdownLink) {
    throw new DkbError('Runtime URL was pasted as a Markdown link. Use a plain http(s) URL without credentials instead.');
  }

  let parsed: URL;

  try {
    parsed = new URL(raw);
  } catch {
    throw new DkbError('Invalid DKB Runtime URL. Use a plain http(s) URL without credentials.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new DkbError('DKB Runtime URL must use http or https.');
  }

  if (parsed.username || parsed.password) {
    throw new DkbError('Runtime URLs must not contain credentials. Use the Runtime credential environment variables.');
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/g, '');
  parsed.search = '';
  parsed.hash = '';

  return parsed.toString().replace(/\/+$/g, '');
}

function redactCredentials(message: string, secrets: Array<string | undefined>): string {
  for (const secret of secrets) if (secret) message = message.split(secret).join('[redacted]');
  return message;
}

function parseJson(text: string): unknown {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
