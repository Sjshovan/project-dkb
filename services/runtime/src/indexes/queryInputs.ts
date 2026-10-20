import path from 'node:path';
import { captureFileSnapshot, type FileSnapshot } from '@sjshovan/dkb-protocol/fileSnapshot.js';
import { loadLibrary, uniqueLoadedDkbs } from '@sjshovan/dkb-protocol/manifest.js';
import { evidenceBuildPath, retrievalBuildPath, retrievalBuildReceiptPath } from '@sjshovan/dkb-protocol/paths.js';
import type { DkbRuntimeActivation } from '@sjshovan/dkb-protocol/runtimeActivation.js';
import { DKB_INSTALL_PLAN_RECEIPT_PATH, DKB_INSTALL_PLAN_RECEIPTS_DIR, DKB_PACKAGE_RECEIPT_PATH } from '@sjshovan/dkb-library/signing.js';
import { readLibraryState } from '@sjshovan/dkb-library/state.js';
import { registryTrustPath } from '../runtime/registryTrust.js';

/** Observe only this activation's immutable inputs, never other Runtime builds. */
export async function captureQueryInputs(root: string, activation: DkbRuntimeActivation): Promise<FileSnapshot> {
  const library = await loadLibrary(root);
  const state = await readLibraryState(root);
  const dkbs = uniqueLoadedDkbs([...library.dkbs, ...library.collections.flatMap((collection) => collection.dkbs)]);
  const inputs = [
    path.join(root, 'dkb.json'),
    path.join(root, 'dkb-lock.json'),
    ...library.collections.map((collection) => path.join(collection.root, 'dkb.json')),
  ];
  for (const dkb of dkbs) {
    const selection = activation.packages[dkb.manifest.id];
    if (!selection) continue; // The full build-graph validator rejects missing selections.
    const entry = state.entries[dkb.manifest.id];
    if (entry?.source === 'registry') {
      if (entry.registryUrl) inputs.push(registryTrustPath(root, entry.registryUrl));
      inputs.push(
        path.join(dkb.root, DKB_INSTALL_PLAN_RECEIPT_PATH),
        path.join(dkb.root, DKB_INSTALL_PLAN_RECEIPTS_DIR),
      );
    }
    inputs.push(
      path.join(dkb.root, 'dkb.json'),
      path.join(dkb.root, DKB_PACKAGE_RECEIPT_PATH),
      evidenceBuildPath(dkb.root, selection.evidenceProfileDigest, selection.evidenceDigest),
      retrievalBuildPath(dkb.root, selection.retrievalProfileDigest, selection.retrievalBuildDigest),
      retrievalBuildReceiptPath(dkb.root, selection.retrievalBuildDigest),
    );
  }
  return captureFileSnapshot(inputs, { recursive: true });
}
