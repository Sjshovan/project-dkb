import fs from 'node:fs/promises';
import path from 'node:path';
import { compileComposeProject } from '../compiler/compile.js';
import { refreshRuntimeCatalogFromInstalledArtifacts } from './catalog.js';
import { getQueryContext, invalidateQueryContext, type QueryContext } from '../indexes/queryContext.js';
import { retrieveKnowledge, type DkbRetrieveKnowledgeRequest } from '../read/runtime.js';
import { renderModelEvidence } from '../read/modelEvidence.js';
import { recordRetrievalTrace } from './trace.js';
import { loadDkb, loadRegistry } from '../protocol/manifest.js';
import { DkbError } from '../protocol/errors.js';
import type { DkbSourceManifest, LoadedDkb } from '../protocol/types.js';

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

  return {
    ok: true,
    stateRoot: paths.stateRoot,
    registryPath: paths.stateRoot,
    packageCount: dkbIds.length,
    dkbIds,
  };
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
    : await compileComposeProject(paths.stateRoot, { force: true });
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

export async function removeDkbFromRuntime(id: string, stateRoot?: string) {
  const paths = await ensureRuntimeState(stateRoot);
  const packageRoots = await installedDkbRoots(paths, id);

  if (packageRoots.length === 0) {
    throw new DkbError(`Runtime DKB is not installed: ${id}`);
  }

  await Promise.all(packageRoots.map((packagePath) => fs.rm(packagePath, { recursive: true, force: true })));
  await refreshRuntimeCatalogFromInstalledArtifacts(paths.stateRoot);
  await removeRuntimeDependencyEntries(paths.stateRoot, id, packageRoots);
  invalidateRuntimeQuerySnapshot(paths.stateRoot);

  return {
    status: 'removed',
    id,
    registryPath: paths.stateRoot,
  };
}

export async function compileRuntimeDkb(id?: string, stateRoot?: string) {
  const paths = await ensureRuntimeState(stateRoot);

  if (id && (await installedDkbRoots(paths, id)).length === 0) {
    throw new DkbError(`Runtime DKB is not installed: ${id}`);
  }

  const compiled = await compileComposeProject(paths.stateRoot, { force: true });
  invalidateRuntimeQuerySnapshot(paths.stateRoot);

  return compiled;
}

export async function retrieveFromRuntime(request: DkbRetrieveKnowledgeRequest, stateRoot?: string) {
  const paths = await ensureRuntimeState(stateRoot);
  const registry = await loadRegistry(paths.stateRoot);
  const snapshotKey = path.resolve(paths.stateRoot);
  let queryContext = runtimeQueryContexts.get(snapshotKey);

  if (!queryContext) {
    queryContext = await getQueryContext(paths.stateRoot, registry.manifest.id);
    runtimeQueryContexts.set(snapshotKey, queryContext);
  }

  const response = await retrieveKnowledge(paths.stateRoot, request, queryContext);

  if (process.env.DKB_TRACE_ENABLED !== 'false') {
    await recordRetrievalTrace({
      root: paths.stateRoot,
      request,
      response,
      modelText: renderModelEvidence(response),
    });
  }

  return response;
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

async function writeGeneratedDkbManifest(root: string, manifest: DkbSourceManifest): Promise<void> {
  await fs.writeFile(path.join(root, 'dkb.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function ensureRuntimeProjectManifest(root: string): Promise<void> {
  const manifestPath = path.join(root, 'dkb.json');

  if (await exists(manifestPath)) {
    return;
  }

  await fs.writeFile(manifestPath, `${JSON.stringify({
    manifestVersion: 1,
    type: 'registry',
    name: titleFromId(path.basename(root) || 'Runtime Registry'),
    version: '0.0.0-local',
    description: 'Local DKB runtime registry.',
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
