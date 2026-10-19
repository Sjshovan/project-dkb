import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { captureFileSnapshot, assertFileSnapshotCurrent, type FileSnapshot } from '@sjshovan/dkb-protocol/fileSnapshot.js';
import { dependencyIntegrity, dependencyIntegrityInputs, validatePluginImports } from './dependencyIntegrity.js';
import { loadBundledPlugin, type DkbBundledPlugin } from './bundledPlugin.js';
export type { DkbBundledPlugin, DkbBundledPluginModule } from './bundledPlugin.js';
import {
  isPluginId,
  readDkbContextConfig,
  resolveContextConfig,
  type DkbContextConfig,
  type DkbResolvedContextConfig,
} from './config.js';
import { DKB_PLUGIN_API_VERSION } from './types.js';
import { importPluginModule } from './pluginModule.js';
import { QueryObserverDelivery, QUERY_OBSERVER_DELIVERY_TIMEOUT_MS } from './observerDelivery.js';
import { RegistrationDisposer } from './registrationLifecycle.js';
import { validateServiceRequirements } from './capabilities.js';
import type {
  DkbExternalIdentityKind,
  DkbPluginModule,
  DkbProcessor,
  DkbProcessorRegistration,
  DkbProcessorStage,
  DkbProvider,
  DkbProviderKind,
  DkbProviderRegistration,
  DkbProviderIntegrityReceipt,
  DkbProviderOptions,
  DkbPipelineChunk,
  DkbPipelineDocument,
  DkbPipelineRecord,
  DkbQueryObserver,
  DkbQueryObserverRegistration,
  DkbQueryObserverResult,
} from './types.js';
import {
  assertProtectedProcessorIdentity,
  mergeExternalIdentityDigests,
  resolvePluginIdentity,
  resolveProviderIdentity,
  validateProcessorStageValues,
  validateProviderHealth,
  validateProviderOptions,
} from './validation.js';

// Relative imported helpers retain Node module-cache entries independently of
// the reloadable plugin.mjs entrypoint. Never attest changed helper bytes to them.
const loadedPluginHelperDigests = new Map<string, string>();

export interface DkbDistributionService {
  id: string;
  kind: 'process' | 'docker' | 'remote';
  requiredBy: string[];
  providerId?: string;
  /**
   * External workload identities that the trusted composition root must attest
   * before this provider may participate in a reproducible build.
   */
  providerExternalIdentities?: ReadonlyArray<{
    kind: DkbExternalIdentityKind;
    name: string;
    option: string;
  }>;
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
  /** Additional Linux-local Stack volumes: inert role to Compose environment binding. */
  stackVolumes?: Record<string, string>;
  id: string;
  version: string;
  defaults: DkbContextConfig;
  plugins: readonly DkbBundledPlugin[];
  services: readonly DkbDistributionService[];
}

export interface DkbProviderHostOptions {
  root: string;
  libraryRoot?: string;
  distribution: DkbDistribution;
  globalRoot?: string;
  target?: string;
  /** Trusted, ephemeral provider options supplied by the composition root. */
  targetOptions?: Record<string, Record<string, unknown>>;
}

export interface DkbProviderHostDescription {
  root: string;
  libraryRoot?: string;
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
    integrityDigest: string;
  }>;
  processors: Array<{
    id: string;
    version: string;
    stage: DkbProcessorStage;
    source: DkbProcessorRegistration['source'];
    sourcePath: string;
    sourceDigest: string;
    integrityDigest: string;
  }>;
  buildDigest: string;
}

export async function resolvePluginSource(
  config: Pick<DkbResolvedContextConfig, 'root' | 'libraryRoot' | 'globalRoot'>,
  distribution: DkbDistribution,
  id: string,
): Promise<{ source: DkbProviderRegistration['source']; sourcePath: string; entrypoint: string }> {
  const candidates = [
    { source: 'local' as const, sourcePath: pluginPath(path.join(config.root, '.dkb/plugins'), id) },
    ...(config.libraryRoot && config.libraryRoot !== config.root
      ? [{ source: 'local' as const, sourcePath: pluginPath(path.join(config.libraryRoot, '.dkb/plugins'), id) }] : []),
    { source: 'global' as const, sourcePath: pluginPath(path.join(config.globalRoot, 'plugins'), id) },
  ];
  for (const candidate of candidates) {
    if (await pluginEntryExists(candidate.sourcePath)) return { ...candidate, entrypoint: candidate.sourcePath };
  }
  const plugin = distribution.plugins.find((candidate) => candidate.id === id);
  if (!plugin) throw new DkbError(`Selected plugin ${id} was not found in Runtime, Library, global, or bundled providers`);
  return { source: 'bundled', sourcePath: `bundled:${id}`, entrypoint: fileURLToPath(plugin.sourceUrl) };
}

export class DkbProviderHost {
  readonly root: string;
  readonly libraryRoot?: string;
  readonly globalRoot: string;
  readonly config: DkbResolvedContextConfig;
  private readonly providers = new Map<DkbProviderKind, DkbProviderRegistration>();
  private readonly processors: DkbProcessorRegistration[] = [];
  private readonly observers: DkbQueryObserverRegistration[] = [];
  private readonly observerDelivery = new QueryObserverDelivery();
  private readonly registrationDisposer = new RegistrationDisposer();
  private readonly resolvedOptions = new Map<string, DkbProviderOptions>();
  private readonly profileOptions = new Map<string, DkbProviderOptions>();
  private readonly distribution: DkbDistribution;
  private readonly dependencyFileDigests = new Map<string, Promise<string>>();
  private inputSnapshot?: FileSnapshot;
  private configurationObservation?: string;
  private disposed = false;

  private constructor(config: DkbResolvedContextConfig, distribution: DkbDistribution, observedConfig = config) {
    this.root = config.root;
    this.libraryRoot = config.libraryRoot;
    this.globalRoot = config.globalRoot;
    this.config = config;
    this.distribution = distribution;
    this.configurationObservation = this.configObservation(observedConfig.global, observedConfig.library, observedConfig.local);
  }

  static async create(options: DkbProviderHostOptions): Promise<DkbProviderHost> {
    const config = await resolveContextConfig(options.root, {
      defaults: options.distribution.defaults,
      ...(options.libraryRoot ? { libraryRoot: options.libraryRoot } : {}),
      ...(options.globalRoot ? { globalRoot: options.globalRoot } : {}),
      ...(options.target ? { target: options.target } : {}),
      ...(options.targetOptions ? { targetOptions: options.targetOptions } : {}),
    });
    return DkbProviderHost.createFromConfig(config, options.distribution);
  }

  static async createFromConfig(config: DkbResolvedContextConfig, distribution: DkbDistribution, options?: {
    /** For staged configuration edits, the exact source documents read before preparing the candidate. */
    observedConfig: Pick<DkbResolvedContextConfig, 'global' | 'library' | 'local'>;
  }): Promise<DkbProviderHost> {
    const host = new DkbProviderHost(config, distribution, options ? { ...config, ...options.observedConfig } : config);
    const bundled = new Map(distribution.plugins.map((plugin) => [plugin.id, plugin]));
    try {
      host.inputSnapshot = await captureFileSnapshot(await host.integrityInputs());
      for (const id of selectedPluginIds(config)) {
        await host.loadSelectedPlugin(id, bundled);
      }
      host.validateSelections();
      await host.assertCurrent();
      return host;
    } catch (error) {
      await host.dispose();
      throw error;
    }
  }

  /** Fail closed on observed code, dependency, precedence or selected recipe drift. */
  async assertCurrent(): Promise<void> {
    this.assertActive();
    if (await this.readConfigurationObservation() !== this.configurationObservation) {
      throw new DkbError(`Selected Pipeline ${this.config.activeTarget} configuration changed. Refresh its Runtime activation before querying.`);
    }
    if (!this.inputSnapshot) throw new DkbError('Provider identity has not been validated');
    try {
      await assertFileSnapshotCurrent(this.inputSnapshot);
    } catch (error) {
      throw new DkbError(`Selected Pipeline ${this.config.activeTarget} plugin code, dependency, or plugin precedence changed. Restart the Runtime or compiler and refresh its activation before querying. ${error instanceof Error ? error.message : ''}`);
    }
  }

  private async readConfigurationObservation(): Promise<string> {
    const [global, library, local] = await Promise.all([
      readDkbContextConfig(path.join(this.globalRoot, 'config.json')),
      this.libraryRoot && this.libraryRoot !== this.root
        ? readDkbContextConfig(path.join(this.libraryRoot, '.dkb/config.json'))
        : Promise.resolve({ format: 'dkb.config.v2' } as DkbContextConfig),
      readDkbContextConfig(path.join(this.root, '.dkb/config.json')),
    ]);
    return this.configObservation(global, library, local);
  }

  private configObservation(global: DkbContextConfig, library: DkbContextConfig, local: DkbContextConfig): string {
    const selected = (scope: DkbContextConfig) => ({ activeTarget: scope.activeTarget ?? null, target: scope.targets?.[this.config.activeTarget] ?? null });
    return stableHash({ global: selected(global), library: selected(library), local: selected(local) });
  }

  private async integrityInputs(): Promise<string[]> {
    const inputs = new Set<string>();
    const packages = new Set<string>();
    for (const id of selectedPluginIds(this.config)) {
      const candidates = [
        pluginPath(path.join(this.root, '.dkb/plugins'), id),
        ...(this.libraryRoot && this.libraryRoot !== this.root ? [pluginPath(path.join(this.libraryRoot, '.dkb/plugins'), id)] : []),
        pluginPath(path.join(this.globalRoot, 'plugins'), id),
      ];
      const selected = await resolvePluginSource(this.config, this.distribution, id);
      for (const candidate of candidates) {
        inputs.add(candidate);
        if (candidate === selected.sourcePath) break;
      }
      const root = path.dirname(selected.entrypoint);
      inputs.add(root);
      for (const file of await pluginFiles(root, root)) {
        inputs.add(file);
        let directory = path.dirname(file);
        while (directory !== root && directory.startsWith(`${root}${path.sep}`)) {
          inputs.add(directory);
          directory = path.dirname(directory);
        }
      }
      const packagePath = selected.source !== 'bundled'
        ? path.join(root, 'package.json')
        : await findParentFile(root, 'package.json');
      if (packagePath) {
        inputs.add(packagePath);
        if (await fileExists(packagePath)) packages.add(path.dirname(packagePath));
      }
    }
    for (const root of packages) for (const input of await dependencyIntegrityInputs(root, true)) inputs.add(input);
    return [...inputs];
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
        const original = structuredClone(value);
        const result = await (registration.processor as DkbProcessor<TValue>).mutate(structuredClone(value), {
          root: this.root,
          options,
          ...(signal ? { signal } : {}),
        });

        if (result !== null) {
          const mutated = validateProcessorStageValues(stage, [result], registration.id)[0]!;
          assertProtectedProcessorIdentity(
            stage,
            original as DkbPipelineDocument | DkbPipelineChunk | DkbPipelineRecord,
            mutated as DkbPipelineDocument | DkbPipelineChunk | DkbPipelineRecord,
            registration.id,
          );
          next.push(mutated);
        }
      }

      current = validateProcessorStageValues(stage, next, registration.id);
    }

    return current;
  }

  optionsFor(id: string): DkbProviderOptions {
    return this.resolvedOptions.get(id) ?? Object.freeze({});
  }

  profileOptionsFor(id: string): DkbProviderOptions {
    return this.profileOptions.get(id) ?? this.optionsFor(id);
  }

  providerIntegrity(kind: DkbProviderKind): DkbProviderIntegrityReceipt {
    const registration = this.providers.get(kind);
    if (!registration) throw new DkbError(`Pipeline target "${this.config.activeTarget}" did not register its selected ${kind} provider`);
    return structuredClone(registration.integrity);
  }

  assertRequiredExternalIdentities(): void {
    this.assertActive();
    const target = this.config.activeTarget;
    const selected = [...this.providers.values()];

    for (const service of this.distribution.services) {
      if (!service.providerId) continue;
      const registration = selected.find((candidate) => candidate.id === service.providerId);
      if (!registration || registration.source !== 'bundled') continue;
      for (const identity of service.providerExternalIdentities ?? []) {
        const key = `${identity.kind}:${identity.name}`;
        if (!registration.integrity.externalDigests[key]) {
          throw new DkbError(
            `Pipeline target "${target}" cannot establish immutable ${key} identity for ${service.providerId}. `
            + `The trusted composition root must resolve the service image and inject ${service.providerId}.${identity.option} as an exact sha256 digest.`,
          );
        }
      }
    }
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
        integrityDigest: registration.integrityDigest,
      }))
      .sort((left, right) => PROVIDER_KIND_ORDER.indexOf(left.kind) - PROVIDER_KIND_ORDER.indexOf(right.kind));
    const processors = this.processors.map((registration) => ({
      id: registration.id,
      version: registration.version,
      stage: registration.processor.stage,
      source: registration.source,
      sourcePath: registration.sourcePath,
      sourceDigest: registration.sourceDigest,
      integrityDigest: registration.integrityDigest,
    }));

    const buildPluginIds = new Set([...providers.map((provider) => provider.id), ...processors.map((processor) => processor.id)]);
    const identityOptions = Object.fromEntries([...this.profileOptions.entries()]
      .filter(([id]) => buildPluginIds.has(id))
      .sort(([left], [right]) => left.localeCompare(right)));
    const { configDigest: _rawConfigDigest, name: _targetLabel, options: _rawOptions, observers: _observers, ...target } = this.config.target;
    const identityTarget = { ...target, options: identityOptions };
    const providerIdentities = providers.map(profileIdentity);
    const processorIdentities = processors.map(profileIdentity);
    return {
      root: this.root,
      ...(this.libraryRoot ? { libraryRoot: this.libraryRoot } : {}),
      globalRoot: this.globalRoot,
      target: this.config.activeTarget,
      configDigest: stableHash(identityTarget),
      providers,
      processors,
      buildDigest: stableHash({ target: identityTarget, providers: providerIdentities, processors: processorIdentities }),
    };
  }

  queryObservers(): readonly DkbQueryObserverRegistration[] {
    this.assertActive();
    return this.observers;
  }

  async observeQuery(
    event: Parameters<DkbQueryObserver['observe']>[0],
    signal?: AbortSignal,
    timeoutMs = QUERY_OBSERVER_DELIVERY_TIMEOUT_MS,
  ): Promise<DkbQueryObserverResult[]> {
    this.assertActive();
    return Promise.all(this.observers.map(async (registration) => {
      try {
        await this.observerDelivery.run(registration.observer, event, {
          root: this.root,
          options: this.optionsFor(registration.id),
        }, signal, timeoutMs);
        return observerResult(registration, true);
      } catch (error) {
        return observerResult(
          registration,
          false,
          error instanceof Error ? error.message : String(error),
        );
      }
    }));
  }

  async health(kinds?: readonly DkbProviderKind[]): Promise<Array<{ id: string; kind: DkbProviderKind; ok: boolean; detail?: string }>> {
    this.assertActive();
    const selectedKinds = kinds ? new Set(kinds) : null;

    return Promise.all([...this.providers.entries()]
      .filter(([kind]) => !selectedKinds || selectedKinds.has(kind))
      .map(async ([kind, registration]) => {
        try {
          const result = registration.provider.health
            ? validateProviderHealth(await registration.provider.health(), registration.id)
            : { ok: true };
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
    this.observerDelivery.abort();
    const disposables = [
      ...this.processors.map((registration) => registration.processor),
      ...this.observers.map((registration) => registration.observer),
      ...[...this.providers.values()].map((registration) => registration.provider),
    ];

    await this.registrationDisposer.disposeAll(disposables);
    this.processors.length = 0;
    this.observers.length = 0;
    this.providers.clear();
    this.resolvedOptions.clear();
    this.profileOptions.clear();
  }

  private async loadSelectedPlugin(id: string, bundled: ReadonlyMap<string, DkbBundledPlugin>): Promise<void> {
    if (!isPluginId(id)) {
      throw new DkbError(`Invalid selected plugin id: ${id}`);
    }
    const selection = await resolvePluginSource(this.config, this.distribution, id);
    let plugin: DkbPluginModule;
    const { source, sourcePath } = selection;
    let sourceDigest: string;
    let integrity: DkbProviderIntegrityReceipt;
    let bundledIntegrity: DkbProviderIntegrityReceipt | undefined;

    if (source !== 'bundled') {
      plugin = await importPlugin(sourcePath, this.root);
      sourceDigest = await hashPluginDirectory(path.dirname(sourcePath));
    } else {
      const selected = bundled.get(id);

      if (!selected) {
        throw new DkbError(`Selected bundled plugin ${id} was not found in the distribution`);
      }
      const loaded = await loadBundledPlugin(selected, this.dependencyFileDigests);
      plugin = loaded.plugin;
      bundledIntegrity = loaded.integrity;
      sourceDigest = bundledIntegrity.filesDigest;
    }

    validatePluginModule(plugin, id, sourcePath);
    const registeredProviders: DkbProvider[] = [];
    const registeredProcessors: DkbProcessor[] = [];
    const registeredObservers: DkbQueryObserver[] = [];
    const registeredResources: unknown[] = [];
    const options = await validateProviderOptions(plugin.optionsSchema, this.config.target.options?.[id] ?? {}, `Plugin ${id}`);
    this.resolvedOptions.set(id, options);
    const pluginIdentity = resolvePluginIdentity(plugin.identity, options, `Plugin ${id}`);
    this.profileOptions.set(id, pluginIdentity.profileOptions);
    integrity = bundledIntegrity ?? await localPluginIntegrity(plugin, sourcePath, sourceDigest, this.dependencyFileDigests);
    integrity = {
      ...integrity,
      externalDigests: mergeExternalIdentityDigests(`Plugin ${id}`, integrity.externalDigests, pluginIdentity.externalDigests),
    };
    validateIntegrityReceipt(integrity, plugin, sourcePath);

    try {
      try {
        await plugin.setup({
          root: this.root,
          pluginId: plugin.id,
          pluginVersion: plugin.version,
          options,
          registerProvider: (provider) => {
            registeredResources.push(provider);
            registeredProviders.push(provider);
            validateProvider(provider, plugin.id);
          },
          registerProcessor: (processor) => {
            registeredResources.push(processor);
            registeredProcessors.push(processor);
            validateProcessor(processor, plugin.id);
          },
          registerQueryObserver: (observer) => {
            registeredResources.push(observer);
            registeredObservers.push(observer);
            validateQueryObserver(observer, plugin.id);
          },
        });
      } catch (error) {
        throw new DkbError(`Failed to set up selected ${source} plugin ${id} at ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (registeredResources.length === 0) throw new DkbError(`Selected plugin ${id} did not register a provider, processor, or query observer`);
      const pendingProviders = new Map<DkbProviderKind, DkbProviderRegistration>();
      for (const provider of registeredProviders) {
        validateProvider(provider, plugin.id);
        const existing = this.providers.get(provider.kind) ?? pendingProviders.get(provider.kind);
        if (existing) throw new DkbError(`Plugins ${existing.id} and ${id} both registered the selected ${provider.kind} provider`);
        const providerExternalDigests = resolveProviderIdentity(provider.identity, options, `Plugin ${id} ${provider.kind} provider`);
        const providerIntegrity = completeIntegrityCapabilities({
          ...integrity,
          externalDigests: mergeExternalIdentityDigests(`Plugin ${id} ${provider.kind} provider`, integrity.externalDigests, providerExternalDigests),
        }, [provider]);
        validateIntegrityReceipt(providerIntegrity, plugin, sourcePath);
        pendingProviders.set(provider.kind, {
          id: plugin.id, version: plugin.version, provider, source, sourcePath, sourceDigest,
          integrity: providerIntegrity, integrityDigest: stableHash(providerIntegrity),
        });
      }
      for (const processor of registeredProcessors) validateProcessor(processor, plugin.id);
      for (const observer of registeredObservers) validateQueryObserver(observer, plugin.id);
      const pluginIntegrityDigest = stableHash(integrity);
      const pendingProcessors = registeredProcessors.map((processor) => ({ id: plugin.id, version: plugin.version, processor, source, sourcePath, sourceDigest, integrity, integrityDigest: pluginIntegrityDigest }));
      const pendingObservers = registeredObservers.map((observer) => ({ id: plugin.id, version: plugin.version, observer, source, sourcePath, sourceDigest, integrity, integrityDigest: pluginIntegrityDigest }));
      // Admit only after the complete registration/identity batch is valid.
      for (const [kind, registration] of pendingProviders) this.providers.set(kind, registration);
      this.processors.push(...pendingProcessors);
      this.observers.push(...pendingObservers);
    } catch (error) {
      await this.registrationDisposer.disposeAll(registeredResources);
      throw error;
    }
  }

  private validateSelections(): void {
    const target = this.config.target;
    const required: DkbProviderKind[] = [
      ...(target.evidence ? ['evidence' as const] : ['parser' as const, 'chunker' as const]),
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
    if (this.observers.length !== (target.observers?.length ?? 0)) {
      throw new DkbError(`Pipeline target "${target.name}" requires each observer plugin to register exactly one query observer`);
    }
    if (target.evidence) {
      const unsupported = this.processors.filter((registration) => registration.processor.stage !== 'record');
      if (unsupported.length > 0) {
        throw new DkbError(
          `Pipeline target "${target.name}" uses a fused Evidence provider, so it may select only record processors. `
          + `Document or chunk processors must be placed between separate parser and chunker providers: ${unsupported.map((entry) => entry.id).join(', ')}`,
        );
      }
    }
    const index = this.providers.get('index')?.provider;
    const retrieval = this.providers.get('retrieval')?.provider;
    const needsVectors = (index?.kind === 'index' && index.capabilities.vectors === 'required')
      || (retrieval?.kind === 'retrieval' && retrieval.capabilities.vectors === 'required');
    if (needsVectors && !this.providers.has('embedding')) {
      throw new DkbError(`Pipeline target "${target.name}" requires an embedding provider because its index or retrieval provider requires vectors`);
    }
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new DkbError(`Provider host for ${this.root} has been disposed`);
    }
  }
}

const PROVIDER_KIND_ORDER = ['evidence', 'parser', 'chunker', 'embedding', 'index', 'retrieval'] as const;

function observerResult(
  registration: DkbQueryObserverRegistration,
  ok: boolean,
  detail?: string,
): DkbQueryObserverResult {
  return {
    id: registration.id,
    version: registration.version,
    source: registration.source,
    integrityDigest: registration.integrityDigest,
    ok,
    ...(detail ? { detail } : {}),
  };
}

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
    ...(target.observers ?? []),
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
    return await importPluginModule(target, { contextRoot });
  } catch (error) {
    throw new DkbError(`Failed to load selected plugin at ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validatePluginModule(plugin: DkbPluginModule, selectedId: string, source: string): void {
  if (!plugin || plugin.apiVersion !== 3 || plugin.id !== selectedId || typeof plugin.version !== 'string' || plugin.version.length === 0
    || !plugin.optionsSchema || typeof plugin.setup !== 'function') {
    throw new DkbError(`Invalid plugin at ${source}: DKB plugin API v3 requires exports apiVersion=3, id=${selectedId}, version, optionsSchema, and setup(context). Migrate v1/v2 plugins with dkb plugin init and the API v3 guide.`);
  }
}

function validateProvider(provider: DkbProvider, pluginId: string): void {
  if (!provider || !['evidence', 'parser', 'chunker', 'embedding', 'index', 'retrieval'].includes(provider.kind)) {
    throw new DkbError(`Plugin ${pluginId} registered an invalid provider`);
  }
  validateServiceRequirements(provider.serviceRequirements, pluginId);
  if (provider.kind === 'evidence' && typeof provider.compile !== 'function') {
    throw new DkbError(`Plugin ${pluginId} Evidence provider must implement compile()`);
  }
  if (provider.kind === 'evidence' && provider.cancelPending !== undefined && typeof provider.cancelPending !== 'function') {
    throw new DkbError(`Plugin ${pluginId} Evidence provider cancelPending must be a function when supplied`);
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
    && (!['packaged', 'managed'].includes(provider.mode) || typeof provider.format !== 'string' || provider.format.length === 0
      || !provider.capabilities || !['required', 'optional', 'none'].includes(provider.capabilities.vectors)
      || typeof provider.compilePackage !== 'function' || typeof provider.validatePackage !== 'function'
      || typeof provider.verifyRuntime !== 'function' || typeof provider.openRuntime !== 'function'
      || (provider.mode === 'managed' && (typeof provider.storageIdentity !== 'function' || typeof provider.installPackage !== 'function' || typeof provider.discardPackage !== 'function' || typeof provider.uninstallPackage !== 'function')))) {
    throw new DkbError(`Plugin ${pluginId} index provider must implement the complete ${provider.mode} index contract`);
  }
  if (provider.kind === 'retrieval'
    && (typeof provider.protocol !== 'string' || provider.protocol.length === 0
      || !provider.capabilities || !['required', 'optional', 'none'].includes(provider.capabilities.vectors)
      || typeof provider.openRuntime !== 'function')) {
    throw new DkbError(`Plugin ${pluginId} retrieval provider must declare its stable evidence protocol and implement openRuntime()`);
  }
}

function validateQueryObserver(observer: DkbQueryObserver, pluginId: string): void {
  if (!observer || observer.id !== pluginId || typeof observer.version !== 'string' || typeof observer.observe !== 'function') {
    throw new DkbError(`Plugin ${pluginId} registered an invalid query observer`);
  }
}

function validateIntegrityReceipt(receipt: DkbProviderIntegrityReceipt, plugin: DkbPluginModule, source: string): void {
  if (!receipt || receipt.apiVersion !== DKB_PLUGIN_API_VERSION || receipt.id !== plugin.id || receipt.version !== plugin.version
    || typeof receipt.filesDigest !== 'string' || !receipt.filesDigest.startsWith('sha256:')
    || typeof receipt.dependencyDigest !== 'string' || !receipt.dependencyDigest.startsWith('sha256:')
    || !receipt.externalDigests || typeof receipt.externalDigests !== 'object'
    || !Array.isArray(receipt.protocols) || !Array.isArray(receipt.artifactFormats)) {
    throw new DkbError(`Invalid provider integrity receipt for ${plugin.id} at ${source}`);
  }
  for (const [name, digest] of Object.entries(receipt.externalDigests)) {
    if (!/^(service|image|model):[a-z0-9][a-z0-9._/-]{0,127}$/u.test(name)
      || !/^sha256:[a-f0-9]{64}$/u.test(digest)) {
      throw new DkbError(`Invalid provider integrity receipt for ${plugin.id} at ${source}: external identities must be canonical service/image/model sha256 digests`);
    }
  }
}

function completeIntegrityCapabilities(receipt: DkbProviderIntegrityReceipt, providers: readonly DkbProvider[]): DkbProviderIntegrityReceipt {
  return {
    ...receipt,
    protocols: [...new Set([
      ...receipt.protocols,
      ...providers.filter((provider) => provider.kind === 'retrieval').map((provider) => provider.protocol),
    ])].sort(),
    artifactFormats: [...new Set([
      ...receipt.artifactFormats,
      ...providers.filter((provider) => provider.kind === 'index').map((provider) => provider.format),
    ])].sort(),
  };
}

async function localPluginIntegrity(plugin: DkbPluginModule, sourcePath: string, filesDigest: string, cache: Map<string, Promise<string>>): Promise<DkbProviderIntegrityReceipt> {
  const root = path.dirname(sourcePath);
  await validatePluginImports(root, await pluginFiles(root, root));
  return {
    apiVersion: DKB_PLUGIN_API_VERSION,
    id: plugin.id,
    version: plugin.version,
    filesDigest,
    dependencyDigest: await fileExists(path.join(root, 'package.json')) ? await dependencyIntegrity(root, cache) : stableHash([]),
    externalDigests: {},
    protocols: [],
    artifactFormats: [],
  };
}

async function findParentFile(start: string, name: string): Promise<string | null> {
  let current = path.resolve(start);
  while (true) {
    const candidate = path.join(current, name);
    if (await fileExists(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function validateProcessor(processor: DkbProcessor, pluginId: string): void {
  if (!processor || processor.id !== pluginId || typeof processor.version !== 'string' || !['document', 'chunk', 'record'].includes(processor.stage) || typeof processor.mutate !== 'function') {
    throw new DkbError(`Plugin ${pluginId} registered an invalid processor`);
  }
  validateServiceRequirements(processor.serviceRequirements, pluginId);
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

async function pluginEntryExists(target: string): Promise<boolean> {
  try {
    const entry = await fs.lstat(target);
    if (entry.isFile()) return true;
    if (entry.isSymbolicLink() && (await fs.stat(target)).isFile()) return true;
    throw new DkbError(`Selected plugin entry must be a readable file: ${target}. Repair or remove this override; DKB will not fall back to a lower-priority plugin.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      await fs.lstat(path.dirname(target));
    } catch (parentError) {
      if ((parentError as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw parentError;
    }
    throw new DkbError(`Selected plugin override is incomplete or has a broken link: ${target}. Repair or remove this override; DKB will not fall back to a lower-priority plugin.`);
  }
}

async function hashPluginDirectory(root: string): Promise<string> {
  const files = await pluginFiles(root, root);
  const entries = await Promise.all(files.map(async (target) => {
    const hash = createHash('sha256').update(await fs.readFile(target)).digest('hex');
    if (/\.[cm]?js$/u.test(target) && path.basename(target) !== 'plugin.mjs') {
      const canonical = await fs.realpath(target);
      const loaded = loadedPluginHelperDigests.get(canonical);
      if (loaded && loaded !== hash) throw new DkbError(`Plugin helper module changed after it was loaded: ${path.relative(root, target)}. Restart the Runtime or compiler process before selecting the changed plugin.`);
      loadedPluginHelperDigests.set(canonical, hash);
    }
    return { path: path.relative(root, target).replace(/\\/g, '/'), hash };
  }));

  return stableHash(entries.sort((left, right) => left.path.localeCompare(right.path)));
}

async function pluginFiles(root: string, current: string): Promise<string[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const nested = await Promise.all(entries
    .filter((entry) => entry.name !== '.git' && entry.name !== 'node_modules' && !entry.name.endsWith('.tsbuildinfo'))
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

function profileIdentity<T extends { source: unknown; sourcePath: unknown }>(description: T): Omit<T, 'source' | 'sourcePath'> {
  const { source: _source, sourcePath: _sourcePath, ...identity } = description;
  return identity;
}
