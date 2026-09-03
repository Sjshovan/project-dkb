import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbSdkError } from './sdk.js';
import { DKB_PLUGIN_API_VERSION, type DkbPluginModule } from './types.js';

const DEFINITION_EXPORTS = ['apiVersion', 'id', 'version', 'optionsSchema', 'identity', 'setup'] as const;

/** Resolve a named API definition or one default definition without choosing between conflicting exports. */
export function normalizePluginModule(value: unknown): DkbPluginModule {
  if (!isRecord(value)) throw invalidDefinition();
  let definition = value;
  if (Object.hasOwn(value, 'default')) {
    const conflicts = DEFINITION_EXPORTS.filter((key) => Object.hasOwn(value, key));
    if (conflicts.length > 0) {
      throw new DkbSdkError('conflicting_plugin_exports', `Plugin must export either one default definition or named API fields, not both (${conflicts.join(', ')})`);
    }
    if (!isRecord(value.default)) throw invalidDefinition();
    definition = value.default;
  }
  if (definition.apiVersion !== DKB_PLUGIN_API_VERSION
    || typeof definition.id !== 'string' || !/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/u.test(definition.id)
    || typeof definition.version !== 'string' || !definition.version.trim()
    || !definition.optionsSchema || typeof definition.setup !== 'function') {
    throw invalidDefinition(definition.id);
  }
  return definition as unknown as DkbPluginModule;
}

/** Import operator-controlled filesystem code using the same export rules as verification and conformance. */
export async function importPluginModule(entrypoint: string, options: { contextRoot: string; reload?: boolean }): Promise<DkbPluginModule> {
  const target = path.resolve(entrypoint);
  const entryDigest = createHash('sha256').update(await fs.readFile(target)).digest('hex');
  const url = pathToFileURL(target);
  url.searchParams.set('dkb-context', stableHash({
    contextRoot: path.resolve(options.contextRoot),
    target,
    entryDigest,
    ...(options.reload ? { reload: randomUUID() } : {}),
  }));
  return normalizePluginModule(await import(url.href));
}

function invalidDefinition(id?: unknown): DkbSdkError {
  const identity = typeof id === 'string' && /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/u.test(id) ? `id=${id}` : 'a namespaced id';
  return new DkbSdkError('invalid_plugin', `DKB plugin API v${DKB_PLUGIN_API_VERSION} requires exports apiVersion=${DKB_PLUGIN_API_VERSION}, ${identity}, version, Standard Schema optionsSchema, and setup(context), either as named fields or one default definition. Migrate v1/v2 plugins with dkb plugin init and the API v3 guide.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
