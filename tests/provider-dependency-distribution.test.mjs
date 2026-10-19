import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { providerPackages } from '../scripts/generate-provider-integrity.mjs';
import { assertDeclaredProviderBundles, installedNpmCli, packDistribution } from '../scripts/package-distribution.mjs';
import { executePackageCommand as execute } from '../scripts/lib/package-command.mjs';

const repositoryRoot = process.cwd();
const generator = path.resolve('scripts/generate-provider-integrity.mjs');

test('deployable providers explicitly bundle their exact direct dependency set without locking SDK libraries', async () => {
  const providers = await providerPackages();
  assert.equal(providers.length, 6);
  const lock = JSON.parse(await fs.readFile('package-lock.json', 'utf8'));
  for (const { manifest, packageRoot } of providers) {
    const expected = Object.keys(manifest.dependencies).sort();
    assert.deepEqual([...manifest.bundleDependencies].sort(), expected);
    assert.deepEqual([...lock.packages[path.relative(repositoryRoot, packageRoot).replace(/\\/gu, '/')].bundleDependencies].sort(), expected);
    assert.throws(() => assertDeclaredProviderBundles(manifest, ['package.json']), /omits declared bundle/u);
    assert.doesNotThrow(() => assertDeclaredProviderBundles(manifest, expected.map(name => `node_modules/${name}/package.json`)));
  }
  for (const packageRoot of ['packages/protocol', 'packages/pipeline']) {
    const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    assert.equal(manifest.bundleDependencies, undefined);
    await assert.rejects(fs.access(path.join(packageRoot, 'npm-shrinkwrap.json')), { code: 'ENOENT' });
  }
});

// Native archive staging is I/O-heavy and also runs in the parallel full suite.
// This is a packaging budget, not a compile or retrieval performance gate.
test('all provider bundles install independently offline, retain receipts, isolate competing dependencies, and reject tampering', { timeout: 600_000, concurrency: 1 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-native-install-'));
  const controller = new AbortController();
  const signal = AbortSignal.any([t.signal, controller.signal]);
  let work;
  t.after(async () => {
    controller.abort();
    await work?.catch(() => {});
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('dkb-provider-native-install-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  work = proveIndependentProviderInstallation(root, signal);
  try {
    await work;
  } catch (error) {
    t.diagnostic(JSON.stringify({
      code: error?.code ?? null,
      signal: error?.signal ?? null,
      killed: error?.killed ?? null,
      stdout: Buffer.from(error?.stdout ?? '').subarray(-4096).toString('utf8'),
      stderr: Buffer.from(error?.stderr ?? '').subarray(-4096).toString('utf8'),
    }));
    throw error;
  }
});

async function proveIndependentProviderInstallation(root, signal) {
  const npmCli = await installedNpmCli();
  const providers = await providerPackages();
  const output = path.join(root, 'candidates');
  const { packages } = await packDistribution({ outputDirectory: output, npmCli, workspaces: providers.map(provider => provider.manifest.name), signal });
  assert.equal(packages.length, 6);
  for (const report of packages) {
    assert.ok(report.paths.some(file => file.startsWith('node_modules/')), `${report.name} actually contains dependencies`);
    assert.ok(report.paths.includes('node_modules/@sjshovan/dkb-pipeline/package.json'));
    assert.ok(report.paths.includes('node_modules/@sjshovan/dkb-protocol/package.json'));
  }

  const conflictingArchives = [];
  for (const [name, version] of [['zod', '4.99.0'], ['fast-uri', '3.99.0']]) {
    signal.throwIfAborted();
    const fixture = path.join(root, 'conflicts', name);
    await fs.mkdir(fixture, { recursive: true });
    await fs.writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name, version, type: 'module', files: ['index.js'], exports: './index.js' }));
    await fs.writeFile(path.join(fixture, 'index.js'), 'throw new Error("Competing host dependency must not enter a provider");\n');
    const { stdout } = await execute(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', output], {
      cwd: fixture, windowsHide: true, timeout: 30_000, signal,
    });
    conflictingArchives.push(path.join(output, JSON.parse(stdout)[0].filename));
  }
  const prefix = path.join(root, 'prefix');
  const unrelated = path.join(root, 'unrelated');
  await fs.mkdir(unrelated);
  const environment = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('DKB_'))),
    DKB_HOST_INVENTORY: path.join(root, 'host.json'),
    DKB_GLOBAL_ROOT: path.join(root, 'global'),
    DKB_CLI_CONFIG: path.join(root, 'global/config.json'),
  };
  await execute(process.execPath, [npmCli, 'install', '--global', '--prefix', prefix, '--offline', '--ignore-scripts',
    '--cache', path.join(root, 'empty-cache'), '--registry', 'http://127.0.0.1:1', '--no-audit', '--no-fund',
    ...packages.map(report => report.archive), ...conflictingArchives], {
    cwd: unrelated, env: environment, windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, signal,
  });
  const modules = path.join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules');
  const installed = providers.map(provider => path.join(modules, provider.manifest.name));
  const receiptPaths = installed.map(packageRoot => path.join(packageRoot, 'dist/provider.integrity.json'));
  const originals = await Promise.all(receiptPaths.map(filename => fs.readFile(filename)));
  const verify = () => execute(process.execPath, [generator, '--verify', ...installed], {
    cwd: unrelated, env: environment, windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, signal,
  });
  const verified = JSON.parse((await verify()).stdout);
  assert.equal(verified.status, 'verified');
  assert.equal(verified.providers.length, 6);
  for (let index = 0; index < providers.length; index++) {
    assert.deepEqual(originals[index], await fs.readFile(path.join(providers[index].packageRoot, 'dist/provider.integrity.json')));
  }
  await assert.rejects(fs.access(path.join(modules, '@sjshovan/dkb-cli')), { code: 'ENOENT' });
  assert.equal((await manifest(path.join(modules, 'zod'))).version, '4.99.0');
  assert.equal((await manifest(path.join(modules, 'fast-uri'))).version, '3.99.0');
  const fastembed = installed[providers.findIndex(provider => provider.manifest.name === '@sjshovan/dkb-embedding-fastembed')];
  const protocol = await dependencyRoot(fastembed, '@sjshovan/dkb-protocol');
  const ajv = await dependencyRoot(protocol, 'ajv');
  const uri = await dependencyRoot(ajv, 'fast-uri');
  const zod = await dependencyRoot(protocol, 'zod');
  assert.notEqual((await manifest(zod)).version, '4.99.0');
  assert.notEqual((await manifest(uri)).version, '3.99.0');

  const changedFile = path.join(uri, 'index.js');
  const originalCode = await fs.readFile(changedFile);
  try {
    signal.throwIfAborted();
    await fs.appendFile(changedFile, '\n// Bounded dependency-integrity rejection fixture.\n');
    await assert.rejects(verify(), error => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /integrity|changed|mismatch/iu);
      return true;
    });
  } finally {
    await fs.writeFile(changedFile, originalCode);
  }
  assert.equal(JSON.parse((await verify()).stdout).status, 'verified');
  for (let index = 0; index < receiptPaths.length; index++) {
    assert.deepEqual(await fs.readFile(receiptPaths[index]), originals[index], 'installation and checks never regenerate receipts');
  }
}

async function manifest(packageRoot) {
  return JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
}

async function dependencyRoot(from, name) {
  for (const directory of createRequire(path.join(from, 'package.json')).resolve.paths(name) ?? []) {
    const candidate = path.join(directory, name);
    try { await fs.access(path.join(candidate, 'package.json')); return candidate; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error(`Missing installed dependency ${name}`);
}
