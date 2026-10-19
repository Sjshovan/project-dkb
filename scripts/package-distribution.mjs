import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { t as listTar } from 'tar';
import { distributableWorkspaces, findForbiddenPackagePaths } from './package-policy.mjs';
import { assertProviderPackageFiles, processProviderIntegrity, providerPackages, stageProviderPackages } from './generate-provider-integrity.mjs';
import { executePackageCommand as execute } from './lib/package-command.mjs';

export async function installedNpmCli() {
  const candidates = [process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean);
  for (const candidate of candidates) {
    try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('The installed npm CLI could not be located. Run package commands through npm run; no package manager is downloaded automatically.');
}

async function npmJson(npmCli, args, cwd, signal) {
  const { stdout } = await execute(process.execPath, [npmCli, ...args], {
    cwd, windowsHide: true, timeout: 120_000, maxBuffer: 24 * 1024 * 1024, signal,
  });
  return JSON.parse(stdout);
}

/** npm owns resolution; this reads its exact installed graph without solving ranges. */
async function installedSeeds(npmCli, workspace, repositoryRoot, signal) {
  const tree = await npmJson(npmCli, ['ls', '--json', '--long', '--all', '--omit=dev', '--workspace', workspace], repositoryRoot, signal);
  const lock = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'package-lock.json'), 'utf8'));
  const selected = tree.dependencies?.[workspace];
  if (!selected?.path) throw new Error(`npm did not report the installed workspace ${workspace}.`);
  const seeds = new Map();
  const visit = async (node) => {
    for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
      signal?.throwIfAborted();
      if (!dependency.path) {
        const optional = name in (node.optionalDependencies ?? {}) || node.peerDependenciesMeta?.[name]?.optional === true;
        if (optional && !dependency.invalid) continue;
        throw new Error(`npm reports missing or invalid runtime dependency ${name} for ${workspace}. Run npm ci before packaging.`);
      }
      if (dependency.invalid || dependency.missing || dependency.extraneous) throw new Error(`npm reports an invalid runtime dependency ${name} for ${workspace}.`);
      const packageRoot = await fs.realpath(dependency.path);
      const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
      if (manifest.name !== name || manifest.version !== dependency.version) throw new Error(`Installed dependency ${name} changed while npm reported its graph.`);
      const previous = seeds.get(name);
      if (previous && (previous.packageRoot !== packageRoot || previous.version !== manifest.version)) {
        throw new Error(`Cannot stage ${workspace}: ${name} has multiple installed resolutions. Preserve the dependency graph before packaging; DKB will not substitute a version.`);
      }
      const locked = lock.packages?.[path.relative(repositoryRoot, packageRoot).replace(/\\/gu, '/')];
      if (!locked || locked.version !== manifest.version) throw new Error(`Installed dependency ${name} does not match package-lock.json. Run npm ci before packaging.`);
      const registryArchive = /^https?:\/\//u.test(locked.resolved ?? '') ? locked.resolved : undefined;
      if (registryArchive && !locked.integrity) throw new Error(`Locked dependency ${name} has no archive integrity.`);
      // npm 10's directory fetcher runs prepare even with --ignore-scripts.
      // Registry seeds use original cached tarballs; local seeds must be inert.
      const lifecycleHooks = ['prepack', 'prepare', 'postpack', 'prepublish', 'prepublishOnly'].filter(hook => manifest.scripts?.[hook]);
      if (!registryArchive && lifecycleHooks.length) throw new Error(`Cannot safely pack local dependency ${name}: lifecycle hooks ${lifecycleHooks.join(', ')} are present. Provide an immutable dependency archive.`);
      seeds.set(name, { name, version: manifest.version, packageRoot, registryArchive, integrity: locked.integrity });
      await visit(dependency);
    }
  };
  await visit(selected);
  return [...seeds.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** Inspect the actual archive, including files npm omits from its summary. */
export async function inspectPackageArchive(archive) {
  const paths = [];
  let manifestText = '';
  let rejection;
  await listTar({ file: archive, onReadEntry(entry) {
    if (rejection) return;
    try {
      if (!['File', 'Directory'].includes(entry.type)) throw new Error(`Package archive contains an unsupported ${entry.type} entry: ${entry.path}`);
      const relative = entry.path.replace(/^package\//u, '');
      if (!entry.path.startsWith('package/') || relative.includes('\\') || relative.split('/').includes('..') || path.posix.isAbsolute(relative)) {
        throw new Error(`Package archive contains an unsafe path: ${entry.path}`);
      }
      if (entry.type !== 'File') return;
      paths.push(relative);
      if (relative === 'package.json') {
        if (entry.size > 2 * 1024 * 1024) throw new Error('Package manifest exceeds the inspection limit.');
        entry.on('data', bytes => { manifestText += bytes.toString('utf8'); });
      }
    } catch (error) { rejection = error; }
  } });
  // Never throw out of tar's event callback: that bypasses release staging cleanup.
  if (rejection) throw rejection;
  const forbidden = findForbiddenPackagePaths(paths);
  forbidden.push(...paths.filter(file => /(^|\/)(?:\.npmrc|\.git|\.cache|__pycache__)(\/|$)/iu.test(file)));
  if (forbidden.length) throw new Error(`Package archive contains forbidden files: ${[...new Set(forbidden)].join(', ')}`);
  if (!manifestText) throw new Error('Package archive omits package.json.');
  return { paths, manifest: JSON.parse(manifestText) };
}

export function assertDeclaredProviderBundles(manifest, paths) {
  const declared = Object.keys(manifest.dependencies ?? {}).sort();
  const bundled = Array.isArray(manifest.bundleDependencies) ? [...manifest.bundleDependencies].sort() : [];
  if (JSON.stringify(declared) !== JSON.stringify(bundled)) throw new Error(`${manifest.name} must explicitly bundle every direct runtime dependency.`);
  for (const name of declared) {
    if (!paths.includes(`node_modules/${name}/package.json`)) {
      throw new Error(`${manifest.name} archive omits declared bundle ${name}. Pack the provider through the verified release staging command, not directly from a workspace.`);
    }
  }
}

/** Build receipts are input, never regenerated by packaging or installation. */
export async function packDistribution({ outputDirectory, repositoryRoot = process.cwd(), npmCli, workspaces = distributableWorkspaces, signal } = {}) {
  signal?.throwIfAborted();
  if (!outputDirectory) throw new Error('Choose an output directory for the package candidates.');
  npmCli ??= await installedNpmCli();
  signal?.throwIfAborted();
  const output = path.resolve(outputDirectory);
  await fs.mkdir(output, { recursive: true });
  if ((await fs.readdir(output)).length) throw new Error(`Package output must be empty: ${output}`);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-package-distribution-'));
  try {
    signal?.throwIfAborted();
    const providers = new Map((await processProviderIntegrity(await providerPackages(), { verify: true }))
      .map(result => [result.definition.manifest.name, result]));
    const seedCache = new Map();
    const packages = [];
    for (const workspace of workspaces) {
      signal?.throwIfAborted();
      if (!distributableWorkspaces.includes(workspace)) throw new Error(`Unknown distributable workspace ${workspace}.`);
      const provider = providers.get(workspace);
      let packed;
      if (provider) {
        const stagingRoot = path.join(root, 'staged', path.basename(provider.definition.packageRoot));
        await stageProviderPackages([provider], stagingRoot);
        signal?.throwIfAborted();
        const stage = path.join(stagingRoot, 'providers', path.basename(provider.definition.packageRoot));
        const seedPaths = [];
        for (const seed of await installedSeeds(npmCli, workspace, repositoryRoot, signal)) {
          signal?.throwIfAborted();
          let archive = seedCache.get(seed.packageRoot);
          if (!archive) {
            const seedDirectory = path.join(root, 'seeds', createHash('sha256').update(seed.packageRoot).digest('hex').slice(0, 20));
            await fs.mkdir(seedDirectory, { recursive: true });
            let report;
            try {
              report = (await npmJson(npmCli, ['pack', seed.registryArchive ?? seed.packageRoot, '--ignore-scripts', '--offline', '--json', '--pack-destination', seedDirectory], repositoryRoot, signal))[0];
            } catch (error) {
              if (/ENOTCACHED|only-if-cached|cache miss/iu.test(`${error.stderr ?? ''} ${error.message}`)) {
                throw new Error(`Exact locked archive ${seed.name}@${seed.version} is missing from npm's cache. Run npm ci with Registry access, then npm run package:check. Packaging never substitutes a newer version or falls back to the network.`, { cause: error });
              }
              throw error;
            }
            if (seed.registryArchive && report.integrity !== seed.integrity) throw new Error(`Locked archive integrity differs for dependency ${seed.name}.`);
            archive = path.join(seedDirectory, report.filename);
            await inspectPackageArchive(archive);
            seedCache.set(seed.packageRoot, archive);
          }
          seedPaths.push(archive);
        }
        const ownFiles = [...provider.receipt.files.map(file => file.path), 'dist/provider.integrity.json'];
        const originals = new Map(await Promise.all(ownFiles.map(async file => [file, await fs.readFile(path.join(stage, file))])));
        signal?.throwIfAborted();
        await execute(process.execPath, [npmCli, 'install', '--no-save', '--package-lock=false', '--ignore-scripts', '--offline',
          '--cache', path.join(root, 'install-cache'), '--no-audit', '--no-fund', '--registry', 'http://127.0.0.1:1', ...seedPaths], {
          cwd: stage, windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, signal,
        });
        for (const [file, bytes] of originals) {
          if (!bytes.equals(await fs.readFile(path.join(stage, file)))) throw new Error(`Native staging changed receipt-bound provider file ${file}.`);
        }
        await processProviderIntegrity(await providerPackages([stage]), { verify: true });
        signal?.throwIfAborted();
        packed = (await npmJson(npmCli, ['pack', '--ignore-scripts', '--json', '--pack-destination', output], stage, signal))[0];
      } else {
        packed = (await npmJson(npmCli, ['pack', '--workspace', workspace, '--json', '--pack-destination', output], repositoryRoot, signal))[0];
      }
      const archive = path.join(output, packed.filename);
      const inspection = await inspectPackageArchive(archive);
      if (provider) {
        assertProviderPackageFiles(provider, inspection.paths);
        assertDeclaredProviderBundles(inspection.manifest, inspection.paths);
      }
      packages.push({ ...packed, private: inspection.manifest.private === true, archive, paths: inspection.paths });
    }
    signal?.throwIfAborted();
    return { status: 'packed', packages };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output') throw new Error('Usage: node scripts/package-distribution.mjs --output <empty-directory>');
  const result = await packDistribution({ outputDirectory: args[1] });
  const candidates = { ...result, packages: result.packages.map(({ paths, files, archive, ...report }) => report) };
  const document = `${JSON.stringify(candidates, null, 2)}\n`;
  await fs.writeFile(path.join(path.resolve(args[1]), 'candidates.json'), document, { flag: 'wx' });
  console.log(document.trimEnd());
}
