import fs from 'node:fs/promises';
import path from 'node:path';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { loadCompose } from '@sjshovan/dkb-protocol/manifest.js';
import { DKB_COMPILE_RECEIPT_PATH, DKB_RUNTIME_LOCK_PATH, resolveFrom } from '@sjshovan/dkb-protocol/paths.js';
import { validateDkbLockManifest } from '@sjshovan/dkb-protocol/validation.js';
import type { DkbLockManifest, LoadedLibrary } from '@sjshovan/dkb-protocol/types.js';
import {
  DKB_EVIDENCE_BUILD_IR,
  validatePackageBuildGraph,
  type DkbPackageBuildGraph,
} from '@sjshovan/dkb-library/builds.js';
import { DKB_EVIDENCE_CATALOG_FILENAME } from '@sjshovan/dkb-protocol/evidence/catalog.js';
import { DKB_ARTIFACT_MANIFEST_FILENAME, validateArtifactManifest } from '@sjshovan/dkb-protocol/artifacts.js';
import { DKB_EVIDENCE_IR_FORMAT, validateEvidenceIr, type DkbEvidenceIr } from '@sjshovan/dkb-protocol/evidence/ir.js';
import { summarizeBuildStorage, summarizeEvidenceCorpus, type DkbSourceStatistics } from './buildStatistics.js';
import {
  COMPILE_CACHE_VERSION,
  hashString,
  maybeReadFile,
  quickArtifactSnapshotFor,
  readCompileCache,
  type QuickSourceSnapshot,
} from './compileCache.js';
import { collectRegistryStateForVerification } from './compilationState.js';
import type { CompiledComposeProject, VerifyComposeProjectResult } from './compilerContracts.js';
import type { RegistryCompileState } from './compilerState.js';
import { parseLock, uniqueDkbs } from './sourceHashing.js';

export async function verifyComposeProject(root: string): Promise<VerifyComposeProjectResult> {
  const resolvedRoot = path.resolve(root);
  const lockPath = resolveFrom(resolvedRoot, DKB_COMPILE_RECEIPT_PATH);
  const registry = await loadCompose(resolvedRoot);
  const current = await collectRegistryStateForVerification(registry);
  const lock = validateDkbLockManifest(parseLock(await fs.readFile(lockPath, 'utf8'), lockPath), lockPath);
  const expected = await lockForState(resolvedRoot, registry, current, lock.compiled?.compiledAt ?? new Date().toISOString());
  const buildChecks = await Promise.all(uniqueDkbs([
    ...registry.collections.flatMap((collection) => collection.dkbs),
    ...registry.dkbs,
  ]).map(async (dkb) => {
    try {
      const graph = await validatePackageBuildGraph(dkb.root);
      return {
        name: `build.${dkb.manifest.id}`,
        ok: graph.evidence.package.id === dkb.manifest.id && graph.evidence.package.version === dkb.manifest.version,
        detail: `${graph.evidence.evidenceDigest} -> ${graph.retrieval.retrievalBuildDigest}`,
      };
    } catch (error) {
      return { name: `build.${dkb.manifest.id}`, ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }));
  const checks = [
    {
      name: 'registry',
      ok: lock.registry.id === expected.registry.id,
      detail: `${lock.registry.id} expected ${expected.registry.id}`,
    },
    {
      name: 'packages',
      ok: stableHash(lock.packages) === stableHash(expected.packages),
      detail: packageVerificationDetail(lock.packages, expected.packages),
    },
    ...buildChecks,
  ];

  return { ok: checks.every((check) => check.ok), lockPath, checks };
}

export async function cachedCompileResultFor(
  root: string,
  registry: LoadedLibrary,
  sourceSnapshot: QuickSourceSnapshot,
  lockPath: string,
): Promise<CompiledComposeProject | null> {
  if (!sourceSnapshot.cacheable) return null;

  const [lockSource, cache] = await Promise.all([
    maybeReadFile(lockPath),
    readCompileCache(root),
  ]);
  if (!lockSource || !cache || cache.version !== COMPILE_CACHE_VERSION || cache.registryId !== registry.manifest.id) return null;
  if (cache.lockHash !== hashString(lockSource) || cache.sourceSnapshotHash !== sourceSnapshot.hash) return null;

  const artifactSnapshot = await quickArtifactSnapshotFor(root);
  if (!artifactSnapshot.requiredArtifactsReady || cache.artifactSnapshotHash !== artifactSnapshot.hash) return null;

  const dkbs = uniqueDkbs([...registry.collections.flatMap((collection) => collection.dkbs), ...registry.dkbs]);
  if (dkbs.length !== 1) return null;
  const graph = await validatePackageBuildGraph(dkbs[0]!.root).catch(() => null);
  if (!graph) return null;
  const lock = validateDkbLockManifest(parseLock(lockSource, lockPath), lockPath);

  return {
    registryId: lock.registry.id,
    recordCount: lock.compiled?.recordCount ?? Object.values(lock.packages).reduce((total, item) => total + item.recordCount, 0),
    evidenceCatalogPath: path.join(graph.evidencePath, DKB_EVIDENCE_CATALOG_FILENAME),
    retrievalManifestPath: path.join(graph.retrievalPath, DKB_ARTIFACT_MANIFEST_FILENAME),
    runtimeLockPath: resolveFrom(root, DKB_RUNTIME_LOCK_PATH),
    lockPath,
    lock,
    cacheHit: true,
  };
}

export async function writeCompileReceipt(target: string, lock: DkbLockManifest): Promise<void> {
  const temporary = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  await fs.rm(target, { force: true });
  await fs.rename(temporary, target);
}

export async function readCompileStatistics(root: string, source: DkbSourceStatistics) {
  try {
    const compose = await loadCompose(root);
    const dkbs = uniqueDkbs([
      ...compose.collections.flatMap((collection) => collection.dkbs),
      ...compose.dkbs,
    ]);
    const layers = await Promise.all(dkbs.map(async (dkb) => {
      const graph = await validatePackageBuildGraph(dkb.root);
      const evidencePath = path.join(graph.evidencePath, DKB_EVIDENCE_BUILD_IR);
      const manifestPath = path.join(graph.retrievalPath, DKB_ARTIFACT_MANIFEST_FILENAME);
      return {
        evidence: validateEvidenceIr(JSON.parse(await fs.readFile(evidencePath, 'utf8')), evidencePath),
        manifest: validateArtifactManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')), manifestPath),
        root: dkb.root,
      };
    }));
    const evidence = {
      format: layers[0]?.evidence.format ?? DKB_EVIDENCE_IR_FORMAT,
      evidenceProfileDigest: layers[0]?.evidence.evidenceProfileDigest ?? stableHash({ empty: true }),
      evidenceDigest: stableHash(layers.map((layer) => layer.evidence.evidenceDigest)),
      evidence: layers.flatMap((layer) => layer.evidence.evidence),
      chunks: layers.flatMap((layer) => layer.evidence.chunks),
    } as DkbEvidenceIr;

    return {
      corpus: summarizeEvidenceCorpus(evidence, source),
      storage: await summarizeBuildStorage(root, layers.map((layer) => layer.manifest), source.bytes, layers.map((layer) => layer.root)),
    };
  } catch {
    return null;
  }
}

export async function lockForState(
  root: string,
  registry: LoadedLibrary,
  state: RegistryCompileState,
  compiledAt: string,
  inputGraph?: DkbPackageBuildGraph,
): Promise<DkbLockManifest> {
  const packageDkbs = uniqueDkbs([
    ...registry.collections.flatMap((collection) => collection.dkbs),
    ...registry.dkbs,
  ]);
  const graph = inputGraph ?? (packageDkbs.length === 1 ? await validatePackageBuildGraph(packageDkbs[0]!.root) : undefined);
  const relative = (value: string) => value ? path.relative(root, value).replace(/\\/g, '/') : '';

  return {
    format: 'dkb.compile-receipt.v2',
    registry: {
      id: registry.manifest.id,
      name: registry.manifest.name,
      version: registry.manifest.version,
    },
    packages: state.packages,
    builds: {
      evidence: {
        path: relative(graph?.evidencePath ?? ''),
        profileDigest: graph?.evidence.evidenceProfileDigest ?? null,
        digest: graph?.evidence.evidenceDigest ?? null,
        status: graph ? 'built' : 'not_built',
      },
      retrieval: {
        path: relative(graph?.retrievalPath ?? ''),
        profileDigest: graph?.retrieval.retrievalProfileDigest ?? null,
        digest: graph?.retrieval.retrievalBuildDigest ?? null,
        compatibilityDigest: graph?.retrieval.compatibilityDigest ?? null,
        status: graph ? 'built' : 'not_built',
      },
      runtime: {
        path: DKB_RUNTIME_LOCK_PATH,
        target: graph?.runtime.target ?? '',
        digest: graph ? stableHash(graph.runtime) : null,
        status: graph ? 'built' : 'not_built',
      },
    },
    compiled: {
      recordCount: state.sourceUnits.length,
      compiledAt,
    },
  };
}

function packageVerificationDetail(
  locked: DkbLockManifest['packages'],
  current: DkbLockManifest['packages'],
): string {
  const differences: string[] = [];
  const packageIds = [...new Set([...Object.keys(locked), ...Object.keys(current)])].sort();
  for (const packageId of packageIds) {
    const lockedPackage = locked[packageId];
    const currentPackage = current[packageId];
    if (!lockedPackage || !currentPackage) {
      differences.push(`${packageId}:presence`);
      continue;
    }
    for (const field of Object.keys(lockedPackage) as Array<keyof typeof lockedPackage>) {
      if (stableHash(lockedPackage[field]) !== stableHash(currentPackage[field])) {
        differences.push(`${packageId}:${String(field)} (${String(lockedPackage[field])} != ${String(currentPackage[field])})`);
      }
    }
  }
  return differences.length > 0
    ? `package lock mismatch in ${differences.join(', ')}`
    : 'package manifest, source, and chunk hashes match lockfile';
}
