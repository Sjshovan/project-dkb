import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbRetrieveKnowledgeRequest } from '../read/runtime.js';
import type { DkbRemoteAttachInput } from '../remote/types.js';
import type { DkbInstallPlan } from '@sjshovan/dkb-protocol/builds.js';

export interface DkbRuntimeClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  adminToken?: string;
}

export class DkbRuntimeClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly adminToken?: string;

  constructor(options: DkbRuntimeClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.DKB_RUNTIME_URL ?? 'http://127.0.0.1:7331');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.adminToken = options.adminToken ?? process.env.DKB_RUNTIME_ADMIN_TOKEN;
  }

  status() {
    return this.get('/api/runtime');
  }

  library() {
    return this.get('/api/library');
  }

  reload() {
    return this.post('/api/runtime/reload', {}, true);
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
    registryUrl: string;
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

  remoteDiscover(url: string) {
    return this.post('/api/remote/discover', { url }, true);
  }

  remoteAttach(input: DkbRemoteAttachInput) {
    return this.post('/api/remote/session/attach', input, true);
  }

  remoteSessions() {
    return this.get('/api/remote/sessions', true);
  }

  remoteDetach(sessionId: string) {
    return this.delete(`/api/remote/session/${encodeURIComponent(sessionId)}`, true);
  }

  remoteRetrieve(sessionId: string, request: DkbRetrieveKnowledgeRequest) {
    return this.post(`/api/remote/session/${encodeURIComponent(sessionId)}/retrieve`, request, true);
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

  private async request(method: string, path: string, body?: unknown, admin = false): Promise<unknown> {
    let response: Response;

    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(admin && this.adminToken ? { authorization: `Bearer ${this.adminToken}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
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

      throw new DkbError(message);
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
    throw new DkbError(`Runtime URL was pasted as a Markdown link. Use the plain URL instead: ${markdownLink[1]}`);
  }

  let parsed: URL;

  try {
    parsed = new URL(raw);
  } catch {
    throw new DkbError(`Invalid DKB Runtime URL: ${value}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new DkbError(`DKB Runtime URL must use http or https: ${value}`);
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/g, '');
  parsed.search = '';
  parsed.hash = '';

  return parsed.toString().replace(/\/+$/g, '');
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
