import { readDkbContextConfig, type DkbContextConfig, type DkbResolvedContextConfig } from '@sjshovan/dkb-pipeline/config.js';
import type { DkbDistributionService } from '@sjshovan/dkb-pipeline/host.js';
import { isSha256Digest } from '@sjshovan/dkb-pipeline/validation.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

/** Build configuration, without changing an operator file or a Runtime selection. */
export async function prepareIdentityConfig(
  configPath: string,
  activeTarget: string,
  recipes: Record<string, DkbResolvedContextConfig>,
  bindings: Record<string, string[]>,
  context: { requiredServices: DkbDistributionService[] },
  imageDigests: Readonly<Record<string, string>>,
  environment: Readonly<Record<string, string>>,
): Promise<{ path: string; config: DkbContextConfig }> {
  const config = structuredClone(await readDkbContextConfig(configPath));
  for (const [name, services] of Object.entries(bindings)) {
    for (const serviceId of services) {
      const service = context.requiredServices.find((candidate) => candidate.id === serviceId);
      if (!service?.providerId) continue;
      const recipeImage = recipes[name]!.target.options?.[service.providerId]?.image;
      const deployedImage = service.stack ? environment[service.stack.imageEnvironment] ?? service.image : service.image;
      if (recipeImage !== undefined && recipeImage !== deployedImage) {
        if (name === activeTarget) throw new DkbError(`Pipeline "${name}" configures a different ${service.id} image than the prepared Stack. Prepare the Stack again before attesting it.`);
        continue;
      }
      for (const identity of service.providerExternalIdentities ?? []) {
        if (identity.kind !== 'image') continue;
        const digest = imageDigests[service.id];
        if (!isSha256Digest(digest)) throw new DkbError(`Immutable OCI digest for required provider service ${service.id} was not resolved`);
        const configured = recipes[name]!.target.options?.[service.providerId]?.[identity.option];
        if (configured !== undefined) {
          if (name === activeTarget && (!isSha256Digest(configured) || configured !== digest)) {
            throw new DkbError(`Pipeline "${name}" pins ${service.providerId}.${identity.option} to a different or invalid image identity. `
              + `The Stack resolved ${digest}. Update the trusted recipe explicitly or restore its pinned image; DKB will not overwrite operator options.`);
          }
          continue;
        }
        const targets = config.targets ??= {};
        const target = targets[name] ??= {};
        const options = target.options ??= {};
        options[service.providerId] = { ...options[service.providerId], [identity.option]: digest };
      }
    }
  }
  return { path: configPath, config };
}
