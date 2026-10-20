import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { observeInstalledPackageIntegrity } from '@sjshovan/dkb-pipeline/packageIntegrity.js';
import { DkbProviderHost } from '@sjshovan/dkb-pipeline/host.js';
import { describeResolvedProviderCapabilities, resolvedProviderServices } from '@sjshovan/dkb-pipeline/capabilities.js';
import { resolveRegistryCompilerCatalog } from '@sjshovan/dkb-compiler/registryTargets.js';
import { registryCompilerCapabilities } from '../services/compiler/dist/compilerCapabilities.js';
import { materializeBundledProviderFixtures } from './bundled-provider-fixture.mjs';

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-compiler-capabilities-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeJson(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, JSON.stringify(value));
}

async function installedPackage(root) {
  await writeJson(path.join(root, 'package.json'), { name: '@test/compiler', version: '1.0.0', type: 'module', files: ['dist/'], dependencies: { 'fixture-dependency': '1.0.0' } });
  await fs.mkdir(path.join(root, 'dist'), { recursive: true });
  await fs.writeFile(path.join(root, 'dist', 'index.js'), 'export const value = 1;\n');
  const dependency = path.join(root, 'node_modules', 'fixture-dependency');
  await writeJson(path.join(dependency, 'package.json'), { name: 'fixture-dependency', version: '1.0.0', main: 'index.js', files: ['index.js'] });
  await fs.writeFile(path.join(dependency, 'index.js'), 'module.exports = 1;\n');
}

test('installed compiler identity is path-independent and freezes shipped code and declared dependency bytes', async (t) => {
  const root = await directory(t);
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  await installedPackage(first);
  await installedPackage(second);
  const a = await observeInstalledPackageIntegrity(first);
  const b = await observeInstalledPackageIntegrity(second);
  assert.deepEqual(a.identity, b.identity);
  assert.equal(a.identity.kind, 'observed-installed');
  assert.equal(a.identity.packageVersion, '1.0.0');
  await a.assertCurrent();
  await fs.writeFile(path.join(first, 'dist', 'index.js'), 'export const value = 2;\n');
  await assert.rejects(a.assertCurrent(), /changed after process bootstrap.*Restart/i);
  await fs.writeFile(path.join(second, 'node_modules', 'fixture-dependency', 'index.js'), 'module.exports = 2;\n');
  await assert.rejects(b.assertCurrent(), /changed after process bootstrap.*Restart/i);
});

test('installed compiler identity rejects missing allowlists and new shipped files after boot', async (t) => {
  const root = await directory(t);
  await installedPackage(root);
  const observed = await observeInstalledPackageIntegrity(root);
  await fs.writeFile(path.join(root, 'dist', 'new-helper.js'), 'export const value = 1;\n');
  await assert.rejects(observed.assertCurrent(), /changed after process bootstrap/i);
  const missing = path.join(root, 'missing');
  await writeJson(path.join(missing, 'package.json'), { name: 'missing', version: '1.0.0' });
  await assert.rejects(observeInstalledPackageIntegrity(missing), /explicit shipped-file allowlist/i);
});

const id = '@test/capability';
const schema = { '~standard': { version: 1, vendor: 'test', validate(value) { return { value }; } } };
async function distribution(t) {
  return materializeBundledProviderFixtures(t, {
    id: '@test/distribution', version: '1.0.0',
    defaults: { format: 'dkb.config.v2', activeTarget: 'renamed', targets: { renamed: { evidence: id, index: id, retrieval: id } } },
    plugins: [{
      apiVersion: 3, id, version: '1.0.0', sourceUrl: import.meta.url, optionsSchema: schema,
      integrity: { apiVersion: 3, id, version: '1.0.0', protocols: ['test.evidence.v1'], artifactFormats: ['test.index.v1'] },
      setup(context) {
        context.registerProvider({ kind: 'evidence', async compile() { return { records: [], receipt: { build: {} } }; }, health() { return { ok: true }; } });
        context.registerProvider({ kind: 'index', mode: 'packaged', format: 'test.index.v1', capabilities: { vectors: 'none' }, async compilePackage() { return { build: {} }; }, async validatePackage() { return { documentCount: 0 }; }, async verifyRuntime() { return { indexId: 'test', documentCount: 0, status: 'ready' }; }, async openRuntime() { return null; }, health() { return { ok: true }; } });
        context.registerProvider({ kind: 'retrieval', protocol: 'test.evidence.v1', capabilities: { vectors: 'none' }, async openRuntime() { return { providerId: id, protocol: 'test.evidence.v1', async search() { return { hits: [], trace: {} }; }, async close() {} }; }, health() { return { ok: true }; } });
      },
    }],
    services: [
      { id: 'selected-worker', kind: 'docker', providerId: id, requiredBy: ['old-label'] },
      { id: 'unselected-worker', kind: 'docker', providerId: '@test/unused', requiredBy: ['renamed'] },
      { id: 'unrelated-infrastructure', kind: 'docker', requiredBy: ['renamed'] },
    ],
  });
}

test('compiler envelope exposes exact full receipts and origin-resolved services after target rename', async (t) => {
  const root = await directory(t);
  const previousAllowed = process.env.DKB_COMPILER_ALLOWED_TARGETS;
  const previousDefault = process.env.DKB_COMPILER_DEFAULT_TARGET;
  process.env.DKB_COMPILER_ALLOWED_TARGETS = 'renamed';
  process.env.DKB_COMPILER_DEFAULT_TARGET = 'renamed';
  t.after(() => {
    if (previousAllowed === undefined) delete process.env.DKB_COMPILER_ALLOWED_TARGETS; else process.env.DKB_COMPILER_ALLOWED_TARGETS = previousAllowed;
    if (previousDefault === undefined) delete process.env.DKB_COMPILER_DEFAULT_TARGET; else process.env.DKB_COMPILER_DEFAULT_TARGET = previousDefault;
  });
  const result = await registryCompilerCapabilities(await distribution(t), root);
  assert.equal(result.format, 'dkb.compiler-capabilities.v1');
  assert.equal(result.compiler.kind, 'observed-installed');
  assert.match(result.compiler.buildDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.compiler.packageVersion, result.version);
  assert.equal(result.defaultTarget, 'renamed');
  assert.deepEqual(result.allowedTargets[0].requiredServices, ['selected-worker']);
  assert.deepEqual(result.allowedTargets[0].chains, { evidence: [id], embedding: null, index: id, retrieval: id, processors: { document: [], chunk: [], record: [] } });
  for (const provider of result.allowedTargets[0].providers) {
    assert.equal(provider.integrity.id, id);
    assert.match(provider.integrity.filesDigest, /^sha256:/);
    assert.match(provider.integrity.dependencyDigest, /^sha256:/);
    assert.equal(provider.sourcePath, undefined);
    assert.equal(provider.options, undefined);
  }
  assert.equal(result.contextRoot, undefined);
});

test('same-ID local provider replacement declares its own services instead of inheriting the bundle', async (t) => {
  const root = await directory(t);
  const fixture = await distribution(t);
  const pluginPath = path.join(root, '.dkb/plugins/@test/capability/plugin.mjs');
  await fs.mkdir(path.dirname(pluginPath), { recursive: true });
  await fs.writeFile(pluginPath, `
export const apiVersion=3; export const id='${id}'; export const version='1.0.0';
export const optionsSchema={'~standard':{version:1,vendor:'test',validate(value){return {value};}}};
export function setup(context){
context.registerProvider({kind:'evidence',serviceRequirements:[{id:'custom-parser',kind:'remote'}],async compile(){return {records:[],receipt:{build:{}}};}});
context.registerProvider({kind:'index',mode:'packaged',format:'test.index.v1',capabilities:{vectors:'none'},async compilePackage(){return {build:{}};},async validatePackage(){return {documentCount:0};},async verifyRuntime(){return {indexId:'test',documentCount:0,status:'ready'};},async openRuntime(){return null;}});
context.registerProvider({kind:'retrieval',protocol:'test.evidence.v1',capabilities:{vectors:'none'},async openRuntime(){return {providerId:id,protocol:'test.evidence.v1',async search(){return {hits:[],trace:{}};},async close(){}};}});
}`);
  const host = await DkbProviderHost.create({ root, globalRoot: path.join(root, 'global'), distribution: fixture });
  t.after(() => host.dispose());
  assert.deepEqual(resolvedProviderServices(host, fixture).map((item) => [item.id, item.source]), [['custom-parser', 'local']]);
  assert.deepEqual(resolvedProviderServices(host, fixture, ['index', 'retrieval']), []);
  assert.equal(describeResolvedProviderCapabilities(host).providers[0].source, 'local');
});

test('provider service declarations reject URLs, secret-bearing metadata, and duplicate requirements', async (t) => {
  for (const requirements of [[{ id: 'https://user:secret@host', kind: 'remote' }], [{ id: 'worker', kind: 'remote', token: 'secret' }], [{ id: 'worker', kind: 'remote' }, { id: 'worker', kind: 'docker' }]]) {
    const root = await directory(t);
    const fixture = await distribution(t);
    const pluginPath = path.join(root, '.dkb/plugins/@test/capability/plugin.mjs');
    await fs.mkdir(path.dirname(pluginPath), { recursive: true });
    await fs.writeFile(pluginPath, `export const apiVersion=3;export const id='${id}';export const version='1.0.0';export const optionsSchema={'~standard':{version:1,vendor:'test',validate(value){return {value};}}};export function setup(context){context.registerProvider({kind:'evidence',serviceRequirements:${JSON.stringify(requirements)},async compile(){return {records:[],receipt:{build:{}}};}});}`);
    await assert.rejects(DkbProviderHost.create({ root, globalRoot: path.join(root, 'global'), distribution: fixture }), /serviceRequirements/i);
  }
});
