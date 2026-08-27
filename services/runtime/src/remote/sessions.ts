import { randomUUID } from 'node:crypto';
import { DkbError } from '@dkb/protocol/errors.js';
import type { DkbRetrieveKnowledgeResponse } from '../read/runtime.js';
import { discoverRemoteDkb } from './discovery.js';
import type {
  DkbRemoteAttachInput,
  DkbDiscoveryEndpoint,
  DkbRemoteRetrieveResult,
  DkbRemoteSession,
  DkbRetrieveKnowledgeRequest,
} from './types.js';

const sessions = new Map<string, DkbRemoteSession>();

export async function attachRemoteSession(input: DkbRemoteAttachInput): Promise<DkbRemoteSession> {
  const discovered = await discoverRemoteDkb(input.url);
  const ttlSeconds = input.ttlSeconds ?? discovered.discovery.policy?.ttlSeconds ?? secondsUntil(discovered.expiresAt);
  const now = new Date();
  const endpoint = discovered.discovery.endpoints[0];

  if (!endpoint) {
    throw new DkbError('DKB discovery did not expose a usable endpoint.');
  }

  const session: DkbRemoteSession = {
    id: `remote_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    origin: 'remote',
    trust: 'unverified',
    status: 'attached',
    endpoint,
    discoveryUrl: discovered.discoveryUrl,
    site: discovered.discovery.site,
    publisher: discovered.discovery.publisher,
    packages: discovered.discovery.packages ?? [],
    scrapePolicy: discovered.discovery.policy?.scrape ?? 'fallback',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    lastUsedAt: now.toISOString(),
  };

  pruneExpiredSessions();
  sessions.set(session.id, session);

  return session;
}

export function listRemoteSessions(): DkbRemoteSession[] {
  pruneExpiredSessions();

  return [...sessions.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function detachRemoteSession(id: string): { status: 'detached'; sessionId: string } {
  pruneExpiredSessions();

  if (!sessions.delete(id)) {
    throw new DkbError(`Unknown remote DKB session: ${id}`);
  }

  return {
    status: 'detached',
    sessionId: id,
  };
}

export async function retrieveFromRemoteSession(id: string, request: DkbRetrieveKnowledgeRequest): Promise<DkbRemoteRetrieveResult> {
  pruneExpiredSessions();
  const session = sessions.get(id);

  if (!session) {
    throw new DkbError(`Unknown or expired remote DKB session: ${id}`);
  }

  session.lastUsedAt = new Date().toISOString();

  return {
    session,
    remote: await retrieveFromEndpoint(session, request),
  };
}

async function retrieveFromEndpoint(session: DkbRemoteSession, request: DkbRetrieveKnowledgeRequest): Promise<DkbRetrieveKnowledgeResponse> {
  return retrieveFromRemoteEndpoint(session.endpoint, request);
}

export async function retrieveFromRemoteEndpoint(endpoint: DkbDiscoveryEndpoint, request: DkbRetrieveKnowledgeRequest): Promise<DkbRetrieveKnowledgeResponse> {
  if (endpoint.type === 'dkb-runtime-http') {
    return retrieveFromRuntimeHttp(endpoint.url, request);
  }

  return retrieveFromMcpHttp(endpoint.url, request);
}

async function retrieveFromRuntimeHttp(endpointUrl: string, request: DkbRetrieveKnowledgeRequest): Promise<DkbRetrieveKnowledgeResponse> {
  const response = await fetch(runtimeRetrieveUrl(endpointUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(request),
  });

  return parseJsonResponse<DkbRetrieveKnowledgeResponse>(response, 'remote DKB runtime retrieve');
}

function runtimeRetrieveUrl(endpointUrl: string): string {
  const url = new URL(endpointUrl);
  const basePath = url.pathname.replace(/\/+$/g, '');

  url.pathname = `${basePath}/api/retrieve`;
  url.search = '';
  url.hash = '';

  return url.toString();
}

async function retrieveFromMcpHttp(endpointUrl: string, request: DkbRetrieveKnowledgeRequest): Promise<DkbRetrieveKnowledgeResponse> {
  const response = await fetch(endpointUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `dkb_${Date.now().toString(36)}`,
      method: 'tools/call',
      params: {
        name: 'dkb.retrieve_knowledge',
        arguments: {
          request,
        },
      },
    }),
  });
  const payload = await parseJsonResponse<unknown>(response, 'remote DKB MCP retrieve');

  return extractMcpToolResult(payload);
}

async function parseJsonResponse<T>(response: Response, label: string): Promise<T> {
  const text = await response.text();
  const parsed = text ? JSON.parse(text) as unknown : null;

  if (!response.ok) {
    const message = parsed && typeof parsed === 'object' && 'message' in parsed
      ? String((parsed as { message: unknown }).message)
      : `${label} failed with HTTP ${response.status}`;

    throw new DkbError(message);
  }

  return parsed as T;
}

function extractMcpToolResult(value: unknown): DkbRetrieveKnowledgeResponse {
  if (!value || typeof value !== 'object') {
    throw new DkbError('Remote DKB MCP response was not a JSON object.');
  }

  if ('error' in value) {
    throw new DkbError(`Remote DKB MCP returned an error: ${JSON.stringify((value as { error: unknown }).error)}`);
  }

  const result = 'result' in value ? (value as { result: unknown }).result : value;

  if (result && typeof result === 'object' && 'structuredContent' in result) {
    return (result as { structuredContent: DkbRetrieveKnowledgeResponse }).structuredContent;
  }

  if (result && typeof result === 'object' && 'content' in result && Array.isArray((result as { content: unknown }).content)) {
    const text = ((result as { content: Array<{ type?: unknown; text?: unknown }> }).content)
      .filter((item) => item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n');

    if (text) {
      return JSON.parse(text) as DkbRetrieveKnowledgeResponse;
    }
  }

  return result as DkbRetrieveKnowledgeResponse;
}

function pruneExpiredSessions(): void {
  const now = Date.now();

  for (const [id, session] of sessions.entries()) {
    if (Date.parse(session.expiresAt) <= now) {
      sessions.delete(id);
    }
  }
}

function secondsUntil(isoDate: string): number {
  return Math.max(60, Math.ceil((Date.parse(isoDate) - Date.now()) / 1000));
}
