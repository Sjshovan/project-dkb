import fs from 'node:fs/promises';
import path from 'node:path';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { captureFileSnapshot, assertFileSnapshotCurrent } from '@sjshovan/dkb-protocol/fileSnapshot.js';
import { dependencyIntegrity, dependencyIntegrityInputs, shippedPackageFileHashes } from './dependencyIntegrity.js';

/** Capture once at process bootstrap, before admitting work from this package. */
export async function observeInstalledPackageIntegrity(packageRoot: string) {
  const root = path.resolve(packageRoot);
  const inputs = await dependencyIntegrityInputs(root, true);
  const snapshot = await captureFileSnapshot(inputs);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new DkbError('Installed package integrity requires an exact package name and version.');
  }
  const files = await shippedPackageFileHashes(root);
  if (!files || files.length === 0) throw new DkbError(`Installed package ${manifest.name} requires a nonempty explicit shipped-file allowlist.`);
  const fields = {
    packageName: manifest.name,
    packageVersion: manifest.version,
    filesDigest: stableHash(files),
    dependencyDigest: await dependencyIntegrity(root),
  };
  const currentInputs = await dependencyIntegrityInputs(root, true);
  if (stableHash([...inputs].sort()) !== stableHash([...currentInputs].sort())) {
    throw new DkbError(`Installed ${manifest.name} file inventory changed during process bootstrap. Restart before using this build.`, 'installed_build_drift');
  }
  await assertFileSnapshotCurrent(snapshot);
  const identity = Object.freeze({ kind: 'observed-installed' as const, ...fields, buildDigest: stableHash(fields) });
  return {
    identity,
    async assertCurrent(): Promise<void> {
      try { await assertFileSnapshotCurrent(snapshot); } catch {
        throw new DkbError(`Installed ${manifest.name} files or runtime dependencies changed after process bootstrap. Restart the compiler or Runtime before using the changed build.`, 'installed_build_drift');
      }
    },
  };
}
