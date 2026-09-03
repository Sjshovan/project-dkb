import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  evidenceBuildLock,
  evidenceBuildReceiptDigest,
  retrievalBuildLock,
  validateEvidenceBuildLock,
  validateRetrievalBuildLock,
  type DkbEvidenceBuildLock,
  type DkbRetrievalBuildLock,
} from '@sjshovan/dkb-protocol/builds.js';
import type { DkbRuntimeActivation, DkbRuntimeActivationEntry } from '@sjshovan/dkb-protocol/runtimeActivation.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { assertProviderExecutionIdentities, type DkbProviderExecutionReceipt } from '@sjshovan/dkb-protocol/providerReceipts.js';
import {
  DKB_ARTIFACT_MANIFEST_FILENAME,
  DKB_ARTIFACT_MANIFEST_FORMAT,
  validateArtifactManifest,
  type DkbArtifactManifest,
} from '@sjshovan/dkb-protocol/artifacts.js';
import { validateEvidenceIr, type DkbEvidenceIr } from '@sjshovan/dkb-protocol/evidence/ir.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { loadCollection, loadDkb, loadLibrary, loadManifest, uniqueLoadedDkbs } from '@sjshovan/dkb-protocol/manifest.js';
import type { LoadedDkb } from '@sjshovan/dkb-protocol/types.js';
import { materializeEvidenceCatalog } from './evidenceCatalog.js';
import { withDkbFileLock } from './locks.js';
import {
  validateRetrievalProfileLock,
  type DkbRetrievalProfileLock,
} from '@sjshovan/dkb-protocol/retrievalProfile.js';
import {
  DKB_EVIDENCE_BUILDS_DIR,
  DKB_RETRIEVAL_BUILDS_DIR,
  evidenceBuildPath,
  retrievalBuildPath,
  resolveFrom,
} from '@sjshovan/dkb-protocol/paths.js';

export const DKB_EVIDENCE_BUILD_IR = 'evidence.ir.json';
export const DKB_EVIDENCE_BUILD_LOCK = 'evidence.lock.json';
export const DKB_RETRIEVAL_BUILD_LOCK = 'retrieval.lock.json';
export const DKB_RETRIEVAL_BUILD_ARTIFACTS = 'artifacts';
export const DKB_RETRIEVAL_BUILD_PROFILE_LOCK = 'dkb-profile.lock.json';

export interface DkbPackageBuildGraph {
  evidence: DkbEvidenceBuildLock;
  retrieval: DkbRetrievalBuildLock;
  profile: DkbRetrievalProfileLock;
  selection: DkbRuntimeActivationEntry;
  evidencePath: string;
  retrievalPath: string;
}

export interface DkbStoredPackageBuildGraph {
  evidence: DkbEvidenceBuildLock;
  retrieval: DkbRetrievalBuildLock;
  profile: DkbRetrievalProfileLock;
  selection: DkbRuntimeActivationEntry;
  evidencePath: string;
  retrievalPath: string;
}

export interface ValidatePackageBuildResult {
  ok: boolean;
  root: string;
  manifestPath: string;
  manifest?: DkbArtifactManifest;
  graph?: DkbPackageBuildGraph;
  checks: Array<{
    name: string;
    ok: boolean;
    detail: string;
  }>;
}

export interface DkbBuildList {
  root: string;
  evidence: Array<{ profileDigest: string; evidenceDigest: string; path: string }>;
  retrieval: Array<{ profileDigest: string; buildDigest: string; path: string }>;
}

export interface DkbResolvedPackageBuild {
  dkb: LoadedDkb;
  evidenceRoot: string;
  retrievalRoot: string;
  artifactsRoot: string;
}

export interface DkbKnowledgeBuildVerification {
  ok: boolean;
  root: string;
  type: 'library' | 'collection' | 'dkb';
  lockPath: string;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

export async function resolveLibraryActivationBuilds(
  root: string,
  activation: DkbRuntimeActivation,
): Promise<DkbResolvedPackageBuild[]> {
  const library = await loadLibrary(root);
  const dkbs = uniqueLoadedDkbs([
    ...library.collections.flatMap((collection) => collection.dkbs),
    ...library.dkbs,
  ]);
  const expectedIds = dkbs.map((dkb) => dkb.manifest.id).sort();
  const activatedIds = Object.keys(activation.packages).sort();
  if (stableHash(expectedIds) !== stableHash(activatedIds)) {
    throw new DkbError(
      `Runtime activation packages ${activatedIds.join(', ') || 'none'} do not match Library packages ${expectedIds.join(', ') || 'none'}`,
    );
  }

  return Promise.all(dkbs.map(async (dkb) => {
    const selection = activation.packages[dkb.manifest.id];
    if (!selection) throw new DkbError(`Runtime activation does not contain ${dkb.manifest.id}`);
    if (selection.version !== dkb.manifest.version) {
      throw new DkbError(`Runtime activation selects ${dkb.manifest.id}@${selection.version}; Library contains ${dkb.manifest.version}`);
    }
    const graph = await validateStoredPackageBuild(dkb.root, selection);
    if (graph.retrieval.compatibilityDigest !== activation.compatibilityDigest) {
      throw new DkbError(`Runtime activation compatibility does not match ${dkb.manifest.id}`);
    }
    return {
      dkb,
      evidenceRoot: graph.evidencePath,
      retrievalRoot: graph.retrievalPath,
      artifactsRoot: path.join(graph.retrievalPath, DKB_RETRIEVAL_BUILD_ARTIFACTS),
    };
  }));
}

export async function validateStoredPackageBuild(
  root: string,
  selection: DkbRuntimeActivationEntry,
): Promise<DkbStoredPackageBuildGraph> {
  const resolvedRoot = path.resolve(root);
  const evidencePath = evidenceBuildPath(resolvedRoot, selection.evidenceProfileDigest, selection.evidenceDigest);
  const retrievalPath = retrievalBuildPath(resolvedRoot, selection.retrievalProfileDigest, selection.retrievalBuildDigest);
  const evidenceLockPath = path.join(evidencePath, DKB_EVIDENCE_BUILD_LOCK);
  const evidenceIrPath = path.join(evidencePath, DKB_EVIDENCE_BUILD_IR);
  const retrievalLockPath = path.join(retrievalPath, DKB_RETRIEVAL_BUILD_LOCK);
  const profilePath = path.join(retrievalPath, DKB_RETRIEVAL_BUILD_PROFILE_LOCK);
  const [evidenceSource, evidenceIrSource, retrievalSource, profileSource, artifactTree] = await Promise.all([
    fs.readFile(evidenceLockPath, 'utf8'),
    fs.readFile(evidenceIrPath, 'utf8'),
    fs.readFile(retrievalLockPath, 'utf8'),
    fs.readFile(profilePath, 'utf8'),
    treeReceipt(path.join(retrievalPath, DKB_RETRIEVAL_BUILD_ARTIFACTS)),
  ]);
  const evidence = validateEvidenceBuildLock(JSON.parse(evidenceSource), evidenceLockPath);
  const evidenceIr = validateEvidenceIr(JSON.parse(evidenceIrSource), evidenceIrPath);
  const retrieval = validateRetrievalBuildLock(JSON.parse(retrievalSource), retrievalLockPath);
  const profile = validateRetrievalProfileLock(JSON.parse(profileSource), profilePath);
  const artifactTreeDigest = stableHash(artifactTree);
  const artifactManifestPath = path.join(retrievalPath, DKB_ARTIFACT_MANIFEST_FILENAME);
  const artifactManifest = validateArtifactManifest(JSON.parse(await fs.readFile(artifactManifestPath, 'utf8')), artifactManifestPath);

  if (evidence.package.id !== retrieval.package.id
    || evidence.package.version !== retrieval.package.version
    || retrieval.package.version !== selection.version
    || evidence.evidenceProfileDigest !== selection.evidenceProfileDigest
    || evidence.evidenceDigest !== selection.evidenceDigest
    || retrieval.retrievalProfileDigest !== selection.retrievalProfileDigest
    || retrieval.retrievalBuildDigest !== selection.retrievalBuildDigest) {
    throw new DkbError(`Stored Build selection does not match ${retrieval.package.id}@${retrieval.package.version}`);
  }
  if (artifactTreeDigest !== retrieval.artifactTreeDigest) {
    throw new DkbError(`Retrieval Build ${retrieval.retrievalBuildDigest} artifact tree mismatch: expected ${retrieval.artifactTreeDigest}, got ${artifactTreeDigest}`);
  }
  if (artifactManifest.package.id !== retrieval.package.id
    || artifactManifest.package.version !== retrieval.package.version
    || artifactManifest.evidenceDigest !== retrieval.evidenceDigest
    || artifactManifest.retrievalProfileDigest !== retrieval.retrievalProfileDigest
    || artifactManifest.compatibilityDigest !== retrieval.compatibilityDigest
    || stableHash(artifactManifest.files) !== artifactTreeDigest) {
    throw new DkbError(`Retrieval Build ${retrieval.retrievalBuildDigest} generic artifact manifest does not match its lock`);
  }
  if (profile.profileDigest !== retrieval.retrievalProfileDigest
    || profile.compatibilityDigest !== retrieval.compatibilityDigest
    || profile.profile.evidence.profileDigest !== retrieval.evidenceProfileDigest) {
    throw new DkbError(`Retrieval Build ${retrieval.retrievalBuildDigest} profile receipt does not match its immutable build graph`);
  }
  assertEvidenceLayer(evidence, evidenceIr);
  if (retrieval.evidenceReceiptDigest !== evidenceBuildReceiptDigest(evidence)) {
    throw new DkbError(`Retrieval Build ${retrieval.retrievalBuildDigest} Evidence receipt mismatch`);
  }
  assertProviderExecutionIdentities(evidence.providerReceipts, profile, 'evidence');
  assertProviderExecutionIdentities(retrieval.providerReceipts, profile, 'retrieval');

  return { evidence, retrieval, profile, selection, evidencePath, retrievalPath };
}

export async function selectStoredPackageBuild(input: {
  root: string;
  target: string;
  evidenceProfileDigest: string;
  retrievalProfileDigest: string;
  compatibilityDigest: string;
}): Promise<DkbStoredPackageBuildGraph> {
  const builds = await listPackageBuilds(input.root);
  const selected = builds.retrieval.filter((build) => build.profileDigest === input.retrievalProfileDigest);
  if (selected.length === 0) throw new DkbError(`No stored Retrieval Build exists for pipeline ${input.target} (${input.retrievalProfileDigest})`);
  if (selected.length > 1) throw new DkbError(`Package has multiple Retrieval Builds for exact profile ${input.retrievalProfileDigest}; immutable compilation is non-deterministic`);
  const retrievalPath = selected[0]!.path;
  const retrievalLockPath = path.join(retrievalPath, DKB_RETRIEVAL_BUILD_LOCK);
  const retrieval = validateRetrievalBuildLock(JSON.parse(await fs.readFile(retrievalLockPath, 'utf8')), retrievalLockPath);
  const selection: DkbRuntimeActivationEntry = {
    version: retrieval.package.version,
    evidenceProfileDigest: retrieval.evidenceProfileDigest,
    evidenceDigest: retrieval.evidenceDigest,
    retrievalProfileDigest: retrieval.retrievalProfileDigest,
    retrievalBuildDigest: retrieval.retrievalBuildDigest,
  };
  const graph = await validateStoredPackageBuild(input.root, selection);
  if (graph.evidence.evidenceProfileDigest !== input.evidenceProfileDigest
    || graph.retrieval.compatibilityDigest !== input.compatibilityDigest) {
    throw new DkbError(`Stored Retrieval Build ${graph.retrieval.retrievalBuildDigest} does not satisfy pipeline ${input.target}`);
  }
  return graph;
}

export async function listPackageBuilds(root: string): Promise<DkbBuildList> {
  const resolvedRoot = path.resolve(root);
  const evidence = await scanDigestBuilds(resolveFrom(resolvedRoot, DKB_EVIDENCE_BUILDS_DIR), (profile, digest) => {
    const profileDigest = `sha256:${profile}`;
    const evidenceDigest = `sha256:${digest}`;
    return {
      profileDigest,
      evidenceDigest,
      path: evidenceBuildPath(resolvedRoot, profileDigest, evidenceDigest),
    };
  });
  const retrieval = await scanDigestBuilds(resolveFrom(resolvedRoot, DKB_RETRIEVAL_BUILDS_DIR), (profile, digest) => {
    const profileDigest = `sha256:${profile}`;
    const buildDigest = `sha256:${digest}`;
    return {
      profileDigest,
      buildDigest,
      path: retrievalBuildPath(resolvedRoot, profileDigest, buildDigest),
    };
  });

  return { root: resolvedRoot, evidence, retrieval };
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
      active: false,
    };
  }
  const retrieval = builds.retrieval.find((item) => item.buildDigest === normalized || item.profileDigest === normalized);
  if (retrieval) {
    const lockPath = path.join(retrieval.path, DKB_RETRIEVAL_BUILD_LOCK);
    return {
      kind: 'retrieval',
      lock: validateRetrievalBuildLock(JSON.parse(await fs.readFile(lockPath, 'utf8')), lockPath),
      path: retrieval.path,
      active: false,
    };
  }
  throw new DkbError(`No Evidence or Retrieval Build matches ${normalized} at ${path.resolve(root)}`);
}

export async function prunePackageBuilds(root: string, retainedDigests: ReadonlySet<string> = new Set()): Promise<{ removed: string[]; retained: string[] }> {
  const builds = await listPackageBuilds(root);
  const removed: string[] = [];
  const retained: string[] = [];

  for (const build of [...builds.evidence, ...builds.retrieval]) {
    const digest = 'evidenceDigest' in build ? build.evidenceDigest : build.buildDigest;
    if (retainedDigests.size === 0 || retainedDigests.has(digest)) {
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
  return withDkbFileLock(destinationRoot, 'build-promotion', () => mergeStoredPackageBuildsUnlocked(sourceRoot, destinationRoot));
}

/** Merge immutable builds while the caller owns the package build-promotion lock. */
export async function mergeStoredPackageBuildsWithinMutation(sourceRoot: string, destinationRoot: string): Promise<{
  copied: string[];
  reused: string[];
}> {
  return mergeStoredPackageBuildsUnlocked(sourceRoot, destinationRoot);
}

async function mergeStoredPackageBuildsUnlocked(sourceRoot: string, destinationRoot: string): Promise<{
  copied: string[];
  reused: string[];
}> {
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(destinationRoot);
  const builds = await listPackageBuilds(source);
  const copied: string[] = [];
  const reused: string[] = [];
  const staged: Array<{ path: string; target: string }> = [];
  const stamp = `${process.pid}-${Date.now().toString(36)}`;

  try {
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
      const stagedPath = `${target}.stage-${stamp}-${staged.length}`;
      await fs.rm(stagedPath, { recursive: true, force: true });
      staged.push({ path: stagedPath, target });
      await cloneTree(build.path, stagedPath);
    }

    for (const item of staged) {
      await fs.mkdir(path.dirname(item.target), { recursive: true });
      await fs.rename(item.path, item.target);
      copied.push(item.target);
    }
    return { copied, reused };
  } catch (error) {
    await Promise.all(copied.map((target) => fs.rm(target, { recursive: true, force: true })));
    throw error;
  } finally {
    await Promise.all(staged.map((item) => fs.rm(item.path, { recursive: true, force: true })));
  }
}

export async function writePackageBuildGraph(input: {
  root: string;
  package: { id: string; version: string; sourceDigest: string };
  evidence: DkbEvidenceIr;
  evidenceProviderReceipts: DkbProviderExecutionReceipt[];
  retrievalProviderReceipts: DkbProviderExecutionReceipt[];
  retrievalProfile: DkbRetrievalProfileLock;
  artifactsRoot: string;
  target: string;
  generation?: number;
  generatedAt?: string;
}): Promise<DkbPackageBuildGraph> {
  const root = path.resolve(input.root);
  const evidence = validateEvidenceIr(input.evidence);
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  assertProviderExecutionIdentities(input.evidenceProviderReceipts, input.retrievalProfile, 'evidence');
  assertProviderExecutionIdentities(input.retrievalProviderReceipts, input.retrievalProfile, 'retrieval');
  const evidenceLock = evidenceBuildLock({
    package: input.package,
    evidenceProfileDigest: evidence.evidenceProfileDigest,
    evidenceDigest: evidence.evidenceDigest,
    recordCount: evidence.evidence.length,
    chunkCount: evidence.chunks.length,
    providerReceipts: input.evidenceProviderReceipts,
    generatedAt,
  });
  const evidencePath = evidenceBuildPath(root, evidence.evidenceProfileDigest, evidence.evidenceDigest);
  const stagedEvidence = `${evidencePath}.stage-${process.pid}-${Date.now().toString(36)}`;

  await fs.rm(stagedEvidence, { recursive: true, force: true });
  await fs.mkdir(stagedEvidence, { recursive: true });
  await writeJson(path.join(stagedEvidence, DKB_EVIDENCE_BUILD_IR), evidence);
  await materializeEvidenceCatalog(stagedEvidence, evidence);
  await writeJson(path.join(stagedEvidence, DKB_EVIDENCE_BUILD_LOCK), evidenceLock);
  await promoteImmutableDirectory(stagedEvidence, evidencePath, DKB_EVIDENCE_BUILD_LOCK, validateEvidenceBuildLock);

  const artifactTree = await treeReceipt(input.artifactsRoot, isRetrievalArtifact);
  const partialRetrieval = {
    package: { id: input.package.id, version: input.package.version },
    evidenceProfileDigest: evidence.evidenceProfileDigest,
    evidenceDigest: evidence.evidenceDigest,
    retrievalProfileDigest: input.retrievalProfile.profileDigest,
    evidenceReceiptDigest: evidenceBuildReceiptDigest(evidenceLock),
    compatibilityDigest: input.retrievalProfile.compatibilityDigest,
    artifactTreeDigest: stableHash(artifactTree),
    providerReceipts: input.retrievalProviderReceipts,
    generatedAt,
  };
  const retrievalLock = retrievalBuildLock(partialRetrieval);
  const retrievalPath = retrievalBuildPath(root, input.retrievalProfile.profileDigest, retrievalLock.retrievalBuildDigest);
  const stagedRetrieval = `${retrievalPath}.stage-${process.pid}-${Date.now().toString(36)}`;

  await fs.rm(stagedRetrieval, { recursive: true, force: true });
  await fs.mkdir(stagedRetrieval, { recursive: true });
  await cloneTree(input.artifactsRoot, path.join(stagedRetrieval, DKB_RETRIEVAL_BUILD_ARTIFACTS), isRetrievalArtifact);
  const artifactManifest: DkbArtifactManifest = validateArtifactManifest({
    format: DKB_ARTIFACT_MANIFEST_FORMAT,
    package: { id: input.package.id, version: input.package.version },
    evidenceDigest: evidence.evidenceDigest,
    retrievalProfileDigest: input.retrievalProfile.profileDigest,
    compatibilityDigest: input.retrievalProfile.compatibilityDigest,
    index: input.retrievalProfile.profile.index,
    files: artifactTree,
    generatedAt,
  });
  await writeJson(path.join(stagedRetrieval, DKB_ARTIFACT_MANIFEST_FILENAME), artifactManifest);
  await writeJson(path.join(stagedRetrieval, DKB_RETRIEVAL_BUILD_LOCK), retrievalLock);
  await writeJson(path.join(stagedRetrieval, DKB_RETRIEVAL_BUILD_PROFILE_LOCK), input.retrievalProfile);
  await promoteImmutableDirectory(stagedRetrieval, retrievalPath, DKB_RETRIEVAL_BUILD_LOCK, validateRetrievalBuildLock);

  const selection: DkbRuntimeActivationEntry = {
    version: input.package.version,
    evidenceProfileDigest: evidence.evidenceProfileDigest,
    evidenceDigest: evidence.evidenceDigest,
    retrievalProfileDigest: input.retrievalProfile.profileDigest,
    retrievalBuildDigest: retrievalLock.retrievalBuildDigest,
  };
  return { evidence: evidenceLock, retrieval: retrievalLock, profile: input.retrievalProfile, selection, evidencePath, retrievalPath };
}

export async function validatePackageBuildGraph(root: string, selected?: DkbRuntimeActivationEntry): Promise<DkbPackageBuildGraph> {
  const entry = selected ?? await unambiguousPackageSelection(root);
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
  const profilePath = path.join(retrievalPath, DKB_RETRIEVAL_BUILD_PROFILE_LOCK);
  const profile = validateRetrievalProfileLock(JSON.parse(await fs.readFile(profilePath, 'utf8')), profilePath);
  const artifactTreeDigest = stableHash(await treeReceipt(path.join(retrievalPath, DKB_RETRIEVAL_BUILD_ARTIFACTS)));
  const artifactManifestPath = path.join(retrievalPath, DKB_ARTIFACT_MANIFEST_FILENAME);
  const artifactManifest = validateArtifactManifest(JSON.parse(await fs.readFile(artifactManifestPath, 'utf8')), artifactManifestPath);

  if (artifactTreeDigest !== retrieval.artifactTreeDigest) {
    throw new DkbError(`Retrieval Build ${retrieval.retrievalBuildDigest} artifact tree mismatch: expected ${retrieval.artifactTreeDigest}, got ${artifactTreeDigest}`);
  }
  if (artifactManifest.package.id !== retrieval.package.id
    || artifactManifest.package.version !== retrieval.package.version
    || artifactManifest.evidenceDigest !== retrieval.evidenceDigest
    || artifactManifest.retrievalProfileDigest !== retrieval.retrievalProfileDigest
    || artifactManifest.compatibilityDigest !== retrieval.compatibilityDigest
    || stableHash(artifactManifest.files) !== artifactTreeDigest) {
    throw new DkbError(`Retrieval Build ${retrieval.retrievalBuildDigest} generic artifact manifest does not match its lock`);
  }
  if (evidence.evidenceDigest !== retrieval.evidenceDigest || evidence.evidenceProfileDigest !== retrieval.evidenceProfileDigest) {
    throw new DkbError(`Retrieval Build ${retrieval.retrievalBuildDigest} is attached to the wrong Evidence Build`);
  }
  if (profile.profileDigest !== retrieval.retrievalProfileDigest
    || profile.compatibilityDigest !== retrieval.compatibilityDigest
    || profile.profile.evidence.profileDigest !== retrieval.evidenceProfileDigest) {
    throw new DkbError(`Retrieval Build ${retrieval.retrievalBuildDigest} profile receipt does not match its immutable build graph`);
  }
  assertEvidenceLayer(evidence, evidenceIr);
  if (retrieval.evidenceReceiptDigest !== evidenceBuildReceiptDigest(evidence)) {
    throw new DkbError(`Retrieval Build ${retrieval.retrievalBuildDigest} Evidence receipt mismatch`);
  }
  assertProviderExecutionIdentities(evidence.providerReceipts, profile, 'evidence');
  assertProviderExecutionIdentities(retrieval.providerReceipts, profile, 'retrieval');

  return { evidence, retrieval, profile, selection: entry, evidencePath, retrievalPath };
}

async function unambiguousPackageSelection(root: string): Promise<DkbRuntimeActivationEntry> {
  const builds = await listPackageBuilds(root);
  if (builds.retrieval.length !== 1) {
    throw new DkbError(
      `Package build graph at ${path.resolve(root)} has ${builds.retrieval.length} Retrieval Builds. `
      + 'Select an exact Runtime activation entry before validating a multi-build package.',
    );
  }
  const lockPath = path.join(builds.retrieval[0]!.path, DKB_RETRIEVAL_BUILD_LOCK);
  const retrieval = validateRetrievalBuildLock(JSON.parse(await fs.readFile(lockPath, 'utf8')), lockPath);
  return {
    version: retrieval.package.version,
    evidenceProfileDigest: retrieval.evidenceProfileDigest,
    evidenceDigest: retrieval.evidenceDigest,
    retrievalProfileDigest: retrieval.retrievalProfileDigest,
    retrievalBuildDigest: retrieval.retrievalBuildDigest,
  };
}

export async function readEvidenceBuild(evidenceRoot: string): Promise<DkbEvidenceIr> {
  const target = path.join(path.resolve(evidenceRoot), DKB_EVIDENCE_BUILD_IR);
  return validateEvidenceIr(JSON.parse(await fs.readFile(target, 'utf8')), target);
}

export async function readRetrievalBuildProfile(retrievalRoot: string): Promise<DkbRetrievalProfileLock> {
  const target = path.join(path.resolve(retrievalRoot), DKB_RETRIEVAL_BUILD_PROFILE_LOCK);
  return validateRetrievalProfileLock(JSON.parse(await fs.readFile(target, 'utf8')), target);
}

/**
 * Validate the active, immutable Evidence/Retrieval Build chain for a package.
 * This is the provider-neutral package verification boundary used by the CLI,
 * Runtime, and archive transport.
 */
export async function validateCompiledPackage(root: string): Promise<ValidatePackageBuildResult> {
  const resolvedRoot = path.resolve(root);
  let graph: DkbPackageBuildGraph;

  try {
    graph = await validatePackageBuildGraph(resolvedRoot);
  } catch (error) {
    return {
      ok: false,
      root: resolvedRoot,
      manifestPath: '',
      checks: [{
        name: 'build.graph',
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      }],
    };
  }

  const manifestPath = path.join(graph.retrievalPath, DKB_ARTIFACT_MANIFEST_FILENAME);
  const manifest = validateArtifactManifest(
    JSON.parse(await fs.readFile(manifestPath, 'utf8')),
    manifestPath,
  );
  const checks = [
    {
      name: 'build.graph',
      ok: true,
      detail: `${graph.evidence.evidenceDigest} -> ${graph.retrieval.retrievalBuildDigest}`,
    },
    {
      name: 'evidence.catalog',
      ok: true,
      detail: `${graph.evidence.recordCount} records, ${graph.evidence.chunkCount} chunks`,
    },
    {
      name: 'retrieval.artifacts',
      ok: true,
      detail: `${manifest.files.length} files (${graph.retrieval.artifactTreeDigest})`,
    },
  ];

  return { ok: true, root: resolvedRoot, manifestPath, manifest, graph, checks };
}

/** Verify every immutable Evidence/Retrieval Build stored by this knowledge root. */
export async function verifyKnowledgeBuilds(root: string): Promise<DkbKnowledgeBuildVerification> {
  const resolvedRoot = path.resolve(root);
  const manifest = await loadManifest(resolvedRoot);
  const type = manifest.type;
  const lockPath = resolveFrom(resolvedRoot, '.dkb/builds');
  if (type === 'dkb') {
    const checks = await verifyAllStoredBuilds(resolvedRoot, manifest.name);
    return { ok: checks.every((check) => check.ok), root: resolvedRoot, type, lockPath, checks };
  }

  const dkbs = type === 'library'
    ? await loadLibrary(resolvedRoot).then((library) => uniqueLoadedDkbs([
      ...library.collections.flatMap((collection) => collection.dkbs),
      ...library.dkbs,
    ]))
    : await loadCollection(resolvedRoot).then((collection) => uniqueLoadedDkbs(collection.dkbs));
  const checks: DkbKnowledgeBuildVerification['checks'] = [];
  for (const dkb of dkbs) {
    checks.push(...await verifyAllStoredBuilds(dkb.root, dkb.manifest.id));
  }

  return { ok: checks.every((check) => check.ok), root: resolvedRoot, type, lockPath, checks };
}

async function verifyAllStoredBuilds(root: string, packageId: string): Promise<DkbKnowledgeBuildVerification['checks']> {
  const builds = await listPackageBuilds(root);
  if (builds.retrieval.length === 0) {
    return [{ name: `build.${packageId}`, ok: false, detail: 'No Retrieval Builds are stored' }];
  }
  return Promise.all(builds.retrieval.map(async (build) => {
    try {
      const lockPath = path.join(build.path, DKB_RETRIEVAL_BUILD_LOCK);
      const retrieval = validateRetrievalBuildLock(JSON.parse(await fs.readFile(lockPath, 'utf8')), lockPath);
      const graph = await validateStoredPackageBuild(root, {
        version: retrieval.package.version,
        evidenceProfileDigest: retrieval.evidenceProfileDigest,
        evidenceDigest: retrieval.evidenceDigest,
        retrievalProfileDigest: retrieval.retrievalProfileDigest,
        retrievalBuildDigest: retrieval.retrievalBuildDigest,
      });
      return {
        name: `build.${packageId}.${retrieval.retrievalBuildDigest.slice(7, 19)}`,
        ok: true,
        detail: `${graph.evidence.evidenceDigest} -> ${graph.retrieval.retrievalBuildDigest}`,
      };
    } catch (error) {
      return {
        name: `build.${packageId}.${build.buildDigest.slice(7, 19)}`,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }));
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
    DKB_ARTIFACT_MANIFEST_FILENAME,
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

function normalizeDigest(value: string): string {
  const normalized = value.startsWith('sha256:') ? value.toLowerCase() : `sha256:${value.toLowerCase()}`;
  if (!/^sha256:[a-f0-9]{64}$/u.test(normalized)) throw new DkbError(`Build digest must be sha256:<64 hex characters>`);
  return normalized;
}

function isRetrievalArtifact(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  return normalized !== DKB_EVIDENCE_BUILD_IR;
}
