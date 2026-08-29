import fs from 'node:fs/promises';
import path from 'node:path';
import { DKB_PACKAGE_RECEIPT_PATH, parsePackageReceipt } from '@sjshovan/dkb-library/signing.js';
import { readLibraryState } from '@sjshovan/dkb-library/state.js';
import { maybeReadRuntimeLock, validatePackageBuildGraph } from '@sjshovan/dkb-library/builds.js';
import { readEvidenceCatalog } from '@sjshovan/dkb-library/evidenceCatalog.js';
import { loadLibrary, uniqueLoadedDkbs } from '@sjshovan/dkb-protocol/manifest.js';
import type { LoadedDkb } from '@sjshovan/dkb-protocol/types.js';
import type { DkbRuntimeLock } from '@sjshovan/dkb-protocol/builds.js';
import type { DkbRetrievalProfileLock } from '@sjshovan/dkb-protocol/retrievalProfile.js';
import { DKB_RUNTIME_VERSION } from '../version.js';
import {
  ensureRuntimeState,
  maybeReadJsonObject,
  pathExists,
  runtimePaths,
  type DkbRuntimePaths,
} from './paths.js';

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
  runtimeLock: DkbRuntimeLock | null;
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
  const runtimeLock = await maybeReadRuntimeLock(paths.stateRoot);
  const retrievalProfile = runtimeLock ? await activeRetrievalProfile(dkbs, runtimeLock) : null;

  return {
    ok: true,
    version: DKB_RUNTIME_VERSION,
    stateRoot: paths.stateRoot,
    libraryPath: paths.stateRoot,
    packageCount: dkbIds.length,
    dkbIds,
    packages,
    retrievalProfile,
    runtimeLock,
  };
}

async function activeRetrievalProfile(dkbs: LoadedDkb[], runtime: DkbRuntimeLock): Promise<DkbRetrievalProfileLock> {
  const dkb = dkbs.find((candidate) => Boolean(runtime.packages[candidate.manifest.id]));
  if (!dkb) {
    throw new Error(`Runtime lock ${runtime.retrievalProfileDigest} does not reference an installed DKB`);
  }
  const entry = runtime.packages[dkb.manifest.id]!;
  const graph = await validatePackageBuildGraph(dkb.root, {
    ...runtime,
    packages: { [dkb.manifest.id]: entry },
  });
  return graph.profile;
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
      if (!namespace.isDirectory() || !namespace.name.startsWith('@') || namespace.name.includes('.replace-')) continue;
      const namespacePath = path.join(paths.vendorDir, namespace.name);
      for (const nested of await fs.readdir(namespacePath, { withFileTypes: true })) {
        if (!nested.isDirectory() || nested.name.includes('.replace-')) continue;
        const nestedPath = path.join(namespacePath, nested.name);
        if (await pathExists(path.join(nestedPath, 'dkb.json'))) {
          candidates.set(`${namespace.name}/${nested.name}`, nestedPath);
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const packages = await Promise.all([...candidates.entries()].map(async ([candidateIdentity, packagePath]) => {
    const manifest = await maybeReadJsonObject(path.join(packagePath, 'dkb.json')) ?? {};
    const id = typeof manifest.name === 'string' ? manifest.name : candidateIdentity;
    const stateEntry = state.entries[id];
    const kind = stateEntry?.kind ?? (manifest.type === 'collection' ? 'collection' as const : 'dkb' as const);
    const recordCount = kind === 'dkb'
      ? await validatePackageBuildGraph(packagePath)
        .then((graph) => readEvidenceCatalog(graph.evidencePath).records.length)
        .catch(() => undefined)
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

export async function installedDkbs(paths: DkbRuntimePaths): Promise<LoadedDkb[]> {
  try {
    const library = await loadLibrary(paths.stateRoot);
    return uniqueLoadedDkbs([
      ...library.collections.flatMap((collection) => collection.dkbs),
      ...library.dkbs,
    ]);
  } catch {
    return [];
  }
}

export async function runtimeLibraryId(paths: DkbRuntimePaths): Promise<string> {
  return (await loadLibrary(paths.stateRoot)).manifest.id;
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
