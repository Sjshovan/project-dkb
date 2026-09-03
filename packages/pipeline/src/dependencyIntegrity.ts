import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { captureFileSnapshot, assertFileSnapshotCurrent, type FileSnapshot } from '@sjshovan/dkb-protocol/fileSnapshot.js';
import { literalPluginImports } from './pluginImports.js';

type PackageManifest = {
  name?: string;
  version?: string;
  files?: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  type?: string;
  main?: string;
  exports?: unknown;
  imports?: unknown;
};

// Node caches imported package modules for the process lifetime. Never label
// that cached code with newly edited bytes: operators must restart after edits.
const loadedDependencyDigests = new Map<string, string>();
const observedDependencyCaches = new WeakMap<Map<string, Promise<string>>, Map<string, {
  pending: Promise<string>;
  validation: Promise<{ digest: string; snapshot: FileSnapshot }>;
}>>();

export const BUNDLED_INTEGRITY_RECEIPT_PATH = 'dist/provider.integrity.json';
export interface ShippedPackageFileHash { path: string; hash: string }

/** Observe only declared runtime packages, never all of a host node_modules. */
export async function dependencyIntegrityInputs(packageRoot: string, includeEntryFiles = false): Promise<string[]> {
  const inputs = new Set<string>();
  const visited = new Set<string>();
  const visit = async (root: string, entry = false): Promise<void> => {
    inputs.add(root);
    const canonical = await fs.realpath(root);
    if (visited.has(canonical)) return;
    visited.add(canonical);
    const manifestPath = path.join(canonical, 'package.json');
    inputs.add(manifestPath);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as PackageManifest;
    if (!entry || (includeEntryFiles && manifest.files)) {
      const files = await packageFiles(canonical, manifest, inputs);
      for (const file of files) inputs.add(file.filename);
    }
    const resolver = createRequire(manifestPath);
    const dependencies = { ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.optionalDependencies };
    for (const name of Object.keys(dependencies).sort()) {
      const dependency = await resolvePackageRoot(resolver.resolve.paths(name) ?? [], name, inputs);
      if (dependency) await visit(dependency);
    }
  };
  await visit(packageRoot, true);
  return [...inputs];
}

/** A real distributed provider owns an explicit npm files allowlist. */
export async function shippedPackageFilesDigest(packageRoot: string): Promise<string | null> {
  const files = await shippedPackageFileHashes(packageRoot);
  return files ? stableHash(files) : null;
}

/** The generated receipt never hashes itself; dependency packages remain exact. */
export async function shippedPackageFileHashes(packageRoot: string): Promise<ShippedPackageFileHash[] | null> {
  const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8')) as PackageManifest;
  if (!Array.isArray(manifest.files)) return null;
  const files = (await packageFiles(packageRoot, manifest)).filter((file) => file.path !== BUNDLED_INTEGRITY_RECEIPT_PATH);
  return hashPackageFiles(files);
}

/** Hash the installed, declared runtime closure, never an unrelated host lock. */
export async function dependencyIntegrity(packageRoot: string, fileDigests = new Map<string, Promise<string>>()): Promise<string> {
  const nodes = new Map<string, { identity: string; files: string; edges: Record<string, string | null> }>();
  const visit = async (root: string, entry = false): Promise<string> => {
    const canonical = await fs.realpath(root);
    const present = nodes.get(canonical);
    if (present) return present.identity;
    const manifestPath = path.join(canonical, 'package.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as PackageManifest;
    const files = entry ? stableHash({
      name: manifest.name ?? null, version: manifest.version ?? null,
      type: manifest.type ?? null, main: manifest.main ?? null,
      exports: manifest.exports ?? null, imports: manifest.imports ?? null,
      dependencies: manifest.dependencies ?? {}, optionalDependencies: manifest.optionalDependencies ?? {},
      peerDependencies: manifest.peerDependencies ?? {}, peerDependenciesMeta: manifest.peerDependenciesMeta ?? {},
    }) : await cachedPackageFilesDigest(canonical, manifest, fileDigests);
    if (!entry) {
      const loaded = loadedDependencyDigests.get(canonical);
      if (loaded && loaded !== files) throw new DkbError(`Plugin runtime dependency ${manifest.name ?? 'package'} changed after it was loaded. Restart this Runtime or compiler process before using the changed dependency; Node may still hold the previous module in memory.`);
      loadedDependencyDigests.set(canonical, files);
    }
    const identity = stableHash({ name: manifest.name ?? null, version: manifest.version ?? null, files });
    const node = { identity, files, edges: {} as Record<string, string | null> };
    nodes.set(canonical, node);
    const dependencies = { ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.optionalDependencies };
    const resolver = createRequire(manifestPath);
    for (const name of Object.keys(dependencies).sort()) {
      const optional = name in (manifest.optionalDependencies ?? {}) || manifest.peerDependenciesMeta?.[name]?.optional === true;
      const dependency = await resolvePackageRoot(resolver.resolve.paths(name) ?? [], name);
      if (!dependency) {
        if (!optional) throw new DkbError(`Plugin runtime dependency ${name} is missing. Install the declared dependencies before selecting this plugin.`);
        node.edges[name] = null;
      } else {
        node.edges[name] = await visit(dependency);
      }
    }
    return identity;
  };
  const rootIdentity = await visit(packageRoot, true);
  const closure = [...nodes.values()].sort((left, right) => left.identity.localeCompare(right.identity));
  return stableHash({ root: rootIdentity, closure });
}

export async function validatePluginImports(
  root: string,
  files: readonly string[],
  options: { allowedFiles?: readonly string[] } = {},
): Promise<void> {
  const canonicalRoot = await fs.realpath(root);
  const allowedFiles = options.allowedFiles
    ? new Set(await Promise.all(options.allowedFiles.map((file) => fs.realpath(file))))
    : undefined;
  let manifest: PackageManifest = {};
  try { manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as PackageManifest; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const declared = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
  for (const file of files) {
    const actualFile = await fs.realpath(file);
    const inside = path.relative(canonicalRoot, actualFile);
    if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new DkbError('Plugin files may not symlink outside their package. Declare external code as a runtime dependency.');
    if (!/\.(?:[cm]?js|[cm]?ts)$/u.test(file) || /\.d\.[cm]?ts$/u.test(file)) continue;
    const source = await fs.readFile(file, 'utf8');
    // Syntax-aware boundary inspection is not a sandbox or a JS evaluator.
    for (const specifier of literalPluginImports(source, file, manifest.type)) {
      if (specifier.startsWith('file:') || path.isAbsolute(specifier)) {
        throw new DkbError(`Plugin import ${specifier} is outside its package. Use a declared package dependency or include the module within the plugin directory.`);
      }
      if (!specifier.startsWith('.')) {
        if (specifier.startsWith('node:') || builtinModules.includes(specifier)) continue;
        const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!;
        if (!(packageName in declared)) throw new DkbError(`Plugin import ${specifier} is not a declared runtime dependency. Add it to package.json dependencies so its installed code participates in the recipe identity.`);
        continue;
      }
      const candidate = path.resolve(path.dirname(file), specifier);
      let resolved = candidate;
      try { resolved = await fs.realpath(candidate); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const relative = path.relative(canonicalRoot, resolved);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new DkbError(`Plugin relative import ${specifier} escapes its package. Include that code within the plugin directory or declare it as a package dependency.`);
      }
      if (allowedFiles) {
        // ESM query/fragment suffixes identify module instances, not different files.
        // CJS extension/directory resolution is delegated to Node, never guessed here.
        let importedFile: string;
        try {
          const target = fileURLToPath(new URL(specifier, pathToFileURL(file)));
          let importedTarget = target;
          try {
            if (!(await fs.stat(target)).isFile()) importedTarget = createRequire(file).resolve(target);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            importedTarget = createRequire(file).resolve(target);
          }
          importedFile = await fs.realpath(importedTarget);
        } catch {
          throw new DkbError(`Bundled plugin relative import ${specifier} does not resolve to a shipped file. Include every imported module in the package files allowlist and regenerate its integrity receipt.`);
        }
        if (!allowedFiles.has(importedFile)) {
          throw new DkbError(`Bundled plugin relative import ${specifier} is outside its integrity receipt file inventory. Include every imported module in the package files allowlist and regenerate its integrity receipt.`);
        }
      }
    }
  }
}

async function resolvePackageRoot(search: readonly string[], name: string, inputs?: Set<string>): Promise<string | null> {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(name)) throw new DkbError(`Invalid runtime dependency name ${name}`);
  for (const directory of search) {
    const candidate = path.join(directory, name);
    inputs?.add(path.join(candidate, 'package.json'));
    try { if ((await fs.stat(path.join(candidate, 'package.json'))).isFile()) return candidate; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return null;
}

async function hashPackageFiles(selected: Array<{ path: string; filename: string }>): Promise<ShippedPackageFileHash[]> {
  const entries: ShippedPackageFileHash[] = [];
  for (let offset = 0; offset < selected.length; offset += 32) {
    entries.push(...await Promise.all(selected.slice(offset, offset + 32).map(async (file) => ({ path: file.path, hash: createHash('sha256').update(await fs.readFile(file.filename)).digest('hex') }))));
  }
  return entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export function packageFilesInclude(relative: string, patterns?: readonly string[]): boolean {
  if (relative === 'package.json') return true;
  if (!patterns) return true;
  const matches = (pattern: string) => {
    const normalized = pattern.replace(/^\.\//u, '').replace(/\/$/u, '');
    return relative === normalized || relative.startsWith(`${normalized}/`) || path.matchesGlob(relative, normalized);
  };
  return patterns.some((pattern) => !pattern.startsWith('!') && matches(pattern))
    && !patterns.some((pattern) => pattern.startsWith('!') && matches(pattern.slice(1)));
}

async function packageFiles(root: string, manifest: PackageManifest, directories?: Set<string>): Promise<Array<{ path: string; filename: string }>> {
  const selected: Array<{ path: string; filename: string }> = [];
  const patterns = manifest.files;
  const walk = async (directory: string): Promise<void> => {
    directories?.add(directory);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (['node_modules', '.git', '.cache', '__pycache__'].includes(entry.name) || entry.name.endsWith('.tsbuildinfo')) continue;
      const filename = path.join(directory, entry.name);
      const relative = path.relative(root, filename).replace(/\\/gu, '/');
      if (entry.isDirectory()) await walk(filename);
      else if (entry.isFile() && packageFilesInclude(relative, patterns)) selected.push({ path: relative, filename });
      else if (entry.isSymbolicLink() && packageFilesInclude(relative, patterns)) {
        throw new DkbError(`Runtime dependency contains an unverifiable symlink at ${relative}. Package its code as ordinary files before selecting this plugin.`);
      }
    }
  };
  await walk(root);
  return selected;
}

async function cachedPackageFilesDigest(root: string, manifest: PackageManifest, cache: Map<string, Promise<string>>): Promise<string> {
  let observed = observedDependencyCaches.get(cache);
  if (!observed) {
    observed = new Map();
    observedDependencyCaches.set(cache, observed);
  }
  const prior = observed.get(root);
  if (prior && prior.pending === cache.get(root)) {
    const validated = await prior.validation;
    await assertFileSnapshotCurrent(validated.snapshot);
    return validated.digest;
  }
  const validation = (async () => {
    const inputs = new Set<string>([path.join(root, 'package.json')]);
    const files = await packageFiles(root, manifest, inputs);
    const snapshot = await captureFileSnapshot([...inputs, ...files.map((file) => file.filename)]);
    const digest = stableHash(await hashPackageFiles(files));
    await assertFileSnapshotCurrent(snapshot);
    return { digest, snapshot };
  })();
  const pending = validation.then((value) => value.digest);
  cache.set(root, pending);
  observed.set(root, { pending, validation });
  return pending;
}
