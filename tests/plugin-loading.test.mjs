import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { DkbProviderHost } from '@sjshovan/dkb-pipeline/host.js';
import { importPluginModule, normalizePluginModule } from '@sjshovan/dkb-pipeline/pluginModule.js';
import { runPluginConformance } from '@sjshovan/dkb-pipeline/testing.js';
import { verifyPluginPath, testPluginPath } from '../apps/cli/dist/providers/verification.js';
import { addPlugin, listPlugins } from '../apps/cli/dist/providers/management.js';

const sdkSpecifier = '@sjshovan/dkb-pipeline/sdk.js';
const pluginId = '@test/module-exports';
const distribution = {
  id: '@test/distribution', version: '1.0.0', plugins: [], services: [],
  defaults: {
    format: 'dkb.config.v2', activeTarget: 'lexical',
    targets: { lexical: { evidence: pluginId, index: pluginId, retrieval: pluginId } },
  },
};

function definitionSource(style) {
  return `import { definePlugin, emptyOptionsSchema } from ${JSON.stringify(sdkSpecifier)};
const definition = definePlugin({
  apiVersion: 3, id: '${pluginId}', version: '1.0.0', optionsSchema: emptyOptionsSchema,
  setup(context) {
    context.registerProvider({ kind: 'evidence', async compile() { return { records: [], receipt: { build: {} } }; } });
    context.registerProvider({ kind: 'index', mode: 'packaged', format: 'test.lexical.v1', capabilities: { vectors: 'none' }, async compilePackage() { return null; }, async validatePackage() { return { documentCount: 0 }; }, async verifyRuntime() { return { indexId: 'test', documentCount: 0, status: 'ready' }; }, async openRuntime() { return null; } });
    context.registerProvider({ kind: 'retrieval', protocol: 'dkb.evidence.v1', capabilities: { vectors: 'none' }, openRuntime() { return { providerId: '${pluginId}', protocol: 'dkb.evidence.v1', async search() { return { hits: [], trace: {} }; }, close() {} }; } });
  },
});
${style === 'named' ? 'export const { apiVersion, id, version, optionsSchema, setup } = definition;' : 'export default definition;'}
${style === 'conflict' ? 'export const id = definition.id;' : ''}
`;
}

async function prepareSdkDependency(root) {
  const scope = path.join(root, 'node_modules', '@sjshovan');
  await fs.mkdir(scope, { recursive: true });
  await fs.symlink(path.resolve('packages/pipeline'), path.join(scope, 'dkb-pipeline'), 'junction');
}

async function writePluginManifest(root) {
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: pluginId, version: '1.0.0', type: 'module', files: ['plugin.mjs'],
    peerDependencies: { '@sjshovan/dkb-pipeline': '*' },
  }));
}

test('named and default filesystem definitions share host, CLI inspection, and installation loading', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-plugin-loader-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await prepareSdkDependency(root);
  for (const style of ['named', 'default']) {
    const contextRoot = path.join(root, style);
    const pluginRoot = path.join(contextRoot, '.dkb', 'plugins', '@test', 'module-exports');
    await fs.mkdir(pluginRoot, { recursive: true });
    const entrypoint = path.join(pluginRoot, 'plugin.mjs');
    await writePluginManifest(pluginRoot);
    await fs.writeFile(entrypoint, definitionSource(style));
    assert.equal((await importPluginModule(entrypoint, { contextRoot })).id, pluginId);
    assert.equal((await verifyPluginPath(pluginRoot)).plugin.id, pluginId);
    const host = await DkbProviderHost.create({ root: contextRoot, globalRoot: path.join(root, 'global'), distribution });
    try { assert.equal(host.provider('index').format, 'test.lexical.v1'); } finally { await host.dispose(); }
    const destination = path.join(root, `${style}-installed`);
    const installed = await addPlugin({ source: pluginRoot, root: destination, globalRoot: path.join(root, 'global') });
    assert.equal(installed.id, pluginId);
    const listing = await listPlugins({ root: destination, globalRoot: path.join(root, 'global'), distribution });
    assert.equal(listing.find((entry) => entry.id === pluginId)?.valid, true);
  }
});

test('ambiguous default and named API exports fail closed in the shared loader, CLI, and selected host', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-plugin-conflicting-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await prepareSdkDependency(root);
  const pluginRoot = path.join(root, '.dkb', 'plugins', '@test', 'module-exports');
  await fs.mkdir(pluginRoot, { recursive: true });
  const entrypoint = path.join(pluginRoot, 'plugin.mjs');
  await fs.writeFile(entrypoint, definitionSource('conflict'));
  await assert.rejects(importPluginModule(entrypoint, { contextRoot: root }), /either one default definition or named API fields, not both/u);
  await assert.rejects(verifyPluginPath(pluginRoot), /not both/u);
  await assert.rejects(DkbProviderHost.create({ root, globalRoot: path.join(root, 'global'), distribution }), /Failed to load selected plugin.*not both/u);
  await assert.rejects(addPlugin({ source: pluginRoot, root: path.join(root, 'destination'), globalRoot: path.join(root, 'global') }), /not both/u);
});

test('plugin verify inspects definition and defaults without invoking setup or provider methods', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-plugin-definition-only-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await prepareSdkDependency(root);
  await fs.writeFile(path.join(root, 'plugin.mjs'), `
export const apiVersion = 3;
export const id = '@test/definition-only';
export const version = '1.0.0';
export const optionsSchema = { '~standard': { version: 1, vendor: 'test', validate() { return { value: { dimensions: 2 } }; } } };
export function setup() { throw new Error('setup must not run while verifying a definition'); }
`);
  const result = await verifyPluginPath(root);
  assert.equal(result.ok, true);
  assert.equal(result.setupExecuted, false);
  assert.equal(result.checks.find((entry) => entry.name === 'Runtime contracts').status, 'skipped');
  await assert.rejects(testPluginPath(root), /setup must not run/u);
});

test('filesystem entry imports are content-addressed even when size and timestamps are restored', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-plugin-entry-drift-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await prepareSdkDependency(root);
  const entrypoint = path.join(root, 'plugin.mjs');
  const original = definitionSource('named');
  await fs.writeFile(entrypoint, original);
  const timestamp = new Date('2026-01-01T00:00:00.000Z');
  await fs.utimes(entrypoint, timestamp, timestamp);
  const originalStat = await fs.stat(entrypoint);
  const first = await importPluginModule(entrypoint, { contextRoot: root });
  assert.equal(first.version, '1.0.0');

  await fs.writeFile(entrypoint, original.replace("version: '1.0.0'", "version: '1.0.1'"));
  await fs.utimes(entrypoint, originalStat.atime, originalStat.mtime);
  const updatedStat = await fs.stat(entrypoint);
  assert.equal(updatedStat.size, originalStat.size);
  assert.equal(updatedStat.mtimeMs, originalStat.mtimeMs);
  const second = await importPluginModule(entrypoint, { contextRoot: root });
  assert.equal(second.version, '1.0.1');
  assert.notEqual(first, second);
});

test('documented default definePlugin export passes CLI and SDK conformance directly from a filesystem namespace', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-plugin-default-conformance-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await prepareSdkDependency(root);
  const entrypoint = path.join(root, 'plugin.mjs');
  await fs.writeFile(entrypoint, `import { definePlugin, defineQueryObserver, emptyOptionsSchema } from ${JSON.stringify(sdkSpecifier)};
export default definePlugin({ apiVersion: 3, id: '@test/default-observer', version: '1.0.0', optionsSchema: emptyOptionsSchema, setup(context) { context.registerQueryObserver(defineQueryObserver({ id: '@test/default-observer', version: '1.0.0', observe() {} })); } });
export const helper = 'non-definition exports are inert';
`);
  const namespace = await import(pathToFileURL(entrypoint).href);
  assert.equal((await runPluginConformance(namespace)).ok, true);
  assert.equal((await testPluginPath(root)).ok, true);
  assert.throws(() => normalizePluginModule({ ...namespace, apiVersion: 3 }), /not both/u);
  assert.throws(() => normalizePluginModule({ default: null }), /plugin API v3/u);
});
