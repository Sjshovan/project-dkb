import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { DkbProviderHost, pluginPath } from '@sjshovan/dkb-pipeline/host.js';
import { resolveContextConfig } from '@sjshovan/dkb-pipeline/config.js';
import { writeBundledIntegrityReceipt } from '@sjshovan/dkb-pipeline/bundledIntegrity.js';

const id = '@test/integrity';
const defaults = { format: 'dkb.config.v2', targets: { default: { evidence: id, index: id, retrieval: id } } };
const distribution = { id: '@test/distribution', version: '1.0.0', defaults, plugins: [], services: [] };
const source = `export const apiVersion=3; export const id='${id}'; export const version='1.0.0';
export const optionsSchema = {'~standard':{version:1,vendor:'test',validate(value){return {value:value??{}};}}};
export function setup(context) {
  context.registerProvider({kind:'evidence',async compile(){return {records:[],receipt:{build:{}}};}});
  context.registerProvider({kind:'index',mode:'packaged',format:'test.index.v1',capabilities:{vectors:'none'},async compilePackage(){return null;},async validatePackage(){return {documentCount:0};},async verifyRuntime(){return {indexId:'test',documentCount:0,status:'ready'};},async openRuntime(){return null;}});
  context.registerProvider({kind:'retrieval',protocol:'dkb.evidence.v1',capabilities:{vectors:'none'},openRuntime(){return {providerId:id,protocol:'dkb.evidence.v1',async search(){return {hits:[],trace:{}};},close(){}};}});
}`;

function bundledIdentity(bundleId = id) {
  return { apiVersion: 3, id: bundleId, version: '1.0.0', protocols: [], artifactFormats: [] };
}

function bundledSource(bundleId = id, trackSetup = false) {
  return [
    ...(trackSetup ? ["import { appendFileSync } from 'node:fs';"] : []),
    source.replaceAll(id, bundleId),
    'export const PLUGIN = {',
    '  apiVersion, id, version, optionsSchema, sourceUrl: import.meta.url,',
    `  integrity: ${JSON.stringify(bundledIdentity(bundleId))},`,
    trackSetup
      ? "  setup(context) { appendFileSync(new URL('../../setup-count.txt', import.meta.url), '1\\n'); return setup(context); },"
      : '  setup,',
    '};',
    '',
  ].join('\n');
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-dependency-integrity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const entry = pluginPath(path.join(root, '.dkb/plugins'), id);
  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.writeFile(entry, source);
  return { root, entry, packageRoot: path.dirname(entry) };
}
async function json(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); }
async function receipt(root) {
  const host = await DkbProviderHost.create({ root, globalRoot: path.join(root, 'global'), distribution });
  try { return host.providerIntegrity('evidence'); } finally { await host.dispose(); }
}
async function dependency(packageRoot, name, content = 'export const value = 1;') {
  const target = path.join(packageRoot, 'node_modules', name);
  await json(path.join(target, 'package.json'), { name, version: '1.0.0', type: 'module', main: 'index.js', files: ['index.js'] });
  await fs.writeFile(path.join(target, 'index.js'), content);
  return target;
}

test('declared dependency closure is path independent and unrelated installed code and host lock do not affect it', async (t) => {
  const a = await fixture(t);
  const b = await fixture(t);
  for (const item of [a, b]) {
    await json(path.join(item.packageRoot, 'package.json'), { name: id, version: '1.0.0', dependencies: { helper: '1.0.0' } });
    await dependency(item.packageRoot, 'helper');
  }
  const first = await receipt(a.root);
  const second = await receipt(b.root);
  assert.equal(first.dependencyDigest, second.dependencyDigest);
  await dependency(a.packageRoot, 'unrelated', 'export const value = 200;');
  await json(path.join(a.root, 'package-lock.json'), { unrelated: Date.now() });
  assert.equal((await receipt(a.root)).dependencyDigest, first.dependencyDigest);
});

test('changed installed dependency bytes fail closed instead of claiming cached Node code uses a new identity', async (t) => {
  const item = await fixture(t);
  await json(path.join(item.packageRoot, 'package.json'), { name: id, dependencies: { helper: '1.0.0' } });
  const helper = await dependency(item.packageRoot, 'helper');
  await receipt(item.root);
  await fs.writeFile(path.join(helper, 'index.js'), 'export const value = 2;');
  await assert.rejects(receipt(item.root), /changed after it was loaded.*Restart/u);
});

test('relative imports escaping the plugin and undeclared hoisted packages are rejected', async (t) => {
  const outside = await fixture(t);
  await fs.writeFile(path.join(path.dirname(outside.packageRoot), 'outside.mjs'), 'export const value = 1;');
  await fs.writeFile(outside.entry, `import '../outside.mjs';\n${source}`);
  await assert.rejects(receipt(outside.root), /relative import .* escapes its package/u);
  const undeclared = await fixture(t);
  await dependency(undeclared.packageRoot, 'helper');
  await fs.writeFile(undeclared.entry, `import 'helper';\n${source}`);
  await assert.rejects(receipt(undeclared.root), /not a declared runtime dependency/u);
});

test('an existing host rejects same-size code and dependency drift without running setup again', async (t) => {
  for (const changed of ['plugin', 'dependency']) {
    const item = await fixture(t);
    await json(path.join(item.packageRoot, 'package.json'), { name: id, dependencies: { helper: '1.0.0' } });
    const helper = await dependency(item.packageRoot, 'helper');
    const host = await DkbProviderHost.create({ root: item.root, globalRoot: path.join(item.root, 'global'), distribution });
    t.after(() => host.dispose());
    await host.assertCurrent();
    const file = changed === 'plugin' ? item.entry : path.join(helper, 'index.js');
    const before = await fs.stat(file);
    const content = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, content.replace(changed === 'plugin' ? '1.0.0' : '= 1', changed === 'plugin' ? '2.0.0' : '= 2'));
    await fs.utimes(file, before.atime, before.mtime);
    await assert.rejects(host.assertCurrent(), /plugin code, dependency, or plugin precedence changed/u);
  }
});

test('an existing host rejects selected recipe drift but ignores changes to unselected recipes', async (t) => {
  const item = await fixture(t);
  const host = await DkbProviderHost.create({ root: item.root, globalRoot: path.join(item.root, 'global'), distribution });
  t.after(() => host.dispose());
  const file = path.join(item.root, '.dkb/config.json');
  await json(file, { format: 'dkb.config.v2', targets: { unrelated: { evidence: '@other/evidence' } } });
  await host.assertCurrent();
  await json(file, { format: 'dkb.config.v2', targets: { default: { options: { [id]: { changed: true } } } } });
  await assert.rejects(host.assertCurrent(), /configuration changed/u);
});

test('an existing host rejects a newly added higher-precedence override', async (t) => {
  const item = await fixture(t);
  const runtimeRoot = path.join(item.root, 'runtime');
  const host = await DkbProviderHost.create({ root: runtimeRoot, libraryRoot: item.root, globalRoot: path.join(item.root, 'global'), distribution });
  t.after(() => host.dispose());
  await host.assertCurrent();
  const override = pluginPath(path.join(runtimeRoot, '.dkb/plugins'), id);
  await fs.mkdir(path.dirname(override), { recursive: true });
  await fs.writeFile(override, 'broken selected override');
  await assert.rejects(host.assertCurrent(), /plugin code, dependency, or plugin precedence changed/u);
});

test('configuration changes between resolution and host creation cannot become the accepted baseline', async (t) => {
  const item = await fixture(t);
  const config = await resolveContextConfig(item.root, { defaults, globalRoot: path.join(item.root, 'global') });
  await json(path.join(item.root, '.dkb/config.json'), { format: 'dkb.config.v2', targets: { default: { options: { [id]: { changed: true } } } } });
  await assert.rejects(DkbProviderHost.createFromConfig(config, distribution), /configuration changed/u);
});

test('a changed relative helper cannot receive a fresh identity while Node retains its previous module', async (t) => {
  const item = await fixture(t);
  const helper = path.join(item.packageRoot, 'helper.mjs');
  await fs.writeFile(helper, 'export const value=1;');
  await fs.writeFile(item.entry, `import './helper.mjs';\n${source}`);
  await receipt(item.root);
  await fs.writeFile(helper, 'export const value=2;');
  await assert.rejects(receipt(item.root), /helper module changed after it was loaded.*Restart/u);
});

test('an existing directory or dangling link override fails instead of selecting a lower-priority plugin', async (t) => {
  for (const broken of ['directory', 'missing-entry', 'dangling-link']) {
    const item = await fixture(t);
    const runtimeRoot = path.join(item.root, 'runtime');
    const override = pluginPath(path.join(runtimeRoot, '.dkb/plugins'), id);
    await fs.mkdir(path.dirname(override), { recursive: true });
    if (broken === 'directory') await fs.mkdir(override);
    if (broken === 'dangling-link') {
      await fs.rmdir(path.dirname(override));
      await fs.symlink(path.join(item.root, 'missing-plugin-directory'), path.dirname(override), process.platform === 'win32' ? 'junction' : 'dir');
    }
    await assert.rejects(DkbProviderHost.create({ root: runtimeRoot, libraryRoot: item.root, globalRoot: path.join(item.root, 'global'), distribution }), /will not fall back/u);
  }
});

test('bundled receipts cover explicit shipped JSON and Python files, not unrelated package files', async (t) => {
  const hosts = [];
  const receipts = [];
  for (const variant of ['first', 'changed-json', 'changed-python']) {
    const item = await fixture(t);
    const bundle = path.join(item.root, 'bundle');
    const entry = path.join(bundle, 'dist/plugin.mjs');
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.mkdir(path.join(bundle, 'python'));
    await fs.writeFile(entry, bundledSource());
    await fs.writeFile(path.join(bundle, 'python/model.json'), variant === 'changed-json' ? '{"revision":2}' : '{"revision":1}');
    await fs.writeFile(path.join(bundle, 'python/worker.py'), variant === 'changed-python' ? 'value=2' : 'value=1');
    await json(path.join(bundle, 'package.json'), { name: id, version: '1.0.0', type: 'module', files: ['dist/', 'python/'] });
    const plugin = { id, version: '1.0.0', sourceUrl: pathToFileURL(entry).href, exportName: 'PLUGIN' };
    await writeBundledIntegrityReceipt({ packageRoot: bundle, entrypoint: entry, identity: bundledIdentity() });
    const options = { root: path.join(item.root, 'runtime'), globalRoot: path.join(item.root, 'global'), distribution: { ...distribution, plugins: [plugin] } };
    const host = await DkbProviderHost.create(options);
    hosts.push(host);
    t.after(() => host.dispose());
    receipts.push(host.providerIntegrity('evidence'));
    if (variant === 'first') {
      await fs.writeFile(path.join(bundle, 'unshipped-notes.txt'), 'unrelated file');
      const unchanged = await DkbProviderHost.create(options);
      try { assert.equal(unchanged.providerIntegrity('evidence').filesDigest, receipts[0].filesDigest); } finally { await unchanged.dispose(); }
      await fs.writeFile(path.join(bundle, 'python/worker.py'), 'value=2');
      await assert.rejects(host.assertCurrent(), /plugin code, dependency, or plugin precedence changed/u);
      await assert.rejects(DkbProviderHost.create(options), /integrity receipt does not match/u);
    }
  }
  assert.notEqual(receipts[0].filesDigest, receipts[1].filesDigest);
  assert.notEqual(receipts[0].filesDigest, receipts[2].filesDigest);
});

async function executableBundle(t, bundleId = id) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-bundled-integrity-host-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'bundle');
  const entrypoint = path.join(packageRoot, 'dist', 'plugin.mjs');
  await fs.mkdir(path.dirname(entrypoint), { recursive: true });
  await fs.writeFile(entrypoint, bundledSource(bundleId, true));
  await json(path.join(packageRoot, 'package.json'), { name: bundleId, version: '1.0.0', type: 'module', files: ['dist/'] });
  const descriptor = {
    id: bundleId,
    version: '1.0.0',
    sourceUrl: pathToFileURL(entrypoint).href,
    exportName: 'PLUGIN',
  };
  return {
    root, packageRoot, entrypoint, descriptor,
    setupCalls: async () => {
      try { return (await fs.readFile(path.join(root, 'setup-count.txt'), 'utf8')).trim().split('\n').length; }
      catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
    },
    writeReceipt: () => writeBundledIntegrityReceipt({ packageRoot, entrypoint, identity: bundledIdentity(bundleId) }),
  };
}

test('production host rejects missing or stale bundled receipts before running setup', async (t) => {
  const bundle = await executableBundle(t);
  const options = {
    root: path.join(bundle.root, 'runtime'), globalRoot: path.join(bundle.root, 'global'),
    distribution: { ...distribution, plugins: [bundle.descriptor] },
  };
  await assert.rejects(DkbProviderHost.create(options), /integrity receipt/iu);
  assert.equal(await bundle.setupCalls(), 0);

  await bundle.writeReceipt();
  await fs.appendFile(bundle.entrypoint, '\n// changed after receipt generation\n');
  await assert.rejects(DkbProviderHost.create(options), /integrity receipt/iu);
  assert.equal(await bundle.setupCalls(), 0);
});

test('unselected bundles with missing or stale receipts cannot block a valid selected Pipeline', async (t) => {
  for (const brokenState of ['missing', 'stale']) {
    const selected = await executableBundle(t);
    const unselected = await executableBundle(t, '@test/unselected-bundle');
    await selected.writeReceipt();
    if (brokenState === 'stale') {
      await unselected.writeReceipt();
      await fs.appendFile(unselected.entrypoint, '\n// stale unselected bundle\n');
    }
    const host = await DkbProviderHost.create({
      root: path.join(selected.root, 'runtime'), globalRoot: path.join(selected.root, 'global'),
      distribution: { ...distribution, plugins: [selected.descriptor, unselected.descriptor] },
    });
    t.after(() => host.dispose());
    assert.equal(await selected.setupCalls(), 1, brokenState);
    assert.equal(await unselected.setupCalls(), 0, brokenState);
    assert.ok(host.describe().providers.every((provider) => provider.id === id), brokenState);
  }
});
