import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbRegistryClient } from '@sjshovan/dkb-registry-client/client.js';

export interface RegistryPipelineBuildSelection {
  packageId: string;
  version: string;
  target: string;
  evidenceProfileDigest: string;
  retrievalProfileDigest: string;
  compatibilityDigest: string;
}

/** Read published variants first: requesting a missing build is a separate authority. */
export async function prepareRegistryPipelineGrant(
  client: Pick<DkbRegistryClient, 'packageDetails' | 'requestBuild' | 'waitForBuild' | 'createInstallGrant'>,
  selection: RegistryPipelineBuildSelection,
) {
  const { packageId, version, target } = selection;
  const details = await client.packageDetails(packageId, version);
  if (!Array.isArray(details.selectedVersion.builds)) {
    throw new DkbError(`Registry did not provide a build catalog for ${packageId}@${version}; no compilation was requested.`);
  }
  const matches = details.selectedVersion.builds.filter((build) => build.status === 'published'
    && build.evidenceProfileDigest === selection.evidenceProfileDigest
    && build.retrievalProfileDigest === selection.retrievalProfileDigest
    && build.compatibilityDigest === selection.compatibilityDigest);
  if (matches.length > 1) {
    throw new DkbError(`Registry has multiple published builds for the exact ${target} profile of ${packageId}@${version}. Resolve the conflicting build identities before activation.`);
  }
  let digest: string | undefined = matches[0]?.retrievalBuildDigest;
  // The digest selects artifacts; the stored target label may predate a recipe rename.
  let grantTarget = matches[0]?.target ?? target;
  if (!digest) {
    const request = await client.requestBuild(packageId, version, target, {
      retrievalProfileDigest: selection.retrievalProfileDigest,
      compatibilityDigest: selection.compatibilityDigest,
    });
    digest = request.retrievalBuildDigest;
    if (request.status === 'queued') {
      if (!request.jobId) throw new DkbError(`Registry queued ${packageId}@${version} without a build job id.`);
      const completed = await client.waitForBuild(packageId, version, request.jobId);
      if (completed.target !== target) throw new DkbError(`Registry build job ${request.jobId} resolved ${completed.target}, not requested Pipeline ${target}.`);
      digest = completed.retrievalBuildDigest;
    }
    grantTarget = target;
  }
  if (!digest) throw new DkbError(`Registry did not resolve an exact Retrieval Build for ${packageId}@${version} (${target}).`);
  const grant = await client.createInstallGrant(packageId, version, grantTarget, digest);
  if (grant.plan.evidenceProfileDigest !== selection.evidenceProfileDigest
    || grant.plan.retrievalProfileDigest !== selection.retrievalProfileDigest
    || grant.plan.compatibilityDigest !== selection.compatibilityDigest
    || grant.plan.retrievalBuildDigest !== digest) {
    throw new DkbError(`Registry install plan for ${packageId}@${version} does not match Pipeline ${target}.`);
  }
  return grant;
}
