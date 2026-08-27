import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stableHash } from '@dkb/protocol/contracts/hash.js';
import { loadLibrary, uniqueLoadedDkbs } from '@dkb/protocol/manifest.js';
import {
  DKB_ARTIFACT_LOCK_PATH,
  artifactLockPath,
  resolveFrom,
} from '@dkb/protocol/paths.js';
import type { DkbLockArtifact, DkbLockManifest, LoadedDkb } from '@dkb/protocol/types.js';
import { validateDkbLockManifest } from '@dkb/protocol/validation.js';
import {
  SOURCE_GRAPH_PATH,
  SOURCE_INDEX_PATH,
  SOURCE_VECTOR_PATH,
  readSourceIndex,
  type IndexedSourceUnit,
} from '@dkb/providers-bundled/sourceIndex.js';
import {
  DKB_RETRIEVAL_PROFILE_LOCK_PATH,
  maybeReadRetrievalProfileLock,
} from '@dkb/pipeline/profile.js';
import { inspectDkbArtifactManifest, writeDkbArtifactManifest } from './artifacts.js';

/**
 * Rebuild aggregate Library receipts from already-compiled package receipts.
 * This is an activation operation: it never parses, chunks, or embeds source.
 */
export async function refreshInstalledLibraryArtifactMetadata(root: string): Promise<DkbLockManifest> {
  const resolvedRoot = path.resolve(root);
  const library = await loadLibrary(resolvedRoot);
  const dkbs = uniqueLoadedDkbs([
    ...library.collections.flatMap((collection) => collection.dkbs),
    ...library.dkbs,
  ]);
  const sourceIndex = await readSourceIndex(resolvedRoot);
  const packages = Object.fromEntries(await Promise.all(dkbs.map(async (dkb) => [
    dkb.manifest.id,
    await installedPackageReceipt(resolvedRoot, dkb),
  ])));
  const sourceIndexHash = await maybeHashArtifact(resolveFrom(resolvedRoot, SOURCE_INDEX_PATH));
  const sourceGraphHash = await maybeHashArtifact(resolveFrom(resolvedRoot, SOURCE_GRAPH_PATH));
  const sourceVectorHash = await maybeHashArtifact(resolveFrom(resolvedRoot, SOURCE_VECTOR_PATH));
  const retrievalProfile = await maybeReadRetrievalProfileLock(resolvedRoot);
  const previousManifest = await inspectDkbArtifactManifest(resolvedRoot).catch(() => null);
  const lock: DkbLockManifest = {
    registry: {
      id: library.manifest.id,
      name: library.manifest.name,
      version: library.manifest.version,
    },
    packages,
    artifacts: {
      sourceIndex: artifact(SOURCE_INDEX_PATH, sourceIndexHash),
      sourceGraph: artifact(SOURCE_GRAPH_PATH, sourceGraphHash),
      sourceVector: artifact(SOURCE_VECTOR_PATH, sourceVectorHash),
    },
    ...(retrievalProfile ? {
      retrievalProfile: {
        path: DKB_RETRIEVAL_PROFILE_LOCK_PATH,
        profileDigest: retrievalProfile.profileDigest,
      },
    } : {}),
    compiled: {
      path: SOURCE_INDEX_PATH,
      artifactHash: sourceIndexHash,
      chunkRepositoryHash: stableHash(sourceIndex.units.map(sourceUnitHashProjection)),
      indexHash: stableHash({ sourceIndexHash, sourceGraphHash, sourceVectorHash }),
      recordCount: sourceIndex.units.length,
      compiledAt: new Date().toISOString(),
    },
  };
  const lockPath = artifactLockPath(resolvedRoot);
  const temporaryPath = `${lockPath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  const backupPath = `${lockPath}.replace-${process.pid}-${Date.now().toString(36)}`;
  const hadLock = await exists(lockPath);

  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(temporaryPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  if (hadLock) await fs.rename(lockPath, backupPath);

  try {
    await fs.rename(temporaryPath, lockPath);
    await writeDkbArtifactManifest(resolvedRoot, lock, {
      ...(previousManifest?.compiler ? { compiler: previousManifest.compiler } : {}),
    });
    await fs.rm(backupPath, { force: true });
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    await fs.rm(lockPath, { force: true });
    if (hadLock) await fs.rename(backupPath, lockPath);
    throw error;
  }

  return lock;
}

async function installedPackageReceipt(libraryRoot: string, dkb: LoadedDkb): Promise<DkbLockManifest['packages'][string]> {
  const sourcePath = artifactLockPath(dkb.root);
  const packageLock = validateDkbLockManifest(JSON.parse(await fs.readFile(sourcePath, 'utf8')), sourcePath);
  const receipt = packageLock.packages[dkb.manifest.id];

  if (!receipt) {
    throw new Error(`Compiled package ${dkb.manifest.id} has no package receipt in ${DKB_ARTIFACT_LOCK_PATH}`);
  }

  return {
    ...receipt,
    path: dkb.packagePath
      ? path.relative(libraryRoot, dkb.packagePath).replace(/\\/g, '/')
      : path.relative(libraryRoot, dkb.root).replace(/\\/g, '/') || null,
  };
}

function sourceUnitHashProjection(unit: IndexedSourceUnit): Record<string, unknown> {
  return {
    id: unit.id,
    assetId: unit.assetId,
    dkbId: unit.dkbId,
    storeId: unit.storeId,
    type: unit.type,
    locator: unit.locator,
    assetLocator: unit.assetLocator,
    title: unit.title,
    text: unit.text,
    keywords: unit.keywords,
    hash: unit.hash,
    updatedAt: unit.updatedAt,
    chunkOrdinal: unit.chunkOrdinal,
    chunkStart: unit.chunkStart,
    chunkEnd: unit.chunkEnd,
  };
}

function artifact(pathValue: string, hash: string | null): DkbLockArtifact {
  return {
    path: pathValue,
    hash,
    status: hash ? 'built' : 'not_built',
  };
}

async function maybeHashArtifact(target: string): Promise<string | null> {
  try {
    const stat = await fs.stat(target);

    return stat.isDirectory() ? hashDirectory(target) : hashFile(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

async function hashDirectory(root: string): Promise<string> {
  const files = await listFiles(root, root);
  const entries = await Promise.all(files.map(async (file) => ({
    path: path.relative(root, file).replace(/\\/g, '/'),
    hash: await hashFile(file),
  })));

  return stableHash(entries);
}

async function listFiles(root: string, current: string): Promise<string[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(current, entry.name);

    if (entry.isDirectory()) {
      return listFiles(root, target);
    }

    return entry.isFile() ? [target] : [];
  }));

  return nested.flat().sort((left, right) => left.localeCompare(right));
}

async function hashFile(target: string): Promise<string> {
  return `sha256:${createHash('sha256').update(await fs.readFile(target)).digest('hex')}`;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
