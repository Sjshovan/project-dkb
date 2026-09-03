import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { captureFileSnapshot, assertFileSnapshotCurrent, type FileSnapshot } from '@sjshovan/dkb-protocol/fileSnapshot.js';
import { verifyBundledIntegrityReceipt, type DkbBundledIntegrityReceipt } from './bundledIntegrity.js';
import { dependencyIntegrityInputs, validatePluginImports } from './dependencyIntegrity.js';
import { isPluginId } from './config.js';
import { normalizePluginModule } from './pluginModule.js';
import type { DkbPluginModule, DkbProviderIntegrityReceipt } from './types.js';

/** Inert composition metadata. Resolving a catalog must not execute provider modules. */
export interface DkbBundledPlugin {
  readonly id: string;
  readonly version: string;
  readonly sourceUrl: string;
  readonly exportName: string;
}

/** Build-time named export owned by one independently packaged provider. */
export interface DkbBundledPluginModule extends DkbPluginModule {
  sourceUrl: string;
  integrity: Omit<DkbProviderIntegrityReceipt, 'filesDigest' | 'dependencyDigest' | 'externalDigests'>;
}

interface LoadedBundle {
  plugin: DkbPluginModule;
  integrity: DkbProviderIntegrityReceipt;
}

// Only the verified loader populates this cache. Provider setup/state stays per host.
// A failed import remains failed: Node can retain partially evaluated dependencies.
const loadedBundles = new Map<string, { digest: string; exportName: string; pending: Promise<LoadedBundle> }>();

export async function loadBundledPlugin(
  reference: DkbBundledPlugin,
  dependencyCache: Map<string, Promise<string>>,
): Promise<LoadedBundle> {
  const entrypoint = referenceEntrypoint(reference);
  const packageRoot = await findPackageRoot(entrypoint);
  const observation = await captureFileSnapshot(await dependencyIntegrityInputs(packageRoot, true));
  const receipt = await verifyBundledIntegrityReceipt({ packageRoot, entrypoint }, dependencyCache);
  if (receipt.id !== reference.id || receipt.version !== reference.version) {
    throw invalid(reference.id, 'The catalog identity does not match the shipped integrity receipt.');
  }
  const shippedFiles = receipt.files.map((file) => path.join(packageRoot, file.path));
  await validatePluginImports(packageRoot, shippedFiles, { allowedFiles: shippedFiles });
  const digest = stableHash(receipt);
  const canonical = await fs.realpath(packageRoot);
  const existing = loadedBundles.get(canonical);
  if (existing && existing.digest !== digest) {
    throw invalid(reference.id, 'Shipped files or dependencies changed after loading. Restart this Runtime or compiler before selecting the changed provider.');
  }
  if (existing && existing.exportName !== reference.exportName) throw invalid(reference.id, 'The catalog changed the named export of an already loaded provider.');
  const pending = existing?.pending ?? importVerifiedModule(reference, entrypoint, receipt, digest, observation);
  if (!existing) loadedBundles.set(canonical, { digest, exportName: reference.exportName, pending });
  const loaded = await pending;
  await assertFileSnapshotCurrent(observation);
  return loaded;
}

async function importVerifiedModule(
  reference: DkbBundledPlugin,
  entrypoint: string,
  receipt: DkbBundledIntegrityReceipt,
  digest: string,
  observation: FileSnapshot,
): Promise<LoadedBundle> {
  const url = pathToFileURL(entrypoint);
  // Never adopt a previously imported canonical entrypoint that predates verification.
  url.searchParams.set('dkb-integrity', digest);
  let module: Record<string, unknown>;
  try { module = await import(url.href) as Record<string, unknown>; } catch (error) {
    throw invalid(reference.id, `Failed to import the verified provider: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Object.hasOwn(module, reference.exportName)) throw invalid(reference.id, `Missing named export ${reference.exportName}.`);
  const definitions = new Set(Object.values(module).filter((value) => value && typeof value === 'object'
    && 'setup' in value && typeof value.setup === 'function' && 'apiVersion' in value));
  if (definitions.size !== 1 || !definitions.has(module[reference.exportName])) {
    throw invalid(reference.id, 'A bundled entrypoint must expose exactly one executable plugin definition.');
  }
  const plugin = normalizePluginModule(module[reference.exportName]) as DkbBundledPluginModule;
  const expected = {
    apiVersion: receipt.apiVersion, id: receipt.id, version: receipt.version,
    protocols: receipt.protocols, artifactFormats: receipt.artifactFormats,
  };
  if (plugin.id !== reference.id || plugin.version !== reference.version
    || stableHash(plugin.integrity) !== stableHash(expected)) {
    throw invalid(reference.id, 'The loaded module identity or protocols do not match the verified receipt.');
  }
  let actualEntrypoint: string;
  try { actualEntrypoint = fileURLToPath(plugin.sourceUrl); } catch {
    throw invalid(reference.id, 'The loaded module must identify its own entrypoint.');
  }
  if (path.resolve(actualEntrypoint) !== path.resolve(entrypoint)) throw invalid(reference.id, 'The loaded module source does not match its verified entrypoint.');
  await assertFileSnapshotCurrent(observation);
  return {
    plugin: Object.freeze({ ...plugin }),
    integrity: { ...expected, filesDigest: receipt.filesDigest, dependencyDigest: receipt.dependencyDigest, externalDigests: {} },
  };
}

function referenceEntrypoint(reference: DkbBundledPlugin): string {
  if (!reference || typeof reference !== 'object'
    || Object.keys(reference).some((key) => !['id', 'version', 'sourceUrl', 'exportName'].includes(key))
    || !isPluginId(reference.id) || typeof reference.version !== 'string' || !reference.version.trim()
    || typeof reference.exportName !== 'string' || !/^[A-Za-z_$][\w$]{0,127}$/u.test(reference.exportName)) {
    throw invalid(reference?.id ?? 'unknown', 'A bundled reference must contain only id, version, sourceUrl, and exportName; executable definitions belong in the provider module.');
  }
  try {
    const url = new URL(reference.sourceUrl);
    if (url.protocol !== 'file:' || url.search || url.hash) throw new Error('invalid source');
    return fileURLToPath(url);
  } catch {
    throw invalid(reference.id, 'The catalog source must be an ordinary file URL without query or fragment.');
  }
}

async function findPackageRoot(entrypoint: string): Promise<string> {
  let current = path.dirname(entrypoint);
  while (true) {
    try {
      if ((await fs.stat(path.join(current, 'package.json'))).isFile()) return current;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = path.dirname(current);
    if (parent === current) throw new DkbError('Bundled provider is missing its shipped package.json', 'bundled_integrity_invalid');
    current = parent;
  }
}

function invalid(id: string, message: string): DkbError {
  return new DkbError(`Bundled plugin ${id}: ${message}`, 'bundled_integrity_invalid');
}
