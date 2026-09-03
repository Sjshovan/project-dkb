import { resolveContextConfig } from '@sjshovan/dkb-pipeline/config.js';
import { resolvePluginSource, type DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import { isSha256Digest } from '@sjshovan/dkb-pipeline/validation.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { resolveImmutableImageDigest } from '../stack/docker.js';

export interface DkbHostProviderIdentityOptions {
  target: string;
  targetOptions: Record<string, Record<string, unknown>>;
}

/**
 * Resolves external workload identities at the host composition boundary.
 * Compiler and Runtime code consume the resulting exact digests and never need
 * access to the Docker engine.
 */
export async function resolveHostProviderIdentityOptions(input: {
  distribution: DkbDistribution;
  root: string;
  libraryRoot?: string;
  target?: string;
}): Promise<DkbHostProviderIdentityOptions> {
  const config = await resolveContextConfig(input.root, {
    defaults: input.distribution.defaults,
    ...(input.libraryRoot ? { libraryRoot: input.libraryRoot } : {}),
    ...(input.target ? { target: input.target } : {}),
  });
  const targetOptions = structuredClone(config.target.options ?? {});
  const selectedProviders = new Set([
    config.target.evidence, config.target.parser, config.target.chunker,
    config.target.embedding, config.target.index, config.target.retrieval,
    ...(config.target.processors ?? []), ...(config.target.observers ?? []),
  ].filter((id): id is string => typeof id === 'string'));

  for (const service of input.distribution.services) {
    if (!service.providerId || !selectedProviders.has(service.providerId)) continue;
    // Service requirements belong to bundled code, not its label or same-ID operator replacements.
    if ((await resolvePluginSource(config, input.distribution, service.providerId)).source !== 'bundled') continue;
    for (const identity of service.providerExternalIdentities ?? []) {
      const providerOptions = targetOptions[service.providerId] ?? {};
      const configured = providerOptions[identity.option];
      if (isSha256Digest(configured)) continue;
      if (configured !== undefined) {
        throw new DkbError(
          `Pipeline target "${config.activeTarget}" configures invalid ${service.providerId}.${identity.option}. `
          + 'External identities must be exact lowercase sha256 digests; DKB will not replace a broken higher-precedence value.',
        );
      }
      if (identity.kind !== 'image') {
        throw unresolvedIdentity(config.activeTarget, service.providerId, identity.kind, identity.name, identity.option);
      }
      const image = stringOption(providerOptions.image)
        ?? (service.stack ? stringOption(process.env[service.stack.imageEnvironment]) : undefined)
        ?? service.image;
      const digest = image ? resolveImmutableImageDigest(image) : null;
      if (!digest) {
        throw new DkbError(
          `Pipeline target "${config.activeTarget}" cannot resolve immutable image:${identity.name} identity for ${service.providerId}. `
          + `${image ? `Image ${image} is not pinned and is not available in the local Docker engine. ` : ''}`
          + `Pin the image as image@sha256:<digest>, make the local image available, or configure trusted ${service.providerId}.${identity.option}.`,
        );
      }
      targetOptions[service.providerId] = { ...providerOptions, [identity.option]: digest };
    }
  }

  return { target: config.activeTarget, targetOptions };
}

function unresolvedIdentity(
  target: string,
  providerId: string,
  kind: string,
  name: string,
  option: string,
): DkbError {
  return new DkbError(
    `Pipeline target "${target}" cannot resolve immutable ${kind}:${name} identity for ${providerId}. `
    + `Configure trusted ${providerId}.${option} as an exact sha256 digest.`,
  );
}

function stringOption(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
