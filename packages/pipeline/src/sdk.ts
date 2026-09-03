import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  DKB_PLUGIN_API_VERSION,
  type DkbChunkerProvider,
  type DkbEmbeddingProvider,
  type DkbEvidenceProvider,
  type DkbJsonValue,
  type DkbIndexRuntime,
  type DkbManagedIndexProvider,
  type DkbPackagedIndexProvider,
  type DkbParserProvider,
  type DkbPluginModule,
  type DkbPluginIdentity,
  type DkbProviderIdentity,
  type DkbProcessor,
  type DkbProviderOptionsSchema,
  type DkbQueryObserver,
  type DkbRetrievalProvider,
  type DkbRetrievalRuntime,
} from './types.js';

export class DkbSdkError extends Error {
  readonly code: string;
  readonly issues: readonly { message: string; path?: readonly PropertyKey[] }[];

  constructor(code: string, message: string, issues: readonly { message: string; path?: readonly PropertyKey[] }[] = []) {
    super(message);
    this.name = 'DkbSdkError';
    this.code = code;
    this.issues = issues;
  }
}

export function definePlugin(plugin: DkbPluginModule): DkbPluginModule {
  if (plugin.apiVersion !== DKB_PLUGIN_API_VERSION) {
    throw new DkbSdkError('plugin_api_mismatch', `Plugin ${plugin.id} must use DKB plugin API v${DKB_PLUGIN_API_VERSION}`);
  }
  return Object.freeze(plugin);
}

export function definePluginIdentity(identity: DkbPluginIdentity): DkbPluginIdentity { return identity; }
export function defineProviderIdentity(identity: DkbProviderIdentity): DkbProviderIdentity { return identity; }

export function defineEvidenceProvider(provider: DkbEvidenceProvider): DkbEvidenceProvider {
  return { ...provider, async compile(input) { assertNotAborted(input.signal); return provider.compile(input); } };
}
export function defineParserProvider(provider: DkbParserProvider): DkbParserProvider {
  return { ...provider, async parse(input) { assertNotAborted(input.signal); return provider.parse(input); } };
}
export function defineChunkerProvider(provider: DkbChunkerProvider): DkbChunkerProvider {
  return { ...provider, async chunk(input) { assertNotAborted(input.signal); return provider.chunk(input); } };
}
export function defineEmbeddingProvider(provider: DkbEmbeddingProvider): DkbEmbeddingProvider {
  return {
    ...provider,
    async embedDocuments(input) { assertNotAborted(input.signal); return provider.embedDocuments(input); },
    async embedQuery(input) { assertNotAborted(input.signal); return provider.embedQuery(input); },
  };
}
export function definePackagedIndexProvider(provider: DkbPackagedIndexProvider): DkbPackagedIndexProvider {
  return {
    ...provider,
    async compilePackage(input) { assertNotAborted(input.signal); return provider.compilePackage(input); },
    async validatePackage(input) { assertNotAborted(input.signal); return provider.validatePackage(input); },
    async verifyRuntime(input) { assertNotAborted(input.signal); return provider.verifyRuntime(input); },
    async openRuntime(input) { assertNotAborted(input.signal); return wrapIndexRuntime(await provider.openRuntime(input)); },
  };
}
export function defineManagedIndexProvider(provider: DkbManagedIndexProvider): DkbManagedIndexProvider {
  return {
    ...provider,
    async compilePackage(input) { assertNotAborted(input.signal); return provider.compilePackage(input); },
    async validatePackage(input) { assertNotAborted(input.signal); return provider.validatePackage(input); },
    async installPackage(input) { assertNotAborted(input.signal); return provider.installPackage(input); },
    async discardPackage(input) { assertNotAborted(input.signal); return provider.discardPackage(input); },
    async uninstallPackage(input) { assertNotAborted(input.signal); return provider.uninstallPackage(input); },
    async verifyRuntime(input) { assertNotAborted(input.signal); return provider.verifyRuntime(input); },
    async openRuntime(input) { assertNotAborted(input.signal); return wrapIndexRuntime(await provider.openRuntime(input)); },
  };
}
export function defineRetrievalProvider(provider: DkbRetrievalProvider): DkbRetrievalProvider {
  return {
    ...provider,
    async openRuntime(input) { assertNotAborted(input.signal); return wrapRetrievalRuntime(await provider.openRuntime(input)); },
  };
}
export function defineProcessor<TValue>(processor: DkbProcessor<TValue>): DkbProcessor<TValue> { return processor; }
export function defineQueryObserver(observer: DkbQueryObserver): DkbQueryObserver { return observer; }

export function defineOptionsSchema<TOptions extends Record<string, DkbJsonValue>>(
  validate: (value: unknown) => TOptions | readonly { message: string; path?: readonly PropertyKey[] }[],
  vendor = 'dkb',
): StandardSchemaV1<unknown, TOptions> {
  return {
    '~standard': {
      version: 1,
      vendor,
      validate(value) {
        const result = validate(value);
        return Array.isArray(result) ? { issues: result } : { value: result as TOptions };
      },
    },
  };
}

export const emptyOptionsSchema: DkbProviderOptionsSchema = defineOptionsSchema((value) => {
  if (!isPlainObject(value)) return [{ message: 'Options must be an object' }];
  if (Object.keys(value).length > 0) return [{ message: 'This plugin does not accept options' }];
  return {};
});

function isPlainObject(value: unknown): value is Record<string, DkbJsonValue> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertNotAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function wrapIndexRuntime(runtime: DkbIndexRuntime | null): DkbIndexRuntime | null {
  if (!runtime) return null;
  return {
    ...runtime,
    async search(query, limit, signal) {
      assertNotAborted(signal);
      return runtime.search(query, limit, signal);
    },
  };
}

function wrapRetrievalRuntime(runtime: DkbRetrievalRuntime): DkbRetrievalRuntime {
  return {
    ...runtime,
    async search(input) {
      assertNotAborted(input.signal);
      return runtime.search(input);
    },
  };
}
