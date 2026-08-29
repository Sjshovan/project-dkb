import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import {
  DKB_CONFIG_FORMAT,
  DKB_CONFIG_PATH,
  defaultDkbGlobalRoot,
  isPluginId,
  readDkbContextConfig,
  resolveContextConfig,
  resolveContextConfigDocuments,
  writeDkbContextConfig,
  type DkbContextConfig,
  type DkbPipelineTargetConfig,
} from '@sjshovan/dkb-pipeline/config.js';
import { DkbProviderHost, pluginPath, type DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import type { DkbPluginModule } from '@sjshovan/dkb-pipeline/types.js';
import { maybeReadRetrievalProfileLock, resolveProviderRetrievalProfile } from '@sjshovan/dkb-pipeline/profile.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { maybeReadRuntimeLock } from '@sjshovan/dkb-library/builds.js';

export type DkbPluginScope = 'local' | 'global';

export interface DkbPluginListEntry {
  id: string;
  version: string | null;
  scope: DkbPluginScope | 'bundled';
  path: string;
  selected: boolean;
  valid: boolean;
  error?: string;
}

export async function listPipelineTargets(input: { distribution: DkbDistribution; root: string; globalRoot?: string }): Promise<{
  root: string;
  activeTarget: string;
  targets: Array<{ name: string; active: boolean; providers: string[] }>;
}> {
  const resolved = await resolveContextConfig(input.root, { defaults: input.distribution.defaults, ...(input.globalRoot ? { globalRoot: input.globalRoot } : {}) });
  const names = [...new Set([
    ...Object.keys(input.distribution.defaults.targets ?? {}),
    ...Object.keys(resolved.global.targets ?? {}),
    ...Object.keys(resolved.local.targets ?? {}),
  ])];
  return {
    root: resolved.root,
    activeTarget: resolved.activeTarget,
    targets: names.map((name) => {
      const target = resolveContextConfigDocuments(resolved.root, resolved.globalRoot, input.distribution.defaults, resolved.global, resolved.local, name).target;
      return { name, active: name === resolved.activeTarget, providers: selectedPluginIds(target) };
    }).sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export async function activatePipelineTarget(input: { distribution: DkbDistribution; root: string; name: string; globalRoot?: string }): Promise<ReturnType<DkbProviderHost['describe']>> {
  const root = path.resolve(input.root);
  const globalRoot = path.resolve(input.globalRoot ?? defaultDkbGlobalRoot());
  const targetPath = path.join(root, DKB_CONFIG_PATH);
  const [global, local] = await Promise.all([
    readDkbContextConfig(path.join(globalRoot, 'config.json')),
    readDkbContextConfig(targetPath),
  ]);
  const candidate: DkbContextConfig = { ...local, format: DKB_CONFIG_FORMAT, activeTarget: input.name };
  const resolved = resolveContextConfigDocuments(root, globalRoot, input.distribution.defaults, global, candidate, input.name);
  const host = await DkbProviderHost.createFromConfig(resolved, input.distribution);

  try {
    const selected = await resolveProviderRetrievalProfile(host);
    const runtime = await maybeReadRuntimeLock(root);
    if (runtime && (
      runtime.evidenceProfileDigest !== selected.evidenceProfileDigest
      || runtime.retrievalProfileDigest !== selected.retrievalProfileDigest
      || runtime.compatibilityDigest !== stableHash(selected.compatibility)
    )) {
      throw new DkbError(
        `Cannot activate pipeline target "${input.name}": the active Runtime Build is ${runtime.retrievalProfileDigest}. `
        + `Prepare this target first with dkb build ${root} --pipeline ${input.name}.`,
      );
    }
    const description = host.describe();
    await writeDkbContextConfig(targetPath, candidate);
    return description;
  } finally {
    await host.dispose();
  }
}

export async function addPlugin(input: {
  root: string;
  source: string;
  scope?: DkbPluginScope;
  globalRoot?: string;
}): Promise<DkbPluginListEntry> {
  const sourceDirectory = await pluginSourceDirectory(input.source);
  const identity = await inspectPlugin(path.join(sourceDirectory, 'plugin.mjs'));
  const destination = pluginDirectory(input.root, identity.id, input.scope ?? 'local', input.globalRoot);

  await assertDestinationAvailable(destination, identity.id);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(sourceDirectory, destination, { recursive: true, errorOnExist: true, force: false });

  return {
    id: identity.id,
    version: identity.version,
    scope: input.scope ?? 'local',
    path: path.join(destination, 'plugin.mjs'),
    selected: false,
    valid: true,
  };
}

export async function linkPlugin(input: {
  root: string;
  source: string;
  scope?: DkbPluginScope;
  globalRoot?: string;
}): Promise<DkbPluginListEntry> {
  const sourceDirectory = await pluginSourceDirectory(input.source);
  const identity = await inspectPlugin(path.join(sourceDirectory, 'plugin.mjs'));
  const destination = pluginDirectory(input.root, identity.id, input.scope ?? 'local', input.globalRoot);

  await assertDestinationAvailable(destination, identity.id);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.symlink(sourceDirectory, destination, process.platform === 'win32' ? 'junction' : 'dir');

  return {
    id: identity.id,
    version: identity.version,
    scope: input.scope ?? 'local',
    path: path.join(destination, 'plugin.mjs'),
    selected: false,
    valid: true,
  };
}

export async function removePlugin(input: {
  distribution: DkbDistribution;
  root: string;
  id: string;
  scope?: DkbPluginScope;
  globalRoot?: string;
}): Promise<{ id: string; scope: DkbPluginScope; removed: boolean; path: string }> {
  if (!isPluginId(input.id)) {
    throw new DkbError(`Invalid plugin id: ${input.id}`);
  }
  const scope = input.scope ?? 'local';
  const destination = pluginDirectory(input.root, input.id, scope, input.globalRoot);
  const selected = await resolveContextConfig(input.root, { defaults: input.distribution.defaults, ...(input.globalRoot ? { globalRoot: input.globalRoot } : {}) });
  const selectedIds = selectedPluginIds(selected.target);

  if (selectedIds.includes(input.id)) {
    throw new DkbError(`Cannot remove selected plugin ${input.id}. Change the active pipeline target first.`);
  }
  const removed = await pathExists(destination);

  if (removed) {
    await fs.rm(destination, { recursive: true, force: false });
  }

  return { id: input.id, scope, removed, path: destination };
}

export async function listPlugins(input: {
  distribution: DkbDistribution;
  root: string;
  globalRoot?: string;
}): Promise<DkbPluginListEntry[]> {
  const resolved = await resolveContextConfig(input.root, { defaults: input.distribution.defaults, ...(input.globalRoot ? { globalRoot: input.globalRoot } : {}) });
  const selected = new Set(selectedPluginIds(resolved.target));
  const entries = [
    ...(await scanPlugins(path.join(resolved.globalRoot, 'plugins'), 'global', selected)),
    ...(await scanPlugins(path.join(resolved.root, '.dkb/plugins'), 'local', selected)),
    ...input.distribution.plugins.map((plugin) => ({
      id: plugin.id,
      version: plugin.version,
      scope: 'bundled' as const,
      path: `bundled:${plugin.id}`,
      selected: selected.has(plugin.id),
      valid: true,
    })),
  ];

  return entries.sort((left, right) => left.id.localeCompare(right.id) || scopeRank(left.scope) - scopeRank(right.scope));
}

export async function setPipelineTarget(input: {
  distribution: DkbDistribution;
  root: string;
  name: string;
  patch: Partial<DkbPipelineTargetConfig>;
  activate?: boolean;
  globalRoot?: string;
}): Promise<ReturnType<DkbProviderHost['describe']>> {
  const root = path.resolve(input.root);
  const globalRoot = path.resolve(input.globalRoot ?? defaultDkbGlobalRoot());
  const targetPath = path.join(root, DKB_CONFIG_PATH);
  const [global, local] = await Promise.all([
    readDkbContextConfig(path.join(globalRoot, 'config.json')),
    readDkbContextConfig(targetPath),
  ]);
  const candidate: DkbContextConfig = {
    ...local,
    format: DKB_CONFIG_FORMAT,
    ...(input.activate ? { activeTarget: input.name } : local.activeTarget ? { activeTarget: local.activeTarget } : {}),
    targets: {
      ...(local.targets ?? {}),
      [input.name]: {
        ...input.patch,
        options: {
          ...(local.targets?.[input.name]?.options ?? {}),
          ...(input.patch.options ?? {}),
        },
      },
    },
  };
  const resolved = resolveContextConfigDocuments(root, globalRoot, input.distribution.defaults, global, candidate, input.activate ? input.name : undefined);
  const host = await DkbProviderHost.createFromConfig(resolved, input.distribution);

  try {
    const unhealthy = (await host.health()).filter((result) => !result.ok && result.kind !== 'embedding' && result.kind !== 'evidence');

    if (unhealthy.length > 0) {
      throw new DkbError(`Pipeline validation failed: ${unhealthy.map((result) => `${result.id}: ${result.detail ?? 'unhealthy'}`).join('; ')}`);
    }
    if (input.activate) {
      const installedProfile = await maybeReadRetrievalProfileLock(root);

      if (installedProfile) {
        const selectedProfile = await resolveProviderRetrievalProfile(host);
        const selectedCompatibilityDigest = stableHash(selectedProfile.compatibility);

        if (selectedCompatibilityDigest !== installedProfile.compatibilityDigest) {
          throw new DkbError(
            `Cannot activate pipeline target "${input.name}": installed packages require compatibility ${installedProfile.compatibilityDigest}, but the target provides ${selectedCompatibilityDigest}. Save it with --no-activate, rebuild or remove incompatible packages, then activate it.`,
          );
        }
      }
    }
    const description = host.describe();
    await writeDkbContextConfig(targetPath, candidate);
    return description;
  } finally {
    await host.dispose();
  }
}

export async function verifyPipeline(input: { distribution: DkbDistribution; root: string; globalRoot?: string; target?: string }): Promise<{
  ok: boolean;
  pipeline: ReturnType<DkbProviderHost['describe']>;
  health: Awaited<ReturnType<DkbProviderHost['health']>>;
}> {
  const host = await DkbProviderHost.create({
    root: input.root,
    ...(input.globalRoot ? { globalRoot: input.globalRoot } : {}),
    ...(input.target ? { target: input.target } : {}),
    distribution: input.distribution,
  });

  try {
    const health = await host.health();
    return { ok: health.every((result) => result.ok), pipeline: host.describe(), health };
  } finally {
    await host.dispose();
  }
}

async function pluginSourceDirectory(source: string): Promise<string> {
  const resolved = path.resolve(source);
  const stat = await fs.stat(resolved).catch(() => null);

  if (!stat) {
    throw new DkbError(`Plugin source does not exist: ${resolved}`);
  }
  const directory = stat.isDirectory() ? resolved : path.dirname(resolved);
  const entrypoint = stat.isDirectory() ? path.join(resolved, 'plugin.mjs') : resolved;

  if (path.basename(entrypoint) !== 'plugin.mjs') {
    throw new DkbError(`Plugin source must be a directory containing plugin.mjs or the plugin.mjs file itself`);
  }
  await inspectPlugin(entrypoint);
  return directory;
}

async function inspectPlugin(target: string): Promise<{ id: string; version: string }> {
  try {
    const url = pathToFileURL(target);
    url.searchParams.set('dkb-inspect', `${Date.now()}-${Math.random()}`);
    const plugin = await import(url.href) as Partial<DkbPluginModule>;

    if (plugin.apiVersion !== 2 || !isPluginId(plugin.id) || typeof plugin.version !== 'string' || plugin.version.trim().length === 0 || typeof plugin.setup !== 'function') {
      throw new DkbError(`expected exports apiVersion=2, id, version, and setup(context)`);
    }
    return { id: plugin.id, version: plugin.version };
  } catch (error) {
    throw new DkbError(`Invalid DKB plugin at ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function scanPlugins(root: string, scope: DkbPluginScope, selected: ReadonlySet<string>): Promise<DkbPluginListEntry[]> {
  const entries: DkbPluginListEntry[] = [];
  const namespaces = await fs.readdir(root, { withFileTypes: true }).catch(() => []);

  for (const namespace of namespaces.filter((entry) => entry.isDirectory() && entry.name.startsWith('@'))) {
    const namespaceRoot = path.join(root, namespace.name);
    const names = await fs.readdir(namespaceRoot, { withFileTypes: true }).catch(() => []);

    for (const name of names.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())) {
      const id = `${namespace.name}/${name.name}`;
      const entrypoint = path.join(namespaceRoot, name.name, 'plugin.mjs');

      try {
        const identity = await inspectPlugin(entrypoint);
        entries.push({ id, version: identity.version, scope, path: entrypoint, selected: selected.has(id), valid: identity.id === id, ...(identity.id !== id ? { error: `exports id ${identity.id}` } : {}) });
      } catch (error) {
        entries.push({ id, version: null, scope, path: entrypoint, selected: selected.has(id), valid: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  return entries;
}

function pluginDirectory(root: string, id: string, scope: DkbPluginScope, globalRoot?: string): string {
  const pluginsRoot = scope === 'global'
    ? path.join(path.resolve(globalRoot ?? defaultDkbGlobalRoot()), 'plugins')
    : path.join(path.resolve(root), '.dkb/plugins');

  return path.dirname(pluginPath(pluginsRoot, id));
}

async function assertDestinationAvailable(destination: string, id: string): Promise<void> {
  if (await pathExists(destination)) {
    throw new DkbError(`Plugin ${id} already exists at ${destination}. Remove it before replacing it.`);
  }
}

async function pathExists(target: string): Promise<boolean> {
  return Boolean(await fs.lstat(target).catch(() => null));
}

function selectedPluginIds(target: DkbPipelineTargetConfig): string[] {
  return [target.evidence, target.parser, target.chunker, target.embedding, target.index, target.retrieval, ...(target.processors ?? [])]
    .filter((id): id is string => Boolean(id));
}

function scopeRank(scope: DkbPluginListEntry['scope']): number {
  return scope === 'local' ? 0 : scope === 'global' ? 1 : 2;
}
