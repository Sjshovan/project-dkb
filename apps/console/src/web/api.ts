import type { DkbCommandEvent } from '@sjshovan/dkb-protocol/command-events.js';

export const CONSOLE_SESSION_EXPIRED_EVENT = 'dkb:console-session-expired';

let csrfToken = '';
let sessionIssue: string | undefined;

export class ConsoleSessionExpiredError extends Error {
  readonly code = 'console_session_expired';
}

export function consoleSessionIssue(): string | undefined {
  return sessionIssue;
}

export async function establishConsoleSession(): Promise<void> {
  const url = new URL(window.location.href);
  const bootstrap = url.searchParams.get('bootstrap');
  if (bootstrap) {
    const session = await request<{ csrf: string }>('/api/session/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: bootstrap }),
    }, false);
    csrfToken = session.csrf;
    sessionIssue = undefined;
    url.searchParams.delete('bootstrap');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    return;
  }
  csrfToken = (await request<{ csrf: string }>('/api/session', {}, false)).csrf;
  sessionIssue = undefined;
}

export async function getJson<T>(path: string): Promise<T> {
  return request<T>(path);
}

export async function startOperation(commandId: string, input: Record<string, unknown> = {}): Promise<string> {
  const value = await request<{ operationId: string }>('/api/v1/operations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dkb-csrf': csrfToken },
    body: JSON.stringify({ commandId, input }),
  });
  return value.operationId;
}

export async function cancelOperation(id: string): Promise<void> {
  await request(`/api/v1/operations/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    headers: { 'x-dkb-csrf': csrfToken },
  });
}

export function followOperation(id: string, listener: (event: DkbCommandEvent) => void): () => void {
  const source = new EventSource(`/api/v1/operations/${encodeURIComponent(id)}/events`);
  source.onmessage = (message) => {
    const event = JSON.parse(message.data) as DkbCommandEvent;
    listener(event);
    if (event.event === 'completion') source.close();
  };
  return () => source.close();
}

async function request<T>(path: string, init: RequestInit = {}, retrySession = true): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'same-origin', headers: { accept: 'application/json', ...init.headers } });
  if (response.status === 401 && retrySession && path !== '/api/session' && path !== '/api/session/bootstrap') {
    try {
      await establishConsoleSession();
      return request<T>(path, init, false);
    } catch (error) {
      if (error instanceof ConsoleSessionExpiredError) markSessionExpired(error.message);
      throw error;
    }
  }
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) {
    const message = body.error ?? `Console request failed (${response.status}).`;
    if (response.status === 401) {
      markSessionExpired(message);
      throw new ConsoleSessionExpiredError(message);
    }
    throw new Error(message);
  }
  return body as T;
}

function markSessionExpired(message: string): void {
  csrfToken = '';
  sessionIssue = message;
  window.dispatchEvent(new CustomEvent(CONSOLE_SESSION_EXPIRED_EVENT, { detail: { message } }));
}
