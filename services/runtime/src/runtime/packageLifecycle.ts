import fs from 'node:fs/promises';
import path from 'node:path';
import { refreshRuntimeCatalogFromInstalledArtifacts } from './catalog.js';
import { loadDkbPackage } from '@sjshovan/dkb-protocol/manifest.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { parseDkbIdentity, registryPackagePath } from '@sjshovan/dkb-protocol/identity.js';
import { progressFinish, progressStart, progressUpdate, type DkbProgressReporter } from '@sjshovan/dkb-protocol/progress.js';
import type { DkbPackageReceipt, LoadedDkb } from '@sjshovan/dkb-protocol/types.js';
import { applyLibraryLock, maybeReadLibraryLock, readLibraryState } from '@sjshovan/dkb-library/state.js';
import { syncLibrary } from '@sjshovan/dkb-library/resolver.js';
import { snapshotRuntimeReceipts } from '@sjshovan/dkb-library/runtimeSnapshot.js';
import {
  maybeReadRuntimeLock,
  validateCompiledPackage,
  validatePackageBuildGraph,
  writeRuntimeLock,
  type ValidatePackageBuildResult,
} from '@sjshovan/dkb-library/builds.js';
import { DKB_RUNTIME_LOCK_PATH } from '@sjshovan/dkb-protocol/paths.js';
import { DKB_RUNTIME_LOCK_FORMAT, type DkbRuntimeLock } from '@sjshovan/dkb-protocol/builds.js';
import { cleanupRuntimeIndexPackage, prepareRuntimeIndexPackage, verifyRuntimeIndex, type PreparedRuntimeIndexPackage } from '../providers/runtimeIndex.js';
import type { DkbIndexMutationResult } from '@sjshovan/dkb-pipeline/types.js';
import type { DkbRuntimeContext } from './context.js';
import {
  ensureRuntimeState,
  isEphemeralDkbStatePath,
  isRecord,
  maybeReadJsonObject,
  pathExists as exists,
  safeRuntimeId as safeId,
  writeJsonAtomic,
  type DkbRuntimePaths,
} from './paths.js';
import {
  closeRuntimeQuerySnapshot,
  invalidateRuntimeQuerySnapshot,
} from './querySnapshot.js';
import { installedDkbs, runtimeLibraryId } from './libraryState.js';

export interface ImportCompiledDkbArtifactOptions {
  runtime: DkbRuntimeContext;
  sourcePath: string;
  id?: string;
  force?: boolean;
  progress?: DkbProgressReporter;
  registryReceipt?: DkbPackageReceipt;
  archiveHash?: string;
}

export interface ImportCompiledDkbArtifactResult {
  status: 'imported_compiled_artifact';
  id: string;
  libraryPath: string;
  packagePath: string;
  validation: ValidatePackageBuildResult;
  catalog: Awaited<ReturnType<typeof refreshRuntimeCatalogFromInstalledArtifacts>>;
  search: {
    upsert: DkbIndexMutationResult;
    removedPrevious?: DkbIndexMutationResult;
  };
  warning?: string;
}

export async function importCompiledDkbArtifactIntoRuntime(
  options: ImportCompiledDkbArtifactOptions,
  stateRoot?: string,
): Promise<ImportCompiledDkbArtifactResult> {
  const paths = await ensureRuntimeState(stateRoot);
  const sourceRoot = path.resolve(options.sourcePath);

  if (!(await exists(sourceRoot))) {
    throw new DkbError(`Compiled artifact source does not exist: ${sourceRoot}`);
  }

  const sourceValidation = await validateCompiledPackage(sourceRoot);

  if (!sourceValidation.ok || !sourceValidation.manifest || !sourceValidation.graph) {
    throw new DkbError(`Compiled artifact validation failed at ${sourceRoot}`);
  }
  await validatePackageBuildGraph(sourceRoot);

  const sourceDkb = await loadDkbPackage(sourceRoot);
  const id = options.id ? parseDkbIdentity(options.id, 'Compiled DKB identity').identity : sourceDkb.manifest.id;
  if (id !== sourceDkb.manifest.id) {
    throw new DkbError(`Compiled DKB identity override ${id} does not match its manifest ${sourceDkb.manifest.id}.`);
  }
  const activeEntry = (await readLibraryState(paths.stateRoot)).entries[id];
  if (!options.registryReceipt && activeEntry?.source === 'registry') {
    throw new DkbError(`Cannot install local compiled DKB ${id}; that identity is owned by vendor/ in this Library.`);
  }
  if (options.registryReceipt && activeEntry?.source === 'local') {
    throw new DkbError(`Cannot install Registry DKB ${id}; that identity is owned by editable local source in this Library.`);
  }
  if (options.registryReceipt && (
    options.registryReceipt.package.id !== id
    || options.registryReceipt.package.version !== sourceDkb.manifest.version
  )) {
    throw new DkbError(`Registry receipt identity does not match compiled DKB ${id}@${sourceDkb.manifest.version}.`);
  }
  const packagePath = options.registryReceipt
    ? registryPackagePath(paths.stateRoot, id)
    : localEntryPath(paths.stateRoot, id);
  const existing = await maybeInstalledPackage(packagePath, id);
  await closeRuntimeQuerySnapshot(paths.stateRoot);
  const tempPath = await copyCompiledArtifactToInstallTemp(sourceRoot, paths, id);
  const libraryManifestPath = path.join(paths.stateRoot, 'dkb.json');
  const previousLibraryManifest = await fs.readFile(libraryManifestPath, 'utf8');
  const previousLibraryLock = await maybeReadLibraryLock(paths.stateRoot);
  const artifactSnapshot = await snapshotRuntimeReceipts(paths.stateRoot);
  let libraryActivated = false;
  let preparedIndex: PreparedRuntimeIndexPackage | null = null;
  let indexCommitted = false;

  try {
    const tempValidation = await validateCompiledPackage(tempPath);

    if (!tempValidation.ok || !tempValidation.graph) {
      throw new DkbError(`Copied compiled artifact validation failed at ${tempPath}`);
    }

    const stagedDkb = await loadDkbPackage(tempPath, id);
    const candidateGraph = await validatePackageBuildGraph(tempPath);
    const activeRuntimeLock = await maybeReadRuntimeLock(paths.stateRoot);
    if (activeRuntimeLock && (
      activeRuntimeLock.evidenceProfileDigest !== candidateGraph.runtime.evidenceProfileDigest
      || activeRuntimeLock.retrievalProfileDigest !== candidateGraph.runtime.retrievalProfileDigest
      || activeRuntimeLock.compatibilityDigest !== candidateGraph.runtime.compatibilityDigest
    )) {
      throw new DkbError(
        `Build-space mismatch for ${stagedDkb.manifest.id}@${stagedDkb.manifest.version}: `
        + `the Library is active on ${activeRuntimeLock.retrievalProfileDigest}, but the package provides ${candidateGraph.runtime.retrievalProfileDigest}. `
        + 'Build or fetch the active pipeline before installing.',
      );
    }
    const sameVersionReplacement = existing?.dkb.manifest.version === stagedDkb.manifest.version;

    if (sameVersionReplacement
      && existing.validation?.graph?.retrieval.artifactTreeDigest !== tempValidation.graph.retrieval.artifactTreeDigest) {
      throw new DkbError(`Cannot atomically replace ${id}@${stagedDkb.manifest.version} with different compiled content. Bump the DKB version before updating.`);
    }

    const registryId = await runtimeLibraryId(paths);
    preparedIndex = await prepareRuntimeIndexPackage({ runtime: options.runtime, libraryRoot: paths.stateRoot, libraryId: registryId, dkb: stagedDkb });
    let finalValidation: ValidatePackageBuildResult | undefined;
    let catalog: Awaited<ReturnType<typeof refreshRuntimeCatalogFromInstalledArtifacts>> | undefined;
    let searchUpsert: DkbIndexMutationResult | undefined;
    let removedPrevious: DkbIndexMutationResult | undefined;

    const activationTotal = 4;

    options.progress?.(progressStart({
      phase: 'activate',
      label: 'Activate package',
      total: activationTotal,
      unit: 'steps',
    }));

    await promotePackagePath(tempPath, packagePath, options.force, async () => {
      options.progress?.(progressUpdate({
        phase: 'activate',
        label: 'Activate package',
        value: 1,
        total: activationTotal,
        unit: 'steps',
      }));
      finalValidation = await validateCompiledPackage(packagePath);

      if (!finalValidation.ok) {
        throw new DkbError(`Installed compiled artifact validation failed at ${packagePath}`);
      }

      libraryActivated = true;
      if (options.registryReceipt) {
        await activateRegistryImport(
          paths.stateRoot,
          options.registryReceipt,
          path.relative(paths.stateRoot, packagePath).replace(/\\/gu, '/'),
          options.archiveHash,
        );
      } else {
        await activateLocalImports(paths.stateRoot, [id]);
      }

      options.progress?.(progressUpdate({
        phase: 'activate',
        label: 'Activate package',
        value: 2,
        total: activationTotal,
        unit: 'steps',
      }));
      catalog = await refreshRuntimeCatalogFromInstalledArtifacts(paths.stateRoot);
      invalidateRuntimeQuerySnapshot(paths.stateRoot);
      options.progress?.(progressUpdate({
        phase: 'activate',
        label: 'Activate package',
        value: 3,
        total: activationTotal,
        unit: 'steps',
      }));
      searchUpsert = await verifyRuntimeIndex({
        runtime: options.runtime,
        libraryRoot: paths.stateRoot,
        libraryId: registryId,
        packageId: stagedDkb.manifest.id,
        packageVersion: stagedDkb.manifest.version,
      }) ?? preparedIndex!.installed ?? {
        indexId: preparedIndex!.providerId,
        documentCount: preparedIndex!.validation.documentCount,
        status: 'ready',
      };
      await writeRuntimeLock(paths.stateRoot, mergedRuntimeLock(activeRuntimeLock, candidateGraph.runtime, stagedDkb.manifest.id));
      options.progress?.(progressUpdate({
        phase: 'activate',
        label: 'Activate package',
        value: 4,
        total: activationTotal,
        unit: 'steps',
      }));
    });
    options.progress?.(progressFinish({
      phase: 'activate',
      label: 'Activate package',
      total: activationTotal,
      unit: 'steps',
    }));

    if (existing && existing.dkb.manifest.version !== stagedDkb.manifest.version) {
      removedPrevious = await cleanupRuntimeIndexPackage({
        runtime: options.runtime,
        libraryRoot: paths.stateRoot,
        libraryId: registryId,
        packageId: existing.dkb.manifest.id,
        packageVersion: existing.dkb.manifest.version,
      }) ?? undefined;
    }
    indexCommitted = true;
    invalidateRuntimeQuerySnapshot(paths.stateRoot);
    await artifactSnapshot.commit();

    return {
      status: 'imported_compiled_artifact',
      id,
      libraryPath: paths.stateRoot,
      packagePath,
      validation: finalValidation!,
      catalog: catalog!,
      search: {
        upsert: searchUpsert!,
        removedPrevious,
      },
      ...(removedPrevious?.warning ? { warning: removedPrevious.warning } : {}),
    };
  } catch (error) {
    if (!indexCommitted) {
      await preparedIndex?.rollback().catch(() => undefined);
    }
    await fs.rm(tempPath, { recursive: true, force: true });
    if (libraryActivated) {
      await fs.writeFile(libraryManifestPath, previousLibraryManifest, 'utf8').catch(() => undefined);
      if (previousLibraryLock) {
        await applyLibraryLock(paths.stateRoot, previousLibraryLock).catch(() => undefined);
      } else {
        const manifest = await maybeReadJsonObject(libraryManifestPath);
        await applyLibraryLock(paths.stateRoot, {
          library: { name: String(manifest?.name ?? 'DKB Library') },
          generation: 0,
          entries: {},
          resolvedAt: new Date().toISOString(),
        }).catch(() => undefined);
        await fs.rm(path.join(paths.stateRoot, 'dkb-lock.json'), { force: true }).catch(() => undefined);
      }
    }
    await artifactSnapshot.rollback().catch(() => undefined);
    invalidateRuntimeQuerySnapshot(paths.stateRoot);
    throw error;
  }
}

export async function removeDkbFromRuntime(
  id: string,
  stateRoot: string | undefined,
  options: { runtime: DkbRuntimeContext; progress?: DkbProgressReporter },
) {
  const paths = await ensureRuntimeState(stateRoot);
  parseDkbIdentity(id, 'DKB identity');
  const state = await readLibraryState(paths.stateRoot);
  const stateEntry = state.entries[id];

  if (!stateEntry || stateEntry.kind !== 'dkb') {
    throw new DkbError(`Runtime DKB is not installed: ${id}`);
  }
  const blockers = stateEntry.requiredBy.filter((requirement) => requirement !== `root:${id}`);
  if (blockers.length > 0) {
    throw new DkbError(`Cannot uninstall ${id}; it is required by ${blockers.join(', ')}`);
  }
  const packageRoots = stateEntry.source === 'registry'
    ? [path.resolve(paths.stateRoot, stateEntry.path)]
    : [];

  const registryId = await runtimeLibraryId(paths);
  const installed = (await installedDkbs(paths)).find((dkb) => dkb.manifest.id === id);

  if (!installed) {
    throw new DkbError(`Runtime DKB content is unavailable: ${id}`);
  }
  const total = packageRoots.length + 3;
  let completed = 0;
  const uninstallRoot = path.join(paths.stateDir, 'tmp', `uninstall-${safeId(id)}-${process.pid}-${Date.now().toString(36)}`);
  const stagedPackages: Array<{ originalPath: string; stagedPath: string }> = [];
  let activation: { rollback: () => Promise<void> } | null = null;
  const artifactSnapshot = await snapshotRuntimeReceipts(paths.stateRoot);

  try {
    options.progress?.(progressStart({
      phase: 'uninstall',
      label: 'Uninstall package',
      total,
      unit: 'steps',
    }));

    await closeRuntimeQuerySnapshot(paths.stateRoot);
    await fs.mkdir(uninstallRoot, { recursive: true });

    for (const [index, packagePath] of packageRoots.entries()) {
      const stagedPath = path.join(uninstallRoot, `${index}-${path.basename(packagePath)}`);

      await fs.rename(packagePath, stagedPath);
      stagedPackages.push({ originalPath: packagePath, stagedPath });
      completed += 1;
      options.progress?.(progressUpdate({
        phase: 'uninstall',
        label: 'Uninstall package',
        value: completed,
        total,
        unit: 'steps',
      }));
    }

    activation = await removeRuntimeDependencyEntries(paths.stateRoot, id);
    completed += 1;
    options.progress?.(progressUpdate({
      phase: 'uninstall',
      label: 'Uninstall package',
      value: completed,
      total,
      unit: 'steps',
    }));
    const catalog = await refreshRuntimeCatalogFromInstalledArtifacts(paths.stateRoot);
    completed += 1;
    options.progress?.(progressUpdate({
      phase: 'uninstall',
      label: 'Uninstall package',
      value: completed,
      total,
      unit: 'steps',
    }));
    const removedIndex = await cleanupRuntimeIndexPackage({
      runtime: options.runtime,
      libraryRoot: paths.stateRoot,
      libraryId: registryId,
      packageId: installed.manifest.id,
      packageVersion: installed.manifest.version,
    });
    const remaining = await verifyRuntimeIndex({ runtime: options.runtime, libraryRoot: paths.stateRoot, libraryId: registryId }).catch(() => null);
    const activeRuntimeLock = await maybeReadRuntimeLock(paths.stateRoot);
    if (activeRuntimeLock) {
      const packages = { ...activeRuntimeLock.packages };
      delete packages[id];
      if (Object.keys(packages).length === 0) {
        await fs.rm(path.join(paths.stateRoot, DKB_RUNTIME_LOCK_PATH), { force: true });
      } else {
        await writeRuntimeLock(paths.stateRoot, {
          ...activeRuntimeLock,
          packages,
          generation: activeRuntimeLock.generation + 1,
          generatedAt: new Date().toISOString(),
        });
      }
    }
    completed += 1;
    options.progress?.(progressUpdate({
      phase: 'uninstall',
      label: 'Uninstall package',
      value: completed,
      total,
      unit: 'steps',
    }));
    await fs.rm(uninstallRoot, { recursive: true, force: true });
    options.progress?.(progressFinish({
      phase: 'uninstall',
      label: 'Uninstall package',
      total,
      unit: 'steps',
    }));
    await artifactSnapshot.commit();

    return {
      status: 'removed',
      id,
      libraryPath: paths.stateRoot,
      search: {
        removed: removedIndex ? [removedIndex] : [],
        remaining,
      },
      ...(removedIndex?.warning ? { warning: removedIndex.warning } : {}),
    };
  } catch (error) {
    for (const item of stagedPackages.reverse()) {
      if (await exists(item.stagedPath) && !(await exists(item.originalPath))) {
        await fs.rename(item.stagedPath, item.originalPath).catch(() => undefined);
      }
    }
    await activation?.rollback().catch(() => undefined);
    await artifactSnapshot.rollback().catch(() => undefined);
    invalidateRuntimeQuerySnapshot(paths.stateRoot);
    throw error;
  }
}

function mergedRuntimeLock(active: DkbRuntimeLock | null, candidate: DkbRuntimeLock, packageId: string): DkbRuntimeLock {
  const entry = candidate.packages[packageId];
  if (!entry) throw new DkbError(`Candidate Runtime lock does not contain ${packageId}`);

  return {
    format: DKB_RUNTIME_LOCK_FORMAT,
    target: candidate.target,
    evidenceProfileDigest: candidate.evidenceProfileDigest,
    retrievalProfileDigest: candidate.retrievalProfileDigest,
    compatibilityDigest: candidate.compatibilityDigest,
    packages: {
      ...(active?.packages ?? {}),
      [packageId]: entry,
    },
    generation: (active?.generation ?? 0) + 1,
    generatedAt: new Date().toISOString(),
  };
}

export async function reloadRuntimeState(stateRoot?: string): Promise<{
  status: 'reloaded';
  libraryPath: string;
  closedContexts: number;
}> {
  const paths = await ensureRuntimeState(stateRoot);

  return {
    status: 'reloaded',
    libraryPath: paths.stateRoot,
    closedContexts: await closeRuntimeQuerySnapshot(paths.stateRoot),
  };
}

async function activateLocalImports(libraryRoot: string, identities: string[]): Promise<void> {
  const manifestPath = path.join(libraryRoot, 'dkb.json');
  const manifest = await maybeReadJsonObject(manifestPath);
  if (!manifest || manifest.type !== 'library') throw new DkbError(`Invalid DKB Library manifest at ${manifestPath}`);
  const roots = isRecord(manifest.roots) ? { ...manifest.roots } : {};

  for (const identity of identities) {
    const entryPath = localEntryPath(libraryRoot, identity);
    roots[identity] = { path: path.relative(libraryRoot, entryPath).replace(/\\/g, '/') };
  }

  await writeJsonAtomic(manifestPath, { ...manifest, roots });
  await syncLibrary(libraryRoot);
}

function localEntryPath(libraryRoot: string, identity: string): string {
  const parsed = parseDkbIdentity(identity, 'Local DKB identity');
  return path.join(libraryRoot, parsed.name);
}

async function maybeInstalledPackage(packagePath: string, id: string): Promise<{
  dkb: LoadedDkb;
  validation: ValidatePackageBuildResult | null;
} | null> {
  if (!(await exists(packagePath))) {
    return null;
  }

  const dkb = await loadDkbPackage(packagePath, id);
  const validation = await validateCompiledPackage(packagePath).catch(() => null);

  return { dkb, validation };
}

async function copyCompiledArtifactToInstallTemp(sourceRoot: string, paths: DkbRuntimePaths, id: string): Promise<string> {
  const tempRoot = path.join(paths.stateDir, 'tmp');
  const tempPath = path.join(tempRoot, `install-${safeId(id)}-${process.pid}-${Date.now().toString(36)}`);

  await fs.mkdir(tempRoot, { recursive: true });
  await fs.rm(tempPath, { recursive: true, force: true });
  await fs.cp(sourceRoot, tempPath, {
    recursive: true,
    filter: (source) => !isEphemeralDkbStatePath(sourceRoot, source),
  });

  return tempPath;
}

async function promotePackagePath<T>(
  tempPath: string,
  packagePath: string,
  force: boolean | undefined,
  validatePromotion: () => Promise<T>,
): Promise<T> {
  const backupPath = `${packagePath}.replace-${process.pid}-${Date.now().toString(36)}`;
  await fs.mkdir(path.dirname(packagePath), { recursive: true });

  if (await exists(packagePath)) {
    if (!force) {
      throw new DkbError(`Runtime DKB already exists: ${path.basename(packagePath)}. Use force to replace it.`);
    }

    await fs.rename(packagePath, backupPath);
  }

  try {
    await fs.rename(tempPath, packagePath);
    const result = await validatePromotion();
    await fs.rm(backupPath, { recursive: true, force: true });

    return result;
  } catch (error) {
    await fs.rm(packagePath, { recursive: true, force: true });

    if (await exists(backupPath)) {
      await fs.rename(backupPath, packagePath);
    }

    throw error;
  }

}

async function activateRegistryImport(
  root: string,
  receipt: DkbPackageReceipt,
  installedPath: string,
  archiveHash?: string,
): Promise<void> {
  const rootManifestPath = path.join(root, 'dkb.json');
  const rootManifest = await maybeReadJsonObject(rootManifestPath);
  if (!rootManifest || rootManifest.type !== 'library') {
    throw new DkbError(`Runtime Library manifest is invalid: ${rootManifestPath}`);
  }
  const identity = parseDkbIdentity(receipt.package.id, 'Registry DKB identity').identity;
  const receiptPackage = receipt.payload.lock.packages[identity];
  if (!receiptPackage) throw new DkbError(`Package receipt does not contain package lock entry: ${identity}`);
  const previousLock = await maybeReadLibraryLock(root);
  const now = new Date().toISOString();
  const roots = {
    ...(isRecord(rootManifest.roots) ? rootManifest.roots : {}),
    [identity]: { version: receipt.package.version },
  };

  await writeJsonAtomic(rootManifestPath, { ...rootManifest, roots });
  await applyLibraryLock(root, {
    library: {
      name: String(rootManifest.name),
      ...(previousLock?.library.retrievalProfileDigest
        ? { retrievalProfileDigest: previousLock.library.retrievalProfileDigest }
        : {}),
    },
    generation: (previousLock?.generation ?? 0) + 1,
    entries: {
      ...(previousLock?.entries ?? {}),
      [identity]: {
        identity,
        kind: 'dkb',
        source: 'registry',
        version: receipt.package.version,
        digest: receipt.payload.packageTreeHash ?? receipt.payloadHash ?? archiveHash ?? 'unknown',
        path: installedPath,
        requiredBy: [`root:${identity}`],
        installedAt: now,
      },
    },
    resolvedAt: now,
  });
}

async function removeRuntimeDependencyEntries(root: string, id: string): Promise<{ rollback: () => Promise<void> }> {
  const manifestPath = path.join(root, 'dkb.json');
  const manifest = await maybeReadJsonObject(manifestPath);

  if (!manifest || manifest.type !== 'library' || !isRecord(manifest.roots)) {
    throw new DkbError(`Invalid DKB Library manifest at ${manifestPath}`);
  }

  const previousManifest = await fs.readFile(manifestPath, 'utf8');
  const previousLock = await maybeReadLibraryLock(root);
  if (!previousLock?.entries[id]) {
    throw new DkbError(`Runtime DKB is not installed: ${id}`);
  }

  const roots = { ...manifest.roots as Record<string, unknown> };
  delete roots[id];
  const entries = { ...previousLock.entries };
  delete entries[id];
  const now = new Date().toISOString();
  const nextLock = {
    ...previousLock,
    generation: previousLock.generation + 1,
    entries,
    resolvedAt: now,
  };

  const rollback = async () => {
    await fs.writeFile(manifestPath, previousManifest, 'utf8');
    await applyLibraryLock(root, previousLock);
  };

  try {
    await fs.writeFile(manifestPath, `${JSON.stringify({ ...manifest, roots }, null, 2)}\n`, 'utf8');
    await applyLibraryLock(root, nextLock);
  } catch (error) {
    await rollback().catch(() => undefined);
    throw error;
  }

  return { rollback };
}
