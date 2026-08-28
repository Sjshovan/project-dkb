import fs from 'node:fs/promises';
import path from 'node:path';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { parseDkbIdentity } from '@sjshovan/dkb-protocol/identity.js';
import { loadManifest } from '@sjshovan/dkb-protocol/manifest.js';
import { resolveContainedPath } from '@sjshovan/dkb-protocol/paths.js';
import { inspectDkbArtifactManifest } from './artifacts.js';
import { maybeReadRuntimeLock } from './builds.js';
import { DKB_PACKAGE_RECEIPT_PATH, parsePackageReceipt } from './signing.js';
import { readLibraryState } from './state.js';

export interface DkbInstalledPackageInfo {
  identity: string;
  kind: 'dkb' | 'collection';
  source: 'local' | 'registry';
  status: 'installed' | 'broken';
  version?: string;
  revision?: number;
  digest?: string;
  path: string;
  registryUrl?: string;
  requiredBy: string[];
  installedAt: string;
  displayName?: string;
  description?: string;
  records?: number;
  sources?: number;
  artifactStatus: 'ready' | 'not-applicable' | 'missing' | 'invalid';
  receiptStatus: 'present' | 'not-applicable' | 'missing' | 'invalid';
  activeBuild?: {
    target: string;
    evidenceProfileDigest: string;
    evidenceDigest: string;
    retrievalProfileDigest: string;
    retrievalBuildDigest: string;
  };
}

/**
 * Returns bounded operational metadata for one installed Library entry.
 * Source contents and private receipt material are deliberately not returned.
 */
export async function inspectInstalledPackage(
  libraryRoot: string,
  identity: string,
): Promise<DkbInstalledPackageInfo> {
  const root = path.resolve(libraryRoot);
  const normalizedIdentity = parseDkbIdentity(identity, 'Installed package identity').identity;
  const state = await readLibraryState(root);
  const entry = state.entries[normalizedIdentity];

  if (!entry) {
    throw new DkbError(
      `${normalizedIdentity} is not installed in ${root}. Run dkb list to see installed knowledge or dkb install ${normalizedIdentity}.`,
    );
  }

  const packageRoot = resolveContainedPath(root, entry.path, `Installed entry ${normalizedIdentity} path`);
  const manifest = await loadManifest(packageRoot).catch(() => null);
  const runtimeLock = await maybeReadRuntimeLock(root);
  const activeBuild = runtimeLock?.packages[normalizedIdentity];
  let artifactStatus: DkbInstalledPackageInfo['artifactStatus'] = entry.kind === 'dkb' ? 'missing' : 'not-applicable';
  let receiptStatus: DkbInstalledPackageInfo['receiptStatus'] = entry.kind === 'dkb' && entry.source === 'registry'
    ? 'missing'
    : 'not-applicable';
  let records: number | undefined;
  let sources: number | undefined;

  if (entry.kind === 'dkb') {
    try {
      const artifact = await inspectDkbArtifactManifest(packageRoot);
      artifactStatus = 'ready';
      records = artifact.counts.records;
      sources = artifact.counts.sourceAssets ?? undefined;
    } catch (error) {
      artifactStatus = missingFileError(error) ? 'missing' : 'invalid';
    }

    if (entry.source === 'registry') {
      const receiptPath = path.join(packageRoot, DKB_PACKAGE_RECEIPT_PATH);
      try {
        parsePackageReceipt(JSON.parse(await fs.readFile(receiptPath, 'utf8')) as unknown, receiptPath);
        receiptStatus = 'present';
      } catch (error) {
        receiptStatus = missingFileError(error) ? 'missing' : 'invalid';
      }
    }
  }

  return {
    identity: normalizedIdentity,
    kind: entry.kind,
    source: entry.source,
    status: entry.status,
    ...(entry.version ? { version: entry.version } : {}),
    ...(entry.revision ? { revision: entry.revision } : {}),
    ...(entry.digest ? { digest: entry.digest } : {}),
    path: packageRoot,
    ...(entry.registryUrl ? { registryUrl: entry.registryUrl } : {}),
    requiredBy: [...entry.requiredBy],
    installedAt: entry.installedAt,
    ...(manifest && 'displayName' in manifest && typeof manifest.displayName === 'string'
      ? { displayName: manifest.displayName }
      : {}),
    ...(manifest && 'description' in manifest && typeof manifest.description === 'string' && manifest.description
      ? { description: manifest.description }
      : {}),
    ...(records === undefined ? {} : { records }),
    ...(sources === undefined ? {} : { sources }),
    artifactStatus,
    receiptStatus,
    ...(activeBuild && runtimeLock
      ? {
          activeBuild: {
            target: runtimeLock.target,
            evidenceProfileDigest: activeBuild.evidenceProfileDigest,
            evidenceDigest: activeBuild.evidenceDigest,
            retrievalProfileDigest: activeBuild.retrievalProfileDigest,
            retrievalBuildDigest: activeBuild.retrievalBuildDigest,
          },
        }
      : {}),
  };
}

function missingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT');
}
