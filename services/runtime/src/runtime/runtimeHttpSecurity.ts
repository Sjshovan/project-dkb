import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

export type RuntimeHttpReadAccess = 'authenticated' | 'public-read';

export interface RuntimeHttpSecurityOptions {
  host: string;
  adminToken?: string;
  readToken?: string;
  readAccess?: RuntimeHttpReadAccess;
  allowedHosts?: string[];
  allowedOrigins?: string[];
}

/** Ordinary Runtime HTTP authority. MCP retains its separate transport boundary. */
export class RuntimeHttpSecurity {
  readonly readAccess: RuntimeHttpReadAccess;
  readonly #adminToken: string;
  readonly #readToken: string | undefined;
  readonly #host: string;
  readonly #allowedHosts: ReadonlySet<string>;
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #publicUrl: URL | undefined;

  constructor(options: RuntimeHttpSecurityOptions) {
    this.#adminToken = credential(options.adminToken ?? process.env.DKB_RUNTIME_ADMIN_TOKEN, 'DKB_RUNTIME_ADMIN_TOKEN', true)!;
    this.#readToken = credential(options.readToken ?? process.env.DKB_RUNTIME_READ_TOKEN, 'DKB_RUNTIME_READ_TOKEN');
    if (this.#readToken === this.#adminToken) {
      throw configurationError('DKB_RUNTIME_READ_TOKEN must differ from DKB_RUNTIME_ADMIN_TOKEN.');
    }
    const readAccess = options.readAccess ?? process.env.DKB_RUNTIME_READ_ACCESS ?? 'authenticated';
    if (readAccess !== 'authenticated' && readAccess !== 'public-read') {
      throw configurationError('DKB_RUNTIME_READ_ACCESS must be authenticated or public-read.');
    }
    this.readAccess = readAccess;
    this.#host = options.host;
    this.#allowedHosts = new Set((options.allowedHosts ?? csv(process.env.DKB_RUNTIME_ALLOWED_HOSTS))
      .map((value) => requiredAuthority(value, 'DKB_RUNTIME_ALLOWED_HOSTS')));
    this.#allowedOrigins = new Set((options.allowedOrigins ?? csv(process.env.DKB_RUNTIME_ALLOWED_ORIGINS))
      .map((value) => requiredOrigin(value, 'DKB_RUNTIME_ALLOWED_ORIGINS')));
    if (process.env.DKB_PUBLIC_URL) {
      this.#publicUrl = new URL(requiredOrigin(process.env.DKB_PUBLIC_URL, 'DKB_PUBLIC_URL'));
    }
  }

  /** Return false after completing a rejection or an approved preflight. */
  authorize(request: IncomingMessage, response: ServerResponse, pathName: string): boolean {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    const host = singleHeader(request, 'host');
    const authority = host ? parseAuthority(host) : null;
    const port = request.socket.localPort;
    const localHosts = ['localhost', '127.0.0.1', '[::1]'];
    if (!['0.0.0.0', '::', '[::]'].includes(this.#host)) localHosts.push(bracketIpv6(this.#host));
    const allowed = new Set(localHosts.map((name) => parseAuthority(`${name}:${port}`)));
    if (!authority || (!allowed.has(authority) && !this.#allowedHosts.has(authority) && authority !== this.#publicUrl?.host)) {
      return reject(response, 421, 'invalid_host', 'Unexpected Runtime Host header.');
    }

    const origin = singleHeader(request, 'origin');
    if (request.headers.origin !== undefined && !origin) {
      return reject(response, 403, 'invalid_origin', 'Cross-origin Runtime request rejected.');
    }
    if (origin) {
      const normalized = parseOrigin(origin);
      const sameOrigin = authority === this.#publicUrl?.host ? this.#publicUrl.origin : `http://${authority}`;
      if (!normalized || (normalized !== sameOrigin && !this.#allowedOrigins.has(normalized))) {
        return reject(response, 403, 'invalid_origin', 'Cross-origin Runtime request rejected.');
      }
      response.setHeader('access-control-allow-origin', normalized);
      response.setHeader('vary', 'Origin');
    }

    if (request.method === 'OPTIONS') {
      const method = singleHeader(request, 'access-control-request-method');
      if (method && !['GET', 'POST', 'DELETE'].includes(method)) {
        return reject(response, 405, 'invalid_preflight', 'Runtime preflight method is not allowed.');
      }
      const headers = singleHeader(request, 'access-control-request-headers');
      if (headers?.split(',').some((header) => !['authorization', 'content-type', 'x-dkb-client-id', 'x-dkb-session-id'].includes(header.trim().toLowerCase()))) {
        return reject(response, 403, 'invalid_preflight', 'Runtime preflight headers are not allowed.');
      }
      if (origin) {
        response.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
        response.setHeader('access-control-allow-headers', 'content-type,authorization,x-dkb-client-id,x-dkb-session-id');
      }
      response.writeHead(204);
      response.end();
      return false;
    }

    const access = routeAccess(request.method, pathName);
    // Every dispatched route must explicitly declare its authority here.
    if (access === null) return reject(response, 404, 'not_found', 'Unknown DKB Runtime route.');
    if (access === 'public') return true;
    if (access === 'discovery') {
      if (this.readAccess === 'public-read') return true;
      return reject(response, 404, 'not_found', 'Public Runtime discovery is not enabled.');
    }
    if (access === 'read' && this.readAccess === 'public-read') return true;
    const supplied = bearerToken(request);
    if (matchesToken(supplied, this.#adminToken) || (access === 'read' && matchesToken(supplied, this.#readToken))) return true;
    response.setHeader('www-authenticate', 'Bearer realm="DKB Runtime"');
    return reject(response, 401, 'unauthorized', access === 'admin'
      ? 'This Runtime route requires a valid admin bearer token.'
      : 'This Runtime route requires a valid read or admin bearer token.');
  }

  /** Configuration and supplied credentials must never appear in HTTP errors. */
  errorMessage(error: unknown, request: IncomingMessage): string {
    if (!(error instanceof DkbError)) return 'Runtime request failed.';
    let message = error.message;
    for (const secret of [this.#adminToken, this.#readToken, singleHeader(request, 'authorization'), bearerToken(request)]) {
      if (secret) message = message.split(secret).join('[redacted]');
    }
    return message.replace(/Bearer\s+[^\s"',;]+/giu, 'Bearer [redacted]');
  }
}

function routeAccess(method: string | undefined, pathName: string): 'public' | 'read' | 'admin' | 'discovery' | null {
  if (method === 'GET') {
    if (pathName === '/health' || pathName === '/api/health') return 'public';
    if (pathName === '/.well-known/dkb.json') return 'discovery';
    if (pathName === '/api/runtime') return 'read';
    if (['/api/library', '/api/runtime/pipelines', '/api/runtime/audit', '/api/traces'].includes(pathName) || /^\/api\/traces\/[^/]+$/u.test(pathName)) return 'admin';
  }
  if (method === 'POST') {
    if (['/api/search', '/api/retrieve', '/api/read-targets', '/api/read'].includes(pathName)) return 'read';
    if (['/api/runtime/reload', '/api/runtime/pipeline', '/api/runtime/library', '/api/dkbs/import-artifact', '/api/dkbs/install-registry'].includes(pathName)) return 'admin';
  }
  if (method === 'DELETE' && /^\/api\/dkbs\/[^/]+$/u.test(pathName)) return 'admin';
  return null;
}

function credential(value: string | undefined, name: string, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.length > 4096 || !/^[A-Za-z0-9._~+/-]+=*$/u.test(value)) {
    throw configurationError(`${name} must contain a valid bearer credential of at most 4096 characters. Runtime administration requires authentication on every bind address.`);
  }
  return value;
}

function configurationError(message: string): DkbError {
  return new DkbError(message, 'runtime_http_configuration_invalid');
}

function csv(value: string | undefined): string[] {
  return value?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
}

function bracketIpv6(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function parseAuthority(value: string): string | null {
  if (!value || /[\s/\\?#@*]/u.test(value)) return null;
  try {
    const parsed = new URL(`http://${value}`);
    return parsed.hostname && parsed.pathname === '/' && !parsed.username && !parsed.password ? parsed.host : null;
  } catch { return null; }
}

function requiredAuthority(value: string, label: string): string {
  const result = typeof value === 'string' ? parseAuthority(value) : null;
  if (!result) throw configurationError(`${label} must contain exact Host authorities, such as localhost:7331 or knowledge.example; wildcards and URLs are not allowed.`);
  return result;
}

function parseOrigin(value: string): string | null {
  if (!value || /[\s\\*]/u.test(value)) return null;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.pathname === '/' && !parsed.search && !parsed.hash && !parsed.username && !parsed.password
      ? parsed.origin : null;
  } catch { return null; }
}

function requiredOrigin(value: string, label: string): string {
  const result = typeof value === 'string' ? parseOrigin(value) : null;
  if (!result) throw configurationError(`${label} must contain exact http(s) origins without credentials, paths, queries, fragments, or wildcards.`);
  return result;
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  let occurrences = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) occurrences += 1;
  }
  return typeof value === 'string' && occurrences === 1 ? value : undefined;
}

function bearerToken(request: IncomingMessage): string | undefined {
  return singleHeader(request, 'authorization')?.match(/^Bearer ([^\s]+)$/iu)?.[1];
}

function matchesToken(supplied: string | undefined, expected: string | undefined): boolean {
  if (!supplied || !expected) return false;
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

function reject(response: ServerResponse, status: number, error: string, message: string): false {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error, message }));
  return false;
}
