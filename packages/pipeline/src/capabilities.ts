import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbCapabilityServiceRequirement, DkbResolvedCompilerTargetCapability } from '@sjshovan/dkb-protocol/compilerCapabilities.js';
import type { DkbDistribution, DkbProviderHost } from './host.js';
import type { DkbProviderKind, DkbProviderServiceRequirement } from './types.js';

export function validateServiceRequirements(value: unknown, owner: string): asserts value is readonly DkbProviderServiceRequirement[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 32) throw new DkbError(`${owner} serviceRequirements must be a bounded array.`);
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some((key) => !['id', 'kind'].includes(key))
      || typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/u.test(item.id)
      || !['process', 'docker', 'remote'].includes(item.kind) || ids.has(item.id)) {
      throw new DkbError(`${owner} serviceRequirements must contain unique service IDs and process, docker, or remote kinds only.`);
    }
    ids.add(item.id);
  }
}

/** Target labels never determine services, and filesystem overrides own their requirements. */
export function resolvedProviderServices(host: DkbProviderHost, distribution: DkbDistribution, kinds?: readonly DkbProviderKind[]): DkbCapabilityServiceRequirement[] {
  const result: DkbCapabilityServiceRequirement[] = [];
  const description = host.describe();
  for (const provider of description.providers) {
    if (kinds && !kinds.includes(provider.kind)) continue;
    const declared = host.provider(provider.kind).serviceRequirements;
    validateServiceRequirements(declared, provider.id);
    const requirements = declared ?? (provider.source === 'bundled'
      ? distribution.services.filter((service) => service.providerId === provider.id).map(({ id, kind }) => ({ id, kind }))
      : []);
    for (const requirement of requirements) result.push({ ...requirement, providerId: provider.id, providerKind: provider.kind, source: provider.source });
  }
  if (!kinds) {
    for (const stage of ['document', 'chunk', 'record'] as const) {
      for (const registration of host.processorPipeline(stage)) {
        const declared = registration.processor.serviceRequirements;
        validateServiceRequirements(declared, registration.id);
        for (const requirement of declared ?? []) result.push({ ...requirement, providerId: registration.id, providerKind: 'processor', source: registration.source });
      }
    }
  }
  return result.sort((a, b) => `${a.id}:${a.providerKind}:${a.providerId}`.localeCompare(`${b.id}:${b.providerKind}:${b.providerId}`));
}

/** Portable capability projection: no paths, resolved options, credentials, or image URLs. */
export function describeResolvedProviderCapabilities(host: DkbProviderHost): Pick<DkbResolvedCompilerTargetCapability, 'providers' | 'processors' | 'chains'> {
  const description = host.describe();
  const providers = description.providers.map(({ sourcePath: _path, ...provider }) => ({ ...provider, integrity: host.providerIntegrity(provider.kind) }));
  const processors = (['document', 'chunk', 'record'] as const).flatMap((stage) => host.processorPipeline(stage))
    .map(({ processor, sourcePath: _path, integrity, ...registration }, order) => ({
      ...registration, stage: processor.stage, order, integrity: structuredClone(integrity),
    }));
  const target = host.config.target;
  return {
    providers,
    processors,
    chains: {
      evidence: [target.evidence, target.parser, target.chunker].filter((id): id is string => Boolean(id)),
      embedding: target.embedding ?? null,
      index: target.index,
      retrieval: target.retrieval,
      processors: {
        document: host.processorPipeline('document').map((entry) => entry.id),
        chunk: host.processorPipeline('chunk').map((entry) => entry.id),
        record: host.processorPipeline('record').map((entry) => entry.id),
      },
    },
  };
}
