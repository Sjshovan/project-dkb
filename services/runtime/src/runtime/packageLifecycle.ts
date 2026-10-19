import fs from 'node:fs/promises';
import path from 'node:path';
import { validateCompiledPackage, type ValidatePackageBuildResult } from '@sjshovan/dkb-library/builds.js';
import { hashPortablePackageTree } from '@sjshovan/dkb-library/packageTree.js';
import { applyLibraryLock, maybeReadLibraryLock, readLibraryState } from '@sjshovan/dkb-library/state.js';
import { syncLibrary } from '@sjshovan/dkb-library/resolver.js';
import { assertLibraryMutation, promoteLibraryPath, removeLibraryPath, withLibraryMutation, writeLibraryMutationFile } from '@sjshovan/dkb-library/mutation.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { normalizeRegistryUrl } from '@sjshovan/dkb-registry-client/config.js';
import { parseDkbIdentity, registryPackagePath } from '@sjshovan/dkb-protocol/identity.js';
import { loadDkbPackage } from '@sjshovan/dkb-protocol/manifest.js';
import { progressFinish, progressStart, progressUpdate, type DkbProgressReporter } from '@sjshovan/dkb-protocol/progress.js';
import type { DkbPackageReceipt, LoadedDkb } from '@sjshovan/dkb-protocol/types.js';
import type { DkbIndexMutationResult } from '@sjshovan/dkb-pipeline/types.js';
import { verifyRuntimeIndex } from '../providers/runtimeIndex.js';
import type { ManagedIndexCleanup } from '../providers/managedIndexRetention.js';
import type { DkbRuntimeContext } from './context.js';
import { refreshRuntimeCatalogFromInstalledArtifacts } from './catalog.js';
import { ensureRuntimeState, type DkbRuntimeInstance } from './activation.js';
import { refreshRuntimeActivation } from './pipelineSwitch.js';
import { closeRuntimeQuerySnapshot, invalidateRuntimeQuerySnapshot } from './querySnapshot.js';
import {
  isEphemeralDkbStatePath,
  isRecord,
  maybeReadJsonObject,
  pathExists as exists,
  safeRuntimeId as safeId,
} from './paths.js';
import { installedDkbs, runtimeLibraryId } from './libraryState.js';

export interface ImportCompiledDkbArtifactOptions {
  runtime: DkbRuntimeContext;
  sourcePath: string;
  id?: string;
  force?: boolean;
  progress?: DkbProgressReporter;
  registryReceipt?: DkbPackageReceipt;
  registryUrl?: string;
  archiveHash?: string;
}

export type ImportCompiledDkbArtifactIntoLibraryOptions = Omit<ImportCompiledDkbArtifactOptions, 'runtime'>;

export interface ImportCompiledDkbArtifactIntoLibraryResult {
  status: 'installed_in_library';
  id: string;
  libraryPath: string;
  packagePath: string;
  validation: ValidatePackageBuildResult;
  replaced?: { id: string; version: string };
}

export interface ImportCompiledDkbArtifactResult {
  status: 'imported_compiled_artifact';
  id: string;
  libraryPath: string;
  packagePath: string;
  validation: ValidatePackageBuildResult;
  catalog: Awaited<ReturnType<typeof refreshRuntimeCatalogFromInstalledArtifacts>>;
  search: { upsert: DkbIndexMutationResult };
  indexCleanup?: ManagedIndexCleanup;
  warning?: string;
}

export async function importCompiledDkbArtifactIntoRuntime(
  options: ImportCompiledDkbArtifactOptions,
  stateRoot?: string,
): Promise<ImportCompiledDkbArtifactResult> {
  const runtime = await ensureRuntimeState(stateRoot);
  await closeRuntimeQuerySnapshot(runtime.stateRoot);
  const installed = await importCompiledDkbArtifactIntoLibrary(options, runtime.libraryRoot);
  let warning: string | undefined;
  let activation: Awaited<ReturnType<typeof refreshRuntimeActivation>> | null = null;
  try {
    activation = await refreshRuntimeActivation({ runtime: options.runtime, stateRoot: runtime.stateRoot });
    warning = activation.warning;
  } catch (error) {
    warning = `Library installation succeeded, but Runtime ${runtime.runtimeId} is stale: ${error instanceof Error ? error.message : String(error)}. Run dkb runtime refresh ${runtime.runtimeId}.`;
  }

  invalidateRuntimeQuerySnapshot(runtime.stateRoot);
  const refreshed = await ensureRuntimeState(runtime.stateRoot);
  const catalog = refreshed.activation
    ? await refreshRuntimeCatalogFromInstalledArtifacts(runtime.libraryRoot, refreshed.activation)
    : { recordCount: 0, packageCount: 0 };
  return {
    status: 'imported_compiled_artifact',
    id: installed.id,
    libraryPath: installed.libraryPath,
    packagePath: installed.packagePath,
    validation: installed.validation,
    catalog,
    search: {
      upsert: {
        indexId: activation?.target ?? runtime.target,
        documentCount: catalog.recordCount,
        status: 'ready',
        ...(warning ? { warning } : {}),
      },
    },
    ...(activation?.indexCleanup ? { indexCleanup: activation.indexCleanup } : {}),
    ...(warning ? { warning } : {}),
  };
}

export async function importCompiledDkbArtifactIntoLibrary(
  options: ImportCompiledDkbArtifactIntoLibraryOptions,
  libraryRoot: string,
): Promise<ImportCompiledDkbArtifactIntoLibraryResult> {
  const resolvedLibraryRoot = path.resolve(libraryRoot);
  return withLibraryMutation(resolvedLibraryRoot, () => importCompiledDkbArtifactIntoLibraryUnlocked(options, resolvedLibraryRoot));
}

/**
 * Imports a package as part of the caller's durable Library transaction.
 */
export async function importCompiledDkbArtifactIntoLibraryWithinMutation(
  options: ImportCompiledDkbArtifactIntoLibraryOptions,
  libraryRoot: string,
): Promise<ImportCompiledDkbArtifactIntoLibraryResult> {
  const root = path.resolve(libraryRoot);
  await assertLibraryMutation(root);
  return importCompiledDkbArtifactIntoLibraryUnlocked(options, root);
}

async function importCompiledDkbArtifactIntoLibraryUnlocked(
  options: ImportCompiledDkbArtifactIntoLibraryOptions,
  libraryRoot: string,
): Promise<ImportCompiledDkbArtifactIntoLibraryResult> {
  const sourceRoot = path.resolve(options.sourcePath);
  if (!(await exists(sourceRoot))) throw new DkbError(`Compiled artifact source does not exist: ${sourceRoot}`);

  const sourceValidation = await validateCompiledPackage(sourceRoot);
  if (!sourceValidation.ok || !sourceValidation.manifest || !sourceValidation.graph) {
    throw new DkbError(`Compiled artifact validation failed at ${sourceRoot}`);
  }
  const sourceDkb = await loadDkbPackage(sourceRoot);
  const id = options.id ? parseDkbIdentity(options.id, 'Compiled DKB identity').identity : sourceDkb.manifest.id;
  if (id !== sourceDkb.manifest.id) throw new DkbError(`Compiled DKB identity override ${id} does not match its manifest ${sourceDkb.manifest.id}.`);

  const state = await readLibraryState(libraryRoot);
  const activeEntry = state.entries[id];
  if (!options.registryReceipt && activeEntry?.source === 'registry') {
    throw new DkbError(`Cannot install local compiled DKB ${id}; that identity is owned by vendor/ in this Library.`);
  }
  if (options.registryReceipt && activeEntry?.source === 'local') {
    throw new DkbError(`Cannot install Registry DKB ${id}; that identity is owned by editable local source in this Library.`);
  }
  if (options.registryReceipt && (options.registryReceipt.package.id !== id || options.registryReceipt.package.version !== sourceDkb.manifest.version)) {
    throw new DkbError(`Registry receipt identity does not match compiled DKB ${id}@${sourceDkb.manifest.version}.`);
  }
  const registryUrl = options.registryReceipt ? normalizeRegistryUrl(requiredRegistryUrl(options.registryUrl)) : undefined;
  const incomingDigest = options.registryReceipt
    ? options.registryReceipt.payload.packageTreeHash ?? options.registryReceipt.payloadHash ?? options.archiveHash ?? 'unknown'
    : undefined;
  if (registryUrl && activeEntry?.source === 'registry' && activeEntry.registryUrl
    && normalizeRegistryUrl(activeEntry.registryUrl) !== registryUrl && activeEntry.digest !== incomingDigest) {
    throw new DkbError(
      `Registry origin conflict for ${id}: the installed release came from ${activeEntry.registryUrl}, `
      + `but the requested signed release came from ${registryUrl} with a different digest. `
      + `Uninstall ${id} before changing its Registry origin.`,
    );
  }

  const packagePath = options.registryReceipt
    ? registryPackagePath(libraryRoot, id)
    : localEntryPath(libraryRoot, id);
  const existing = await maybeInstalledPackage(packagePath, id);
  const tempPath = await copyCompiledArtifactToInstallTemp(sourceRoot, libraryRoot, id);

  try {
    const stagedValidation = await validateCompiledPackage(tempPath);
    if (!stagedValidation.ok || !stagedValidation.graph) throw new DkbError(`Copied compiled artifact validation failed at ${tempPath}`);
    const stagedDkb = await loadDkbPackage(tempPath, id);
    if (existing?.dkb.manifest.version === stagedDkb.manifest.version) {
      const [existingSource, stagedSource] = await Promise.all([
        hashPortablePackageTree(packagePath),
        hashPortablePackageTree(tempPath),
      ]);
      if (existingSource.hash !== stagedSource.hash) {
        throw new DkbError(`Cannot replace ${id}@${stagedDkb.manifest.version} with different source content. Bump the DKB version first.`);
      }
    }

    let finalValidation!: ValidatePackageBuildResult;
    options.progress?.(progressStart({ phase: 'activate', label: 'Install package in Library', total: 2, unit: 'steps' }));
    await promotePackagePath(libraryRoot, tempPath, packagePath, options.force, async () => {
      finalValidation = await validateCompiledPackage(packagePath);
      if (!finalValidation.ok) throw new DkbError(`Installed compiled artifact validation failed at ${packagePath}`);
      options.progress?.(progressUpdate({ phase: 'activate', label: 'Install package in Library', value: 1, total: 2, unit: 'steps' }));
      if (options.registryReceipt) {
        await activateRegistryImport(
          libraryRoot,
          options.registryReceipt,
          path.relative(libraryRoot, packagePath).replace(/\\/gu, '/'),
          options.archiveHash,
          registryUrl,
        );
      } else {
        await activateLocalImports(libraryRoot, [id]);
      }
      options.progress?.(progressUpdate({ phase: 'activate', label: 'Install package in Library', value: 2, total: 2, unit: 'steps' }));
    });
    options.progress?.(progressFinish({ phase: 'activate', label: 'Install package in Library', total: 2, unit: 'steps' }));

    return {
      status: 'installed_in_library',
      id,
      libraryPath: libraryRoot,
      packagePath,
      validation: finalValidation,
      ...(existing && existing.dkb.manifest.version !== stagedDkb.manifest.version
        ? { replaced: { id: existing.dkb.manifest.id, version: existing.dkb.manifest.version } }
        : {}),
    };
  } catch (error) {
    await fs.rm(tempPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removeDkbFromRuntime(
  id: string,
  stateRoot: string | undefined,
  options: { runtime: DkbRuntimeContext; progress?: DkbProgressReporter },
) {
  const runtime = await ensureRuntimeState(stateRoot);
  await closeRuntimeQuerySnapshot(runtime.stateRoot);
  await removeDkbFromLibrary(id, runtime.libraryRoot, { progress: options.progress });

  let warning: string | undefined;
  let refreshed = null as Awaited<ReturnType<typeof refreshRuntimeActivation>> | null;
  try {
    refreshed = await refreshRuntimeActivation({ runtime: options.runtime, stateRoot: runtime.stateRoot });
    warning = refreshed.warning;
  } catch (error) {
    warning = `Library removal succeeded, but Runtime ${runtime.runtimeId} is stale: ${error instanceof Error ? error.message : String(error)}. Run dkb runtime refresh ${runtime.runtimeId}.`;
  }
  invalidateRuntimeQuerySnapshot(runtime.stateRoot);

  let remaining: DkbIndexMutationResult | null = null;
  const current = await ensureRuntimeState(runtime.stateRoot);
  if (refreshed && current.activation) {
    remaining = await verifyRuntimeIndex({
      runtime: options.runtime,
      runtimeStateRoot: runtime.stateRoot,
      libraryRoot: runtime.libraryRoot,
      libraryId: await runtimeLibraryId(runtime),
      target: current.target,
      activation: current.activation,
    }).catch(() => null);
  }
  return {
    status: 'removed',
    id,
    libraryPath: runtime.libraryRoot,
    search: { remaining },
    ...(refreshed?.indexCleanup ? { indexCleanup: refreshed.indexCleanup } : {}),
    ...(warning ? { warning } : {}),
  };
}

export async function removeDkbFromLibrary(
  id: string,
  libraryRoot: string,
  options: { progress?: DkbProgressReporter } = {},
): Promise<{ status: 'removed'; id: string; version: string; libraryPath: string }> {
  const resolvedLibraryRoot = path.resolve(libraryRoot);
  return withLibraryMutation(resolvedLibraryRoot, async () => {
    const identity = parseDkbIdentity(id, 'DKB identity').identity;
    const state = await readLibraryState(resolvedLibraryRoot);
    const stateEntry = state.entries[identity];
    if (!stateEntry || stateEntry.kind !== 'dkb') throw new DkbError(`Library DKB is not installed: ${identity}`);
    const blockers = stateEntry.requiredBy.filter((requirement) => requirement !== `root:${identity}`);
    if (blockers.length > 0) throw new DkbError(`Cannot uninstall ${identity}; it is required by ${blockers.join(', ')}`);
    const packageRoot = path.resolve(resolvedLibraryRoot, stateEntry.path);
    const installed = await loadDkbPackage(packageRoot, identity);
    options.progress?.(progressStart({ phase: 'uninstall', label: 'Remove package from Library', total: 2, unit: 'steps' }));
    if (stateEntry.source === 'registry') await removeLibraryPath(resolvedLibraryRoot, packageRoot);
    await removeLibraryDependencyEntry(resolvedLibraryRoot, identity);
    options.progress?.(progressUpdate({ phase: 'uninstall', label: 'Remove package from Library', value: 1, total: 2, unit: 'steps' }));
    options.progress?.(progressUpdate({ phase: 'uninstall', label: 'Remove package from Library', value: 2, total: 2, unit: 'steps' }));
    options.progress?.(progressFinish({ phase: 'uninstall', label: 'Remove package from Library', total: 2, unit: 'steps' }));
    return { status: 'removed', id: identity, version: installed.manifest.version, libraryPath: resolvedLibraryRoot };
  });
}

export async function reloadRuntimeState(stateRoot?: string): Promise<{ status: 'reloaded'; libraryPath: string; closedContexts: number }> {
  const runtime = await ensureRuntimeState(stateRoot);
  return {
    status: 'reloaded',
    libraryPath: runtime.libraryRoot,
    closedContexts: await closeRuntimeQuerySnapshot(runtime.stateRoot),
  };
}

async function activateLocalImports(libraryRoot: string, identities: string[]): Promise<void> {
  const manifestPath = path.join(libraryRoot, 'dkb.json');
  const manifest = await maybeReadJsonObject(manifestPath);
  if (!manifest || manifest.type !== 'library') throw new DkbError(`Invalid DKB Library manifest at ${manifestPath}`);
  const roots = isRecord(manifest.roots) ? { ...manifest.roots } : {};
  for (const identity of identities) {
    roots[identity] = { path: path.relative(libraryRoot, localEntryPath(libraryRoot, identity)).replace(/\\/g, '/') };
  }
  await writeLibraryMutationFile(libraryRoot, manifestPath, `${JSON.stringify({ ...manifest, roots }, null, 2)}\n`);
  await syncLibrary(libraryRoot);
}

function localEntryPath(libraryRoot: string, identity: string): string {
  return path.join(libraryRoot, parseDkbIdentity(identity, 'Local DKB identity').name);
}

async function maybeInstalledPackage(packagePath: string, id: string): Promise<{ dkb: LoadedDkb; validation: ValidatePackageBuildResult | null } | null> {
  if (!(await exists(packagePath))) return null;
  return { dkb: await loadDkbPackage(packagePath, id), validation: await validateCompiledPackage(packagePath).catch(() => null) };
}

async function copyCompiledArtifactToInstallTemp(sourceRoot: string, libraryRoot: string, id: string): Promise<string> {
  const tempRoot = path.join(libraryRoot, '.dkb', 'tmp');
  await fs.mkdir(tempRoot, { recursive: true });
  const tempPath = await fs.mkdtemp(path.join(tempRoot, `install-${safeId(id)}-`));
  await fs.cp(sourceRoot, tempPath, { recursive: true, filter: (source) => !isEphemeralDkbStatePath(sourceRoot, source) });
  return tempPath;
}

async function promotePackagePath<T>(libraryRoot: string, tempPath: string, packagePath: string, force: boolean | undefined, operation: () => Promise<T>): Promise<T> {
  if (await exists(packagePath)) {
    if (!force) throw new DkbError(`Runtime DKB already exists: ${path.basename(packagePath)}. Use force to replace it.`);
  }
  await promoteLibraryPath(libraryRoot, tempPath, packagePath);
  return operation();
}

async function activateRegistryImport(
  root: string,
  receipt: DkbPackageReceipt,
  installedPath: string,
  archiveHash: string | undefined,
  registryUrl: string | undefined,
): Promise<void> {
  const manifestPath = path.join(root, 'dkb.json');
  const manifest = await maybeReadJsonObject(manifestPath);
  if (!manifest || manifest.type !== 'library') throw new DkbError(`Runtime Library manifest is invalid: ${manifestPath}`);
  const identity = parseDkbIdentity(receipt.package.id, 'Registry DKB identity').identity;
  if (!receipt.payload.lock.packages[identity]) throw new DkbError(`Package receipt does not contain package lock entry: ${identity}`);
  const previous = await maybeReadLibraryLock(root);
  const now = new Date().toISOString();
  await writeLibraryMutationFile(root, manifestPath, `${JSON.stringify({
    ...manifest,
    roots: { ...(isRecord(manifest.roots) ? manifest.roots : {}), [identity]: { version: receipt.package.version } },
  }, null, 2)}\n`);
  await applyLibraryLock(root, {
    library: { name: String(manifest.name) },
    generation: (previous?.generation ?? 0) + 1,
    entries: {
      ...(previous?.entries ?? {}),
      [identity]: {
        identity,
        kind: 'dkb',
        source: 'registry',
        version: receipt.package.version,
        digest: receipt.payload.packageTreeHash ?? receipt.payloadHash ?? archiveHash ?? 'unknown',
        registryUrl: requiredRegistryUrl(registryUrl),
        path: installedPath,
        requiredBy: [`root:${identity}`],
        installedAt: now,
      },
    },
    resolvedAt: now,
  });
}

function requiredRegistryUrl(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) throw new DkbError('Registry-installed knowledge requires its exact Registry URL.');
  return normalized;
}

async function removeLibraryDependencyEntry(root: string, id: string): Promise<void> {
  const manifestPath = path.join(root, 'dkb.json');
  const manifest = await maybeReadJsonObject(manifestPath);
  const previousLock = await maybeReadLibraryLock(root);
  if (!manifest || manifest.type !== 'library' || !isRecord(manifest.roots) || !previousLock?.entries[id]) {
    throw new DkbError(`Runtime DKB is not installed: ${id}`);
  }
  const roots = { ...manifest.roots };
  delete roots[id];
  const entries = { ...previousLock.entries };
  delete entries[id];
  await writeLibraryMutationFile(root, manifestPath, `${JSON.stringify({ ...manifest, roots }, null, 2)}\n`);
  await applyLibraryLock(root, { ...previousLock, generation: previousLock.generation + 1, entries, resolvedAt: new Date().toISOString() });
}
