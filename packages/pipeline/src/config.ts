import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

export const DKB_CONFIG_FORMAT = 'dkb.config.v2';
export const DKB_CONFIG_PATH = '.dkb/config.json';
export const DEFAULT_PIPELINE_TARGET = 'default';

export interface DkbPipelineTargetConfig {
  evidence?: string;
  parser?: string;
  chunker?: string;
  embedding: string;
  index: string;
  retrieval: string;
  processors?: string[];
  options?: Record<string, Record<string, unknown>>;
}

export interface DkbContextConfig {
  format: typeof DKB_CONFIG_FORMAT;
  registry?: {
    url?: string;
  };
  activeTarget?: string;
  targets?: Record<string, Partial<DkbPipelineTargetConfig>>;
}

export interface DkbResolvedPipelineTarget extends DkbPipelineTargetConfig {
  name: string;
  configDigest: string;
}

export interface DkbResolvedContextConfig {
  root: string;
  libraryRoot?: string;
  globalRoot: string;
  activeTarget: string;
  target: DkbResolvedPipelineTarget;
  global: DkbContextConfig;
  library: DkbContextConfig;
  local: DkbContextConfig;
}

export function defaultDkbGlobalRoot(): string {
  return process.env.DKB_GLOBAL_ROOT
    ? path.resolve(process.env.DKB_GLOBAL_ROOT)
    : path.join(os.homedir(), '.dkb');
}

export async function resolveContextConfig(
  root: string,
  options: { defaults: DkbContextConfig; globalRoot?: string; libraryRoot?: string; target?: string },
): Promise<DkbResolvedContextConfig> {
  const resolvedRoot = path.resolve(root);
  const globalRoot = path.resolve(options.globalRoot ?? defaultDkbGlobalRoot());
  const libraryRoot = options.libraryRoot ? path.resolve(options.libraryRoot) : undefined;
  const [global, library, local] = await Promise.all([
    readDkbContextConfig(path.join(globalRoot, 'config.json')),
    libraryRoot && libraryRoot !== resolvedRoot
      ? readDkbContextConfig(path.join(libraryRoot, DKB_CONFIG_PATH))
      : Promise.resolve({ format: DKB_CONFIG_FORMAT } as DkbContextConfig),
    readDkbContextConfig(path.join(resolvedRoot, DKB_CONFIG_PATH)),
  ]);
  return resolveContextConfigDocuments(resolvedRoot, globalRoot, options.defaults, global, local, options.target, library, libraryRoot);
}

export function resolveContextConfigDocuments(
  resolvedRoot: string,
  globalRoot: string,
  defaults: DkbContextConfig,
  global: DkbContextConfig,
  local: DkbContextConfig,
  selectedTarget?: string,
  library: DkbContextConfig = { format: DKB_CONFIG_FORMAT },
  libraryRoot?: string,
): DkbResolvedContextConfig {
  const activeTarget = selectedTarget?.trim()
    || local.activeTarget?.trim()
    || library.activeTarget?.trim()
    || global.activeTarget?.trim()
    || defaults.activeTarget
    || DEFAULT_PIPELINE_TARGET;
  const bundledTarget = defaults.targets?.[activeTarget]
    ?? (activeTarget === DEFAULT_PIPELINE_TARGET ? defaults.targets?.[DEFAULT_PIPELINE_TARGET] : undefined);
  const globalTarget = global.targets?.[activeTarget];
  const libraryTarget = library.targets?.[activeTarget];
  const localTarget = local.targets?.[activeTarget];

  if (!bundledTarget && !globalTarget && !libraryTarget && !localTarget) {
    throw new DkbError(`Pipeline target "${activeTarget}" is not configured in ${resolvedRoot}, ${globalRoot}, or DKB's bundled defaults`);
  }

  const merged = mergeTarget(mergeTarget(mergeTarget(bundledTarget, globalTarget), libraryTarget), localTarget);
  const target = validateTarget(activeTarget, merged);

  return {
    root: resolvedRoot,
    ...(libraryRoot ? { libraryRoot } : {}),
    globalRoot,
    activeTarget,
    target: {
      ...target,
      name: activeTarget,
      configDigest: stableHash(target),
    },
    global,
    library,
    local,
  };
}

export async function readDkbContextConfig(target: string): Promise<DkbContextConfig> {
  let source: string;

  try {
    source = await fs.readFile(target, 'utf8');
  } catch (error) {
    if (isMissing(error)) {
      return { format: DKB_CONFIG_FORMAT };
    }
    throw error;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new DkbError(`Invalid DKB configuration at ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return validateContextConfig(parsed, target);
}

export async function writeDkbContextConfig(target: string, config: DkbContextConfig): Promise<void> {
  validateContextConfig(config, target);
  const resolved = path.resolve(target);
  const temp = `${resolved}.${process.pid}.${Date.now().toString(36)}.tmp`;

  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await fs.rm(resolved, { force: true });
  await fs.rename(temp, resolved);
}

export function validateContextConfig(value: unknown, source = DKB_CONFIG_PATH): DkbContextConfig {
  if (!isRecord(value) || value.format !== DKB_CONFIG_FORMAT) {
    throw new DkbError(`Invalid DKB configuration at ${source}: format must be ${DKB_CONFIG_FORMAT}`);
  }
  if (value.activeTarget !== undefined && (typeof value.activeTarget !== 'string' || value.activeTarget.trim().length === 0)) {
    throw new DkbError(`Invalid DKB configuration at ${source}: activeTarget must be a non-empty string`);
  }
  if (value.targets !== undefined && !isRecord(value.targets)) {
    throw new DkbError(`Invalid DKB configuration at ${source}: targets must be an object`);
  }

  return { ...value, format: DKB_CONFIG_FORMAT } as unknown as DkbContextConfig;
}

function validateTarget(name: string, target: Partial<DkbPipelineTargetConfig> | undefined): DkbPipelineTargetConfig {
  if (!target) {
    throw new DkbError(`Pipeline target "${name}" has no configuration`);
  }
  if (Boolean(target.evidence) === Boolean(target.parser || target.chunker)) {
    throw new DkbError(`Pipeline target "${name}" must select either one Evidence provider or both parser and chunker providers`);
  }
  if (!target.evidence && (!target.parser || !target.chunker)) {
    throw new DkbError(`Pipeline target "${name}" requires both parser and chunker providers`);
  }
  for (const key of ['embedding', 'index', 'retrieval'] as const) {
    if (!isPluginId(target[key])) {
      throw new DkbError(`Pipeline target "${name}" requires a namespaced ${key} provider id`);
    }
  }
  for (const providerId of [target.evidence, target.parser, target.chunker].filter(Boolean)) {
    if (!isPluginId(providerId)) {
      throw new DkbError(`Pipeline target "${name}" contains an invalid provider id: ${String(providerId)}`);
    }
  }
  if (target.processors && (!Array.isArray(target.processors) || target.processors.some((id) => !isPluginId(id)))) {
    throw new DkbError(`Pipeline target "${name}" processors must be namespaced plugin ids`);
  }
  if (target.options && !isRecord(target.options)) {
    throw new DkbError(`Pipeline target "${name}" options must be an object keyed by provider id`);
  }
  for (const [providerId, options] of Object.entries(target.options ?? {})) {
    if (!isPluginId(providerId) || !isRecord(options)) {
      throw new DkbError(`Pipeline target "${name}" options must be keyed by namespaced provider ids`);
    }
    assertNoInlineSecrets(options, `Pipeline target "${name}" options for ${providerId}`);
  }

  const embedding = target.embedding as string;
  const index = target.index as string;
  const retrieval = target.retrieval as string;

  return {
    ...(target.evidence ? { evidence: target.evidence } : {}),
    ...(target.parser ? { parser: target.parser } : {}),
    ...(target.chunker ? { chunker: target.chunker } : {}),
    embedding,
    index,
    retrieval,
    processors: [...(target.processors ?? [])],
    options: cloneOptions(target.options),
  };
}

function mergeTarget(
  base: Partial<DkbPipelineTargetConfig> | undefined,
  override: Partial<DkbPipelineTargetConfig> | undefined,
): Partial<DkbPipelineTargetConfig> | undefined {
  if (!base && !override) {
    return undefined;
  }

  const result: Partial<DkbPipelineTargetConfig> = {
    ...base,
    ...override,
    processors: override && Object.hasOwn(override, 'processors') ? [...(override.processors ?? [])] : [...(base?.processors ?? [])],
    options: mergeOptions(base?.options, override?.options),
  };

  if (override?.evidence) {
    delete result.parser;
    delete result.chunker;
  } else if (override?.parser || override?.chunker) {
    delete result.evidence;
  }

  return result;
}

function mergeOptions(
  base: Record<string, Record<string, unknown>> | undefined,
  override: Record<string, Record<string, unknown>> | undefined,
): Record<string, Record<string, unknown>> {
  const result = cloneOptions(base);

  for (const [id, options] of Object.entries(override ?? {})) {
    if (!isRecord(options)) {
      throw new DkbError(`Provider options for ${id} must be an object`);
    }
    result[id] = deepMerge(result[id] ?? {}, options);
  }

  return result;
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(override)) {
    result[key] = isRecord(value) && isRecord(result[key])
      ? deepMerge(result[key] as Record<string, unknown>, value)
      : value;
  }

  return result;
}

function cloneOptions(options: Record<string, Record<string, unknown>> | undefined): Record<string, Record<string, unknown>> {
  return Object.fromEntries(Object.entries(options ?? {}).map(([id, value]) => [id, deepMerge({}, value)]));
}

function assertNoInlineSecrets(value: Record<string, unknown>, source: string, pathPrefix = ''): void {
  for (const [key, nested] of Object.entries(value)) {
    const optionPath = pathPrefix ? `${pathPrefix}.${key}` : key;

    if (/^(api[_-]?key|access[_-]?token|token|password|secret)$/i.test(key)) {
      throw new DkbError(`${source} cannot store ${optionPath}; use an environment or secret reference option instead`);
    }
    if (isRecord(nested)) {
      assertNoInlineSecrets(nested, source, optionPath);
    }
  }
}

export function isPluginId(value: unknown): value is string {
  return typeof value === 'string' && /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}
