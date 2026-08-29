import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  evidenceBuildLock,
  retrievalBuildLock,
  validateEvidenceBuildLock,
  validateRetrievalBuildLock,
  validateRuntimeLock,
  DKB_RUNTIME_LOCK_FORMAT,
  type DkbEvidenceBuildLock,
  type DkbRetrievalBuildLock,
  type DkbRuntimeLock,
} from '@sjshovan/dkb-protocol/builds.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DKB_EVIDENCE_IR_PATH, validateEvidenceIr, type DkbEvidenceIr } from '@sjshovan/dkb-protocol/evidence/ir.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { loadLibrary, uniqueLoadedDkbs } from '@sjshovan/dkb-protocol/manifest.js';
import type { LoadedDkb } from '@sjshovan/dkb-protocol/types.js';
import {
  DKB_RETRIEVAL_PROFILE_LOCK_PATH,
  validateRetrievalProfileLock,
  type DkbRetrievalProfileLock,
} from '@sjshovan/dkb-pipeline/profile.js';
import {
  DKB_ARTIFACTS_DIR,
  DKB_EVIDENCE_BUILDS_DIR,
  DKB_RETRIEVAL_BUILDS_DIR,
  DKB_RUNTIME_LOCK_PATH,
  evidenceBuildPath,
  retrievalBuildPath,
  resolveFrom,
} from '@sjshovan/dkb-protocol/paths.js';

export const DKB_EVIDENCE_BUILD_IR = 'evidence.ir.json';
export const DKB_EVIDENCE_BUILD_LOCK = 'evidence.lock.json';
export const DKB_RETRIEVAL_BUILD_LOCK = 'retrieval.lock.json';
export const DKB_RETRIEVAL_BUILD_ARTIFACTS = 'artifacts';
export const DKB_RETRIEVAL_BUILD_PROFILE_LOCK = 'dkb-profile.lock.json';
const EVIDENCE_ARTIFACT_NAME = path.basename(DKB_EVIDENCE_IR_PATH);

export interface DkbPackageBuildGraph {
  evidence: DkbEvidenceBuildLock;
  retrieval: DkbRetrievalBuildLock;
  runtime: DkbRuntimeLock;
  evidencePath: string;
  retrievalPath: string;
}

export interface DkbBuildList {
  root: string;
  active: DkbRuntimeLock | null;
  evidence: Array<{ profileDigest: string; evidenceDigest: string; path: string; active: boolean }>;
  retrieval: Array<{ profileDigest: string; buildDigest: string; path: string; active: boolean }>;
}

export interface DkbResolvedPackageBuild {
  dkb: LoadedDkb;
  evidenceRoot: string;
  retrievalRoot: string;
  artifactsRoot: string;
}

export async function resolveLibraryRuntimeBuilds(root: string): Promise<DkbResolvedPackageBuild[]> {
  const library = await loadLibrary(root);
  const dkbs = uniqueLoadedDkbs([
    ...library.collections.flatMap((collection) => collection.dkbs),
    ...library.dkbs,
  ]);

  return Promise.all(dkbs.map(async (dkb) => {
    const graph = await validatePackageBuildGraph(dkb.root);

    return {
      dkb,
      evidenceRoot: graph.evidencePath,
      retrievalRoot: graph.retrievalPath,
      artifactsRoot: path.join(graph.retrievalPath, DKB_RETRIEVAL_BUILD_ARTIFACTS),
    };
  }));
}

export async function listPackageBuilds(root: string): Promise<DkbBuildList> {
  const resolvedRoot = path.resolve(root);
  const active = await maybeReadRuntimeLock(resolvedRoot);
  const evidence = await scanDigestBuilds(resolveFrom(resolvedRoot, DKB_EVIDENCE_BUILDS_DIR), (profile, digest) => {
    const profileDigest = `sha256:${profile}`;
    const evidenceDigest = `sha256:${digest}`;
    return {
      profileDigest,
      evidenceDigest,
      path: evidenceBuildPath(resolvedRoot, profileDigest, evidenceDigest),
      active: Object.values(active?.packages ?? {}).some((entry) => entry.evidenceProfileDigest === profileDigest && entry.evidenceDigest === evidenceDigest),
    };
  });
  const retrieval = await scanDigestBuilds(resolveFrom(resolvedRoot, DKB_RETRIEVAL_BUILDS_DIR), (profile, digest) => {
    const profileDigest = `sha256:${profile}`;
    const buildDigest = `sha256:${digest}`;
    return {
      profileDigest,
      buildDigest,
      path: retrievalBuildPath(resolvedRoot, profileDigest, buildDigest),
      active: Object.values(active?.packages ?? {}).some((entry) => entry.retrievalProfileDigest === profileDigest && entry.retrievalBuildDigest === buildDigest),
    };
  });

  return { root: resolvedRoot, active, evidence, retrieval };
}

export async function inspectPackageBuild(root: string, digest: string): Promise<{
  kind: 'evidence' | 'retrieval';
  lock: DkbEvidenceBuildLock | DkbRetrievalBuildLock;
  path: string;
  active: boolean;
}> {
  const normalized = normalizeDigest(digest);
  const builds = await listPackageBuilds(root);
  const evidence = builds.evidence.find((item) => item.evidenceDigest === normalized || item.profileDigest === normalized);
  if (evidence) {
    const lockPath = path.join(evidence.path, DKB_EVIDENCE_BUILD_LOCK);
    return {
      kind: 'evidence',
      lock: validateEvidenceBuildLock(JSON.parse(await fs.readFile(lockPath, 'utf8')), lockPath),
      path: evidence.path,
      active: evidence.active,
    };
  }
  const retrieval = builds.retrieval.find((item) => item.buildDigest === normalized || item.profileDigest === normalized);
  if (retrieval) {
    const lockPath = path.join(retrieval.path, DKB_RETRIEVAL_BUILD_LOCK);
    return {
      kind: 'retrieval',
      lock: validateRetrievalBuildLock(JSON.parse(await fs.readFile(lockPath, 'utf8')), lockPath),
      path: retrieval.path,
      active: retrieval.active,
    };
  }
  throw new DkbError(`No Evidence or Retrieval Build matches ${normalized} at ${path.resolve(root)}`);
}

export async function prunePackageBuilds(root: string): Promise<{ removed: string[]; retained: string[] }> {
  const builds = await listPackageBuilds(root);
  const removed: string[] = [];
  const retained: string[] = [];

  for (const build of [...builds.evidence, ...builds.retrieval]) {
    if (build.active) {
      retained.push(build.path);
    } else {
      await fs.rm(build.path, { recursive: true, force: true });
      removed.push(build.path);
    }
  }

  return { removed, retained };
}

export async function mergeStoredPackageBuilds(sourceRoot: string, destinationRoot: string): Promise<{
  copied: string[];
  reused: string[];
}> {
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(destinationRoot);
  const builds = await listPackageBuilds(source);
  const copied: string[] = [];
  const reused: string[] = [];

  for (const build of [...builds.evidence, ...builds.retrieval]) {
    const relative = path.relative(source, build.path);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new DkbError(`Stored Build escapes its package root: ${build.path}`);
    }
    const target = path.join(destination, relative);
    const targetExists = await fs.stat(target).then((stat) => stat.isDirectory()).catch(() => false);
    if (targetExists) {
      const [sourceTree, targetTree] = await Promise.all([
        immutableBuildTreeReceipt(build.path),
        immutableBuildTreeReceipt(target),
      ]);
      if (stableHash(sourceTree) !== stableHash(targetTree)) {
        throw new DkbError(`Stored Build collision while retaining inactive build ${relative}`);
      }
      reused.push(target);
      continue;
    }
    await cloneTree(build.path, target);
    copied.push(target);
  }

  return { copied, reused };
}

export async function writePackageBuildGraph(input: {
  root: string;
  package: { id: string; version: string; sourceDigest: string };
  evidence: DkbEvidenceIr;
  retrievalProfile: DkbRetrievalProfileLock;
  target: string;
  generation?: number;
  generatedAt?: string;
}): Promise<DkbPackageBuildGraph> {
  const root = path.resolve(input.root);
  const evidence = validateEvidenceIr(input.evidence);
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const evidenceLock = evidenceBuildLock({
    package: input.package,
    evidenceProfileDigest: evidence.evidenceProfileDigest,
    evidenceDigest: evidence.evidenceDigest,
    recordCount: evidence.evidence.length,
    chunkCount: evidence.chunks.length,
    generatedAt,
  });
  const evidencePath = evidenceBuildPath(root, evidence.evidenceProfileDigest, evidence.evidenceDigest);
  const stagedEvidence = `${evidencePath}.stage-${process.pid}-${Date.now().toString(36)}`;

  await fs.rm(stagedEvidence, { recursive: true, force: true });
  await fs.mkdir(stagedEvidence, { recursive: true });
  await writeJson(path.join(stagedEvidence, DKB_EVIDENCE_BUILD_IR), evidence);
  await writeJson(path.join(stagedEvidence, DKB_EVIDENCE_BUILD_LOCK), evidenceLock);
  await promoteImmutableDirectory(stagedEvidence, evidencePath, DKB_EVIDENCE_BUILD_LOCK, validateEvidenceBuildLock);

  const activeArtifacts = resolveFrom(root, DKB_ARTIFACTS_DIR);
  const artifactTree = await treeReceipt(activeArtifacts, (relativePath) => relativePath !== EVIDENCE_ARTIFACT_NAME);
  const partialRetrieval = {
    package: { id: input.package.id, version: input.package.version },
    evidenceProfileDigest: evidence.evidenceProfileDigest,
    evidenceDigest: evidence.evidenceDigest,
    retrievalProfileDigest: input.retrievalProfile.profileDigest,
    compatibilityDigest: input.retrievalProfile.compatibilityDigest,
    artifactTreeDigest: stableHash(artifactTree),
    generatedAt,
  };
  const retrievalLock = retrievalBuildLock(partialRetrieval);
  const retrievalPath = retrievalBuildPath(root, input.retrievalProfile.profileDigest, retrievalLock.retrievalBuildDigest);
  const stagedRetrieval = `${retrievalPath}.stage-${process.pid}-${Date.now().toString(36)}`;

  await fs.rm(stagedRetrieval, { recursive: true, force: true });
  await fs.mkdir(stagedRetrieval, { recursive: true });
  await cloneTree(activeArtifacts, path.join(stagedRetrieval, DKB_RETRIEVAL_BUILD_ARTIFACTS), (relativePath) => relativePath !== EVIDENCE_ARTIFACT_NAME);
  await writeJson(path.join(stagedRetrieval, DKB_RETRIEVAL_BUILD_LOCK), retrievalLock);
  await writeJson(path.join(stagedRetrieval, DKB_RETRIEVAL_BUILD_PROFILE_LOCK), input.retrievalProfile);
  await promoteImmutableDirectory(stagedRetrieval, retrievalPath, DKB_RETRIEVAL_BUILD_LOCK, validateRetrievalBuildLock);

  const runtime: DkbRuntimeLock = validateRuntimeLock({
    format: DKB_RUNTIME_LOCK_FORMAT,
    target: input.target,
    evidenceProfileDigest: evidence.evidenceProfileDigest,
    retrievalProfileDigest: input.retrievalProfile.profileDigest,
    compatibilityDigest: input.retrievalProfile.compatibilityDigest,
    packages: {
      [input.package.id]: {
        version: input.package.version,
        evidenceProfileDigest: evidence.evidenceProfileDigest,
        evidenceDigest: evidence.evidenceDigest,
        retrievalProfileDigest: input.retrievalProfile.profileDigest,
        retrievalBuildDigest: retrievalLock.retrievalBuildDigest,
      },
    },
    generation: input.generation ?? 1,
    generatedAt,
  });
  await writeRuntimeLock(root, runtime);

  return { evidence: evidenceLock, retrieval: retrievalLock, runtime, evidencePath, retrievalPath };
}

export async function activateStoredPackageBuild(input: {
  root: string;
  target: string;
  evidenceProfileDigest: string;
  retrievalProfileDigest: string;
  compatibilityDigest: string;
}): Promise<DkbPackageBuildGraph> {
  const root = path.resolve(input.root);
  const builds = await listPackageBuilds(root);
  const selected = builds.retrieval.filter((build) => build.profileDigest === input.retrievalProfileDigest);
  if (selected.length === 0) throw new DkbError(`No stored Retrieval Build exists for pipeline ${input.target} (${input.retrievalProfileDigest})`);
  if (selected.length > 1) throw new DkbError(`Package has multiple Retrieval Builds for exact profile ${input.retrievalProfileDigest}; immutable compilation is non-deterministic`);

  const retrievalPath = selected[0]!.path;
  const retrievalLockPath = path.join(retrievalPath, DKB_RETRIEVAL_BUILD_LOCK);
  const retrieval = validateRetrievalBuildLock(JSON.parse(await fs.readFile(retrievalLockPath, 'utf8')), retrievalLockPath);
  const profilePath = path.join(retrievalPath, DKB_RETRIEVAL_BUILD_PROFILE_LOCK);
  const profile = validateRetrievalProfileLock(JSON.parse(await fs.readFile(profilePath, 'utf8')), profilePath);
  if (retrieval.evidenceProfileDigest !== input.evidenceProfileDigest
    || retrieval.compatibilityDigest !== input.compatibilityDigest
    || profile.profileDigest !== input.retrievalProfileDigest
    || profile.compatibilityDigest !== input.compatibilityDigest) {
    throw new DkbError(`Stored Retrieval Build ${retrieval.retrievalBuildDigest} does not satisfy pipeline ${input.target}`);
  }
  const evidencePath = evidenceBuildPath(root, retrieval.evidenceProfileDigest, retrieval.evidenceDigest);
  const evidenceLockPath = path.join(evidencePath, DKB_EVIDENCE_BUILD_LOCK);
  const evidence = validateEvidenceBuildLock(JSON.parse(await fs.readFile(evidenceLockPath, 'utf8')), evidenceLockPath);
  const evidenceIrPath = path.join(evidencePath, DKB_EVIDENCE_BUILD_IR);
  const evidenceIr = validateEvidenceIr(JSON.parse(await fs.readFile(evidenceIrPath, 'utf8')), evidenceIrPath);
  assertEvidenceLayer(evidence, evidenceIr);
  const actualArtifactTree = stableHash(await treeReceipt(path.join(retrievalPath, DKB_RETRIEVAL_BUILD_ARTIFACTS)));
  if (actualArtifactTree !== retrieval.artifactTreeDigest) throw new DkbError(`Stored Retrieval Build ${retrieval.retrievalBuildDigest} artifact tree is corrupt`);

  const previous = await maybeReadRuntimeLock(root);
  const runtime: DkbRuntimeLock = validateRuntimeLock({
    format: DKB_RUNTIME_LOCK_FORMAT,
    target: input.target,
    evidenceProfileDigest: input.evidenceProfileDigest,
    retrievalProfileDigest: input.retrievalProfileDigest,
    compatibilityDigest: input.compatibilityDigest,
    packages: {
      [retrieval.package.id]: {
        version: retrieval.package.version,
        evidenceProfileDigest: retrieval.evidenceProfileDigest,
        evidenceDigest: retrieval.evidenceDigest,
        retrievalProfileDigest: retrieval.retrievalProfileDigest,
        retrievalBuildDigest: retrieval.retrievalBuildDigest,
      },
    },
    generation: (previous?.generation ?? 0) + 1,
    generatedAt: new Date().toISOString(),
  });

  const stageRoot = resolveFrom(root, `.dkb/activate-${process.pid}-${Date.now().toString(36)}`);
  const stageArtifacts = path.join(stageRoot, DKB_ARTIFACTS_DIR);
  const activeArtifacts = resolveFrom(root, DKB_ARTIFACTS_DIR);
  const activeProfile = resolveFrom(root, DKB_RETRIEVAL_PROFILE_LOCK_PATH);
  const activeRuntime = resolveFrom(root, DKB_RUNTIME_LOCK_PATH);
  const backupArtifacts = `${activeArtifacts}.replace-${process.pid}`;
  const backupProfile = `${activeProfile}.replace-${process.pid}`;
  const backupRuntime = `${activeRuntime}.replace-${process.pid}`;

  await fs.rm(stageRoot, { recursive: true, force: true });
  await cloneTree(path.join(retrievalPath, DKB_RETRIEVAL_BUILD_ARTIFACTS), stageArtifacts);
  await fs.copyFile(evidenceIrPath, path.join(stageArtifacts, EVIDENCE_ARTIFACT_NAME));
  await writeJson(path.join(stageRoot, DKB_RETRIEVAL_PROFILE_LOCK_PATH), profile);
  await writeJson(path.join(stageRoot, DKB_RUNTIME_LOCK_PATH), runtime);

  try {
    await moveOptional(activeArtifacts, backupArtifacts);
    await moveOptional(activeProfile, backupProfile);
    await moveOptional(activeRuntime, backupRuntime);
    try {
      await fs.rename(stageArtifacts, activeArtifacts);
      await fs.rename(path.join(stageRoot, DKB_RETRIEVAL_PROFILE_LOCK_PATH), activeProfile);
      await fs.rename(path.join(stageRoot, DKB_RUNTIME_LOCK_PATH), activeRuntime);
      await fs.rm(backupArtifacts, { recursive: true, force: true });
      await fs.rm(backupProfile, { force: true });
      await fs.rm(backupRuntime, { force: true });
    } catch (error) {
      await fs.rm(activeArtifacts, { recursive: true, force: true });
      await fs.rm(activeProfile, { force: true });
      await fs.rm(activeRuntime, { force: true });
      await moveOptional(backupArtifacts, activeArtifacts);
      await moveOptional(backupProfile, activeProfile);
      await moveOptional(backupRuntime, activeRuntime);
      throw error;
    }
  } finally {
    await fs.rm(stageRoot, { recursive: true, force: true });
  }

  return { evidence, retrieval, runtime, evidencePath, retrievalPath };
}

export async function validatePackageBuildGraph(root: string, runtimeLock?: DkbRuntimeLock): Promise<DkbPackageBuildGraph> {
  const runtime = runtimeLock ?? await readRuntimeLock(root);
  const ids = Object.keys(runtime.packages);
  if (ids.length !== 1) throw new DkbError(`Package build graph at ${root} must contain exactly one package, got ${ids.length}`);
  const entry = runtime.packages[ids[0]!]!;
  const evidencePath = evidenceBuildPath(root, entry.evidenceProfileDigest, entry.evidenceDigest);
  const retrievalPath = retrievalBuildPath(root, entry.retrievalProfileDigest, entry.retrievalBuildDigest);
  const evidence = validateEvidenceBuildLock(
    JSON.parse(await fs.readFile(path.join(evidencePath, DKB_EVIDENCE_BUILD_LOCK), 'utf8')),
    path.join(evidencePath, DKB_EVIDENCE_BUILD_LOCK),
  );
  const evidenceIrPath = path.join(evidencePath, DKB_EVIDENCE_BUILD_IR);
  const evidenceIr = validateEvidenceIr(JSON.parse(await fs.readFile(evidenceIrPath, 'utf8')), evidenceIrPath);
  const retrieval = validateRetrievalBuildLock(
    JSON.parse(await fs.readFile(path.join(retrievalPath, DKB_RETRIEVAL_BUILD_LOCK), 'utf8')),
    path.join(retrievalPath, DKB_RETRIEVAL_BUILD_LOCK),
  );
  const artifactTreeDigest = stableHash(await treeReceipt(path.join(retrievalPath, DKB_RETRIEVAL_BUILD_ARTIFACTS)));

  if (artifactTreeDigest !== retrieval.artifactTreeDigest) {
    throw new DkbError(`Retrieval Build ${retrieval.retrievalBuildDigest} artifact tree mismatch: expected ${retrieval.artifactTreeDigest}, got ${artifactTreeDigest}`);
  }
  if (evidence.evidenceDigest !== retrieval.evidenceDigest || evidence.evidenceProfileDigest !== retrieval.evidenceProfileDigest) {
    throw new DkbError(`Retrieval Build ${retrieval.retrievalBuildDigest} is attached to the wrong Evidence Build`);
  }
  assertEvidenceLayer(evidence, evidenceIr);

  return { evidence, retrieval, runtime, evidencePath, retrievalPath };
}

export async function readRuntimeLock(root: string): Promise<DkbRuntimeLock> {
  const target = resolveFrom(root, DKB_RUNTIME_LOCK_PATH);
  return validateRuntimeLock(JSON.parse(await fs.readFile(target, 'utf8')), target);
}

export async function maybeReadRuntimeLock(root: string): Promise<DkbRuntimeLock | null> {
  try {
    return await readRuntimeLock(root);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && String((error as { code?: unknown }).code) === 'ENOENT') return null;
    throw error;
  }
}

export async function writeRuntimeLock(root: string, runtime: DkbRuntimeLock): Promise<void> {
  const validated = validateRuntimeLock(runtime);
  await writeJsonAtomic(resolveFrom(root, DKB_RUNTIME_LOCK_PATH), validated);
}

async function promoteImmutableDirectory<T>(
  staged: string,
  target: string,
  lockName: string,
  validate: (value: unknown, source?: string) => T,
): Promise<void> {
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(staged, target);
    return;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
    const targetExists = await fs.stat(target).then((stat) => stat.isDirectory()).catch(() => false);
    if (!targetExists || (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'EPERM')) throw error;
  }

  const [existing, candidate] = await Promise.all([
    fs.readFile(path.join(target, lockName), 'utf8').then((value) => validate(JSON.parse(value), path.join(target, lockName))),
    fs.readFile(path.join(staged, lockName), 'utf8').then((value) => validate(JSON.parse(value), path.join(staged, lockName))),
  ]);
  if (stableHash(withoutGeneratedAt(existing)) !== stableHash(withoutGeneratedAt(candidate))) {
    throw new DkbError(`Content-addressed build collision at ${target}`);
  }
  await fs.rm(staged, { recursive: true, force: true });
}

function withoutGeneratedAt(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { generatedAt: _generatedAt, ...identity } = value as Record<string, unknown>;
  return identity;
}

async function cloneTree(
  source: string,
  destination: string,
  include: (relativePath: string) => boolean = () => true,
  relativeRoot = source,
): Promise<void> {
  const entries = await fs.readdir(source, { withFileTypes: true });
  await fs.mkdir(destination, { recursive: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new DkbError(`Build artifact tree contains a symbolic link: ${path.join(source, entry.name)}`);
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await cloneTree(from, to, include, relativeRoot);
    } else if (entry.isFile()) {
      const relativePath = path.relative(relativeRoot, from).replace(/\\/g, '/');
      if (!include(relativePath)) continue;
      // Build directories are immutable snapshots. A hard link would let a
      // later active-index rewrite mutate an older build in place. Prefer a
      // copy-on-write clone where the filesystem supports it, with Node's
      // documented regular-copy fallback elsewhere.
      await fs.copyFile(from, to, fsConstants.COPYFILE_FICLONE);
    }
  }
}

async function treeReceipt(
  root: string,
  include: (relativePath: string) => boolean = () => true,
): Promise<Array<{ path: string; hash: string; size: number }>> {
  const values: Array<{ path: string; hash: string; size: number }> = [];

  async function visit(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new DkbError(`Build artifact tree contains a symbolic link: ${path.join(current, entry.name)}`);
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile()) {
        const relativePath = path.relative(root, target).replace(/\\/g, '/');
        if (!include(relativePath)) continue;
        const stat = await fs.stat(target);
        values.push({
          path: relativePath,
          hash: await fileHash(target),
          size: stat.size,
        });
      }
    }
  }

  await visit(root);
  return values.sort((left, right) => left.path.localeCompare(right.path));
}

async function immutableBuildTreeReceipt(root: string): Promise<Array<{ path: string; hash: string; size: number }>> {
  const receipt = await treeReceipt(root);
  const generatedLocks = new Set([
    DKB_EVIDENCE_BUILD_LOCK,
    DKB_RETRIEVAL_BUILD_LOCK,
    DKB_RETRIEVAL_BUILD_PROFILE_LOCK,
  ]);

  return Promise.all(receipt.map(async (entry) => {
    if (!generatedLocks.has(path.basename(entry.path))) return entry;
    const value = JSON.parse(await fs.readFile(path.join(root, ...entry.path.split('/')), 'utf8')) as unknown;
    const canonical = JSON.stringify(withoutGeneratedAt(value));
    return {
      path: entry.path,
      hash: stableHash(withoutGeneratedAt(value)),
      size: Buffer.byteLength(canonical),
    };
  }));
}

function assertEvidenceLayer(lock: DkbEvidenceBuildLock, evidence: DkbEvidenceIr): void {
  if (lock.evidenceProfileDigest !== evidence.evidenceProfileDigest
    || lock.evidenceDigest !== evidence.evidenceDigest
    || lock.recordCount !== evidence.evidence.length
    || lock.chunkCount !== evidence.chunks.length) {
    throw new DkbError(`Evidence Build ${lock.evidenceDigest} does not match its Evidence IR layer`);
  }
}

async function fileHash(target: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(await fs.readFile(target));
  return `sha256:${hash.digest('hex')}`;
}

async function writeJson(target: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await writeJson(temporary, value);
  await fs.rm(target, { force: true });
  await fs.rename(temporary, target);
}

async function scanDigestBuilds<T>(root: string, map: (profile: string, build: string) => T): Promise<T[]> {
  const profiles = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const results: T[] = [];
  for (const profile of profiles.filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/iu.test(entry.name))) {
    const builds = await fs.readdir(path.join(root, profile.name), { withFileTypes: true }).catch(() => []);
    for (const build of builds.filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/iu.test(entry.name))) {
      results.push(map(profile.name.toLowerCase(), build.name.toLowerCase()));
    }
  }
  return results;
}

async function moveOptional(source: string, target: string): Promise<void> {
  try {
    await fs.rename(source, target);
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || String((error as { code?: unknown }).code) !== 'ENOENT') throw error;
  }
}

function normalizeDigest(value: string): string {
  const normalized = value.startsWith('sha256:') ? value.toLowerCase() : `sha256:${value.toLowerCase()}`;
  if (!/^sha256:[a-f0-9]{64}$/u.test(normalized)) throw new DkbError(`Build digest must be sha256:<64 hex characters>`);
  return normalized;
}
