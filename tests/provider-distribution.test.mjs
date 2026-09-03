import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  assertProviderPackageFiles,
  processProviderIntegrity,
  providerPackages,
  stageProviderPackages,
} from '../scripts/generate-provider-integrity.mjs';

const execute = promisify(execFile);
const generator = path.resolve('scripts/generate-provider-integrity.mjs');

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-distribution-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'provider');
  await fs.mkdir(path.join(packageRoot, 'dist'), { recursive: true });
  const dependencyScope = path.join(packageRoot, 'node_modules', '@sjshovan');
  await fs.mkdir(dependencyScope, { recursive: true });
  await fs.symlink(path.resolve('packages/pipeline'), path.join(dependencyScope, 'dkb-pipeline'), 'junction');
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: '@test/packaged-provider', version: '1.0.0', type: 'module',
    files: ['dist/', '!dist/.tsbuildinfo'],
    exports: { './plugin.js': { import: './dist/plugin.js' } },
    dependencies: { '@sjshovan/dkb-pipeline': '0.2.0' },
    ...overrides,
  }));
  await fs.writeFile(path.join(packageRoot, 'dist', 'plugin.js'), `export const plugin = {
    apiVersion: 3, id: '@test/packaged-provider', version: '1.0.0', sourceUrl: import.meta.url,
    integrity: { apiVersion: 3, id: '@test/packaged-provider', version: '1.0.0', protocols: ['test.provider.v1'], artifactFormats: [] },
    setup() { throw new Error('Build and verification must never call setup'); },
  };\n`);
  await fs.writeFile(path.join(packageRoot, 'dist', 'helper.js'), 'export const value = 1;\n');
  return { root, packageRoot, receipt: path.join(packageRoot, 'dist', 'provider.integrity.json') };
}

test('provider generator writes only at build time and uses the trusted ESM SDK without setup', async (t) => {
  const { root, packageRoot, receipt } = await fixture(t);
  await assert.rejects(execute(process.execPath, [generator, '--verify', packageRoot], { cwd: root }), /integrity|ENOENT/u);
  await assert.rejects(fs.access(receipt), { code: 'ENOENT' });

  const generated = JSON.parse((await execute(process.execPath, [generator, packageRoot], { cwd: root })).stdout);
  assert.equal(generated.status, 'generated');
  assert.equal(generated.providers[0].id, '@test/packaged-provider');
  const original = await fs.readFile(receipt, 'utf8');
  const verified = JSON.parse((await execute(process.execPath, [generator, '--verify', packageRoot], { cwd: root })).stdout);
  assert.equal(verified.status, 'verified');
  assert.equal(verified.providers.length, 1);
  assert.equal(await fs.readFile(receipt, 'utf8'), original);

  await fs.writeFile(path.join(packageRoot, 'dist', 'helper.js'), 'export const value = 2;\n');
  await assert.rejects(execute(process.execPath, [generator, '--verify', '--quiet', packageRoot], { cwd: root }), error => {
    assert.notEqual(error.code, 0);
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /integrity|mismatch|changed|rebuild/iu);
    return true;
  });
  assert.equal(await fs.readFile(receipt, 'utf8'), original, 'verification must not bless changed bytes');
});

test('verify-only prepack leaves npm pack JSON parseable and rejects changed provider bytes', async (t) => {
  const { packageRoot, receipt } = await fixture(t, {
    scripts: { prepack: `node ${JSON.stringify(generator.replace(/\\/gu, '/'))} --verify --quiet .` },
  });
  await execute(process.execPath, [generator, packageRoot]);
  const original = await fs.readFile(receipt, 'utf8');
  const pack = () => execute(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json'], {
    cwd: packageRoot, shell: process.platform === 'win32', windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  const packed = JSON.parse((await pack()).stdout);
  assert.equal(packed.length, 1);
  assert.equal(packed[0].name, '@test/packaged-provider');
  assert.ok(packed[0].files.some(file => file.path === 'dist/provider.integrity.json'));
  assert.equal(await fs.readFile(receipt, 'utf8'), original);
  await fs.writeFile(path.join(packageRoot, 'dist', 'helper.js'), 'export const value = 2;\n');
  await assert.rejects(pack(), error => {
    assert.notEqual(error.code, 0);
    assert.match(error.stderr, /integrity|mismatch|changed|rebuild/iu);
    return true;
  });
  assert.equal(await fs.readFile(receipt, 'utf8'), original);
});

test('verify-only inspection never imports the provider entrypoint', async (t) => {
  const { root, packageRoot, receipt } = await fixture(t);
  const marker = path.join(root, 'provider-executed');
  const entrypoint = path.join(packageRoot, 'dist/plugin.js');
  const original = await fs.readFile(entrypoint, 'utf8');
  await fs.writeFile(entrypoint, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'executed');\n${original}`);
  await execute(process.execPath, [generator, packageRoot]);
  await fs.rm(marker);
  await execute(process.execPath, [generator, '--verify', packageRoot]);
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
  await fs.rm(receipt);
  await assert.rejects(execute(process.execPath, [generator, '--verify', packageRoot]), /integrity|missing/iu);
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
});

test('candidate SDK code cannot execute or supply a self-attesting verifier', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-verifier-trust-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'provider');
  const sdkRoot = path.join(packageRoot, 'node_modules/@sjshovan/dkb-pipeline');
  const marker = path.join(root, 'candidate-verifier-executed');
  await fs.mkdir(path.join(packageRoot, 'dist'), { recursive: true });
  await fs.mkdir(sdkRoot, { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: '@test/verifier-trust', version: '1.0.0', type: 'module', files: ['dist/'],
    exports: { './plugin.js': { import: './dist/plugin.js' } },
    dependencies: { '@sjshovan/dkb-pipeline': '0.2.0' },
  }));
  await fs.writeFile(path.join(packageRoot, 'dist/plugin.js'), `export const plugin = {
    apiVersion: 3, id: '@test/verifier-trust', version: '1.0.0', sourceUrl: import.meta.url,
    integrity: { apiVersion: 3, id: '@test/verifier-trust', version: '1.0.0', protocols: [], artifactFormats: [] },
    setup() { throw new Error('Verification must never call setup'); },
  };\n`);
  await fs.writeFile(path.join(sdkRoot, 'package.json'), JSON.stringify({
    name: '@sjshovan/dkb-pipeline', version: '0.2.0', type: 'module', files: ['verifier.js'],
    exports: { './bundledIntegrity.js': { import: './verifier.js' } },
  }));
  const candidateVerifier = path.join(sdkRoot, 'verifier.js');
  await fs.writeFile(candidateVerifier, `import fs from 'node:fs';
    fs.writeFileSync(${JSON.stringify(marker)}, 'executed');
    export async function verifyBundledIntegrityReceipt() {
      return { id: '@test/verifier-trust', files: [], filesDigest: 'forged', dependencyDigest: 'forged' };
    }\n`);
  await assert.rejects(execute(process.execPath, [generator, '--verify', packageRoot]), /integrity|missing/iu);
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });

  await execute(process.execPath, [generator, packageRoot]);
  const receipt = path.join(packageRoot, 'dist/provider.integrity.json');
  const original = await fs.readFile(receipt);
  await execute(process.execPath, [generator, '--verify', packageRoot]);
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });

  // A copied inspection tool has no implicit SDK; the candidate remains ineligible.
  const copiedTool = path.join(root, 'verify-providers.mjs');
  await fs.copyFile(generator, copiedTool);
  await assert.rejects(execute(process.execPath, [copiedTool, '--verify', packageRoot], { cwd: root }), /Trusted host SDK|candidate provider cannot/iu);
  await execute(process.execPath, [copiedTool, '--verify', '--trusted-sdk', path.resolve('packages/pipeline'), packageRoot], { cwd: root });
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });

  await fs.appendFile(candidateVerifier, '\nexport const tampered = true;\n');
  await assert.rejects(execute(process.execPath, [generator, '--verify', packageRoot]), /integrity|mismatch|changed/iu);
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(receipt), original, 'a dependency may not rewrite or bless its own baseline');
});

test('provider package inspection requires both its receipt and every bound shipped file', () => {
  const result = { definition: { manifest: { name: '@test/provider' } }, receipt: { files: [{ path: 'dist/plugin.js' }, { path: 'python/service.py' }] } };
  assert.throws(() => assertProviderPackageFiles(result, ['dist/plugin.js', 'python/service.py']), /provider.integrity.json/u);
  assert.throws(() => assertProviderPackageFiles(result, ['dist/provider.integrity.json', 'dist/plugin.js']), /python\/service.py/u);
  assert.doesNotThrow(() => assertProviderPackageFiles(result, ['dist/provider.integrity.json', 'dist/plugin.js', 'python/service.py']));
});

test('Node image staging contains exactly receipt-bound provider bytes and no worker environments', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-image-stage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const results = await processProviderIntegrity(await providerPackages(), { verify: true });
  await stageProviderPackages(results, root);
  for (const { definition, receipt } of results) {
    const stagedRoot = path.join(root, 'providers', path.basename(definition.packageRoot));
    const actual = (await fs.readdir(stagedRoot, { recursive: true, withFileTypes: true }))
      .filter(entry => entry.isFile())
      .map(entry => path.relative(stagedRoot, path.join(entry.parentPath, entry.name)).replace(/\\/gu, '/')).sort();
    const expected = [...receipt.files.map(file => file.path), 'dist/provider.integrity.json'].sort();
    assert.deepEqual(actual, expected);
    assert.equal(actual.some(file => /(^|\/)(?:src|node_modules|__pycache__|\.cache)(\/|$)/u.test(file)), false);
    assert.equal(actual.some(file => /\.(?:onnx|safetensors|gguf|pt|pth|bin)$/u.test(file)), false);
    for (const file of actual) {
      assert.deepEqual(await fs.readFile(path.join(stagedRoot, file)), await fs.readFile(path.join(definition.packageRoot, file)));
    }
  }
});
