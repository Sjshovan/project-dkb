import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage } from 'node:http';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import type { DkbQueryAuditEvent } from './queryAudit.js';

const runtimeClientContext = new AsyncLocalStorage<DkbQueryAuditEvent['client']>();

export function withRuntimeClient<T>(client: DkbQueryAuditEvent['client'], operation: () => T): T {
  return runtimeClientContext.run(client, operation);
}

export function currentRuntimeClient(): DkbQueryAuditEvent['client'] | undefined {
  return runtimeClientContext.getStore();
}

export function runtimeClientForRequest(request: IncomingMessage): DkbQueryAuditEvent['client'] {
  const claimedClient = headerValue(request, 'x-dkb-client-id');
  const claimedSession = headerValue(request, 'x-dkb-session-id') ?? headerValue(request, 'mcp-session-id');
  const userAgent = bounded(headerValue(request, 'user-agent'), 256);
  const address = bounded(request.socket.remoteAddress, 128);
  return {
    id: stableHash({ claimedClient: claimedClient ?? null, address: address ?? null, userAgent: userAgent ?? null }),
    ...(claimedSession ? { sessionId: stableHash({ claimedSession }) } : {}),
    ...(address ? { address } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function bounded(value: string | undefined, limit: number): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, limit) : undefined;
}
