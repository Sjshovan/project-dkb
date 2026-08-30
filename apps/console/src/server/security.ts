import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

interface ConsoleSession {
  id: string;
  csrf: string;
  expiresAt: number;
}

export class ConsoleSecurity {
  readonly #sessions = new Map<string, ConsoleSession>();
  #bootstrapSecret: string;
  readonly #port: number;
  #bootstrapConsumed = false;

  constructor(input: { bootstrapSecret: string; port: number }) {
    this.#bootstrapSecret = input.bootstrapSecret;
    this.#port = input.port;
  }

  assertRequestBoundary(request: FastifyRequest): void {
    const host = request.headers.host?.toLowerCase();
    const allowed = new Set([`127.0.0.1:${this.#port}`, `localhost:${this.#port}`, `[::1]:${this.#port}`]);
    if (!host || !allowed.has(host)) throw new ConsoleSecurityError(421, 'Unexpected Console Host header.');
    const origin = request.headers.origin;
    if (origin && ![`http://127.0.0.1:${this.#port}`, `http://localhost:${this.#port}`, `http://[::1]:${this.#port}`].includes(origin)) {
      throw new ConsoleSecurityError(403, 'Cross-origin Console request rejected.');
    }
  }

  bootstrap(secret: unknown, reply: FastifyReply): ConsoleSession {
    if (this.#bootstrapConsumed || typeof secret !== 'string' || !constantTimeText(secret, this.#bootstrapSecret)) {
      throw new ConsoleSecurityError(401, 'Console bootstrap link is invalid or has already been used.');
    }
    this.#bootstrapConsumed = true;
    return this.#createSession(reply);
  }

  issueBootstrap(): string {
    this.#bootstrapSecret = randomBytes(32).toString('base64url');
    this.#bootstrapConsumed = false;
    return this.#bootstrapSecret;
  }

  session(request: FastifyRequest): ConsoleSession {
    this.#prune();
    const id = request.cookies.dkb_console_session;
    const session = id ? this.#sessions.get(id) : undefined;
    if (!session || session.expiresAt <= Date.now()) throw new ConsoleSecurityError(401, 'Console session expired. Reopen it with dkb console.');
    return session;
  }

  assertMutation(request: FastifyRequest): ConsoleSession {
    const session = this.session(request);
    if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      throw new ConsoleSecurityError(415, 'Console mutations require application/json.');
    }
    if (!constantTimeText(String(request.headers['x-dkb-csrf'] ?? ''), session.csrf)) {
      throw new ConsoleSecurityError(403, 'Console CSRF token is missing or invalid.');
    }
    return session;
  }

  #createSession(reply: FastifyReply): ConsoleSession {
    const session: ConsoleSession = {
      id: randomBytes(32).toString('base64url'),
      csrf: randomBytes(32).toString('base64url'),
      expiresAt: Date.now() + 12 * 60 * 60_000,
    };
    this.#sessions.set(session.id, session);
    reply.setCookie('dkb_console_session', session.id, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 12 * 60 * 60,
    });
    return session;
  }

  #prune(): void {
    for (const [id, session] of this.#sessions) if (session.expiresAt <= Date.now()) this.#sessions.delete(id);
  }
}

export class ConsoleSecurityError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function constantTimeText(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
