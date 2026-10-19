import path from 'node:path';
import type { DkbDistribution, DkbDistributionService } from '@sjshovan/dkb-pipeline/host.js';
import { resolvePluginSource } from '@sjshovan/dkb-pipeline/host.js';
import { DKB_CONFIG_FORMAT, DKB_CONFIG_PATH, readDkbContextConfig, resolveContextConfigDocuments, type DkbContextConfig, type DkbResolvedContextConfig } from '@sjshovan/dkb-pipeline/config.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { validateStackServiceEnvironment } from './serviceEnvironment.js';

export interface StackRecipePaths {
  compilerRoot: string;
  runtimeRoot: string;
  libraryRoot: string;
}

export interface StackSelection {
  target: string;
  runtimeTarget: string;
  compilerTargets: string[];
  allowedTargets: string[];
  compiler: Record<string, DkbResolvedContextConfig>;
  runtime: Record<string, DkbResolvedContextConfig>;
  compilerServices: Record<string, string[]>;
  runtimeServices: Record<string, string[]>;
  requiredServices: DkbDistributionService[];
}

export async function resolveStackSelection(distribution: DkbDistribution, paths: StackRecipePaths, input: {
  compilerTarget?: string; runtimeTarget?: string; allowedTargets: string;
}): Promise<StackSelection> {
  const compilerScope = await stackScope(distribution, paths.compilerRoot);
  const compilerDefault = compilerScope.resolve(input.compilerTarget);
  const allowedTargets = [...new Set(input.allowedTargets.split(',').map((value) => value.trim()).filter(Boolean))].sort();
  if (allowedTargets.length > 128) throw new DkbError('DKB_COMPILER_ALLOWED_TARGETS must contain at most 128 Pipeline names.');
  const compilerNames = allowedTargets.length ? allowedTargets : compilerScope.names;
  for (const name of compilerNames) {
    if (!compilerScope.names.includes(name)) throw new DkbError(`DKB_COMPILER_ALLOWED_TARGETS contains unknown target "${name}". Available targets: ${compilerScope.names.join(', ')}`);
  }
  const target = compilerDefault.activeTarget;
  if (!compilerNames.includes(target)) throw new DkbError(`Registry compiler default target "${target}" is not allowed by DKB_COMPILER_ALLOWED_TARGETS. Select an allowed default or explicitly update the restriction.`);
  const runtimeScope = await stackScope(distribution, paths.runtimeRoot, paths.libraryRoot);
  const runtimeDefault = runtimeScope.resolve(input.runtimeTarget ?? runtimeScope.local.activeTarget ?? runtimeScope.library.activeTarget ?? target);
  const resolvable = (scope: typeof compilerScope, names: string[], active: DkbResolvedContextConfig) => {
    const recipes: Record<string, DkbResolvedContextConfig> = { [active.activeTarget]: active };
    for (const name of names) {
      if (name === active.activeTarget) continue;
      try { recipes[name] = scope.resolve(name); } catch {
        // An unresolved inactive recipe remains allowed. The compiler catalog reports its failure;
        // Stack startup does not rewrite it or replace it with a bundled recipe.
      }
    }
    return recipes;
  };
  const compiler = resolvable(compilerScope, compilerNames, compilerDefault);
  const runtime = resolvable(runtimeScope, runtimeScope.names, runtimeDefault);
  const services = async (recipes: Record<string, DkbResolvedContextConfig>, active: string) => Object.fromEntries(await Promise.all(
    Object.entries(recipes).map(async ([name, config]) => {
      const ids = new Set([config.target.evidence, config.target.parser, config.target.chunker,
        config.target.embedding, config.target.index, config.target.retrieval,
        ...(config.target.processors ?? []), ...(config.target.observers ?? [])].filter(Boolean));
      const selected: string[] = [];
      for (const service of distribution.services) {
        if (!service.providerId || !ids.has(service.providerId)) continue;
        try {
          if ((await resolvePluginSource(config, distribution, service.providerId)).source === 'bundled') selected.push(service.id);
        } catch (error) {
          if (name === active) throw error;
          // Do not attest an unresolved inactive implementation. Its catalog row remains visible.
        }
      }
      return [name, selected];
    }),
  ));
  const compilerServices = await services(compiler, target);
  const runtimeServices = await services(runtime, runtimeDefault.activeTarget);
  const selected = new Set([...compilerServices[target]!, ...runtimeServices[runtimeDefault.activeTarget]!]);
  // Unbound services are Stack infrastructure; provider services belong to selected implementations, never target labels.
  const requiredServices = distribution.services.filter((service) => !service.providerId || selected.has(service.id));
  return { target, runtimeTarget: runtimeDefault.activeTarget, compilerTargets: compilerNames, allowedTargets, compiler, runtime, compilerServices, runtimeServices, requiredServices };
}

async function stackScope(distribution: DkbDistribution, root: string, libraryRoot?: string) {
  const local = await readDkbContextConfig(path.join(root, DKB_CONFIG_PATH));
  const library = libraryRoot ? await readDkbContextConfig(path.join(libraryRoot, DKB_CONFIG_PATH)) : { format: DKB_CONFIG_FORMAT } as DkbContextConfig;
  // Containers mount their trusted context and (for Runtime) Library, not the host's user-global directory.
  // Reusing the already-searched local plugin directory as the empty global scope keeps planning inside those mounts.
  const globalRoot = path.join(root, '.dkb');
  const resolve = (target?: string) => resolveContextConfigDocuments(root, globalRoot, distribution.defaults,
    { format: DKB_CONFIG_FORMAT }, local, target, library, libraryRoot);
  const names = [...new Set([...Object.keys(distribution.defaults.targets ?? {}), ...Object.keys(library.targets ?? {}), ...Object.keys(local.targets ?? {})])].sort();
  return { names, local, library, resolve };
}

export function selectedServiceEnvironment(selection: StackSelection): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [recipe, bindings] of [
    [selection.compiler[selection.target]!, selection.compilerServices[selection.target]!],
    [selection.runtime[selection.runtimeTarget]!, selection.runtimeServices[selection.runtimeTarget]!],
  ] as const) {
    for (const service of selection.requiredServices) {
      if (!service.providerId || !bindings.includes(service.id)) continue;
      const mappedOptions = { ...service.stack?.optionEnvironment,
        ...(service.stack ? { image: service.stack.imageEnvironment } : {}) };
      for (const [option, environment] of Object.entries(mappedOptions)) {
        const value = recipe.target.options?.[service.providerId]?.[option];
        if (value === undefined) continue;
        const encoded = environmentValue(value, service.id, option);
        if (result[environment] !== undefined && result[environment] !== encoded) {
          throw new DkbError(`Compiler and Runtime recipes require different ${service.id}.${option} values for one shared Stack service. Use separately configured services or Stacks; neither recipe was changed.`);
        }
        result[environment] = encoded;
      }
    }
  }
  return validateStackServiceEnvironment(result, selection.requiredServices, selection.requiredServices.map(service => service.id));
}

function environmentValue(value: unknown, serviceId: string, option: string): string {
  if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return String(value);
  throw new DkbError(`Stack option ${serviceId}.${option} must be a string, number, or boolean to map into a service environment variable.`);
}

/** Configuration planning identity only; provider integrity and build compatibility are separate gates. */
export function stackSelectionDigest(distribution: DkbDistribution, selection: StackSelection): string {
  const recipes = (values: Record<string, DkbResolvedContextConfig>) => Object.fromEntries(
    Object.entries(values).map(([name, config]) => [name, config.target.configDigest]),
  );
  return stableHash({ distribution: { id: distribution.id, version: distribution.version },
    compiler: recipes(selection.compiler), runtime: recipes(selection.runtime),
    compilerServices: selection.compilerServices, runtimeServices: selection.runtimeServices,
    services: selection.requiredServices,
  });
}
