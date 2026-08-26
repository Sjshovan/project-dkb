import path from 'node:path';

export const DKB_STATE_DIR = '.dkb';
export const DKB_ARTIFACTS_DIR = '.dkb/artifacts';
export const DKB_ARTIFACT_LOCK_PATH = `${DKB_ARTIFACTS_DIR}/dkb-artifact.lock.json`;
export const DKB_CACHE_DIR = '.dkb/cache';
export const DKB_LOCKS_DIR = '.dkb/locks';
export const DKB_RUNS_DIR = '.dkb/runs';
export const DKB_WRITE_QUEUE_DIR = '.dkb/runs/write-queue';

export function resolveFrom(base: string, target: string): string {
  return path.resolve(base, target);
}

export function resolveContainedPath(base: string, target: string, label = 'path'): string {
  if (path.isAbsolute(target)) {
    throw new Error(`${label} must be relative to ${base}: ${target}`);
  }

  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(resolvedBase, target);
  const relative = path.relative(resolvedBase, resolvedTarget);

  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolvedTarget;
  }

  throw new Error(`${label} must stay within ${resolvedBase}: ${target}`);
}

export function defaultStatePath(root: string, relativePath: string): string {
  return path.resolve(root, relativePath);
}

export function artifactLockPath(root: string): string {
  return resolveFrom(root, DKB_ARTIFACT_LOCK_PATH);
}

export type ManifestFilename = 'dkb.json' | 'dkb-lock.json' | 'dkb-release.json' | '.dkb-package.json';

export function manifestPath(root: string, filename: ManifestFilename): string {
  return path.join(root, filename);
}
