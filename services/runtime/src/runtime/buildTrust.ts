import fs from 'node:fs/promises';
import path from 'node:path';
import { listPackageBuilds, validateStoredPackageBuild, DKB_RETRIEVAL_BUILD_LOCK } from '@sjshovan/dkb-library/builds.js';
import { readLibraryState } from '@sjshovan/dkb-library/state.js';
import { validateRetrievalBuildLock } from '@sjshovan/dkb-protocol/builds.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { parseDkbIdentity } from '@sjshovan/dkb-protocol/identity.js';
import { assertFileSnapshotCurrent, captureFileSnapshot } from '@sjshovan/dkb-protocol/fileSnapshot.js';
import { resolveContainedPath } from '@sjshovan/dkb-protocol/paths.js';
import type { DkbBuildTrustVerification } from '@sjshovan/dkb-protocol/packageInspection.js';
import { verifyRetainedRegistryBuild } from './registryInstall.js';

/** Explicit, read-only verification of one stored build, never an activation. */
export async function verifyInstalledBuildTrust(input: {
  libraryRoot: string; identity: string; buildDigest: string;
}): Promise<DkbBuildTrustVerification> {
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.buildDigest)) throw new DkbError('Build verification requires an exact sha256 digest.');
  const identity = parseDkbIdentity(input.identity, 'Installed package').identity;
  const state = await readLibraryState(input.libraryRoot);
  const entry = state.entries[identity];
  if (!entry || entry.kind !== 'dkb' || entry.status !== 'installed') throw new DkbError('Build verification requires an installed DKB.');
  const packageRoot = await fs.realpath(resolveContainedPath(input.libraryRoot, entry.path, 'Installed package'));
  const libraryRoot = await fs.realpath(input.libraryRoot);
  const relative = path.relative(libraryRoot, packageRoot);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new DkbError('Installed package path escapes its Library.');
  const stored = await listPackageBuilds(packageRoot);
  const kind = stored.retrieval.some((item) => item.buildDigest === input.buildDigest) ? 'retrieval'
    : stored.evidence.some((item) => item.evidenceDigest === input.buildDigest) ? 'evidence' : undefined;
  if (!kind) throw new DkbError('The exact build is not stored for this installed DKB.');
  const result = (status: DkbBuildTrustVerification['status'], message: string): DkbBuildTrustVerification => ({
    format: 'dkb.build-trust.v1', identity, buildDigest: input.buildDigest,
    kind, status, checkedAt: new Date().toISOString(), message,
  });
  try {
    const candidates = kind === 'retrieval' ? stored.retrieval.filter((candidate) => candidate.buildDigest === input.buildDigest) : stored.retrieval;
    let failure: unknown;
    for (const candidate of candidates) {
      try {
        const lockPath = path.join(candidate.path, DKB_RETRIEVAL_BUILD_LOCK);
        const lock = validateRetrievalBuildLock(JSON.parse(await fs.readFile(lockPath, 'utf8')), lockPath);
        if (kind === 'evidence' && lock.evidenceDigest !== input.buildDigest) continue;
        const evidence = stored.evidence.find((item) => item.evidenceDigest === lock.evidenceDigest && item.profileDigest === lock.evidenceProfileDigest);
        if (!evidence) throw new DkbError('The parent Evidence Build is missing.');
        const observed = await captureFileSnapshot([candidate.path, evidence.path], { recursive: true });
        const graph = await validateStoredPackageBuild(packageRoot, {
          version: entry.version!, evidenceProfileDigest: lock.evidenceProfileDigest, evidenceDigest: lock.evidenceDigest,
          retrievalProfileDigest: candidate.profileDigest, retrievalBuildDigest: candidate.buildDigest,
        });
        if (graph.evidence.package.id !== identity) throw new DkbError('Build belongs to another package.');
        if (entry.source === 'registry') {
          if (!entry.registryUrl) throw new DkbError('The installed release has no pinned Registry origin.');
          await verifyRetainedRegistryBuild({ libraryRoot, packageRoot, registryUrl: entry.registryUrl, graph, target: graph.profile.profile.target });
        }
        await assertFileSnapshotCurrent(observed);
        if (stableHash((await readLibraryState(libraryRoot)).entries[identity]) !== stableHash(entry)) throw new DkbError('Library state changed during verification. Reload and retry.');
        return entry.source === 'registry'
          ? result('registry-verified', 'Verified this exact build, its parent receipts, artifact hashes, installed release, and Library-pinned Registry signing key. This does not activate a Runtime.')
          : result('local-verified', 'Verified the local build graph and artifact hashes. This editable build is not Registry-signed and cannot satisfy Registry-origin trust.');
      } catch (error) { failure = error; }
    }
    if (failure) throw failure;
    return result('unverified', 'No complete Retrieval chain references this Evidence Build. Receipt presence alone is not signature verification. Prepare a complete build before verifying its chain.');
  } catch (error) {
    return result('failed', error instanceof Error ? error.message : String(error));
  }
}
