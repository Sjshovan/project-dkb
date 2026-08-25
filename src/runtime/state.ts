import fs from 'node:fs/promises';
import path from 'node:path';
import { DKB_PACKAGE_RECEIPT_PATH, parsePackageReceipt } from '../signing/index.js';
import { validateDkbArtifactManifest, type ValidateDkbArtifactManifestResult } from '../artifacts/manifest.js';
import { compileComposeProject } from '../compiler/compile.js';
import { refreshRuntimeCatalogFromInstalledArtifacts } from './catalog.js';
import { getQueryContext, invalidateQueryContext, type QueryContext } from '../indexes/queryContext.js';
import { closeFaissSnapshot, validateFaissPackageQueryability, validateFaissRuntimeReady, type FaissPackageMutationResult } from '../indexes/faissStore.js';
import { retrieveKnowledge, type DkbRetrieveKnowledgeRequest } from '../read/runtime.js';
import { renderModelEvidence } from '../read/modelEvidence.js';
import { recordRetrievalTrace, retrievalTraceEnabled } from './trace.js';
import { enqueueQueryAudit } from './queryAudit.js';
import { loadDkb, loadDkbPackage, loadRegistry } from '../protocol/manifest.js';
import { DkbError } from '../protocol/errors.js';
import { progressFinish, progressStart, progressUpdate, type DkbProgressReporter } from '../progress.js';
import type { DkbSourceManifest, LoadedDkb } from '../protocol/types.js';
import {
  assertMatchingRetrievalProfiles,
  maybeReadRetrievalProfileLock,
  writeRetrievalProfileLock,
  type DkbRetrievalProfileLock,
} from '../profiles/retrievalProfile.js';

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
  stateRoot: string;
  registryPath: string;
  packageCount: number;
  dkbIds: string[];
  packages: Array<{
    id: string;
    version: string;
    packageTreeHash?: string;
  }>;
  retrievalProfile: DkbRetrievalProfileLock | null;
}

export interface ImportDkbOptions {
  sourcePath: string;
  id?: string;
  name?: string;
  force?: boolean;
  compile?: boolean;
}

export interface ImportDkbResult {
  status: 'imported';
  id: string;
  registryPath: string;
  packagePath: string;
  generatedManifest: boolean;
  compiled?: Awaited<ReturnType<typeof compileComposeProject>>;
}

export interface ImportCompiledDkbArtifactOptions {
  sourcePath: string;
  id?: string;
  force?: boolean;
  progress?: DkbProgressReporter;
}

export interface ImportCompiledDkbArtifactResult {
  status: 'imported_compiled_artifact';
  id: string;
  registryPath: string;
  packagePath: string;
  validation: ValidateDkbArtifactManifestResult;
  catalog: Awaited<ReturnType<typeof refreshRuntimeCatalogFromInstalledArtifacts>>;
  search: {
    upsert: FaissPackageMutationResult;
    removedPrevious?: FaissPackageMutationResult;
  };
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
    stateRoot: paths.stateRoot,
    registryPath: paths.stateRoot,
    packageCount: dkbIds.length,
    dkbIds,
    packages,
    retrievalProfile,
  };
}

async function runtimePackageTreeHashes(root: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();

  try {
    const lock = JSON.parse(await fs.readFile(path.join(root, 'dkb-lock.json'), 'utf8')) as {
      packages?: Record<string, { version?: unknown; packageTreeHash?: unknown; resolved?: unknown }>;
    };

    for (const item of Object.values(lock.packages ?? {})) {
      if (typeof item.version !== 'string' || typeof item.packageTreeHash !== 'string') {
        continue;
      }

      const resolved = typeof item.resolved === 'string' ? item.resolved : '';
      const packageId = resolved.split(':').pop()?.split('@')[0] ?? '';

      if (packageId) {
        hashes.set(`${packageId}@${item.version}`, item.packageTreeHash);
      }
    }
  } catch {
    // A local source runtime may not have a generated lock yet.
  }

  return hashes;
}

export async function listRuntimeRegistries(stateRoot?: string) {
  const status = await runtimeStatus(stateRoot);

  return {
    registries: [{
      id: 'default',
      path: status.registryPath,
      dkbIds: status.dkbIds,
      packageCount: status.packageCount,
    }],
  };
}

export async function importDkbIntoRuntime(options: ImportDkbOptions, stateRoot?: string): Promise<ImportDkbResult> {
  const paths = await ensureRuntimeState(stateRoot);
  const sourceRoot = path.resolve(options.sourcePath);

  if (!(await exists(sourceRoot))) {
    throw new DkbError(`Import source does not exist: ${sourceRoot}`);
  }

  const imported = await importSource(sourceRoot, paths, options);
  const compileResult = options.compile === false
    ? undefined
    : await compileComposeProject(paths.stateRoot, {
      force: true,
      compiler: 'llamaindex',
      model: (await maybeReadRetrievalProfileLock(paths.stateRoot))?.profile.embedding.model,
    });
  // A precompiled package still needs its chunks and vectors activated in the
  // shared runtime catalog. Skipping compilation must never mean skipping
  // installation into the search index.
  if (options.compile === false) {
    await refreshRuntimeCatalogFromInstalledArtifacts(paths.stateRoot);
  }
  invalidateRuntimeQuerySnapshot(paths.stateRoot);

  return {
    status: 'imported',
    id: imported.ids[0] ?? imported.id,
    registryPath: paths.stateRoot,
    packagePath: imported.packagePath,
    generatedManifest: imported.generatedManifest,
    compiled: compileResult,
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

  const id = await allocateInstallId(paths, safeId(options.id ?? sourceValidation.manifest.registry.id), options.force);
  const packagePath = path.join(paths.packagesDir, id);
  const existing = await maybeInstalledPackage(paths, id);
  const tempPath = await copyCompiledArtifactToInstallTemp(sourceRoot, paths, id);

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
    await validateFaissPackageQueryability(stagedDkb);
    let finalValidation: ValidateDkbArtifactManifestResult | undefined;
    let catalog: Awaited<ReturnType<typeof refreshRuntimeCatalogFromInstalledArtifacts>> | undefined;
    let searchUpsert: FaissPackageMutationResult | undefined;
    let removedPrevious: FaissPackageMutationResult | undefined;

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

      options.progress?.(progressUpdate({
        phase: 'activate',
        label: 'Activate package',
        value: 2,
        total: activationTotal,
        unit: 'steps',
      }));
      catalog = await refreshRuntimeCatalogFromInstalledArtifacts(paths.stateRoot, { syncSearch: false });
      invalidateRuntimeQuerySnapshot(paths.stateRoot);
      options.progress?.(progressUpdate({
        phase: 'activate',
        label: 'Activate package',
        value: 3,
        total: activationTotal,
        unit: 'steps',
      }));
      searchUpsert = await validateFaissRuntimeReady({
        root: paths.stateRoot,
        registryId,
        packageId: stagedDkb.manifest.id,
        packageVersion: stagedDkb.manifest.version,
      });
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
      removedPrevious = searchUpsert;
    }
    invalidateRuntimeQuerySnapshot(paths.stateRoot);

    return {
      status: 'imported_compiled_artifact',
      id,
      registryPath: paths.stateRoot,
      packagePath,
      validation: finalValidation!,
      catalog: catalog!,
      search: {
        upsert: searchUpsert!,
        removedPrevious,
      },
    };
  } catch (error) {
    await fs.rm(tempPath, { recursive: true, force: true });
    invalidateRuntimeQuerySnapshot(paths.stateRoot);
    throw error;
  }
}

export async function removeDkbFromRuntime(id: string, stateRoot?: string, options: { progress?: DkbProgressReporter } = {}) {
  const paths = await ensureRuntimeState(stateRoot);
  const packageRoots = await installedDkbRoots(paths, id);

  if (packageRoots.length === 0) {
    throw new DkbError(`Runtime DKB is not installed: ${id}`);
  }

  const registryId = await runtimeRegistryId(paths);
  const total = packageRoots.length + 3;
  let completed = 0;

  options.progress?.(progressStart({
    phase: 'uninstall',
    label: 'Uninstall package',
    total,
    unit: 'steps',
  }));

  await Promise.all(packageRoots.map(async (packagePath) => {
    await fs.rm(packagePath, { recursive: true, force: true });
    completed += 1;
    options.progress?.(progressUpdate({
      phase: 'uninstall',
      label: 'Uninstall package',
      value: completed,
      total,
      unit: 'steps',
    }));
  }));
  await refreshRuntimeCatalogFromInstalledArtifacts(paths.stateRoot, { syncSearch: false });
  completed += 1;
  options.progress?.(progressUpdate({
    phase: 'uninstall',
    label: 'Uninstall package',
    value: completed,
    total,
    unit: 'steps',
  }));
  await removeRuntimeDependencyEntries(paths.stateRoot, id, packageRoots);
  completed += 1;
  options.progress?.(progressUpdate({
    phase: 'uninstall',
    label: 'Uninstall package',
    value: completed,
    total,
    unit: 'steps',
  }));
  invalidateRuntimeQuerySnapshot(paths.stateRoot);
  const remaining = await validateFaissRuntimeReady({ root: paths.stateRoot, registryId }).catch(() => null);
  completed += 1;
  options.progress?.(progressUpdate({
    phase: 'uninstall',
    label: 'Uninstall package',
    value: completed,
    total,
    unit: 'steps',
  }));
  options.progress?.(progressFinish({
    phase: 'uninstall',
    label: 'Uninstall package',
    total,
    unit: 'steps',
  }));

  return {
    status: 'removed',
    id,
    registryPath: paths.stateRoot,
    search: {
      removed: remaining ? [remaining] : [],
    },
  };
}

export async function compileRuntimeDkb(id?: string, stateRoot?: string) {
  const paths = await ensureRuntimeState(stateRoot);

  if (id && (await installedDkbRoots(paths, id)).length === 0) {
    throw new DkbError(`Runtime DKB is not installed: ${id}`);
  }

  const profile = await maybeReadRetrievalProfileLock(paths.stateRoot);
  const compiled = await compileComposeProject(paths.stateRoot, {
    force: true,
    compiler: 'llamaindex',
    model: profile?.profile.embedding.model,
  });
  invalidateRuntimeQuerySnapshot(paths.stateRoot);

  return compiled;
}

export async function retrieveFromRuntime(request: DkbRetrieveKnowledgeRequest, stateRoot?: string) {
  const paths = await ensureRuntimeState(stateRoot);
  const registry = await loadRegistry(paths.stateRoot);
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
    for (const context of runtimeQueryContexts.values()) {
      void closeFaissSnapshot(context.faiss);
    }
    runtimeQueryContexts.clear();
    invalidateQueryContext();

    return count;
  }

  const root = path.resolve(stateRoot);
  const context = runtimeQueryContexts.get(root);
  const removed = runtimeQueryContexts.delete(root) ? 1 : 0;
  void closeFaissSnapshot(context?.faiss);
  invalidateQueryContext(root);

  return removed;
}

async function importSource(sourceRoot: string, paths: DkbRuntimePaths, options: ImportDkbOptions) {
  const discovered = await discoverSourceDkbs(sourceRoot);

  if (discovered.length === 0) {
    const id = await allocateInstallId(paths, safeId(options.id ?? path.basename(sourceRoot) ?? 'dkb'), options.force);
    const packagePath = path.join(paths.packagesDir, id);

    await replacePackagePath(packagePath, options.force);
    await fs.mkdir(packagePath, { recursive: true });
    await fs.cp(sourceRoot, packagePath, {
      recursive: true,
      filter: (source) => !isRuntimeArtifactPath(sourceRoot, source),
    });
    await writeGeneratedDkbManifest(packagePath, {
      name: options.name ?? titleFromId(id),
      version: '0.1.0',
      permissions: {
        read: true,
        write: false,
      },
      meta: {
        generatedBy: 'dkb-runtime',
      },
    });

    return {
      id,
      ids: [id],
      packagePath,
      generatedManifest: true,
    };
  }

  const importedIds: string[] = [];
  let firstPackagePath = '';

  for (const dkb of discovered) {
    const requested = dkb.root === sourceRoot && options.id
      ? safeId(options.id)
      : dkb.manifest.id;
    const id = await allocateInstallId(paths, requested, options.force);
    const packagePath = path.join(paths.packagesDir, id);

    await replacePackagePath(packagePath, options.force);
    await fs.cp(dkb.root, packagePath, {
      recursive: true,
      filter: (source) => !isRuntimeArtifactPath(dkb.root, source),
    });

    importedIds.push(id);
    firstPackagePath = firstPackagePath || packagePath;
  }

  return {
    id: importedIds[0] ?? safeId(options.id ?? path.basename(sourceRoot) ?? 'dkb'),
    ids: importedIds,
    packagePath: firstPackagePath,
    generatedManifest: false,
  };
}

async function discoverSourceDkbs(sourceRoot: string): Promise<LoadedDkb[]> {
  try {
    const registry = await loadRegistry(sourceRoot);

    return [
      ...registry.collections.flatMap((collection) => collection.dkbs),
      ...registry.dkbs,
    ];
  } catch {
    return [];
  }
}

async function installedDkbs(paths: DkbRuntimePaths): Promise<LoadedDkb[]> {
  try {
    const registry = await loadRegistry(paths.stateRoot);

    return [
      ...registry.collections.flatMap((collection) => collection.dkbs),
      ...registry.dkbs,
    ];
  } catch {
    return [];
  }
}

async function installedDkbRoots(paths: DkbRuntimePaths, id: string): Promise<string[]> {
  return (await installedDkbs(paths))
    .filter((dkb) => dkb.manifest.id === id)
    .map((dkb) => dkb.root);
}

async function maybeInstalledPackage(paths: DkbRuntimePaths, id: string): Promise<{
  dkb: LoadedDkb;
  validation: ValidateDkbArtifactManifestResult | null;
} | null> {
  const packagePath = path.join(paths.packagesDir, id);

  if (!(await exists(packagePath))) {
    return null;
  }

  const dkb = await loadDkbPackage(packagePath, id);
  const validation = await validateDkbArtifactManifest(packagePath).catch(() => null);

  return { dkb, validation };
}

async function runtimeRegistryId(paths: DkbRuntimePaths): Promise<string> {
  return (await loadRegistry(paths.stateRoot)).manifest.id;
}

async function allocateInstallId(paths: DkbRuntimePaths, requested: string, force?: boolean): Promise<string> {
  if (force) {
    return requested;
  }

  if (!(await exists(path.join(paths.packagesDir, requested)))) {
    return requested;
  }

  for (let index = 2; index < 10000; index += 1) {
    const candidate = `${requested}-${index}`;

    if (!(await exists(path.join(paths.packagesDir, candidate)))) {
      return candidate;
    }
  }

  throw new DkbError(`Unable to allocate runtime DKB id for ${requested}`);
}

async function replacePackagePath(packagePath: string, force?: boolean): Promise<void> {
  if (!(await exists(packagePath))) {
    return;
  }

  if (!force) {
    throw new DkbError(`Runtime DKB already exists: ${path.basename(packagePath)}. Use force to replace it.`);
  }

  await fs.rm(packagePath, { recursive: true, force: true });
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

async function writeGeneratedDkbManifest(root: string, manifest: DkbSourceManifest): Promise<void> {
  await fs.writeFile(path.join(root, 'dkb.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function ensureRuntimeProjectManifest(root: string): Promise<void> {
  const manifestPath = path.join(root, 'dkb.json');

  if (await exists(manifestPath)) {
    const existing = await maybeReadJsonObject(manifestPath);

    // Runtime roots activate only explicitly installed packages. Older
    // generated manifests omitted this flag, which made the root's own locks
    // appear as an implicit DKB and duplicated installed catalog rows.
    if (existing?.description === 'Local DKB runtime registry.' && !existing.localSources) {
      await fs.writeFile(manifestPath, `${JSON.stringify({
        ...existing,
        localSources: { enabled: false },
      }, null, 2)}\n`, 'utf8');
    }
    return;
  }

  await fs.writeFile(manifestPath, `${JSON.stringify({
    manifestVersion: 1,
    type: 'registry',
    name: titleFromId(path.basename(root) || 'Runtime Registry'),
    version: '0.0.0-local',
    description: 'Local DKB runtime registry.',
    localSources: {
      enabled: false,
    },
    dependencies: {},
  }, null, 2)}\n`, 'utf8');
}

async function removeRuntimeDependencyEntries(root: string, id: string, removedRoots: string[]): Promise<void> {
  const removedPaths = new Set(removedRoots.map((item) => path.relative(root, item).replace(/\\/g, '/')));
  const manifestPath = path.join(root, 'dkb.json');
  const manifest = await maybeReadJsonObject(manifestPath);

  if (manifest && isRecord(manifest.dependencies)) {
    const dependencies = { ...manifest.dependencies as Record<string, string> };

    for (const name of Object.keys(dependencies)) {
      if (name.endsWith(`/${id}`) || name === id) {
        delete dependencies[name];
      }
    }

    await fs.writeFile(manifestPath, `${JSON.stringify({
      ...manifest,
      dependencies,
    }, null, 2)}\n`, 'utf8');
  }

  const lockPath = path.join(root, 'dkb-lock.json');
  const lock = await maybeReadJsonObject(lockPath);

  if (lock && isRecord(lock.packages)) {
    const packages = { ...lock.packages as Record<string, unknown> };

    for (const [name, value] of Object.entries(packages)) {
      const entry = isRecord(value) ? value : {};
      const installedPath = typeof entry.installedPath === 'string' ? entry.installedPath : '';

      if (entry.id === id || name.endsWith(`/${id}`) || removedPaths.has(installedPath)) {
        delete packages[name];
      }
    }

    await fs.writeFile(lockPath, `${JSON.stringify({
      ...lock,
      packages,
    }, null, 2)}\n`, 'utf8');
  }
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

function isRuntimeArtifactPath(sourceRoot: string, source: string): boolean {
  const relative = path.relative(sourceRoot, source);

  return relative === '.dkb' || relative.startsWith(`.dkb${path.sep}`);
}

function isEphemeralDkbStatePath(sourceRoot: string, source: string): boolean {
  const relative = path.relative(sourceRoot, source);
  const cachePath = path.join('.dkb', 'cache');
  const locksPath = path.join('.dkb', 'locks');
  const runsPath = path.join('.dkb', 'runs');

  return relative === cachePath
    || relative.startsWith(`${cachePath}${path.sep}`)
    || relative === locksPath
    || relative.startsWith(`${locksPath}${path.sep}`)
    || relative === runsPath
    || relative.startsWith(`${runsPath}${path.sep}`);
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
