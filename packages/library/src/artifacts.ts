import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import { DatabaseSync } from 'node:sqlite';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DKB_ARTIFACT_LOCK_PATH, DKB_ARTIFACTS_DIR, artifactLockPath, resolveFrom } from '@sjshovan/dkb-protocol/paths.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { SOURCE_GRAPH_PATH, SOURCE_INDEX_PATH, SOURCE_VECTOR_PATH } from '@sjshovan/dkb-providers-bundled/sourceIndex.js';
import { LLAMAINDEX_COMPILER_BUNDLE_MANIFEST_PATH, LLAMAINDEX_COMPILER_RECORDS_DIR } from '@sjshovan/dkb-providers-bundled/llamaindexArtifacts.js';
import { FAISS_CATALOG_PATH, FAISS_MANIFEST_PATH, FAISS_SEGMENT_PATH } from '@sjshovan/dkb-providers-bundled/faissStore.js';
import { progressFinish, progressStart, progressUpdate, type DkbProgressReporter } from '@sjshovan/dkb-protocol/progress.js';
import { DKB_EVIDENCE_IR_PATH, readEvidenceIr, type DkbEvidenceIr } from '@sjshovan/dkb-protocol/evidence/ir.js';
import {
  DKB_RETRIEVAL_PROFILE_LOCK_PATH,
  readRetrievalProfileLock,
  type DkbRetrievalProfileLock,
} from '@sjshovan/dkb-pipeline/profile.js';
import type { DkbLockManifest } from '@sjshovan/dkb-protocol/types.js';

export const DKB_ARTIFACT_MANIFEST_VERSION = 1;
export const DKB_ARTIFACT_MANIFEST_PATH = `${DKB_ARTIFACTS_DIR}/dkb-artifact.json`;
export const DKB_ARTIFACT_PACKAGE_EXTENSION = '.dkbpkg';
export const DKB_ARTIFACT_PACKAGE_MEDIA_TYPE = 'application/vnd.dkb.artifact+tar+gzip';

export interface DkbArtifactFile {
  path: string;
  hash: string;
  size: number;
}

export interface DkbArtifactManifest {
  type: 'dkb.artifact';
  version: typeof DKB_ARTIFACT_MANIFEST_VERSION;
  mediaType: typeof DKB_ARTIFACT_PACKAGE_MEDIA_TYPE;
  registry: {
    id: string;
    name: string;
    version: string;
  };
  compiler: DkbArtifactCompiler;
  layout: {
    root: '.';
    manifest: 'dkb.json';
    lock: typeof DKB_ARTIFACT_LOCK_PATH;
    artifacts: typeof DKB_ARTIFACTS_DIR;
  };
  counts: {
    packages: number;
    records: number;
    sourceUnits: number | null;
    sourceAssets: number | null;
  };
  retrievalProfile?: {
    path: typeof DKB_RETRIEVAL_PROFILE_LOCK_PATH;
    profileDigest: string;
  };
  evidence?: {
    path: typeof DKB_EVIDENCE_IR_PATH;
    records: number;
    chunks: number;
  };
  files: DkbArtifactFile[];
  hashes: {
    lock: string;
    artifactTree: string;
  };
  generatedAt: string;
}

export interface DkbArtifactCompiler {
  id: string;
  version?: number | string;
  model?: string;
  dimensions?: number;
  optionalDependencies?: Array<{
    package: string;
    available: boolean;
  }>;
  compilers?: DkbArtifactCompiler[];
}

export interface ValidateDkbArtifactManifestResult {
  ok: boolean;
  manifestPath: string;
  manifest?: DkbArtifactManifest;
  checks: Array<{
    name: string;
    ok: boolean;
    detail: string;
  }>;
}

export interface PackDkbArtifactResult {
  status: 'packed';
  root: string;
  archivePath: string;
  archiveHash: string;
  archiveBytes: number;
  manifest: DkbArtifactManifest;
}

const REQUIRED_ARTIFACT_PATHS = [
  SOURCE_INDEX_PATH,
  SOURCE_GRAPH_PATH,
  SOURCE_VECTOR_PATH,
];

const OPTIONAL_ARTIFACT_PATHS = [
  `${DKB_ARTIFACTS_DIR}/llamaindex.compiler.json`,
  LLAMAINDEX_COMPILER_BUNDLE_MANIFEST_PATH,
  FAISS_CATALOG_PATH,
  FAISS_SEGMENT_PATH,
  FAISS_MANIFEST_PATH,
  DKB_RETRIEVAL_PROFILE_LOCK_PATH,
  DKB_EVIDENCE_IR_PATH,
];
const PROVIDER_ARTIFACTS_DIR = `${DKB_ARTIFACTS_DIR}/providers`;

export async function writeDkbArtifactManifest(root: string, lock: DkbLockManifest, options: { compiler?: DkbArtifactCompiler } = {}): Promise<DkbArtifactManifest> {
  const resolvedRoot = path.resolve(root);
  const manifest = await buildDkbArtifactManifest(resolvedRoot, lock, options);
  const outputPath = resolveFrom(resolvedRoot, DKB_ARTIFACT_MANIFEST_PATH);
  const tempPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await fs.rm(outputPath, { force: true });
  await fs.rename(tempPath, outputPath);

  return manifest;
}

export async function inspectDkbArtifactManifest(root: string): Promise<DkbArtifactManifest> {
  const manifestFile = resolveFrom(root, DKB_ARTIFACT_MANIFEST_PATH);
  const parsed = JSON.parse(await fs.readFile(manifestFile, 'utf8')) as unknown;

  return parseDkbArtifactManifest(parsed, manifestFile);
}

export async function validateDkbArtifactManifest(root: string, options: { progress?: DkbProgressReporter } = {}): Promise<ValidateDkbArtifactManifestResult> {
  const resolvedRoot = path.resolve(root);
  const manifestFile = resolveFrom(resolvedRoot, DKB_ARTIFACT_MANIFEST_PATH);
  const checks: ValidateDkbArtifactManifestResult['checks'] = [];
  let manifest: DkbArtifactManifest;

  try {
    manifest = await inspectDkbArtifactManifest(resolvedRoot);
    checks.push({ name: 'manifest.schema', ok: true, detail: 'artifact manifest is parseable' });
  } catch (error) {
    return {
      ok: false,
      manifestPath: manifestFile,
      checks: [{
        name: 'manifest.schema',
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      }],
    };
  }

  if (options.progress && manifest.files.length > 0) {
    options.progress(progressStart({
      phase: 'verify-files',
      label: 'Verify artifact files',
      total: manifest.files.length,
      unit: 'files',
    }));
  }

  for (const [index, file] of manifest.files.entries()) {
    const target = containedPath(resolvedRoot, file.path);
    const actual = await fileDigest(target);
    const ok = actual?.hash === file.hash && actual.size === file.size;

    checks.push({
      name: `file.${file.path}`,
      ok,
      detail: ok ? 'hash and size match' : `expected ${file.hash} (${file.size} bytes), got ${actual?.hash ?? 'missing'} (${actual?.size ?? 0} bytes)`,
    });

    if (options.progress && manifest.files.length > 0) {
      options.progress(progressUpdate({
        phase: 'verify-files',
        label: 'Verify artifact files',
        value: index + 1,
        total: manifest.files.length,
        unit: 'files',
      }));
    }
  }

  if (options.progress && manifest.files.length > 0) {
    options.progress(progressFinish({
      phase: 'verify-files',
      label: 'Verify artifact files',
      total: manifest.files.length,
      unit: 'files',
    }));
  }

  const lockHash = await hashFile(containedPath(resolvedRoot, manifest.layout.lock));
  checks.push({
    name: 'hash.lock',
    ok: lockHash === manifest.hashes.lock,
    detail: lockHash === manifest.hashes.lock ? 'lock hash matches' : `expected ${manifest.hashes.lock}, got ${lockHash}`,
  });

  const artifactTreeHash = stableHash(manifest.files.map(({ path, hash, size }) => ({ path, hash, size })));
  checks.push({
    name: 'hash.artifactTree',
    ok: artifactTreeHash === manifest.hashes.artifactTree,
    detail: artifactTreeHash === manifest.hashes.artifactTree ? 'artifact tree hash matches manifest files' : `expected ${manifest.hashes.artifactTree}, got ${artifactTreeHash}`,
  });

  if (manifest.retrievalProfile) {
    try {
      const lock = await readRetrievalProfileLock(resolvedRoot);
      checks.push({
        name: 'retrievalProfile.digest',
        ok: lock.profileDigest === manifest.retrievalProfile.profileDigest,
        detail: lock.profileDigest === manifest.retrievalProfile.profileDigest
          ? 'retrieval profile digest matches'
          : `expected ${manifest.retrievalProfile.profileDigest}, got ${lock.profileDigest}`,
      });
    } catch (error) {
      checks.push({
        name: 'retrievalProfile.digest',
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (manifest.evidence) {
    try {
      const evidence = await readEvidenceIr(resolvedRoot);
      const ok = evidence.evidence.length === manifest.evidence.records && evidence.chunks.length === manifest.evidence.chunks;
      checks.push({
        name: 'evidence.counts',
        ok,
        detail: ok
          ? 'Evidence IR counts match'
          : `expected ${manifest.evidence.records}/${manifest.evidence.chunks}, got ${evidence.evidence.length}/${evidence.chunks.length}`,
      });
    } catch (error) {
      checks.push({
        name: 'evidence.counts',
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    ok: checks.every((check) => check.ok),
    manifestPath: manifestFile,
    manifest,
    checks,
  };
}

export async function packDkbArtifact(root: string, archivePath: string): Promise<PackDkbArtifactResult> {
  const resolvedRoot = path.resolve(root);
  const resolvedArchive = path.resolve(archivePath);
  const manifest = await inspectDkbArtifactManifest(resolvedRoot);
  const validation = await validateDkbArtifactManifest(resolvedRoot);

  if (!validation.ok) {
    throw new DkbError(`Cannot pack invalid DKB artifact at ${resolvedRoot}`);
  }

  const entries = await packageEntriesFor(resolvedRoot, resolvedArchive);

  await fs.mkdir(path.dirname(resolvedArchive), { recursive: true });
  await tar.c({
    cwd: resolvedRoot,
    file: resolvedArchive,
    gzip: true,
    portable: true,
    noMtime: true,
    follow: false,
  }, entries);

  const archiveDigest = await fileDigest(resolvedArchive);

  if (!archiveDigest) {
    throw new DkbError(`Artifact package was not written: ${resolvedArchive}`);
  }

  return {
    status: 'packed',
    root: resolvedRoot,
    archivePath: resolvedArchive,
    archiveHash: archiveDigest.hash,
    archiveBytes: archiveDigest.size,
    manifest,
  };
}

async function buildDkbArtifactManifest(root: string, lock: DkbLockManifest, options: { compiler?: DkbArtifactCompiler }): Promise<DkbArtifactManifest> {
  const files = (await Promise.all([
    'dkb.json',
  ].map((item) => artifactFileFor(root, item)))).filter(isArtifactFile);

  // The artifact manifest describes its payload. Including the manifest itself
  // would hash the previous revision and make every forced rebuild invalid.
  for (const item of [
    DKB_ARTIFACT_LOCK_PATH,
    ...REQUIRED_ARTIFACT_PATHS,
    ...OPTIONAL_ARTIFACT_PATHS,
    ...await compilerRecordArtifactPaths(root),
    ...await listRelativeFiles(resolveFrom(root, PROVIDER_ARTIFACTS_DIR), PROVIDER_ARTIFACTS_DIR),
  ]) {
    const file = await artifactFileFor(root, item);

    if (file) {
      files.push(file);
    }
  }

  const dedupedFiles = [...new Map(files.map((file) => [file.path, file])).values()]
    .sort((left, right) => left.path.localeCompare(right.path));
  const lockHash = await hashFile(artifactLockPath(root));
  const sourceCounts = await sourceIndexCounts(root);
  const [retrievalProfile, evidence] = await Promise.all([
    readRetrievalProfileLock(root).catch(() => null),
    readEvidenceIr(root).catch(() => null),
  ]);

  return {
    type: 'dkb.artifact',
    version: DKB_ARTIFACT_MANIFEST_VERSION,
    mediaType: DKB_ARTIFACT_PACKAGE_MEDIA_TYPE,
    registry: lock.registry,
    compiler: options.compiler ?? { id: 'dkb.artifact-refresh', version: 1 },
    layout: {
      root: '.',
      manifest: 'dkb.json',
      lock: DKB_ARTIFACT_LOCK_PATH,
      artifacts: DKB_ARTIFACTS_DIR,
    },
    counts: {
      packages: Object.keys(lock.packages).length,
      records: lock.compiled?.recordCount ?? 0,
      sourceUnits: sourceCounts.units,
      sourceAssets: sourceCounts.assets,
    },
    ...(retrievalProfile ? {
      retrievalProfile: {
        path: DKB_RETRIEVAL_PROFILE_LOCK_PATH,
        profileDigest: retrievalProfile.profileDigest,
      },
    } : {}),
    ...(evidence ? {
      evidence: {
        path: DKB_EVIDENCE_IR_PATH,
        records: evidence.evidence.length,
        chunks: evidence.chunks.length,
      },
    } : {}),
    files: dedupedFiles,
    hashes: {
      lock: lockHash,
      artifactTree: stableHash(dedupedFiles.map(({ path, hash, size }) => ({ path, hash, size }))),
    },
    generatedAt: new Date().toISOString(),
  };
}

async function sourceIndexCounts(root: string): Promise<{ assets: number | null; units: number | null }> {
  const compilerCounts = await compilerBundleCounts(root);

  if (compilerCounts) {
    return compilerCounts;
  }

  const sourceIndexPath = resolveFrom(root, SOURCE_INDEX_PATH);

  try {
    const database = new DatabaseSync(sourceIndexPath, { readOnly: true });

    try {
      const units = database.prepare('select count(*) as count from source_units').get() as { count: number };
      const assets = database.prepare('select count(*) as count from source_assets').get() as { count: number };

      return {
        units: Number(units.count),
        assets: Number(assets.count),
      };
    } finally {
      database.close();
    }
  } catch {
    return {
      units: null,
      assets: null,
    };
  }
}

async function compilerBundleCounts(root: string): Promise<{ assets: number; units: number } | null> {
  try {
    const manifest = JSON.parse(await fs.readFile(resolveFrom(root, LLAMAINDEX_COMPILER_BUNDLE_MANIFEST_PATH), 'utf8')) as {
      recordCount?: unknown;
      sources?: unknown;
    };

    return {
      units: typeof manifest.recordCount === 'number' ? manifest.recordCount : 0,
      assets: Array.isArray(manifest.sources) ? manifest.sources.length : 0,
    };
  } catch {
    return null;
  }
}

function parseDkbArtifactManifest(value: unknown, source: string): DkbArtifactManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DkbError(`Invalid DKB artifact manifest at ${source}: expected object`);
  }

  const candidate = value as Partial<DkbArtifactManifest>;

  if (candidate.type !== 'dkb.artifact' || candidate.version !== DKB_ARTIFACT_MANIFEST_VERSION) {
    throw new DkbError(`Invalid DKB artifact manifest at ${source}: unsupported type or version`);
  }

  if (!candidate.registry || !candidate.layout || !Array.isArray(candidate.files) || !candidate.hashes) {
    throw new DkbError(`Invalid DKB artifact manifest at ${source}: missing registry, layout, files, or hashes`);
  }

  return candidate as DkbArtifactManifest;
}

async function artifactFileFor(root: string, relativePath: string): Promise<DkbArtifactFile | null> {
  const target = containedPath(root, relativePath);
  const digest = await fileDigest(target);

  return digest ? { path: relativePath.replace(/\\/g, '/'), ...digest } : null;
}

async function compilerRecordArtifactPaths(root: string): Promise<string[]> {
  return listRelativeFiles(resolveFrom(root, LLAMAINDEX_COMPILER_RECORDS_DIR), LLAMAINDEX_COMPILER_RECORDS_DIR);
}

function isArtifactFile(value: DkbArtifactFile | null): value is DkbArtifactFile {
  return Boolean(value);
}

async function packageEntriesFor(root: string, archivePath: string): Promise<string[]> {
  const entries = await listPackageEntries(root, root, archivePath);

  return entries.sort((left, right) => left.localeCompare(right));
}

async function listPackageEntries(root: string, current: string, archivePath: string): Promise<string[]> {
  const dirEntries = await fs.readdir(current, { withFileTypes: true });
  const nested = await Promise.all(dirEntries.map(async (entry) => {
    const target = path.join(current, entry.name);
    const relative = path.relative(root, target).replace(/\\/g, '/');

    if (path.resolve(target) === archivePath || shouldExcludePackageEntry(relative, entry)) {
      return [];
    }

    if (entry.isDirectory()) {
      return listPackageEntries(root, target, archivePath);
    }

    return entry.isFile() ? [relative] : [];
  }));

  return nested.flat();
}

async function listRelativeFiles(root: string, relativeRoot: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const target = path.join(root, entry.name);
      const relative = `${relativeRoot}/${entry.name}`.replace(/\\/g, '/');

      if (entry.isDirectory()) {
        return listRelativeFiles(target, relative);
      }

      return entry.isFile() ? [relative] : [];
    }));

    return nested.flat().sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function shouldExcludePackageEntry(relative: string, entry: import('node:fs').Dirent): boolean {
  if (entry.isSymbolicLink()) {
    return true;
  }

  const normalized = relative.replace(/\\/g, '/');

  return normalized === '.dkb/cache'
    || normalized.startsWith('.dkb/cache/')
    || normalized === '.dkb/locks'
    || normalized.startsWith('.dkb/locks/')
    || normalized === '.dkb/runs'
    || normalized.startsWith('.dkb/runs/')
    || normalized === '.dkb/config.json'
    || normalized === '.dkb/plugins'
    || normalized.startsWith('.dkb/plugins/');
}

async function fileDigest(target: string): Promise<{ hash: string; size: number } | null> {
  try {
    const stat = await fs.stat(target);

    if (!stat.isFile()) {
      return null;
    }

    return {
      hash: await hashFile(target),
      size: stat.size,
    };
  } catch {
    return null;
  }
}

async function hashFile(target: string): Promise<string> {
  const data = await fs.readFile(target);

  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

function containedPath(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new DkbError(`Artifact path must be relative: ${relativePath}`);
  }

  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolvedTarget);

  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolvedTarget;
  }

  throw new DkbError(`Artifact path escapes root: ${relativePath}`);
}
