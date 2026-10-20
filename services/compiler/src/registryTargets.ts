import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { resolveContextConfig } from '@sjshovan/dkb-pipeline/config.js';
import { DkbProviderHost, type DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import { resolveProviderRetrievalProfile } from '@sjshovan/dkb-pipeline/profile.js';
import { describeResolvedProviderCapabilities, resolvedProviderServices } from '@sjshovan/dkb-pipeline/capabilities.js';
import { DKB_PIPELINE_RESOLUTION_MESSAGE, type DkbCompilerTargetCapability, type DkbResolvedCompilerTargetCapability } from '@sjshovan/dkb-protocol/compilerCapabilities.js';

export type DkbRegistryCompilerTargetCapability = DkbCompilerTargetCapability;

export interface DkbRegistryCompilerCatalog {
  defaultTarget: string;
  targets: DkbRegistryCompilerTargetCapability[];
}

export async function resolveRegistryCompilerCatalog(distribution: DkbDistribution, contextRoot: string): Promise<DkbRegistryCompilerCatalog> {
  const { defaultTarget, allowed } = await configuredTargets(distribution, contextRoot);
  const targets = [];
  for (const name of allowed) targets.push(await resolveTargetCapability(distribution, contextRoot, name));
  return { defaultTarget, targets };
}

async function configuredTargets(distribution: DkbDistribution, contextRoot: string): Promise<{ defaultTarget: string; allowed: string[] }> {
  const config = await resolveContextConfig(contextRoot, { defaults: distribution.defaults });
  const configured = [...new Set([
    ...Object.keys(distribution.defaults.targets ?? {}),
    ...Object.keys(config.global.targets ?? {}),
    ...Object.keys(config.library.targets ?? {}),
    ...Object.keys(config.local.targets ?? {}),
  ])].sort();
  const requested = environmentTargets();
  const allowed = requested.length > 0 ? requested : configured;
  const unknown = allowed.filter((name) => !configured.includes(name));
  if (unknown.length > 0) throw new DkbError(`DKB_COMPILER_ALLOWED_TARGETS contains unknown targets: ${unknown.join(', ')}`);
  if (allowed.length === 0) throw new DkbError('Registry compiler has no allowed Pipeline targets');
  const defaultTarget = process.env.DKB_COMPILER_DEFAULT_TARGET?.trim() || config.activeTarget;
  if (!allowed.includes(defaultTarget)) throw new DkbError(`Registry compiler default target ${defaultTarget} is not allowed`);
  return { defaultTarget, allowed };
}

async function resolveTargetCapability(distribution: DkbDistribution, contextRoot: string, name: string): Promise<DkbCompilerTargetCapability> {
    let host: DkbProviderHost | undefined;
    try {
      host = await DkbProviderHost.create({ root: contextRoot, distribution, target: name });
      const description = host.describe();
      const profile = await resolveProviderRetrievalProfile(host);
      const health = await host.health();
      const serviceRequirements = resolvedProviderServices(host, distribution);
      await host.assertCurrent();
      return {
        name,
        ...describeResolvedProviderCapabilities(host),
        buildDigest: description.buildDigest,
        evidenceProfileDigest: profile.evidenceProfileDigest,
        retrievalProfileDigest: profile.retrievalProfileDigest,
        compatibility: profile.compatibility,
        compatibilityDigest: stableHash(profile.compatibility),
        requiredServices: [...new Set(serviceRequirements.map((service) => service.id))],
        serviceRequirements,
        available: health.every((entry) => entry.ok),
        health,
      };
    } catch {
      // Plugin exceptions may contain options, paths or credentials. The public
      // catalog reports no unverified identity and never forwards their text.
      const message = DKB_PIPELINE_RESOLUTION_MESSAGE;
      return {
        name, available: false, providers: [], processors: [], chains: null,
        buildDigest: null, evidenceProfileDigest: null, retrievalProfileDigest: null,
        compatibility: null, compatibilityDigest: null, requiredServices: [], serviceRequirements: [],
        health: [{ id: name, kind: 'pipeline', ok: false, detail: message }],
        resolutionError: { code: 'pipeline_resolution_failed', message },
      };
    } finally {
      await host?.dispose();
    }
}

export async function resolveRegistryCompilerTarget(input: {
  distribution: DkbDistribution;
  contextRoot: string;
  target?: string;
  expected?: { evidenceProfileDigest?: string; retrievalProfileDigest?: string; compatibilityDigest?: string; providerBuildDigest?: string };
}): Promise<DkbResolvedCompilerTargetCapability> {
  const catalog = await configuredTargets(input.distribution, input.contextRoot);
  const name = input.target ?? catalog.defaultTarget;
  if (!catalog.allowed.includes(name)) throw new DkbError(`Registry compiler target ${name} is not allowed`);
  // Execution validates only its selected recipe. Unrelated optional services
  // must not be contacted or loaded just to compile an already selected target.
  const target = await resolveTargetCapability(input.distribution, input.contextRoot, name);
  if (!target.available) throw new DkbError(`Registry compiler target ${name} is unhealthy: ${target.health.filter((entry) => !entry.ok).map((entry) => `${entry.id}: ${entry.detail ?? 'unavailable'}`).join('; ')}`);
  const expected = input.expected ?? {};
  for (const [label, actual] of Object.entries({
    evidenceProfileDigest: target.evidenceProfileDigest,
    retrievalProfileDigest: target.retrievalProfileDigest,
    compatibilityDigest: target.compatibilityDigest,
    providerBuildDigest: target.buildDigest,
  })) {
    const requested = expected[label as keyof typeof expected];
    if (requested && requested !== actual) throw new DkbError(`Registry compiler target ${name} drifted: expected ${label} ${requested}, resolved ${actual}`);
  }
  return target;
}

function environmentTargets(): string[] {
  return [...new Set((process.env.DKB_COMPILER_ALLOWED_TARGETS ?? '').split(',').map((value) => value.trim()).filter(Boolean))].sort();
}
