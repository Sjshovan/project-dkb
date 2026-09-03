import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const receiptPath = 'dist/provider.integrity.json';

/** Discover packaged provider entrypoints from their existing npm exports, never provider setup. */
export async function providerPackages(roots) {
  const candidates = roots?.length ? roots.map(root => path.resolve(root))
    : (await fs.readdir(path.join(repositoryRoot, 'providers'), { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => path.join(repositoryRoot, 'providers', entry.name));
  const packages = [];
  for (const packageRoot of candidates.sort()) {
    const manifestPath = path.join(packageRoot, 'package.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const exported = manifest.exports?.['./plugin.js'];
    const entry = typeof exported === 'string' ? exported : exported?.import ?? exported?.default;
    if (typeof entry !== 'string' || !entry.startsWith('./')) {
      throw new Error(`${manifest.name ?? packageRoot} must export one built ./plugin.js entrypoint.`);
    }
    const entrypoint = path.resolve(packageRoot, entry);
    const relative = path.relative(packageRoot, entrypoint);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Provider entrypoint escapes its package.');
    packages.push({ packageRoot, manifestPath, manifest, entrypoint });
  }
  return packages;
}

export async function processProviderIntegrity(packages, { verify = false, trustedSdkRoot } = {}) {
  const dependencyCache = new Map();
  const results = [];
  // The verifier is part of the invoking tool's trust root. Candidate dependency
  // code is inspected as data and must never supply its own verification logic.
  const helperEntrypoint = await resolveSdkHelper(trustedSdkRoot);
  const helpers = await import(pathToFileURL(helperEntrypoint).href);
  for (const definition of packages) {
    const { packageRoot, manifest, entrypoint } = definition;
    let receipt;
    if (verify) {
      // Inspection must never execute a stale, missing-receipt, or unselected provider.
      receipt = await helpers.verifyBundledIntegrityReceipt({ packageRoot, entrypoint }, dependencyCache);
    } else {
      const exports = await import(pathToFileURL(entrypoint).href);
      const plugins = [...new Set(Object.values(exports).filter(value => value && typeof value === 'object'
        && typeof value.setup === 'function' && value.integrity && typeof value.sourceUrl === 'string'))];
      if (plugins.length !== 1) throw new Error(`${manifest.name} must export exactly one bundled plugin definition.`);
      const plugin = plugins[0];
      if (path.resolve(fileURLToPath(plugin.sourceUrl)) !== entrypoint) {
        throw new Error(`${manifest.name} declares a sourceUrl other than its exported plugin entrypoint.`);
      }
      receipt = await helpers.writeBundledIntegrityReceipt({ packageRoot, entrypoint, identity: plugin.integrity }, dependencyCache);
    }
    results.push({ definition, receipt });
  }
  return results;
}

async function resolveSdkHelper(trustedSdkRoot) {
  const sdkName = '@sjshovan/dkb-pipeline';
  const require = createRequire(import.meta.url);
  const candidates = trustedSdkRoot === undefined
    ? (require.resolve.paths(sdkName) ?? []).map(modulesRoot => path.join(modulesRoot, sdkName))
    : [path.resolve(trustedSdkRoot)];
  for (const sdkRoot of candidates) {
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(path.join(sdkRoot, 'package.json'), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const exported = manifest.exports?.['./bundledIntegrity.js'];
    const target = typeof exported === 'string' ? exported : exported?.import ?? exported?.default;
    if (manifest.name !== sdkName || typeof target !== 'string' || !target.startsWith('./')) {
      throw new Error(`Installed ${sdkName} does not expose its ESM bundled integrity verifier.`);
    }
    const entrypoint = path.resolve(sdkRoot, target);
    const relative = path.relative(sdkRoot, entrypoint);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Installed SDK helper escapes its package.');
    return entrypoint;
  }
  throw new Error(`Trusted host SDK ${sdkName} is missing. Install the tool's SDK or pass --trusted-sdk <host-sdk-root>; a candidate provider cannot supply its own verifier.`);
}

export function assertProviderPackageFiles(result, paths) {
  const packed = new Set(paths);
  for (const required of [receiptPath, ...result.receipt.files.map(file => file.path)]) {
    if (!packed.has(required)) throw new Error(`${result.definition.manifest.name} package omits receipt-bound file ${required}.`);
  }
}

/** Stage exactly the receipt-bound provider files for a Node image, without Python environments or model caches. */
export async function stageProviderPackages(results, destination) {
  const target = path.resolve(destination);
  await fs.mkdir(target, { recursive: true });
  if ((await fs.readdir(target)).length > 0) throw new Error(`Provider distribution destination must be empty: ${target}`);
  for (const { definition, receipt } of results) {
    const relativeRoot = path.relative(path.join(repositoryRoot, 'providers'), definition.packageRoot);
    if (!relativeRoot || relativeRoot.startsWith('..') || path.isAbsolute(relativeRoot) || relativeRoot.includes(path.sep)) {
      throw new Error('Image staging accepts only direct provider workspaces from this checkout.');
    }
    const packageDestination = path.join(target, 'providers', relativeRoot);
    for (const file of [...receipt.files, { path: receiptPath }]) {
      const source = path.resolve(definition.packageRoot, file.path);
      const sourceRelative = path.relative(definition.packageRoot, source);
      if (sourceRelative.startsWith('..') || path.isAbsolute(sourceRelative)) throw new Error('Provider receipt file escapes its package.');
      const output = path.join(packageDestination, sourceRelative);
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.copyFile(source, output);
    }
  }
}

async function main() {
  const roots = [];
  let verify = false;
  let quiet = false;
  let destination;
  let trustedSdkRoot;
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument === '--verify') verify = true;
    else if (argument === '--quiet') quiet = true;
    else if (argument === '--copy-to') {
      destination = process.argv[++index];
      if (!destination || destination.startsWith('--')) throw new Error('--copy-to requires a destination directory.');
    } else if (argument === '--trusted-sdk') {
      trustedSdkRoot = process.argv[++index];
      if (!trustedSdkRoot || trustedSdkRoot.startsWith('--')) throw new Error('--trusted-sdk requires a trusted host SDK directory.');
    } else if (argument.startsWith('--')) throw new Error(`Unknown provider integrity option: ${argument}`);
    else roots.push(argument);
  }
  if (destination && !verify) throw new Error('Image staging requires --verify; it must not regenerate receipts.');
  const results = await processProviderIntegrity(await providerPackages(roots), { verify, trustedSdkRoot });
  if (destination) await stageProviderPackages(results, destination);
  if (!quiet) console.log(JSON.stringify({
    status: verify ? 'verified' : 'generated',
    providers: results.map(({ definition, receipt }) => ({
      package: definition.manifest.name,
      id: receipt.id,
      files: receipt.files.length,
      filesDigest: receipt.filesDigest,
      dependencyDigest: receipt.dependencyDigest,
    })),
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
