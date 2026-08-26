import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DKB_CONFIG_FORMAT, resolveContextConfig } from '../dist/src/providers/config.js';
import { DkbProviderHost, pluginPath } from '../dist/src/providers/host.js';
import { addPlugin, linkPlugin, listPlugins, removePlugin, setPipelineTarget } from '../dist/src/providers/management.js';

const allPlugin = {
  id: '@test/all',
  version: '1.0.0',
  setup(context) {
    context.registerProvider({ kind: 'ingestion', async compile() { return { records: [], receipt: { providerId: '@test/all', providerVersion: '1.0.0', build: {} } }; } });
    context.registerProvider({
      kind: 'embedding',
      async embedDocuments({ texts }) { return texts.map(() => [1]); },
      async embedQuery() { return [1]; },
      compatibility() { return { dimensions: 1, metric: 'cosine' }; },
    });
    context.registerProvider({ kind: 'index', mode: 'packaged' });
    context.registerProvider({ kind: 'retrieval' });
  },
};

test('context configuration merges bundled, global, and local targets deterministically', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-config-'));
  const globalRoot = path.join(root, 'global');
  const contextRoot = path.join(root, 'library');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeJson(path.join(globalRoot, 'config.json'), {
    format: DKB_CONFIG_FORMAT,
    targets: {
      default: {
        embedding: '@test/all',
        index: '@test/all',
        retrieval: '@test/all',
        ingestion: '@test/all',
        processors: ['@test/global-processor'],
        options: { '@test/all': { shared: 'global', nested: { one: 1 } } },
      },
    },
  });
  await writeJson(path.join(contextRoot, '.dkb/config.json'), {
    format: DKB_CONFIG_FORMAT,
    targets: {
      default: {
        processors: [],
        options: { '@test/all': { local: true, nested: { two: 2 } } },
      },
    },
  });

  const resolved = await resolveContextConfig(contextRoot, { globalRoot });

  assert.deepEqual(resolved.target.processors, []);
  assert.deepEqual(resolved.target.options['@test/all'], {
    shared: 'global',
    local: true,
    nested: { one: 1, two: 2 },
  });
});

test('provider configuration rejects inline secrets and accepts environment references', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-secrets-'));
  const contextRoot = path.join(root, 'library');
  const configPath = path.join(contextRoot, '.dkb/config.json');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = targetConfig('@test/all');
  config.targets.default.options = { '@test/all': { apiKey: 'must-not-live-here' } };
  await writeJson(configPath, config);

  await assert.rejects(resolveContextConfig(contextRoot, { globalRoot: path.join(root, 'global') }), /cannot store apiKey/i);

  config.targets.default.options = { '@test/all': { apiKeyEnv: 'TEST_PROVIDER_API_KEY' } };
  await writeJson(configPath, config);
  const resolved = await resolveContextConfig(contextRoot, { globalRoot: path.join(root, 'global') });
  assert.equal(resolved.target.options['@test/all'].apiKeyEnv, 'TEST_PROVIDER_API_KEY');
});

test('provider host loads only selected plugins and prefers a local override', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-precedence-'));
  const globalRoot = path.join(root, 'global');
  const contextRoot = path.join(root, 'library');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeAllPlugin(pluginPath(path.join(globalRoot, 'plugins'), '@test/all'), '2.0.0', 'global');
  await writeAllPlugin(pluginPath(path.join(contextRoot, '.dkb/plugins'), '@test/all'), '3.0.0', 'local');
  await writeJson(path.join(contextRoot, '.dkb/config.json'), targetConfig('@test/all'));
  await fs.mkdir(path.dirname(pluginPath(path.join(contextRoot, '.dkb/plugins'), '@test/unselected')), { recursive: true });
  await fs.writeFile(pluginPath(path.join(contextRoot, '.dkb/plugins'), '@test/unselected'), 'throw new Error("must not load");\n', 'utf8');

  const host = await DkbProviderHost.create({ root: contextRoot, globalRoot, bundled: [allPlugin] });
  t.after(() => host.dispose());
  const description = host.describe();

  assert.equal(description.providers.length, 4);
  assert.ok(description.providers.every((provider) => provider.version === '3.0.0'));
  assert.ok(description.providers.every((provider) => provider.source === 'local'));
  assert.deepEqual(await host.provider('embedding').embedQuery({ text: 'query', options: {} }), [3]);
});

test('local plugin code drift changes the provider build digest even when version is unchanged', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-drift-'));
  const globalRoot = path.join(root, 'global');
  const contextRoot = path.join(root, 'library');
  const entrypoint = pluginPath(path.join(contextRoot, '.dkb/plugins'), '@test/all');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeAllPlugin(entrypoint, '1.0.0', 'first');
  await writeJson(path.join(contextRoot, '.dkb/config.json'), targetConfig('@test/all'));
  const first = await DkbProviderHost.create({ root: contextRoot, globalRoot, bundled: [allPlugin] });
  const firstDigest = first.describe().buildDigest;
  await first.dispose();

  await fs.writeFile(path.join(path.dirname(entrypoint), 'implementation.txt'), 'changed', 'utf8');
  const second = await DkbProviderHost.create({ root: contextRoot, globalRoot, bundled: [allPlugin] });
  t.after(() => second.dispose());
  assert.notEqual(second.describe().buildDigest, firstDigest);
});

test('a broken local override fails instead of falling back', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-invalid-'));
  const globalRoot = path.join(root, 'global');
  const contextRoot = path.join(root, 'library');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeAllPlugin(pluginPath(path.join(globalRoot, 'plugins'), '@test/all'), '2.0.0', 'global');
  const local = pluginPath(path.join(contextRoot, '.dkb/plugins'), '@test/all');
  await fs.mkdir(path.dirname(local), { recursive: true });
  await fs.writeFile(local, 'export const id = "@test/wrong"; export const version = "1"; export function setup() {}\n', 'utf8');
  await writeJson(path.join(contextRoot, '.dkb/config.json'), targetConfig('@test/all'));

  await assert.rejects(
    DkbProviderHost.create({ root: contextRoot, globalRoot, bundled: [allPlugin] }),
    /Invalid plugin.*expected exports id=@test\/all/i,
  );
});

test('processor order is deterministic and hosts dispose independently', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-processors-'));
  const globalRoot = path.join(root, 'global');
  const firstRoot = path.join(root, 'first');
  const secondRoot = path.join(root, 'second');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const processor = (id, suffix) => ({
    id,
    version: '1.0.0',
    setup(context) {
      context.registerProcessor({
        id,
        version: '1.0.0',
        stage: 'record',
        mutate(value) { return { ...value, text: `${value.text}${suffix}` }; },
      });
    },
  });
  const bundled = [allPlugin, processor('@test/first', '-first'), processor('@test/second', '-second')];
  await writeJson(path.join(firstRoot, '.dkb/config.json'), targetConfig('@test/all', ['@test/first', '@test/second']));
  await writeJson(path.join(secondRoot, '.dkb/config.json'), targetConfig('@test/all', ['@test/second']));
  const first = await DkbProviderHost.create({ root: firstRoot, globalRoot, bundled });
  const second = await DkbProviderHost.create({ root: secondRoot, globalRoot, bundled });
  t.after(() => Promise.all([first.dispose(), second.dispose()]));

  const seed = [{ id: 'r', chunkId: 'c', text: 'seed', metadata: {} }];
  assert.equal((await first.mutate('record', seed))[0].text, 'seed-first-second');
  assert.equal((await second.mutate('record', seed))[0].text, 'seed-second');
  await first.dispose();
  assert.deepEqual(await second.provider('embedding').embedQuery({ text: 'query', options: {} }), [1]);
  assert.throws(() => first.describe(), /disposed/i);
});

test('plugin add, link, list, and guarded removal operate within the selected scope', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-manage-'));
  const library = path.join(root, 'library');
  const globalRoot = path.join(root, 'global');
  const source = path.join(root, 'source');
  const linkedSource = path.join(root, 'linked-source');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writePluginSource(source, '@test/copied', '1.2.3');
  await writePluginSource(linkedSource, '@test/linked', '2.0.0');

  const copied = await addPlugin({ root: library, globalRoot, source });
  const linked = await linkPlugin({ root: library, globalRoot, source: linkedSource, scope: 'global' });
  assert.equal(copied.scope, 'local');
  assert.equal(linked.scope, 'global');
  assert.equal(await fs.readFile(path.join(path.dirname(copied.path), 'helper.txt'), 'utf8'), 'support');
  assert.ok((await fs.lstat(path.dirname(linked.path))).isSymbolicLink());

  const listed = await listPlugins({ root: library, globalRoot });
  assert.ok(listed.some((entry) => entry.id === '@test/copied' && entry.scope === 'local' && entry.valid));
  assert.ok(listed.some((entry) => entry.id === '@test/linked' && entry.scope === 'global' && entry.valid));
  assert.ok(listed.some((entry) => entry.id === '@dkb/faiss' && entry.scope === 'bundled' && entry.selected));

  assert.equal((await removePlugin({ root: library, globalRoot, id: '@test/copied' })).removed, true);
  assert.equal((await removePlugin({ root: library, globalRoot, id: '@test/linked', scope: 'global' })).removed, true);
});

test('pipeline changes validate before atomic promotion and preserve the prior configuration on failure', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-promote-'));
  const library = path.join(root, 'library');
  const globalRoot = path.join(root, 'global');
  const configPath = path.join(library, '.dkb/config.json');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const promoted = await setPipelineTarget({
    root: library,
    globalRoot,
    name: 'default',
    activate: true,
    patch: {
      ingestion: '@dkb/llamaindex',
      embedding: '@dkb/fastembed',
      index: '@dkb/faiss',
      retrieval: '@dkb/hybrid',
      processors: [],
    },
  });
  const before = await fs.readFile(configPath, 'utf8');
  assert.equal(promoted.target, 'default');

  await assert.rejects(setPipelineTarget({
    root: library,
    globalRoot,
    name: 'broken',
    activate: true,
    patch: {
      ingestion: '@missing/ingestion',
      embedding: '@dkb/fastembed',
      index: '@dkb/faiss',
      retrieval: '@dkb/hybrid',
    },
  }), /Selected plugin @missing\/ingestion was not found/);
  assert.equal(await fs.readFile(configPath, 'utf8'), before);
});

function targetConfig(id, processors = []) {
  return {
    format: DKB_CONFIG_FORMAT,
    targets: {
      default: { ingestion: id, embedding: id, index: id, retrieval: id, processors },
    },
  };
}

async function writeJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeAllPlugin(target, version, source) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `
export const id = '@test/all';
export const version = '${version}';
export function setup(context) {
  context.registerProvider({ kind: 'ingestion', async compile() { return { records: [], receipt: { providerId: id, providerVersion: version, build: { source: '${source}' } } }; } });
  context.registerProvider({ kind: 'embedding', async embedDocuments({ texts }) { return texts.map(() => [${Number(version[0])}]); }, async embedQuery() { return [${Number(version[0])}]; }, compatibility() { return { dimensions: 1 }; } });
  context.registerProvider({ kind: 'index', mode: 'packaged' });
  context.registerProvider({ kind: 'retrieval' });
}
`, 'utf8');
}

async function writePluginSource(target, id, version) {
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'helper.txt'), 'support', 'utf8');
  await fs.writeFile(path.join(target, 'plugin.mjs'), `
export const id = '${id}';
export const version = '${version}';
export function setup(context) {
  context.registerProcessor({ id, version, stage: 'record', mutate(value) { return value; } });
}
`, 'utf8');
}
