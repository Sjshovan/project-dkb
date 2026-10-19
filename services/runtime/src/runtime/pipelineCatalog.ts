import path from 'node:path';
import { selectStoredPackageBuild } from '@sjshovan/dkb-library/builds.js';
import { readLibraryState } from '@sjshovan/dkb-library/state.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import {
  resolveContextConfig,
  resolveContextConfigDocuments,
  type DkbPipelineTargetConfig,
} from '@sjshovan/dkb-pipeline/config.js';
import { DkbProviderHost, type DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import { resolveProviderRetrievalProfile } from '@sjshovan/dkb-pipeline/profile.js';
import { resolvedProviderServices } from '@sjshovan/dkb-pipeline/capabilities.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbCapabilityServiceRequirement } from '@sjshovan/dkb-protocol/compilerCapabilities.js';
import { verifyRetainedRegistryBuild } from './registryInstall.js';
import type { DkbRuntimePipelinePreparation } from './pipelinePreparation.js';

export interface DkbRuntimePipelinePackageCoverage {
  id: string;
  version: string | null;
  source: 'local' | 'registry';
  registryUrl?: string;
  status: 'ready' | 'missing' | 'invalid';
  compatible: boolean;
  ready: boolean;
  trust: 'local' | 'registry-signed' | 'unverified';
  detail?: string;
}

export interface DkbRuntimePipelineTarget {
  name: string;
  active: boolean;
  origin: 'runtime' | 'library' | 'global' | 'bundled';
  providers: string[];
  dimensions: number | null;
  metric: string | null;
  requiredServices: string[];
  serviceRequirements: DkbCapabilityServiceRequirement[];
  health: 'ready' | 'unavailable';
  healthDetails: Array<{ id: string; kind: string; ok: boolean; detail?: string }>;
  coverage: { ready: number; compatible: number; total: number; packages: DkbRuntimePipelinePackageCoverage[] };
  /** Stored build graph and origin trust are checked; activation still prepares provider indexes atomically. */
  buildsReady: boolean;
  evidenceProfileDigest: string | null;
  retrievalProfileDigest: string | null;
  compatibilityDigest: string | null;
  configDigest: string | null;
  preparation?: DkbRuntimePipelinePreparation;
}

export interface DkbRuntimePipelineCatalog {
  root: string;
  activeTarget: string;
  targets: DkbRuntimePipelineTarget[];
}

export async function runtimePipelineCatalog(input: {
  distribution: DkbDistribution;
  root: string;
  libraryRoot: string;
  globalRoot?: string;
  activeTarget?: string;
}): Promise<DkbRuntimePipelineCatalog> {
  const resolved = await resolveContextConfig(input.root, {
    defaults: input.distribution.defaults,
    libraryRoot: input.libraryRoot,
    ...(input.globalRoot ? { globalRoot: input.globalRoot } : {}),
    ...(input.activeTarget ? { target: input.activeTarget } : {}),
  });
  const names = [...new Set([
    ...Object.keys(input.distribution.defaults.targets ?? {}),
    ...Object.keys(resolved.global.targets ?? {}),
    ...Object.keys(resolved.library.targets ?? {}),
    ...Object.keys(resolved.local.targets ?? {}),
  ])];
  const state = await readLibraryState(input.libraryRoot);
  const packageEntries = Object.values(state.entries)
    .filter((entry) => entry.kind === 'dkb' && entry.status === 'installed');
  const healthByProvider = new Map<string, Promise<DkbRuntimePipelineTarget['healthDetails'][number]>>();
  const buildTarget = async (name: string): Promise<DkbRuntimePipelineTarget> => {
    const origin = resolved.local.targets?.[name]
      ? 'runtime' as const
      : resolved.library.targets?.[name]
        ? 'library' as const
        : resolved.global.targets?.[name]
          ? 'global' as const
          : 'bundled' as const;
    let serviceRequirements: DkbCapabilityServiceRequirement[] = [];
    let target: DkbPipelineTargetConfig | undefined;
    let host: DkbProviderHost | undefined;
    try {
      target = resolveContextConfigDocuments(
        resolved.root,
        resolved.globalRoot,
        input.distribution.defaults,
        resolved.global,
        resolved.local,
        name,
        resolved.library,
        resolved.libraryRoot,
      ).target;
      host = await DkbProviderHost.create({
        root: resolved.root,
        libraryRoot: input.libraryRoot,
        globalRoot: resolved.globalRoot,
        target: name,
        distribution: input.distribution,
      });
      const pipelineHost = host;
      const profile = await resolveProviderRetrievalProfile(pipelineHost);
      const description = pipelineHost.describe();
      const healthKinds = [
        ...(target.embedding ? ['embedding' as const] : []),
        'index' as const,
        'retrieval' as const,
      ];
      serviceRequirements = resolvedProviderServices(pipelineHost, input.distribution, healthKinds);
      const healthDetails = await Promise.all(healthKinds.map(async (kind) => {
        const provider = description.providers.find((item) => item.kind === kind);
        if (!provider) throw new Error(`Resolved Pipeline ${name} has no ${kind} provider`);
        const healthKey = stableHash({
          id: provider.id,
          kind,
          sourceDigest: provider.sourceDigest,
          integrityDigest: provider.integrityDigest,
          options: pipelineHost.optionsFor(provider.id),
        });
        const existing = healthByProvider.get(healthKey);
        if (existing) return existing;
        const health = pipelineHost.health([kind]).then((result) => result[0] ?? ({
          id: provider.id,
          kind,
          ok: false,
          detail: `${provider.id} returned no health result`,
        }));
        healthByProvider.set(healthKey, health);
        return health;
      }));
      const compatibilityDigest = stableHash(profile.compatibility);
      const coverage = await Promise.all(packageEntries.map(async (entry): Promise<DkbRuntimePipelinePackageCoverage> => {
        const base = { id: entry.identity, version: entry.version ?? null, source: entry.source,
          ...(entry.registryUrl ? { registryUrl: entry.registryUrl } : {}) };
        let compatible = false;
        try {
          const packageRoot = path.resolve(input.libraryRoot, entry.path);
          const graph = await selectStoredPackageBuild({
            root: packageRoot,
            target: name,
            evidenceProfileDigest: profile.evidenceProfileDigest,
            retrievalProfileDigest: profile.retrievalProfileDigest,
            compatibilityDigest,
          });
          if (graph.evidence.package.id !== entry.identity || graph.evidence.package.version !== entry.version) {
            throw new DkbError('Stored build does not match the installed package identity and version.');
          }
          compatible = true;
          if (entry.source === 'registry') {
            if (!entry.registryUrl) throw new DkbError('Registry package has no pinned origin. Reinstall it from its Registry.', 'registry_build_untrusted');
            await verifyRetainedRegistryBuild({ libraryRoot: input.libraryRoot, registryUrl: entry.registryUrl, packageRoot, graph, target: name });
          }
          return { ...base, compatible, ready: true, status: 'ready', trust: entry.source === 'registry' ? 'registry-signed' : 'local' };
        } catch (error) {
          return { ...base, compatible, ready: false, status: error instanceof DkbError && error.code === 'retrieval_build_missing' ? 'missing' : 'invalid',
            trust: 'unverified', detail: error instanceof Error ? error.message : String(error) };
        }
      }));
      await pipelineHost.assertCurrent();
      if (stableHash(state) !== stableHash(await readLibraryState(input.libraryRoot))) {
        throw new DkbError('Library changed while checking build coverage. Refresh the Pipeline catalog.', 'runtime_refresh_required');
      }
      return {
        name,
        active: name === resolved.activeTarget,
        origin,
        providers: selectedPluginIds(target),
        dimensions: profile.embedding?.dimensions ?? null,
        metric: profile.compatibility.metric ?? null,
        requiredServices: [...new Set(serviceRequirements.map((service) => service.id))],
        serviceRequirements,
        health: healthDetails.every((item) => item.ok) ? 'ready' as const : 'unavailable' as const,
        healthDetails,
        coverage: { ready: coverage.filter((entry) => entry.ready).length, compatible: coverage.filter((entry) => entry.compatible).length, total: coverage.length, packages: coverage },
        buildsReady: healthDetails.every((entry) => entry.ok) && coverage.every((entry) => entry.ready),
        evidenceProfileDigest: profile.evidenceProfileDigest,
        retrievalProfileDigest: profile.retrievalProfileDigest,
        compatibilityDigest,
        configDigest: profile.configDigest,
      };
    } catch (error) {
      return {
        name,
        active: name === resolved.activeTarget,
        origin,
        providers: target ? selectedPluginIds(target) : [],
        dimensions: null,
        metric: null,
        requiredServices: [...new Set(serviceRequirements.map((service) => service.id))],
        serviceRequirements,
        health: 'unavailable',
        healthDetails: [{
          id: name,
          kind: 'pipeline',
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        }],
        coverage: { ready: 0, compatible: 0, total: packageEntries.length, packages: [] },
        buildsReady: false,
        evidenceProfileDigest: null,
        retrievalProfileDigest: null,
        compatibilityDigest: null,
        configDigest: null,
      };
    } finally {
      await host?.dispose();
    }
  };
  // Resolve the active chain first. Its known-good sidecars then seed the
  // provider-health cache before optional targets probe unavailable services.
  const active = names.includes(resolved.activeTarget)
    ? [await buildTarget(resolved.activeTarget)]
    : [];
  const targets = [
    ...active,
    ...await Promise.all(names.filter((name) => name !== resolved.activeTarget).map(buildTarget)),
  ];
  return { root: resolved.root, activeTarget: resolved.activeTarget, targets: targets.sort((left, right) => left.name.localeCompare(right.name)) };
}

function selectedPluginIds(target: DkbPipelineTargetConfig): string[] {
  return [target.evidence, target.parser, target.chunker, target.embedding, target.index, target.retrieval, ...(target.processors ?? [])]
    .filter((id): id is string => Boolean(id));
}
