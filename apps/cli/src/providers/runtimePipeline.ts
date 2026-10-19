import path from 'node:path';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { parseDkbIdentity } from '@sjshovan/dkb-protocol/identity.js';
import { progressStart, progressUpdate, progressFinish, type DkbProgressReporter } from '@sjshovan/dkb-protocol/progress.js';
import { readLibraryState } from '@sjshovan/dkb-library/state.js';
import { DkbProviderHost, type DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import { resolveProviderRetrievalProfile, type DkbResolvedRetrievalProfile } from '@sjshovan/dkb-pipeline/profile.js';
import { ensurePackageBuildForTarget } from '@sjshovan/dkb-compiler/compile.js';
import { DkbRegistryClient } from '@sjshovan/dkb-registry-client/client.js';
import { loadRegistryCredentialSync } from '@sjshovan/dkb-registry-client/credentials.js';
import { dockerRegistryTransportUrl, validateRegistryTransportUrl } from '@sjshovan/dkb-registry-client/config.js';
import type { DkbRuntimeClient } from '@sjshovan/dkb-runtime/runtime/client.js';
import { validateRuntimePipelinePreparation } from '@sjshovan/dkb-runtime/runtime/pipelinePreparation.js';
import type { DkbRuntimePipelineTarget } from '@sjshovan/dkb-runtime/runtime/pipelineCatalog.js';
import { resolveHostProviderIdentityOptions } from './externalIdentities.js';
import { prepareRegistryPipelineGrant } from './registryBuilds.js';

/** Native editable builds only; Docker/remote state is never passed here. */
export async function prepareLocalRuntimePipeline(input: {
  root: string; stateRoot: string; target: string; distribution: DkbDistribution;
}) {
  const { targetOptions } = await resolveHostProviderIdentityOptions({ distribution: input.distribution,
    root: input.stateRoot, libraryRoot: input.root, target: input.target });
  const state = await readLibraryState(input.root);
  const localPreparations = [];
  for (const entry of Object.values(state.entries).filter(item => item.kind === 'dkb' && item.source === 'local' && item.status === 'installed')
    .sort((a, b) => a.identity.localeCompare(b.identity))) {
    localPreparations.push({ package: entry.identity, ...await ensurePackageBuildForTarget(path.resolve(input.root, entry.path), {
      target: input.target, contextRoot: input.stateRoot, libraryRoot: input.root, targetOptions,
    }) });
  }
  const host = await DkbProviderHost.create({ root: input.stateRoot, libraryRoot: input.root,
    target: input.target, targetOptions, distribution: input.distribution });
  try { return { localPreparations, profile: await resolveProviderRetrievalProfile(host) }; }
  finally { await host.dispose(); }
}

/** One host orchestration path. Only the owning Runtime reads or promotes builds. */
export async function useRuntimePipeline(input: {
  client: Pick<DkbRuntimeClient, 'pipelines' | 'switchPipeline'>;
  name: string; target: string; kind: 'process' | 'docker' | 'remote'; registryUrl?: string;
  local?: { localPreparations: unknown[]; profile: DkbResolvedRetrievalProfile };
  progress?: DkbProgressReporter;
}) {
  const planning = { phase: 'pipeline-planning', label: `Checking Pipeline ${input.target} on Runtime ${input.name}`, total: 1, unit: 'steps' as const };
  input.progress?.(progressStart(planning));
  const target = selectedTarget(await input.client.pipelines(), input.target);
  if (target.health !== 'ready') throw new DkbError(`Pipeline ${input.target} is unavailable on Runtime ${input.name}. Run: dkb pipeline verify ${input.target} --runtime ${input.name}`);
  const expected = validateRuntimePipelinePreparation(target.preparation);
  if (expected.target !== input.target || expected.configDigest !== target.configDigest
    || expected.evidenceProfileDigest !== target.evidenceProfileDigest || expected.retrievalProfileDigest !== target.retrievalProfileDigest
    || expected.compatibilityDigest !== target.compatibilityDigest) throw new DkbError('Runtime Pipeline catalog has inconsistent identities. Refresh it before retrying.');
  if (input.local && (input.local.profile.evidenceProfileDigest !== expected.evidenceProfileDigest
    || input.local.profile.retrievalProfileDigest !== expected.retrievalProfileDigest
    || stableHash(input.local.profile.compatibility) !== expected.compatibilityDigest)) {
    throw new DkbError(`Pipeline ${input.target} resolves differently between this host and Runtime ${input.name}. No Registry build was requested. Refresh the local configuration before retrying.`);
  }
  // Validate the complete coverage before obtaining any grant or requesting a build.
  const missing = target.coverage.packages.filter(entry => !entry.ready);
  for (const entry of missing) {
    if (entry.status === 'invalid') throw new DkbError(`Stored build for ${entry.id}@${entry.version} failed verification. Inspect its integrity before retrying; no Registry build was requested.`, 'registry_build_untrusted');
    if (entry.source === 'local') throw new DkbError(`Editable DKB ${entry.id}@${entry.version} needs compilation in Runtime ${input.name}'s Library environment. Compile it there for ${input.target}, then retry. No host database was opened.`, 'unsupported_capability');
    if (!entry.registryUrl) throw new DkbError(`Installed ${entry.id}@${entry.version} has no pinned Registry origin. Reinstall it from its Registry.`, 'registry_build_untrusted');
    validateRegistryTransportUrl(entry.registryUrl, entry.registryUrl);
    if (input.registryUrl && validateRegistryTransportUrl(input.registryUrl, input.registryUrl) !== entry.registryUrl) {
      throw new DkbError(`Registry override conflicts with the installed origin of ${entry.id}. Omit --registry-url to use each package's pinned origin.`, 'registry_origin_conflict');
    }
  }
  input.progress?.(progressFinish(planning));
  const grants: NonNullable<Parameters<DkbRuntimeClient['switchPipeline']>[0]['grants']> = {};
  const builds = { phase: 'pipeline-builds', label: 'Preparing exact signed Registry builds', total: missing.length, unit: 'steps' as const };
  if (missing.length) input.progress?.(progressStart(builds));
  for (const [index, entry] of missing.entries()) {
    const origin = entry.registryUrl!;
    // A remote catalog cannot redirect an unscoped environment bearer token.
    // Saved host credentials are already keyed by exact normalized Registry URL.
    const explicitOrigin = input.registryUrl ?? process.env.DKB_REGISTRY_URL;
    const environmentToken = explicitOrigin && validateRegistryTransportUrl(explicitOrigin, explicitOrigin) === origin
      ? process.env.DKB_REGISTRY_TOKEN : undefined;
    const client = new DkbRegistryClient({ baseUrl: origin, token: environmentToken ?? loadRegistryCredentialSync(origin)?.token ?? '' });
    const grant = await prepareRegistryPipelineGrant(client, { packageId: entry.id, version: entry.version!, target: input.target,
      evidenceProfileDigest: expected.evidenceProfileDigest, retrievalProfileDigest: expected.retrievalProfileDigest, compatibilityDigest: expected.compatibilityDigest });
    grants[entry.id] = { plan: grant.plan, installGrant: grant.installGrant,
      registryTransportUrl: input.kind === 'docker' ? dockerRegistryTransportUrl(origin) : origin };
    input.progress?.(progressUpdate({ ...builds, label: `Prepared ${entry.id}@${entry.version}`, value: index + 1 }));
  }
  if (missing.length) input.progress?.(progressFinish(builds));
  const switched = await input.client.switchPipeline({ target: input.target, expected, grants });
  if (!switched || typeof switched !== 'object' || Array.isArray(switched) || (switched as { status?: unknown }).status !== 'pipeline_switched') {
    throw new DkbError('Runtime did not confirm Pipeline activation. Inspect its current state before retrying.');
  }
  return { ...switched as Record<string, unknown>, localPreparations: input.local?.localPreparations ?? [] };
}

function selectedTarget(value: unknown, name: string): DkbRuntimePipelineTarget {
  const catalog = value as { targets?: DkbRuntimePipelineTarget[] } | null;
  if (!catalog || !Array.isArray(catalog.targets)) throw new DkbError('Runtime did not provide a Pipeline catalog.');
  const matches = catalog.targets.filter(target => target && target.name === name);
  if (matches.length !== 1) throw new DkbError(`Pipeline ${name} is not uniquely available on this Runtime.`);
  const target = matches[0]!;
  if (target.health !== 'ready') return target;
  const coverage = target.coverage;
  if (!coverage || !Array.isArray(coverage.packages) || coverage.packages.length !== coverage.total || coverage.total > 10_000) {
    throw new DkbError('Runtime returned invalid package coverage.');
  }
  const seen = new Set<string>();
  for (const entry of coverage.packages) {
    if (!entry || typeof entry.id !== 'string' || seen.has(entry.id) || typeof entry.version !== 'string' || !entry.version.trim()
      || !['local', 'registry'].includes(entry.source) || !['ready', 'missing', 'invalid'].includes(entry.status)
      || entry.ready !== (entry.status === 'ready') || (entry.registryUrl !== undefined && typeof entry.registryUrl !== 'string')) {
      throw new DkbError('Runtime returned inconsistent package coverage.');
    }
    parseDkbIdentity(entry.id, 'Runtime package');
    seen.add(entry.id);
  }
  return target;
}
