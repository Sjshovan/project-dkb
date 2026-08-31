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

export interface DkbRuntimePipelineTarget {
  name: string;
  active: boolean;
  origin: 'runtime' | 'library' | 'global' | 'bundled';
  providers: string[];
  dimensions: number;
  metric: string;
  requiredServices: string[];
  health: 'ready' | 'unavailable';
  healthDetails: Array<{ id: string; kind: string; ok: boolean; detail?: string }>;
  coverage: { ready: number; total: number };
  compatibilityDigest: string;
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
    const target = resolveContextConfigDocuments(
      resolved.root,
      resolved.globalRoot,
      input.distribution.defaults,
      resolved.global,
      resolved.local,
      name,
      resolved.library,
      resolved.libraryRoot,
    ).target;
    const host = await DkbProviderHost.create({
      root: resolved.root,
      libraryRoot: input.libraryRoot,
      globalRoot: resolved.globalRoot,
      target: name,
      distribution: input.distribution,
    });
    try {
      const profile = await resolveProviderRetrievalProfile(host);
      const description = host.describe();
      const healthDetails = await Promise.all((['embedding', 'index', 'retrieval'] as const).map(async (kind) => {
        const provider = description.providers.find((item) => item.kind === kind);
        if (!provider) throw new Error(`Resolved Pipeline ${name} has no ${kind} provider`);
        const healthKey = stableHash({
          id: provider.id,
          kind,
          sourceDigest: provider.sourceDigest,
          options: host.optionsFor(provider.id),
        });
        const existing = healthByProvider.get(healthKey);
        if (existing) return existing;
        const health = host.health([kind]).then((result) => result[0] ?? ({
          id: provider.id,
          kind,
          ok: false,
          detail: `${provider.id} returned no health result`,
        }));
        healthByProvider.set(healthKey, health);
        return health;
      }));
      const compatibilityDigest = stableHash(profile.compatibility);
      const coverage = await Promise.all(packageEntries.map(async (entry) => {
        try {
          await selectStoredPackageBuild({
            root: path.resolve(input.libraryRoot, entry.path),
            target: name,
            evidenceProfileDigest: profile.evidenceProfileDigest,
            retrievalProfileDigest: profile.retrievalProfileDigest,
            compatibilityDigest,
          });
          return true;
        } catch {
          return false;
        }
      }));
      return {
        name,
        active: name === resolved.activeTarget,
        origin: resolved.local.targets?.[name]
          ? 'runtime' as const
          : resolved.library.targets?.[name]
            ? 'library' as const
            : resolved.global.targets?.[name]
              ? 'global' as const
              : 'bundled' as const,
        providers: selectedPluginIds(target),
        dimensions: profile.embedding.dimensions,
        metric: profile.compatibility.metric,
        requiredServices: input.distribution.services.filter((service) => service.requiredBy.includes(name)).map((service) => service.id),
        health: healthDetails.every((item) => item.ok) ? 'ready' as const : 'unavailable' as const,
        healthDetails,
        coverage: { ready: coverage.filter(Boolean).length, total: coverage.length },
        compatibilityDigest,
      };
    } finally {
      await host.dispose();
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
