import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { normalizeRegistryUrl } from './config.js';

export const DKB_REGISTRY_CREDENTIALS_FORMAT = 'dkb.credentials.v1';

export interface RegistryCredential {
  token: string;
  savedAt: string;
  user?: string;
  team?: string;
  abilities?: string[];
  expiresAt?: string | null;
}

interface RegistryCredentialDocument {
  format: typeof DKB_REGISTRY_CREDENTIALS_FORMAT;
  registries: Record<string, RegistryCredential>;
}

export function registryCredentialsPath(): string {
  return process.env.DKB_REGISTRY_CREDENTIALS
    ? path.resolve(process.env.DKB_REGISTRY_CREDENTIALS)
    : path.join(os.homedir(), '.dkb', 'credentials.json');
}

export function loadRegistryCredentialSync(url: string): RegistryCredential | null {
  const target = registryCredentialsPath();

  try {
    const document = validateDocument(JSON.parse(fsSync.readFileSync(target, 'utf8')) as unknown, target);
    return document.registries[normalizeRegistryUrl(url)] ?? null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof DkbError) throw error;
    if (error instanceof SyntaxError) {
      throw new DkbError(`Invalid DKB Registry credentials JSON at ${target}. Move the file aside or repair it; DKB will not overwrite malformed credentials.`);
    }
    throw error;
  }
}

export async function saveRegistryCredential(url: string, credential: RegistryCredential): Promise<void> {
  validateToken(credential.token);
  const normalized = normalizeRegistryUrl(url);

  await mutateCredentials((document) => ({
    ...document,
    registries: {
      ...document.registries,
      [normalized]: credential,
    },
  }));
}

export async function removeRegistryCredential(url: string): Promise<boolean> {
  const normalized = normalizeRegistryUrl(url);
  let removed = false;

  await mutateCredentials((document) => {
    if (!(normalized in document.registries)) return document;
    removed = true;
    const registries = { ...document.registries };
    delete registries[normalized];
    return { ...document, registries };
  });

  return removed;
}

function validateDocument(value: unknown, target: string): RegistryCredentialDocument {
  if (!isObject(value) || value.format !== DKB_REGISTRY_CREDENTIALS_FORMAT || !isObject(value.registries)) {
    throw new DkbError(`Unsupported DKB Registry credentials document at ${target}.`);
  }

  const registries: Record<string, RegistryCredential> = {};

  for (const [url, raw] of Object.entries(value.registries)) {
    if (!isObject(raw) || typeof raw.token !== 'string' || typeof raw.savedAt !== 'string') {
      throw new DkbError(`Invalid DKB Registry credential for ${url} in ${target}.`);
    }
    validateToken(raw.token);
    registries[normalizeRegistryUrl(url)] = {
      token: raw.token,
      savedAt: raw.savedAt,
      ...(typeof raw.user === 'string' ? { user: raw.user } : {}),
      ...(typeof raw.team === 'string' ? { team: raw.team } : {}),
      ...(Array.isArray(raw.abilities) && raw.abilities.every((ability) => typeof ability === 'string')
        ? { abilities: raw.abilities }
        : {}),
      ...(typeof raw.expiresAt === 'string' || raw.expiresAt === null ? { expiresAt: raw.expiresAt } : {}),
    };
  }

  return { format: DKB_REGISTRY_CREDENTIALS_FORMAT, registries };
}

async function mutateCredentials(
  mutation: (document: RegistryCredentialDocument) => RegistryCredentialDocument,
): Promise<void> {
  const target = registryCredentialsPath();
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const release = await acquireLock(`${target}.lock`);

  try {
    let document: RegistryCredentialDocument;
    try {
      document = validateDocument(JSON.parse(await fs.readFile(target, 'utf8')) as unknown, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        document = { format: DKB_REGISTRY_CREDENTIALS_FORMAT, registries: {} };
      } else if (error instanceof SyntaxError) {
        throw new DkbError(`Invalid DKB Registry credentials JSON at ${target}. Move the file aside or repair it; DKB will not overwrite malformed credentials.`);
      } else {
        throw error;
      }
    }

    const updated = mutation(document);
    const temporary = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600).catch(() => undefined);
  } finally {
    await release();
  }
}

async function acquireLock(target: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + 5_000;

  while (true) {
    try {
      const handle = await fs.open(target, 'wx', 0o600);
      return async () => {
        await handle.close();
        await fs.rm(target, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        throw new DkbError(`Timed out waiting for Registry credential lock: ${target}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function validateToken(token: string): void {
  if (!/^dkb_[A-Za-z0-9_-]{32,}$/u.test(token)) {
    throw new DkbError('Registry token is invalid. Expected a token beginning with dkb_.');
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
