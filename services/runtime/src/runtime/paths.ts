import fs from 'node:fs/promises';
import path from 'node:path';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

export interface DkbRuntimePaths {
  stateRoot: string;
  stateDir: string;
  vendorDir: string;
  packagesDir: string;
}

export function runtimePaths(stateRoot = defaultRuntimeStateRoot()): DkbRuntimePaths {
  const resolved = path.resolve(stateRoot);

  return {
    stateRoot: resolved,
    stateDir: path.join(resolved, '.dkb'),
    vendorDir: path.join(resolved, 'vendor'),
    packagesDir: path.join(resolved, 'vendor'),
  };
}

export function defaultRuntimeStateRoot(): string {
  return process.env.DKB_RUNTIME_STATE_ROOT || path.resolve('.dkb/runtime');
}

export async function ensureRuntimeState(stateRoot?: string): Promise<DkbRuntimePaths> {
  const paths = runtimePaths(stateRoot);

  await fs.mkdir(paths.stateDir, { recursive: true });
  await fs.mkdir(paths.vendorDir, { recursive: true });
  await ensureRuntimeProjectManifest(paths.stateRoot);

  return paths;
}

export async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const temp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
  const backup = `${target}.replace-${process.pid}-${Date.now().toString(36)}`;
  const hadTarget = await pathExists(target);
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (hadTarget) await fs.rename(target, backup);
  try {
    await fs.rename(temp, target);
    await fs.rm(backup, { force: true });
  } catch (error) {
    await fs.rm(target, { force: true });
    if (hadTarget && await pathExists(backup)) await fs.rename(backup, target);
    throw error;
  }
}

export async function maybeReadJsonObject(source: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(source, 'utf8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export function safeRuntimeId(value: string): string {
  const id = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

  return id || 'dkb';
}

export function isEphemeralDkbStatePath(sourceRoot: string, source: string): boolean {
  const relative = path.relative(sourceRoot, source);
  const cachePath = path.join('.dkb', 'cache');
  const locksPath = path.join('.dkb', 'locks');
  const runsPath = path.join('.dkb', 'runs');
  const pluginsPath = path.join('.dkb', 'plugins');
  const configPath = path.join('.dkb', 'config.json');

  return relative === cachePath
    || relative.startsWith(`${cachePath}${path.sep}`)
    || relative === locksPath
    || relative.startsWith(`${locksPath}${path.sep}`)
    || relative === runsPath
    || relative.startsWith(`${runsPath}${path.sep}`)
    || relative === pluginsPath
    || relative.startsWith(`${pluginsPath}${path.sep}`)
    || relative === configPath;
}

async function ensureRuntimeProjectManifest(root: string): Promise<void> {
  const manifestPath = path.join(root, 'dkb.json');

  if (await pathExists(manifestPath)) {
    const existing = await maybeReadJsonObject(manifestPath);

    if (existing?.type !== 'library') {
      throw new DkbError(`Runtime root uses the removed ${String(existing?.type ?? 'legacy')} manifest format. Initialize a new DKB Library.`);
    }
    return;
  }

  await fs.writeFile(manifestPath, `${JSON.stringify({
    manifestVersion: 1,
    type: 'library',
    name: titleFromId(path.basename(root) || 'DKB Library'),
    description: 'Local DKB Library.',
    roots: {},
  }, null, 2)}\n`, 'utf8');
}

function titleFromId(value: string): string {
  return value
    .split(/[-_.]+/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ') || value;
}
