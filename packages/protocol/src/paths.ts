import path from 'node:path';

export const DKB_STATE_DIR = '.dkb';
export const DKB_BUILDS_DIR = '.dkb/builds';
export const DKB_EVIDENCE_BUILDS_DIR = `${DKB_BUILDS_DIR}/evidence`;
export const DKB_RETRIEVAL_BUILDS_DIR = `${DKB_BUILDS_DIR}/retrieval`;
export const DKB_RUNTIME_LOCK_PATH = '.dkb/runtime.lock.json';
export const DKB_CACHE_DIR = '.dkb/cache';
export const DKB_COMPILE_RECEIPT_PATH = `${DKB_CACHE_DIR}/compiler/compile.receipt.json`;
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

export function compileReceiptPath(root: string): string {
  return resolveFrom(root, DKB_COMPILE_RECEIPT_PATH);
}

export function evidenceBuildPath(root: string, evidenceProfileDigest: string, evidenceDigest: string): string {
  return resolveFrom(root, path.join(
    DKB_EVIDENCE_BUILDS_DIR,
    digestPathSegment(evidenceProfileDigest, 'Evidence Profile digest'),
    digestPathSegment(evidenceDigest, 'Evidence digest'),
  ));
}

export function retrievalBuildPath(root: string, retrievalProfileDigest: string, retrievalBuildDigest: string): string {
  return resolveFrom(root, path.join(
    DKB_RETRIEVAL_BUILDS_DIR,
    digestPathSegment(retrievalProfileDigest, 'Retrieval Profile digest'),
    digestPathSegment(retrievalBuildDigest, 'Retrieval Build digest'),
  ));
}

export function digestPathSegment(value: string, label = 'digest'): string {
  const match = /^sha256:([a-f0-9]{64})$/iu.exec(value);

  if (!match) {
    throw new Error(`${label} must be a sha256 digest`);
  }

  return match[1]!.toLowerCase();
}

export type ManifestFilename = 'dkb.json' | 'dkb-lock.json' | 'dkb-release.json' | '.dkb-package.json';

export function manifestPath(root: string, filename: ManifestFilename): string {
  return path.join(root, filename);
}
