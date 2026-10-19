import path from 'node:path';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbRegistryCollectionRevision } from '@sjshovan/dkb-protocol/registryCollections.js';
import { progressStart, progressUpdate, progressFinish, type DkbProgressReporter } from '@sjshovan/dkb-protocol/progress.js';
import type { CollectionRegistrySource } from './collections.js';
import { readLibraryState } from '@sjshovan/dkb-library/state.js';
import { parseRegistryTrustedKeys } from './registryTrust.js';
import { preflightDkbInstall, verifyInstalledSignedBuildForPlan, verifyRetainedRegistryBuild, verifySignedInstallPlan } from './registryInstall.js';

/** Authenticate every member before downloading or changing the Collection graph. */
export async function prepareCollectionPlans(options: {
  client: CollectionRegistrySource;
  libraryRoot: string;
  revision: DkbRegistryCollectionRevision;
  update?: boolean;
  progress?: DkbProgressReporter;
}) {
  const stage = { phase: 'verify-collection', label: 'Verify Collection members', total: options.revision.manifest.members.length * 2, unit: 'steps' as const };
  options.progress?.(progressStart(stage));
  const trustedKeys = parseRegistryTrustedKeys(await options.client.publicKeys());
  const members = [];
  for (const member of options.revision.manifest.members) {
    const { plan, sourceReceipt } = await verifySignedInstallPlan(await options.client.installPlan(member.id, member.version), trustedKeys);
    if (plan.package.id !== member.id || plan.package.version !== member.version || sourceReceipt.payload.packageTreeHash !== member.digest) {
      throw new DkbError(`Collection snapshot digest mismatch for ${member.id}@${member.version}.`, 'collection_member_mismatch');
    }
    members.push({ plan, release: { packageId: member.id, version: member.version, packageTreeHash: member.digest } });
    options.progress?.(progressUpdate({ ...stage, value: members.length }));
  }

  const state = await readLibraryState(options.libraryRoot);
  const unchanged = new Set<string>();
  const replaceable = new Set<string>();
  let verified = 0;
  for (const { plan, release } of members) {
    const installed = state.entries[release.packageId];
    if (installed) {
      if (installed.kind !== 'dkb' || installed.source !== 'registry') {
        throw new DkbError(`Collection cannot replace editable local knowledge or a Collection at ${release.packageId}.`);
      }
      if (installed.version !== release.version) {
        if (!options.update || installed.requiredBy.some(owner => owner !== `collection:${options.revision.collectionId}`)) {
          throw new DkbError(`Version conflict for ${release.packageId}: installed ${installed.version ?? '?'}, ${options.revision.collectionId}@r${options.revision.revision} requires ${release.version}.`);
        }
        replaceable.add(release.packageId);
      } else if (installed.digest !== release.packageTreeHash) {
        throw new DkbError(`Installed ${release.packageId}@${release.version} does not match the immutable signed Collection member digest.`);
      }
    }
    await preflightDkbInstall({ libraryRoot: options.libraryRoot, registryUrl: options.client.baseUrl, candidate: release, force: replaceable.has(release.packageId) });
    if (installed && !replaceable.has(release.packageId)) {
      const packageRoot = path.resolve(options.libraryRoot, installed.path);
      const graph = await verifyInstalledSignedBuildForPlan({ packageRoot, plan, trustedKeys });
      if (!installed.registryUrl) throw new DkbError(`Installed ${release.packageId} has no pinned Registry origin. Reinstall it from its Registry.`);
      await verifyRetainedRegistryBuild({ libraryRoot: options.libraryRoot, registryUrl: installed.registryUrl, packageRoot, graph, target: plan.target });
      unchanged.add(release.packageId);
    }
    options.progress?.(progressUpdate({ ...stage, value: members.length + ++verified }));
  }
  options.progress?.(progressFinish(stage));
  return { members, trustedKeys, unchanged, replaceable };
}
