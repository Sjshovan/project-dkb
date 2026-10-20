import fs from 'node:fs/promises';
import path from 'node:path';
import { DKB_PACKAGE_RECEIPT_PATH, parsePackageReceipt } from '@sjshovan/dkb-library/signing.js';
import { readLibraryState } from '@sjshovan/dkb-library/state.js';
import { captureLibraryReadFence, assertLibraryReadFence } from '@sjshovan/dkb-library/mutation.js';
import { validateStoredPackageBuild } from '@sjshovan/dkb-library/builds.js';
import { libraryStateIdentity } from '@sjshovan/dkb-library/state.js';
import { readEvidenceCatalog } from '@sjshovan/dkb-library/evidenceCatalog.js';
import { loadLibrary, uniqueLoadedDkbs } from '@sjshovan/dkb-protocol/manifest.js';
import type { LoadedDkb } from '@sjshovan/dkb-protocol/types.js';
import type { DkbRuntimeActivation } from '@sjshovan/dkb-protocol/runtimeActivation.js';
import { runtimeActivationDigest } from '@sjshovan/dkb-protocol/runtimeActivation.js';
import type { DkbRetrievalProfileLock } from '@sjshovan/dkb-protocol/retrievalProfile.js';
import { DKB_RUNTIME_VERSION } from '../version.js';
import { maybeReadJsonObject, pathExists } from './paths.js';
import { ensureRuntimeState, type DkbRuntimeInstance } from './activation.js';
import { listQueryObserverHealth, type DkbQueryObserverHealth } from './queryAudit.js';

export interface DkbRuntimeObserverHealthSummary {
  status: 'available' | 'unavailable';
  entries: DkbQueryObserverHealth[];
  detail?: string;
}

export interface DkbRuntimeStatus {
  ok: true;
  version: string;
  runtimeId: string;
  stateRoot: string;
  libraryPath: string;
  target: string;
  stale: boolean;
  packageCount: number;
  dkbIds: string[];
  packages: Array<{
    id: string;
    version: string;
    packageTreeHash?: string;
  }>;
  retrievalProfile: DkbRetrievalProfileLock | null;
  activation: DkbRuntimeActivation | null;
  observerHealth: DkbRuntimeObserverHealthSummary;
}

export type DkbRuntimePublicStatus = Omit<DkbRuntimeStatus, 'stateRoot' | 'libraryPath' | 'observerHealth'> & {
  library: {
    id: string;
    generation: number;
    stateDigest: string;
  };
  observerHealth: Omit<DkbRuntimeObserverHealthSummary, 'entries'> & {
    entries: Array<Omit<DkbQueryObserverHealth, 'detail'>>;
  };
};

export interface DkbRuntimePackageListing {
  libraryRoot: string;
  generation: number;
  packages: Array<{
    id: string;
    version: string;
    kind: 'dkb' | 'collection';
    status: 'installed' | 'broken' | 'untracked';
    recordCount?: number;
    path: string;
    source?: 'local' | 'registry';
    registryUrl?: string;
  }>;
}

export async function runtimeStatus(stateRoot?: string): Promise<DkbRuntimeStatus> {
  const paths = await ensureRuntimeState(stateRoot);
  const dkbs = await installedDkbs(paths);
  const dkbIds = dkbs.map((dkb) => dkb.manifest.id).sort();
  const packageTreeHashes = await runtimePackageTreeHashes(paths.libraryRoot);
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
  const identity = await libraryStateIdentity(paths.libraryRoot);
  const stale = Boolean(paths.activation && (
    paths.activation.library.id !== identity.id
    || paths.activation.library.generation !== identity.generation
    || paths.activation.library.stateDigest !== identity.stateDigest
  ));
  const retrievalProfile = paths.activation
    ? await activeRetrievalProfile(dkbs, paths.activation).catch(() => null)
    : null;
  const observerHealth = await readRuntimeObserverHealth(paths.stateRoot, paths.activation);

  return {
    ok: true,
    version: DKB_RUNTIME_VERSION,
    runtimeId: paths.runtimeId,
    stateRoot: paths.stateRoot,
    libraryPath: paths.libraryRoot,
    target: paths.binding.target,
    stale,
    packageCount: dkbIds.length,
    dkbIds,
    packages,
    retrievalProfile,
    activation: paths.activation,
    observerHealth,
  };
}

export async function runtimePublicStatus(stateRoot?: string): Promise<DkbRuntimePublicStatus> {
  const status = await runtimeStatus(stateRoot);
  const { stateRoot: _stateRoot, libraryPath: _libraryPath, observerHealth, ...publicStatus } = status;
  const library = await libraryStateIdentity(status.libraryPath);
  return {
    ...publicStatus,
    library,
    observerHealth: {
      status: observerHealth.status,
      ...(observerHealth.detail ? { detail: observerHealth.detail } : {}),
      entries: observerHealth.entries.map(({ detail: _detail, ...entry }) => entry),
    },
  };
}

async function activeRetrievalProfile(dkbs: LoadedDkb[], activation: DkbRuntimeActivation): Promise<DkbRetrievalProfileLock> {
  const dkb = dkbs.find((candidate) => Boolean(activation.packages[candidate.manifest.id]));
  if (!dkb) {
    throw new Error(`Runtime activation ${activation.retrievalProfileDigest} does not reference an installed DKB`);
  }
  const entry = activation.packages[dkb.manifest.id]!;
  const graph = await validateStoredPackageBuild(dkb.root, entry);
  return graph.profile;
}

async function readRuntimeObserverHealth(
  stateRoot: string,
  activation: DkbRuntimeActivation | null,
): Promise<DkbRuntimeObserverHealthSummary> {
  if (!activation) return { status: 'available', entries: [] };
  try {
    return {
      status: 'available',
      entries: await listQueryObserverHealth(stateRoot, runtimeActivationDigest(activation)),
    };
  } catch (error) {
    console.error(JSON.stringify({
      event: 'dkb.query_observer.health_read_failed',
      message: error instanceof Error ? error.message : String(error),
    }));
    return {
      status: 'unavailable',
      entries: [],
      detail: 'Observer health could not be read from Runtime audit state.',
    };
  }
}

export async function listRuntimePackages(stateRoot?: string): Promise<DkbRuntimePackageListing> {
  const paths = await ensureRuntimeState(stateRoot);
  return listLibraryPackages(paths.libraryRoot, paths.activation);
}

export async function listLibraryPackages(
  libraryRoot: string,
  activation: DkbRuntimeActivation | null = null,
): Promise<DkbRuntimePackageListing> {
  const resolvedLibraryRoot = path.resolve(libraryRoot);
  const fence = await captureLibraryReadFence(resolvedLibraryRoot);
  const state = await readLibraryState(resolvedLibraryRoot);
  const candidates = new Map<string, string>();

  for (const entry of Object.values(state.entries)) {
    candidates.set(entry.identity, path.resolve(resolvedLibraryRoot, entry.path));
  }

  try {
    const vendorDir = path.join(resolvedLibraryRoot, 'vendor');
    for (const namespace of await fs.readdir(vendorDir, { withFileTypes: true })) {
      if (!namespace.isDirectory() || !namespace.name.startsWith('@') || namespace.name.includes('.replace-')) continue;
      const namespacePath = path.join(vendorDir, namespace.name);
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
      ? activation?.packages[id]
        ? await validateStoredPackageBuild(packagePath, activation.packages[id]!)
          .then((graph) => readEvidenceCatalog(graph.evidencePath).records.length)
          .catch(() => undefined)
        : undefined
      : undefined;

    return {
      id,
      version: stateEntry?.version ?? (typeof manifest.version === 'string' ? manifest.version : stateEntry?.revision ? `r${stateEntry.revision}` : '-'),
      kind,
      status: stateEntry?.status ?? 'untracked' as const,
      ...(typeof recordCount === 'number' ? { recordCount } : {}),
      path: packagePath,
      ...(stateEntry ? { source: stateEntry.source, ...(stateEntry.registryUrl ? { registryUrl: stateEntry.registryUrl } : {}) } : {}),
    };
  }));

  await assertLibraryReadFence(resolvedLibraryRoot, fence);
  return {
    libraryRoot: resolvedLibraryRoot,
    generation: state.generation,
    packages: packages.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export async function runtimeLibrary(stateRoot?: string) {
  const status = await runtimeStatus(stateRoot);
  const identity = await libraryStateIdentity(status.libraryPath);

  return {
    library: {
      id: identity.id,
      path: status.libraryPath,
      dkbIds: status.dkbIds,
      packageCount: status.packageCount,
    },
  };
}

export async function installedDkbs(paths: DkbRuntimeInstance): Promise<LoadedDkb[]> {
  try {
    const library = await loadLibrary(paths.libraryRoot);
    return uniqueLoadedDkbs([
      ...library.collections.flatMap((collection) => collection.dkbs),
      ...library.dkbs,
    ]);
  } catch {
    return [];
  }
}

export async function runtimeLibraryId(paths: DkbRuntimeInstance): Promise<string> {
  return (await loadLibrary(paths.libraryRoot)).manifest.id;
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
