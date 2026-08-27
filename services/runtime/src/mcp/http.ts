import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { hostHeaderValidation, NodeStreamableHTTPServerTransport, originValidation } from '@modelcontextprotocol/node';
import { DkbError } from '@dkb/protocol/errors.js';
import { defaultRuntimeStateRoot } from '../runtime/state.js';
import { createDkbReadOnlyMcpServer, fetchRemoteEvidence } from './readOnly.js';

export interface ServeDkbMcpHttpOptions {
  host?: string;
  port?: number;
  path?: string;
  libraryPath?: string;
  bearerToken?: string;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  publicBaseUrl?: string;
  publicDocuments?: boolean;
  allowInsecureNoAuth?: boolean;
}

export async function serveDkbMcpHttp(options: ServeDkbMcpHttpOptions = {}) {
  const host = options.host ?? process.env.DKB_MCP_HTTP_HOST ?? '127.0.0.1';
  const port = options.port ?? parsePort(process.env.DKB_MCP_HTTP_PORT, 7332);
  const endpointPath = normalizePath(options.path ?? process.env.DKB_MCP_HTTP_PATH ?? '/mcp');
  const libraryPath = options.libraryPath ?? process.env.DKB_LIBRARY_PATH ?? defaultRuntimeStateRoot();
  const bearerToken = options.bearerToken ?? process.env.DKB_MCP_BEARER_TOKEN;
  const publicBaseUrl = options.publicBaseUrl ?? process.env.DKB_MCP_PUBLIC_BASE_URL;
  const publicDocuments = options.publicDocuments ?? process.env.DKB_MCP_PUBLIC_DOCUMENTS === 'true';
  const allowInsecureNoAuth = options.allowInsecureNoAuth ?? process.env.DKB_MCP_ALLOW_INSECURE_NO_AUTH === 'true';

  if (!bearerToken && !allowInsecureNoAuth) {
    throw new DkbError('Authenticated HTTP MCP requires DKB_MCP_BEARER_TOKEN. Set DKB_MCP_ALLOW_INSECURE_NO_AUTH=true only for a disposable synthetic-data proof.');
  }

  const validateHost = hostHeaderValidation(uniqueHostnames([
    ...(options.allowedHosts ?? csv(process.env.DKB_MCP_ALLOWED_HOSTS)),
    host, publicBaseUrl ?? '', 'localhost', '127.0.0.1', '[::1]',
  ]));
  const validateOrigin = originValidation(uniqueHostnames([
    ...(options.allowedOrigins ?? csv(process.env.DKB_MCP_ALLOWED_ORIGINS)),
    'localhost', '127.0.0.1', '[::1]',
  ]));
  const mcp = createDkbReadOnlyMcpServer({ libraryPath, publicBaseUrl });
  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await mcp.connect(transport);
  const httpServer = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://dkb.local');

      if (requestUrl.pathname === '/health' && request.method === 'GET') {
        return sendJson(response, 200, { ok: true, mode: 'read-only', endpoint: endpointPath });
      }
      const documentId = requestUrl.pathname.match(/^\/documents\/([^/]+)$/)?.[1];
      if (documentId && request.method === 'GET' && publicDocuments) {
        return sendJson(response, 200, await fetchRemoteEvidence(libraryPath, decodeURIComponent(documentId), publicBaseUrl));
      }
      if (requestUrl.pathname !== endpointPath) return sendJson(response, 404, { error: 'not_found' });
      if (!validateHost(request, response) || !validateOrigin(request, response)) return;
      if (!allowInsecureNoAuth && !validBearer(request, bearerToken!)) {
        response.setHeader('www-authenticate', 'Bearer realm="DKB MCP"');
        return sendJson(response, 401, { error: 'unauthorized' });
      }
      await transport.handleRequest(request, response);
    } catch (error) {
      sendJson(response, 500, {
        error: 'mcp_http_error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  return httpServer;
}

function validBearer(request: IncomingMessage, expected: string): boolean {
  const supplied = (request.headers.authorization ?? '').replace(/^Bearer /, '');
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

function uniqueHostnames(values: string[]): string[] {
  return [...new Set(values.flatMap((value) => {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      return [new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`).hostname];
    } catch {
      return [];
    }
  }))];
}

function csv(value: string | undefined): string[] {
  return value?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
}

function normalizePath(value: string): string {
  const normalized = `/${value}`.replace(/\/+/g, '/');
  return normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized;
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body, null, 2));
}
