import { DkbError } from '../protocol/errors.js';
import type { DkbRetrieveKnowledgeRequest } from '../read/runtime.js';
import type { DkbRemoteAttachInput } from '../remote/types.js';

export interface DkbRuntimeClientOptions {
  baseUrl?: string;
}

export class DkbRuntimeClient {
  readonly baseUrl: string;

  constructor(options: DkbRuntimeClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.DKB_RUNTIME_URL ?? 'http://127.0.0.1:7331');
  }

  status() {
    return this.get('/api/runtime');
  }

  registries() {
    return this.get('/api/registries');
  }

  importDkb(input: { sourcePath: string; id?: string; name?: string; force?: boolean; compile?: boolean }) {
    return this.post('/api/dkbs/import', input);
  }

  removeDkb(id: string) {
    return this.delete(`/api/dkbs/${encodeURIComponent(id)}`);
  }

  compile(id?: string) {
    return id ? this.post(`/api/dkbs/${encodeURIComponent(id)}/compile`, {}) : this.post('/api/compile', {});
  }

  startWatch() {
    return this.post('/api/watch/start', {});
  }

  stopWatch() {
    return this.post('/api/watch/stop', {});
  }

  retrieve(request: DkbRetrieveKnowledgeRequest) {
    return this.post('/api/retrieve', request);
  }

  remoteDiscover(url: string) {
    return this.post('/api/remote/discover', { url });
  }

  remoteAttach(input: DkbRemoteAttachInput) {
    return this.post('/api/remote/session/attach', input);
  }

  remoteSessions() {
    return this.get('/api/remote/sessions');
  }

  remoteDetach(sessionId: string) {
    return this.delete(`/api/remote/session/${encodeURIComponent(sessionId)}`);
  }

  remoteRetrieve(sessionId: string, request: DkbRetrieveKnowledgeRequest) {
    return this.post(`/api/remote/session/${encodeURIComponent(sessionId)}/retrieve`, request);
  }

  private get(path: string) {
    return this.request('GET', path);
  }

  private post(path: string, body: unknown) {
    return this.request('POST', path, body);
  }

  private delete(path: string) {
    return this.request('DELETE', path);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) as unknown : null;

    if (!response.ok) {
      const message = parsed && typeof parsed === 'object' && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : `${method} ${path} failed with HTTP ${response.status}`;

      throw new DkbError(message);
    }

    return parsed;
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/g, '');
}
