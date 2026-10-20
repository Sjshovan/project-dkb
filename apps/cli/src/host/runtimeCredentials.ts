import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

const FORMAT = 'dkb.runtime-http-credentials.v1';

export interface RuntimeHttpCredentials {
  adminToken: string;
  readToken: string;
}

/** Host-owned secrets are never written into a Library or portable Runtime state. */
export function runtimeCredentialsPath(stateRoot: string): string {
  const identity = createHash('sha256').update(canonicalRoot(stateRoot)).digest('hex');
  const root = process.env.DKB_RUNTIME_CREDENTIALS_ROOT
    ?? path.join(os.homedir(), '.dkb', 'runtime-credentials');
  return path.join(path.resolve(root), `${identity}.json`);
}

export async function loadRuntimeHttpCredentials(stateRoot: string): Promise<RuntimeHttpCredentials | undefined> {
  const target = runtimeCredentialsPath(stateRoot);
  let raw: string;
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw invalidCredentials(target);
    raw = await fs.readFile(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let document: Record<string, unknown>;
  try { document = JSON.parse(raw) as Record<string, unknown>; } catch { throw invalidCredentials(target); }
  if (!document || typeof document !== 'object' || Array.isArray(document)
    || Object.keys(document).sort().join(',') !== 'adminToken,format,readToken,stateRoot'
    || document.format !== FORMAT || document.stateRoot !== canonicalRoot(stateRoot)
    || typeof document.adminToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(document.adminToken)
    || typeof document.readToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(document.readToken)
    || document.adminToken === document.readToken) throw invalidCredentials(target);
  return { adminToken: document.adminToken, readToken: document.readToken };
}

export async function prepareRuntimeHttpCredentials(stateRoot: string): Promise<RuntimeHttpCredentials> {
  const overrideAdmin = environmentToken('DKB_RUNTIME_ADMIN_TOKEN');
  const overrideRead = environmentToken('DKB_RUNTIME_READ_TOKEN');
  if (overrideAdmin && overrideRead && overrideAdmin === overrideRead) {
    throw new DkbError('Runtime read and admin credentials must be different.');
  }
  let saved = await loadRuntimeHttpCredentials(stateRoot);
  if (!saved) {
    const target = runtimeCredentialsPath(stateRoot);
    const staged = `${target}.${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const candidate = { format: FORMAT, stateRoot: canonicalRoot(stateRoot),
      adminToken: randomBytes(32).toString('base64url'), readToken: randomBytes(32).toString('base64url') };
    const handle = await fs.open(staged, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(`${JSON.stringify(candidate)}\n`, 'utf8');
        await handle.sync();
      } finally { await handle.close(); }
      // Publish complete bytes only if absent. A competing starter keeps the same winning credentials.
      try { await fs.link(staged, target); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally { await fs.rm(staged, { force: true }); }
    saved = await loadRuntimeHttpCredentials(stateRoot);
    if (!saved) throw invalidCredentials(target);
  }
  return { adminToken: overrideAdmin ?? saved.adminToken, readToken: overrideRead ?? saved.readToken };
}

function canonicalRoot(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function environmentToken(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9._~+/-]+=*$/u.test(value) || value.length > 4096) {
    throw new DkbError(`${name} must contain a nonempty bearer credential without whitespace.`);
  }
  return value;
}

function invalidCredentials(target: string): DkbError {
  return new DkbError(`Invalid Runtime credential file at ${target}. Repair it or move it aside explicitly; DKB will not overwrite it.`, 'runtime_credentials_invalid');
}
