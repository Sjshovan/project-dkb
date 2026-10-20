import fs from 'node:fs/promises';
import path from 'node:path';
import { DKB_RUNTIME_ACTIVATION_PATH, DKB_RUNTIME_BINDING_PATH } from '@sjshovan/dkb-protocol/paths.js';

export interface DkbRuntimeStatePaths {
  stateRoot: string;
  stateDir: string;
  bindingPath: string;
  activationPath: string;
  cacheDir: string;
  tracesDir: string;
  auditDir: string;
}

export function runtimePaths(stateRoot = defaultRuntimeStateRoot()): DkbRuntimeStatePaths {
  const resolved = path.resolve(stateRoot);
  return {
    stateRoot: resolved,
    stateDir: path.join(resolved, '.dkb'),
    bindingPath: path.join(resolved, ...DKB_RUNTIME_BINDING_PATH.split('/')),
    activationPath: path.join(resolved, ...DKB_RUNTIME_ACTIVATION_PATH.split('/')),
    cacheDir: path.join(resolved, '.dkb', 'cache'),
    tracesDir: path.join(resolved, '.dkb', 'traces'),
    auditDir: path.join(resolved, '.dkb', 'audit'),
  };
}

export function defaultRuntimeStateRoot(): string {
  return process.env.DKB_RUNTIME_STATE_ROOT || path.resolve('.dkb/runtime');
}

export async function ensureRuntimeStateDirectories(stateRoot?: string): Promise<DkbRuntimeStatePaths> {
  const paths = runtimePaths(stateRoot);
  await Promise.all([
    fs.mkdir(paths.stateDir, { recursive: true }),
    fs.mkdir(paths.cacheDir, { recursive: true }),
    fs.mkdir(paths.tracesDir, { recursive: true }),
    fs.mkdir(paths.auditDir, { recursive: true }),
  ]);
  return paths;
}

export async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
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
  const ephemeral = ['cache', 'locks', 'runs', 'traces', 'audit'].map((entry) => path.join('.dkb', entry));
  return ephemeral.some((entry) => relative === entry || relative.startsWith(`${entry}${path.sep}`));
}
