import fs from 'node:fs/promises';
import path from 'node:path';
import { DKB_PACKAGE_RECEIPT_PATH, parsePackageReceipt } from '@dkb/library/signing.js';
import { inspectDkbArtifactManifest, validateDkbArtifactManifest, type ValidateDkbArtifactManifestResult } from '@dkb/library/artifacts.js';
import { refreshRuntimeCatalogFromInstalledArtifacts } from './catalog.js';
import { closeQueryContext, getQueryContext, invalidateQueryContext, type QueryContext } from '../indexes/queryContext.js';
import { retrieveKnowledge, type DkbRetrieveKnowledgeRequest } from '../read/runtime.js';
import { renderModelEvidence } from '../read/modelEvidence.js';
import { recordRetrievalTrace, retrievalTraceEnabled } from './trace.js';
import { enqueueQueryAudit } from './queryAudit.js';
import { loadDkbPackage, loadLibrary, uniqueLoadedDkbs } from '@dkb/protocol/manifest.js';
import { DkbError } from '@dkb/protocol/errors.js';
import { parseDkbIdentity, registryPackagePath } from '@dkb/protocol/identity.js';
import { progressFinish, progressStart, progressUpdate, type DkbProgressReporter } from '@dkb/protocol/progress.js';
import type { DkbPackageReceipt, LoadedDkb } from '@dkb/protocol/types.js';
import { DKB_ARTIFACTS_DIR } from '@dkb/protocol/paths.js';
import { applyLibraryLock, maybeReadLibraryLock, readLibraryState } from '@dkb/library/state.js';
import { syncLibrary } from '@dkb/library/resolver.js';
import { snapshotLibraryArtifacts } from '@dkb/library/artifactSnapshot.js';
import {
  DKB_RETRIEVAL_PROFILE_LOCK_PATH,
  assertMatchingRetrievalProfiles,
  maybeReadRetrievalProfileLock,
  writeRetrievalProfileLock,
  type DkbRetrievalProfileLock,
} from '@dkb/pipeline/profile.js';
import { cleanupRuntimeIndexPackage, prepareRuntimeIndexPackage, verifyRuntimeIndex, type PreparedRuntimeIndexPackage } from '../providers/runtimeIndex.js';
import type { DkbIndexMutationResult } from '@dkb/pipeline/types.js';
import { DKB_RUNTIME_VERSION } from '../version.js';

// Runtime snapshots are invalidated by managed mutations, not revalidated on
// every request. This keeps the hot MCP path independent of artifact I/O.
const runtimeQueryContexts = new Map<string, QueryContext>();

export interface DkbRuntimePaths {
  stateRoot: string;
  stateDir: string;
  vendorDir: string;
  packagesDir: string;
}

export interface DkbRuntimeStatus {
  ok: true;
  version: string;
  stateRoot: string;
  libraryPath: string;
  packageCount: number;
  dkbIds: string[];
  packages: Array<{
    id: string;
    version: string;
    packageTreeHash?: string;
  }>;
  retrievalProfile: DkbRetrievalProfileLock | null;
}

export interface DkbRuntimePackageListing {
  libraryRoot: string;
  packages: Array<{
    id: string;
    version: string;
    kind: 'dkb' | 'collection';
    status: 'installed' | 'broken' | 'untracked';
    recordCount?: number;
    path: string;
  }>;
}

export interface ImportCompiledDkbArtifactOptions {
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
  validation: ValidateDkbArtifactManifestResult;
  catalog: Awaited<ReturnType<typeof refreshRuntimeCatalogFromInstalledArtifacts>>;
  search: {
    upsert: DkbIndexMutationResult;
    removedPrevious?: DkbIndexMutationResult;
  };
  warning?: string;
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

export async function runtimeStatus(stateRoot?: string): Promise<DkbRuntimeStatus> {
  const paths = await ensureRuntimeState(stateRoot);
  const dkbs = await installedDkbs(paths);
  const dkbIds = dkbs.map((dkb) => dkb.manifest.id).sort();
  const packageTreeHashes = await runtimePackageTreeHashes(paths.stateRoot);
  const packages = await Promise.all(dkbs.map(async (dkb) => {
    try {
      const receiptPath = path.join(dkb.root, DKB_PACKAGE_RECEIPT_PATH);
      const receipt = parsePackageReceipt(JSON.parse(await fs.readFile(receiptPath, 'utf8')), receiptPath);

      return {
        id: dkb.manifest.id,
        version: dkb.manifest.version,
        ...(receipt.payload.packageTreeHash
          ? { packageTreeHash: receipt.payload.packageTreeHash }
          : packageTreeHashes.get(`${dkb.manifest.id}@${dkb.manifest.version}`)
            ? { packageTreeHash: packageTreeHashes.get(`${dkb.manifest.id}@${dkb.manifest.version}`) }
            : {}),
      };
    } catch {
      return {
        id: dkb.manifest.id,
        version: dkb.manifest.version,
        ...(packageTreeHashes.get(`${dkb.manifest.id}@${dkb.manifest.version}`)
          ? { packageTreeHash: packageTreeHashes.get(`${dkb.manifest.id}@${dkb.manifest.version}`) }
          : {}),
      };
    }
  }));
  const retrievalProfile = await maybeReadRetrievalProfileLock(paths.stateRoot);

  return {
    ok: true,
    version: DKB_RUNTIME_VERSION,
    stateRoot: paths.stateRoot,
    libraryPath: paths.stateRoot,
    packageCount: dkbIds.length,
    dkbIds,
    packages,
    retrievalProfile,
  };
}

export async function listRuntimePackages(stateRoot?: string): Promise<DkbRuntimePackageListing> {
  const paths = runtimePaths(stateRoot);
  const state = await readLibraryState(paths.stateRoot);
  const candidates = new Map<string, string>();

  for (const entry of Object.values(state.entries)) {
    candidates.set(entry.identity, path.resolve(paths.stateRoot, entry.path));
  }

  try {
    for (const namespace of await fs.readdir(paths.vendorDir, { withFileTypes: true })) {
      if (!namespace.isDirectory() || !namespace.name.startsWith('@') || namespace.name.includes('.replace-')) {
        continue;
      }

      const namespacePath = path.join(paths.vendorDir, namespace.name);
      for (const nested of await fs.readdir(namespacePath, { withFileTypes: true })) {
        if (!nested.isDirectory() || nested.name.includes('.replace-')) {
          continue;
        }

        const nestedPath = path.join(namespacePath, nested.name);

        if (await exists(path.join(nestedPath, 'dkb.json'))) {
          candidates.set(`${namespace.name}/${nested.name}`, nestedPath);
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const packages = await Promise.all([...candidates.entries()].map(async ([candidateIdentity, packagePath]) => {
    const manifest = await maybeReadJsonObject(path.join(packagePath, 'dkb.json')) ?? {};
    const id = typeof manifest.name === 'string' ? manifest.name : candidateIdentity;
    const stateEntry = state.entries[id];
    const kind = stateEntry?.kind ?? (manifest.type === 'collection' ? 'collection' as const : 'dkb' as const);
    const recordCount = kind === 'dkb'
      ? await inspectDkbArtifactManifest(packagePath).then((artifact) => artifact.counts.records).catch(() => undefined)
      : undefined;

    return {
      id,
      version: typeof manifest.version === 'string' ? manifest.version : stateEntry?.revision ? `r${stateEntry.revision}` : '-',
      kind,
      status: stateEntry?.status ?? 'untracked' as const,
      ...(typeof recordCount === 'number' ? { recordCount } : {}),
      path: packagePath,
    };
  }));

  return {
    libraryRoot: paths.stateRoot,
    packages: packages.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

async function runtimePackageTreeHashes(root: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();

  for (const entry of Object.values((await readLibraryState(root)).entries)) {
    if (entry.kind === 'dkb' && entry.version && entry.digest) {
      hashes.set(`${entry.identity}@${entry.version}`, entry.digest);
    }
  }

  return hashes;
}

export async function runtimeLibrary(stateRoot?: string) {
  const status = await runtimeStatus(stateRoot);

  return {
    library: {
      id: 'default',
      path: status.libraryPath,
      dkbIds: status.dkbIds,
      packageCount: status.packageCount,
    },
  };
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

  const sourceValidation = await validateDkbArtifactManifest(sourceRoot, { progress: options.progress });

  if (!sourceValidation.ok || !sourceValidation.manifest) {
    throw new DkbError(`Compiled artifact validation failed at ${sourceRoot}`);
  }

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
  const artifactSnapshot = await snapshotLibraryArtifacts(paths.stateRoot);
  let libraryActivated = false;
  let preparedIndex: PreparedRuntimeIndexPackage | null = null;
  let indexCommitted = false;

  try {
    const tempValidation = await validateDkbArtifactManifest(tempPath, { progress: options.progress });

    if (!tempValidation.ok) {
      throw new DkbError(`Copied compiled artifact validation failed at ${tempPath}`);
    }

    const stagedDkb = await loadDkbPackage(tempPath, id);
    const candidateProfile = await maybeReadRetrievalProfileLock(tempPath);
    const activeProfile = await maybeReadRetrievalProfileLock(paths.stateRoot);

    if (activeProfile && candidateProfile) {
      assertMatchingRetrievalProfiles(activeProfile, candidateProfile, `${stagedDkb.manifest.id}@${stagedDkb.manifest.version}`);
    }
    const sameVersionReplacement = existing?.dkb.manifest.version === stagedDkb.manifest.version;

    if (sameVersionReplacement && existing.validation?.manifest?.hashes.artifactTree !== tempValidation.manifest?.hashes.artifactTree) {
      throw new DkbError(`Cannot atomically replace ${id}@${stagedDkb.manifest.version} with different compiled content. Bump the DKB version before updating.`);
    }

    const registryId = await runtimeRegistryId(paths);
    preparedIndex = await prepareRuntimeIndexPackage({ libraryRoot: paths.stateRoot, libraryId: registryId, dkb: stagedDkb });
    let finalValidation: ValidateDkbArtifactManifestResult | undefined;
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
      finalValidation = await validateDkbArtifactManifest(packagePath);

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
        libraryRoot: paths.stateRoot,
        libraryId: registryId,
        packageId: stagedDkb.manifest.id,
        packageVersion: stagedDkb.manifest.version,
      }) ?? preparedIndex!.installed ?? {
        indexId: preparedIndex!.providerId,
        documentCount: preparedIndex!.validation.documentCount,
        status: 'ready',
      };
      if (!activeProfile && candidateProfile) {
        await writeRetrievalProfileLock(paths.stateRoot, candidateProfile);
      }
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

export async function removeDkbFromRuntime(id: string, stateRoot?: string, options: { progress?: DkbProgressReporter } = {}) {
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

  const registryId = await runtimeRegistryId(paths);
  const installed = (await installedDkbs(paths)).find((dkb) => dkb.manifest.id === id);

  if (!installed) {
    throw new DkbError(`Runtime DKB content is unavailable: ${id}`);
  }
  const total = packageRoots.length + 3;
  let completed = 0;
  const uninstallRoot = path.join(paths.stateDir, 'tmp', `uninstall-${safeId(id)}-${process.pid}-${Date.now().toString(36)}`);
  const stagedPackages: Array<{ originalPath: string; stagedPath: string }> = [];
  let activation: { rollback: () => Promise<void> } | null = null;
  const artifactSnapshot = await snapshotLibraryArtifacts(paths.stateRoot);

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
      libraryRoot: paths.stateRoot,
      libraryId: registryId,
      packageId: installed.manifest.id,
      packageVersion: installed.manifest.version,
    });
    const remaining = await verifyRuntimeIndex({ libraryRoot: paths.stateRoot, libraryId: registryId }).catch(() => null);
    if (catalog.packageCount === 0) {
      await fs.rm(path.join(paths.stateRoot, DKB_RETRIEVAL_PROFILE_LOCK_PATH), { force: true });
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

export async function retrieveFromRuntime(request: DkbRetrieveKnowledgeRequest, stateRoot?: string) {
  const paths = await ensureRuntimeState(stateRoot);
  const registry = await loadLibrary(paths.stateRoot);
  const snapshotKey = path.resolve(paths.stateRoot);
  let queryContext = runtimeQueryContexts.get(snapshotKey);

  if (!queryContext) {
    try {
      queryContext = await getQueryContext(paths.stateRoot, registry.manifest.id);
      runtimeQueryContexts.set(snapshotKey, queryContext);
    } catch (error) {
      if (!isMissingCompiledArtifactError(error)) {
        throw error;
      }
    }
  }

  const response = await retrieveKnowledge(paths.stateRoot, request, queryContext);

  const audit = enqueueQueryAudit({
    root: paths.stateRoot,
    channel: 'runtime-http',
    request,
    response,
  });
  if (audit.mode === 'synchronous_fallback') {
    await audit.flushed;
  }

  if (retrievalTraceEnabled()) {
    await recordRetrievalTrace({
      root: paths.stateRoot,
      request,
      response,
      modelText: renderModelEvidence(response),
    });
  }

  return response;
}

function isMissingCompiledArtifactError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return /unable to open database file|no such file or directory|ENOENT/i.test(message);
}

export function invalidateRuntimeQuerySnapshot(stateRoot?: string): number {
  if (!stateRoot) {
    const count = runtimeQueryContexts.size;
    runtimeQueryContexts.clear();
    invalidateQueryContext();

    return count;
  }

  const root = path.resolve(stateRoot);
  const removed = runtimeQueryContexts.delete(root) ? 1 : 0;
  invalidateQueryContext(root);

  return removed;
}

async function closeRuntimeQuerySnapshot(stateRoot: string): Promise<number> {
  const root = path.resolve(stateRoot);
  const context = runtimeQueryContexts.get(root);
  const removed = runtimeQueryContexts.delete(root) ? 1 : 0;
  const residentClosed = await closeQueryContext(root);

  if (context && residentClosed === 0) {
    context.lexical?.close();
    await context.index?.close();
    await context.providerHost.dispose();
  }

  return removed;
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

async function installedDkbs(paths: DkbRuntimePaths): Promise<LoadedDkb[]> {
  try {
    const registry = await loadLibrary(paths.stateRoot);

    return uniqueLoadedDkbs([
      ...registry.collections.flatMap((collection) => collection.dkbs),
      ...registry.dkbs,
    ]);
  } catch {
    return [];
  }
}

async function maybeInstalledPackage(packagePath: string, id: string): Promise<{
  dkb: LoadedDkb;
  validation: ValidateDkbArtifactManifestResult | null;
} | null> {
  if (!(await exists(packagePath))) {
    return null;
  }

  const dkb = await loadDkbPackage(packagePath, id);
  const validation = await validateDkbArtifactManifest(packagePath).catch(() => null);

  return { dkb, validation };
}

async function runtimeRegistryId(paths: DkbRuntimePaths): Promise<string> {
  return (await loadLibrary(paths.stateRoot)).manifest.id;
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

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const temp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
  const backup = `${target}.replace-${process.pid}-${Date.now().toString(36)}`;
  const hadTarget = await exists(target);
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (hadTarget) await fs.rename(target, backup);
  try {
    await fs.rename(temp, target);
    await fs.rm(backup, { force: true });
  } catch (error) {
    await fs.rm(target, { force: true });
    if (hadTarget && await exists(backup)) await fs.rename(backup, target);
    throw error;
  }
}

async function ensureRuntimeProjectManifest(root: string): Promise<void> {
  const manifestPath = path.join(root, 'dkb.json');

  if (await exists(manifestPath)) {
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

async function maybeReadJsonObject(source: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await fs.readFile(source, 'utf8')) as unknown;

    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isEphemeralDkbStatePath(sourceRoot: string, source: string): boolean {
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

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);

    return true;
  } catch {
    return false;
  }
}

function safeId(value: string): string {
  const id = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

  return id || 'dkb';
}

function titleFromId(value: string): string {
  return value
    .split(/[-_.]+/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ') || value;
}
