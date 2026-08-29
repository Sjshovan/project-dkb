import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import {
  isPluginId,
  resolveContextConfig,
  type DkbContextConfig,
  type DkbResolvedContextConfig,
} from './config.js';
import type {
  DkbPluginModule,
  DkbProcessor,
  DkbProcessorRegistration,
  DkbProcessorStage,
  DkbProvider,
  DkbProviderKind,
  DkbProviderRegistration,
} from './types.js';

export interface DkbBundledPlugin {
  apiVersion: DkbPluginModule['apiVersion'];
  id: string;
  version: string;
  setup: DkbPluginModule['setup'];
}

export interface DkbDistributionService {
  id: string;
  kind: 'process' | 'docker' | 'remote';
  requiredBy: string[];
  providerId?: string;
  image?: string;
  version?: string;
  healthPath?: string;
  stack?: {
    composeProfile?: string;
    composeService?: string;
    imageEnvironment: string;
    build?: {
      context: string;
      dockerfile: string;
    };
    recovery?: string;
    stateDirectory?: string;
    optionEnvironment?: Record<string, string>;
    secretEnvironment?: string[];
    health?: {
      component: string;
      portEnvironment: string;
      defaultHostPort: number;
      namedPortBase: number;
      path: string;
      expectation: 'http-ok' | 'json-ok' | 'status-available';
    };
  };
}

export interface DkbDistribution {
  id: string;
  version: string;
  defaults: DkbContextConfig;
  plugins: readonly DkbBundledPlugin[];
  services: readonly DkbDistributionService[];
}

export interface DkbProviderHostOptions {
  root: string;
  distribution: DkbDistribution;
  globalRoot?: string;
  target?: string;
}

export interface DkbProviderHostDescription {
  root: string;
  globalRoot: string;
  target: string;
  configDigest: string;
  providers: Array<{
    id: string;
    version: string;
    kind: DkbProviderKind;
    source: DkbProviderRegistration['source'];
    sourcePath: string;
    sourceDigest: string;
  }>;
  processors: Array<{
    id: string;
    version: string;
    stage: DkbProcessorStage;
    source: DkbProcessorRegistration['source'];
    sourcePath: string;
    sourceDigest: string;
  }>;
  buildDigest: string;
}

export class DkbProviderHost {
  readonly root: string;
  readonly globalRoot: string;
  readonly config: DkbResolvedContextConfig;
  private readonly providers = new Map<DkbProviderKind, DkbProviderRegistration>();
  private readonly processors: DkbProcessorRegistration[] = [];
  private disposed = false;

  private constructor(config: DkbResolvedContextConfig) {
    this.root = config.root;
    this.globalRoot = config.globalRoot;
    this.config = config;
  }

  static async create(options: DkbProviderHostOptions): Promise<DkbProviderHost> {
    const config = await resolveContextConfig(options.root, {
      defaults: options.distribution.defaults,
      ...(options.globalRoot ? { globalRoot: options.globalRoot } : {}),
      ...(options.target ? { target: options.target } : {}),
    });
    return DkbProviderHost.createFromConfig(config, options.distribution);
  }

  static async createFromConfig(config: DkbResolvedContextConfig, distribution: DkbDistribution): Promise<DkbProviderHost> {
    const host = new DkbProviderHost(config);
    const bundled = new Map(distribution.plugins.map((plugin) => [plugin.id, plugin]));

    for (const id of selectedPluginIds(config)) {
      await host.loadSelectedPlugin(id, bundled);
    }
    host.validateSelections();

    return host;
  }

  provider<TProvider extends DkbProvider>(kind: TProvider['kind']): TProvider {
    this.assertActive();
    const registration = this.providers.get(kind);

    if (!registration) {
      throw new DkbError(`Pipeline target "${this.config.activeTarget}" did not register its selected ${kind} provider`);
    }

    return registration.provider as TProvider;
  }

  processorPipeline(stage: DkbProcessorStage): readonly DkbProcessorRegistration[] {
    this.assertActive();
    return this.processors.filter((registration) => registration.processor.stage === stage);
  }

  async mutate<TValue>(stage: DkbProcessorStage, values: readonly TValue[], signal?: AbortSignal): Promise<TValue[]> {
    this.assertActive();
    let current = [...values];

    for (const registration of this.processorPipeline(stage)) {
      const options = this.optionsFor(registration.id);
      const next: TValue[] = [];

      for (const value of current) {
        if (signal?.aborted) {
          throw signal.reason ?? new DkbError(`Pipeline processor ${registration.id} was cancelled`);
        }
        const mutated = await (registration.processor as DkbProcessor<TValue>).mutate(value, {
          root: this.root,
          options,
          ...(signal ? { signal } : {}),
        });

        if (mutated !== null) {
          next.push(mutated);
        }
      }

      current = next;
    }

    return current;
  }

  optionsFor(id: string): Readonly<Record<string, unknown>> {
    return Object.freeze({ ...(this.config.target.options?.[id] ?? {}) });
  }

  describe(): DkbProviderHostDescription {
    this.assertActive();
    const providers = [...this.providers.entries()]
      .map(([kind, registration]) => ({
        id: registration.id,
        version: registration.version,
        kind,
        source: registration.source,
        sourcePath: registration.sourcePath,
        sourceDigest: registration.sourceDigest,
      }))
      .sort((left, right) => PROVIDER_KIND_ORDER.indexOf(left.kind) - PROVIDER_KIND_ORDER.indexOf(right.kind));
    const processors = this.processors.map((registration) => ({
      id: registration.id,
      version: registration.version,
      stage: registration.processor.stage,
      source: registration.source,
      sourcePath: registration.sourcePath,
      sourceDigest: registration.sourceDigest,
    }));

    return {
      root: this.root,
      globalRoot: this.globalRoot,
      target: this.config.activeTarget,
      configDigest: this.config.target.configDigest,
      providers,
      processors,
      buildDigest: stableHash({ target: this.config.target, providers, processors }),
    };
  }

  async health(kinds?: readonly DkbProviderKind[]): Promise<Array<{ id: string; kind: DkbProviderKind; ok: boolean; detail?: string }>> {
    this.assertActive();
    const selectedKinds = kinds ? new Set(kinds) : null;

    return Promise.all([...this.providers.entries()]
      .filter(([kind]) => !selectedKinds || selectedKinds.has(kind))
      .map(async ([kind, registration]) => {
        try {
          const result = await registration.provider.health?.() ?? { ok: true };
          return { id: registration.id, kind, ...result };
        } catch (error) {
          return {
            id: registration.id,
            kind,
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
          };
        }
      }));
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const disposables = [
      ...this.processors.map((registration) => registration.processor),
      ...[...this.providers.values()].map((registration) => registration.provider),
    ];

    await Promise.allSettled(disposables.map(async (disposable) => disposable.dispose?.()));
    this.processors.length = 0;
    this.providers.clear();
  }

  private async loadSelectedPlugin(id: string, bundled: ReadonlyMap<string, DkbBundledPlugin>): Promise<void> {
    if (!isPluginId(id)) {
      throw new DkbError(`Invalid selected plugin id: ${id}`);
    }
    const localPath = pluginPath(path.join(this.root, '.dkb/plugins'), id);
    const globalPath = pluginPath(path.join(this.globalRoot, 'plugins'), id);
    const localExists = await fileExists(localPath);
    const globalExists = await fileExists(globalPath);
    let plugin: DkbPluginModule;
    let source: DkbProviderRegistration['source'];
    let sourcePath: string;
    let sourceDigest: string;

    if (localExists) {
      plugin = await importPlugin(localPath, this.root);
      source = 'local';
      sourcePath = localPath;
      sourceDigest = await hashPluginDirectory(path.dirname(localPath));
    } else if (globalExists) {
      plugin = await importPlugin(globalPath, this.root);
      source = 'global';
      sourcePath = globalPath;
      sourceDigest = await hashPluginDirectory(path.dirname(globalPath));
    } else {
      const selected = bundled.get(id);

      if (!selected) {
        throw new DkbError(`Selected plugin ${id} was not found locally at ${localPath}, globally at ${globalPath}, or in DKB's bundled providers`);
      }
      plugin = selected;
      source = 'bundled';
      sourcePath = `bundled:${id}`;
      sourceDigest = stableHash({ apiVersion: selected.apiVersion, id: selected.id, version: selected.version, setup: String(selected.setup) });
    }

    validatePluginModule(plugin, id, sourcePath);
    const registeredProviders: DkbProviderRegistration[] = [];
    const registeredProcessors: DkbProcessorRegistration[] = [];
    const options = this.optionsFor(id);

    try {
      await plugin.setup({
        root: this.root,
        pluginId: plugin.id,
        pluginVersion: plugin.version,
        options,
        registerProvider: (provider) => {
          validateProvider(provider, plugin.id);
          registeredProviders.push({ id: plugin.id, version: plugin.version, provider, source, sourcePath, sourceDigest });
        },
        registerProcessor: (processor) => {
          validateProcessor(processor, plugin.id);
          registeredProcessors.push({ id: plugin.id, version: plugin.version, processor, source, sourcePath, sourceDigest });
        },
      });
    } catch (error) {
      throw new DkbError(`Failed to set up selected ${source} plugin ${id} at ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (registeredProviders.length === 0 && registeredProcessors.length === 0) {
      throw new DkbError(`Selected plugin ${id} did not register a provider or processor`);
    }
    for (const registration of registeredProviders) {
      const existing = this.providers.get(registration.provider.kind);

      if (existing) {
        throw new DkbError(`Plugins ${existing.id} and ${id} both registered the selected ${registration.provider.kind} provider`);
      }
      this.providers.set(registration.provider.kind, registration);
    }
    this.processors.push(...registeredProcessors);
  }

  private validateSelections(): void {
    const target = this.config.target;
    const required: DkbProviderKind[] = [
      ...(target.evidence ? ['evidence' as const] : ['parser' as const, 'chunker' as const]),
      'embedding',
      'index',
      'retrieval',
    ];

    for (const kind of required) {
      if (!this.providers.has(kind)) {
        throw new DkbError(`Pipeline target "${target.name}" selected a ${kind} plugin that did not register a ${kind} provider`);
      }
    }
    if (this.processors.length !== (target.processors?.length ?? 0)) {
      throw new DkbError(`Pipeline target "${target.name}" requires each processor plugin to register exactly one processor`);
    }
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new DkbError(`Provider host for ${this.root} has been disposed`);
    }
  }
}

const PROVIDER_KIND_ORDER = ['evidence', 'parser', 'chunker', 'embedding', 'index', 'retrieval'] as const;

function selectedPluginIds(config: DkbResolvedContextConfig): string[] {
  const target = config.target;

  return [...new Set([
    target.evidence,
    target.parser,
    target.chunker,
    target.embedding,
    target.index,
    target.retrieval,
    ...(target.processors ?? []),
  ].filter((id): id is string => Boolean(id)))];
}

export function pluginPath(pluginsRoot: string, id: string): string {
  if (!isPluginId(id)) {
    throw new DkbError(`Invalid plugin id: ${id}`);
  }
  const [namespace, name] = id.split('/');

  return path.join(pluginsRoot, namespace as string, name as string, 'plugin.mjs');
}

async function importPlugin(target: string, contextRoot: string): Promise<DkbPluginModule> {
  try {
    const stat = await fs.stat(target);
    const url = pathToFileURL(target);
    url.searchParams.set('dkb-context', stableHash({ contextRoot, target, mtimeMs: stat.mtimeMs, size: stat.size }));
    return await import(url.href) as DkbPluginModule;
  } catch (error) {
    throw new DkbError(`Failed to load selected plugin at ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validatePluginModule(plugin: DkbPluginModule, selectedId: string, source: string): void {
  if (!plugin || plugin.apiVersion !== 2 || plugin.id !== selectedId || typeof plugin.version !== 'string' || plugin.version.length === 0 || typeof plugin.setup !== 'function') {
    throw new DkbError(`Invalid plugin at ${source}: expected exports apiVersion=2, id=${selectedId}, version, and setup(context)`);
  }
}

function validateProvider(provider: DkbProvider, pluginId: string): void {
  if (!provider || !['evidence', 'parser', 'chunker', 'embedding', 'index', 'retrieval'].includes(provider.kind)) {
    throw new DkbError(`Plugin ${pluginId} registered an invalid provider`);
  }
  if (provider.kind === 'evidence' && typeof provider.compile !== 'function') {
    throw new DkbError(`Plugin ${pluginId} Evidence provider must implement compile()`);
  }
  if (provider.kind === 'parser' && typeof provider.parse !== 'function') {
    throw new DkbError(`Plugin ${pluginId} parser provider must implement parse()`);
  }
  if (provider.kind === 'chunker' && typeof provider.chunk !== 'function') {
    throw new DkbError(`Plugin ${pluginId} chunker provider must implement chunk()`);
  }
  if (provider.kind === 'embedding'
    && (typeof provider.embedDocuments !== 'function' || typeof provider.embedQuery !== 'function' || typeof provider.compatibility !== 'function')) {
    throw new DkbError(`Plugin ${pluginId} embedding provider must implement document/query embedding and compatibility`);
  }
  if (provider.kind === 'index'
    && (!['packaged', 'managed'].includes(provider.mode) || typeof provider.format !== 'string' || provider.format.length === 0 || typeof provider.openRuntime !== 'function')) {
    throw new DkbError(`Plugin ${pluginId} index provider must declare mode/format and implement openRuntime()`);
  }
  if (provider.kind === 'retrieval'
    && (typeof provider.protocol !== 'string' || provider.protocol.length === 0 || typeof provider.openRuntime !== 'function')) {
    throw new DkbError(`Plugin ${pluginId} retrieval provider must declare its stable evidence protocol and implement openRuntime()`);
  }
}

function validateProcessor(processor: DkbProcessor, pluginId: string): void {
  if (!processor || processor.id !== pluginId || typeof processor.version !== 'string' || !['document', 'chunk', 'record'].includes(processor.stage) || typeof processor.mutate !== 'function') {
    throw new DkbError(`Plugin ${pluginId} registered an invalid processor`);
  }
}

async function fileExists(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isFile();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function hashPluginDirectory(root: string): Promise<string> {
  const files = await pluginFiles(root, root);
  const entries = await Promise.all(files.map(async (target) => ({
    path: path.relative(root, target).replace(/\\/g, '/'),
    hash: createHash('sha256').update(await fs.readFile(target)).digest('hex'),
  })));

  return stableHash(entries.sort((left, right) => left.path.localeCompare(right.path)));
}

async function pluginFiles(root: string, current: string): Promise<string[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const nested = await Promise.all(entries
    .filter((entry) => entry.name !== '.git' && entry.name !== 'node_modules')
    .map(async (entry) => {
      const target = path.join(current, entry.name);

      if (entry.isDirectory()) {
        return pluginFiles(root, target);
      }
      if (entry.isFile()) {
        return [target];
      }
      if (entry.isSymbolicLink()) {
        const stat = await fs.stat(target);
        return stat.isDirectory() ? pluginFiles(root, target) : stat.isFile() ? [target] : [];
      }
      return [];
    }));

  return nested.flat();
}
