import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Command } from 'commander';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { applyLibraryLock } from '@sjshovan/dkb-library/state.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbRegistryClient } from '@sjshovan/dkb-registry-client/client.js';
import { registerKnowledgeCommands } from '../apps/cli/dist/cli/knowledgeCommands.js';
import { consoleCommand } from '../apps/console/dist/server/commandCatalog.js';

test('Console publication accepts exact registered resources and cannot submit paths, code, or public flags', () => {
  const command = consoleCommand('package.publish');
  const input = { library: 'author', identity: '@test/knowledge', url: 'https://registry.example.test', pipeline: 'lexical' };
  const parsed = command.parse(input);
  assert.deepEqual(command.argv(parsed), ['publish', '--installed', '@test/knowledge', '--library', 'author', '--url', 'https://registry.example.test', '--pipeline', 'lexical']);
  assert.equal(command.mutation, true);
  assert.equal(command.resourceKey(parsed), 'library:author');
  for (const value of [{ ...input, path: '../source' }, { ...input, public: true }, { ...input, force: true }, { ...input, pipeline: '--execute' }, { ...input, library: 'C:/private' }, { ...input, url: 'https://user:secret@example.test' }, { ...input, identity: 'x;rm' }]) assert.throws(() => command.parse(value));
});

test('Console build verification is read-only and requires an exact build identity', () => {
  const command = consoleCommand('package.build.verify');
  const input = { library: 'author', identity: '@test/knowledge', buildDigest: `sha256:${'a'.repeat(64)}` };
  assert.equal(command.mutation, false);
  assert.deepEqual(command.argv(command.parse(input)), ['show', '@test/knowledge', '--library', 'author', '--verify-build', input.buildDigest]);
  assert.throws(() => command.parse({ ...input, buildDigest: '../../secrets' }));
  assert.throws(() => command.parse({ ...input, trusted: true }));
});

test('Build trust UI never infers Registry verification from package receipt presence', async () => {
  const source = await fs.readFile(new URL('../apps/console/src/web/components/resource/BuildChain.vue', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /installChainStatus\s*===\s*['"]present/);
  assert.match(source, /result\?\.status === 'registry-verified'/);
  assert.match(source, /package\.build\.verify/);
  const publish = await fs.readFile(new URL('../apps/console/src/web/components/resource/PublishKnowledgeDrawer.vue', import.meta.url), 'utf8');
  assert.match(publish, /RegistryPipelinePicker/);
  assert.match(publish, /selected\.value\?\.available/);
  assert.match(publish, /Publish source/);
  assert.match(publish, /New packages are private.*existing package retains its Registry visibility/);
  assert.doesNotMatch(publish, /\bfetch\(/);
});

test('publication resolves an editable installed DKB and rejects a Registry-origin source before uploading', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-console-publication-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'knowledge');
  await fs.mkdir(packageRoot);
  await fs.writeFile(path.join(root, 'dkb.json'), JSON.stringify({ type: 'library', name: 'Author', roots: { '@test/knowledge': { path: 'knowledge' } } }));
  await fs.writeFile(path.join(packageRoot, 'dkb.json'), JSON.stringify({ manifestVersion: 1, type: 'dkb', name: '@test/knowledge', version: '1.0.0', permissions: { read: true, write: false } }));
  await fs.writeFile(path.join(packageRoot, 'readme.md'), 'Local editable source.');
  const lock = { library: { name: 'Author' }, generation: 1, resolvedAt: '2026-09-03T00:00:00.000Z', entries: { '@test/knowledge': { identity: '@test/knowledge', kind: 'dkb', source: 'local', version: '1.0.0', digest: stableHash({ test: 1 }), path: 'knowledge', requiredBy: ['root:@test/knowledge'], installedAt: '2026-09-03T00:00:00.000Z' } } };
  await applyLibraryLock(root, lock);
  const previousConfig = process.env.DKB_CLI_CONFIG;
  process.env.DKB_CLI_CONFIG = path.join(root, 'cli.json');
  const previousPublish = DkbRegistryClient.prototype.publish;
  let uploaded;
  DkbRegistryClient.prototype.publish = async function (input) { uploaded = input; return { packageId: '@test/knowledge', version: '1.0.0' }; };
  t.after(() => { DkbRegistryClient.prototype.publish = previousPublish; if (previousConfig === undefined) delete process.env.DKB_CLI_CONFIG; else process.env.DKB_CLI_CONFIG = previousConfig; });
  const program = new Command().exitOverride();
  registerKnowledgeCommands(program, program.command('runtime'), { currentLibraryRoot: async () => root, presenter: () => ({ run: async (_label, action) => action() }), parsePositiveInteger: Number, parseLimit: Number });
  const args = ['publish', '--installed', '@test/knowledge', '--library', 'author', '--url', 'http://127.0.0.1:1', '--pipeline', 'lexical'];
  await program.parseAsync(args, { from: 'user' });
  assert.equal(uploaded.sourcePath, packageRoot);
  assert.equal(uploaded.pipeline, 'lexical');
  assert.equal(uploaded.visibility, 'private');
  assert.equal(uploaded.force, false);
  lock.generation = 2; lock.entries['@test/knowledge'].source = 'registry'; lock.entries['@test/knowledge'].registryUrl = 'https://registry.example.test';
  await applyLibraryLock(root, lock);
  uploaded = undefined;
  await assert.rejects(program.parseAsync(args, { from: 'user' }), /Only an editable local DKB/);
  assert.equal(uploaded, undefined);
});

test('publication and exact-build trust components compile with existing accessible primitives', async () => {
  for (const file of ['RegistryPipelinePicker.vue', 'PublishKnowledgeDrawer.vue', 'BuildChain.vue', 'BuildDetailsDrawer.vue', 'StoredBuildDataTable.vue', 'RegistryPipelineDataTable.vue', 'RegistryPipelineDetailsDrawer.vue']) {
    const url = new URL(`../apps/console/src/web/components/resource/${file}`, import.meta.url);
    const { descriptor, errors } = parse(await fs.readFile(url, 'utf8'), { filename: url.pathname });
    assert.deepEqual(errors, []);
    const script = compileScript(descriptor, { id: 'publication-test' });
    const template = compileTemplate({ source: descriptor.template.content, filename: url.pathname, id: 'publication-test', compilerOptions: { bindingMetadata: script.bindings } });
    assert.deepEqual(template.errors, [], file);
  }
});

test('Registry Pipeline tables search complete names, health states, and digests', async () => {
  const row = { name: 'renamed-recipe', available: true, default: true, providers: [], requiredServices: [], compatibilityDigest: `sha256:${'a'.repeat(64)}` };
  const table = await componentSetup('RegistryPipelineDataTable.vue', { rows: [row] });
  for (const [name, expected] of [['name', row.name], ['availability', 'available'], ['compatibility', row.compatibilityDigest]]) {
    const column = table.columns.value.find((item) => item.name === name);
    const cell = column.data === null ? row : typeof column.data === 'function' ? column.data(row) : row[column.data];
    for (const type of ['filter', 'sort', 'type']) {
      const actual = typeof column.render === 'function' ? column.render(cell, type, row) : typeof column.render._ === 'function' ? column.render._(cell, type, row) : cell[column.render._];
      assert.equal(actual, expected, `${name}:${type}`);
    }
  }
});

test('unresolved Registry recipes render unknown identity instead of zero services or a fake digest', async () => {
  const row = { name: 'optional', available: false, default: false, providers: [], processors: [], requiredServices: [], compatibilityDigest: null, resolutionError: { code: 'pipeline_resolution_failed', message: 'Registry operator action required.' } };
  const table = await componentSetup('RegistryPipelineDataTable.vue', { rows: [row] });
  for (const name of ['providers', 'services']) assert.equal(table.columns.value.find((column) => column.name === name).data(row), 'Not resolved');
  const compatibility = table.columns.value.find((column) => column.name === 'compatibility');
  for (const type of ['display', 'filter', 'sort']) assert.equal(compatibility.render(null, type), 'Not resolved');
  const source = await fs.readFile(new URL('../apps/console/src/web/components/resource/RegistryPipelineDetailsDrawer.vue', import.meta.url), 'utf8');
  assert.match(source, /v-if="pipeline.resolutionError"/);
  assert.match(source, /Recipe identity unavailable/);
  assert.match(source, /cannot be selected for compilation/);
  const picker = await fs.readFile(new URL('../apps/console/src/web/components/resource/RegistryPipelinePicker.vue', import.meta.url), 'utf8');
  assert.match(picker, /Service requirements not resolved/);
  assert.match(picker, /v-if="item.resolutionError"/);
  const selection = await componentSetup('RegistryPipelinePicker.vue', { modelValue: row.name, pipelines: [row], inputId: 'fixture' });
  selection.choose(row.name);
  assert.equal(selection.selected.value.resolutionError.code, 'pipeline_resolution_failed');
});

test('Registry Pipeline picker pins the default, filters provider names, and rejects unavailable choices', async () => {
  const pipelines = [
    { name: 'alpha', default: false, available: true, providers: [{ id: '@custom/lexical' }] },
    { name: 'z-default', default: true, available: true, providers: [{ id: '@custom/vector' }] },
    { name: 'broken', default: false, available: false, providers: [] },
  ];
  const emitted = [];
  const picker = await componentSetup('RegistryPipelinePicker.vue', { modelValue: 'z-default', pipelines, inputId: 'test' }, (...args) => emitted.push(args));
  assert.equal(picker.options.value[0].name, 'z-default');
  picker.filter.value = 'LEXICAL';
  assert.deepEqual(picker.options.value.map((item) => item.name), ['alpha']);
  picker.choose('broken'); picker.choose('invented');
  assert.deepEqual(emitted, []);
  picker.choose('alpha');
  assert.deepEqual(emitted, [['update:modelValue', 'alpha']]);
});

test('Registry build tables preserve exact digest filtering and numeric byte ordering', async () => {
  const row = { target: 'lexical', evidenceDigest: `sha256:${'a'.repeat(64)}`, retrievalBuildDigest: `sha256:${'b'.repeat(64)}`,
    evidenceProviders: [], retrievalProviders: [], evidenceSize: 2048, retrievalSize: 2 * 1048576, status: 'published' };
  const table = await componentSetup('RegistryBuildDataTable.vue', { rows: [row] });
  for (const [name, expected] of [['evidence', row.evidenceDigest], ['retrieval', row.retrievalBuildDigest], ['size', row.evidenceSize + row.retrievalSize]]) {
    const column = table.columns.value.find((item) => item.name === name);
    const cell = typeof column.data === 'function' ? column.data(row) : row[column.data];
    for (const type of ['filter', 'sort', 'type']) assert.equal(column.render(cell, type, row), expected, `${name}:${type}`);
    const display = column.render(cell, 'display', row);
    if (name === 'size') { assert.equal(column.type, 'num'); assert.equal(display, '2.0 MiB'); }
    else { assert.notEqual(display, expected); assert.match(display, /…$/u); }
  }
  const size = table.columns.value.find((item) => item.name === 'size');
  const sorted = [{ ...row, evidenceSize: 0, retrievalSize: 2 * 1048576 }, { ...row, evidenceSize: 0, retrievalSize: 900 * 1024 }]
    .sort((a, b) => size.render(size.data(a), 'sort', a) - size.render(size.data(b), 'sort', b));
  assert.equal(sorted[0].retrievalSize, 900 * 1024, 'formatted 900 KiB must sort before 2 MiB');
});

test('Registry build requests require the current healthy recipe and current release/context', async () => {
  const pipeline = { name: 'lexical', available: true, default: true, providers: [], evidenceProfileDigest: 'evidence', retrievalProfileDigest: 'retrieval', compatibilityDigest: 'compatible' };
  const state = (data) => ({ data: Vue.ref(data), isFetching: Vue.ref(false), isError: Vue.ref(false), error: Vue.ref(undefined), refetch: async () => {} });
  const states = {
    'registry-context': state({ registry: { url: 'https://registry.example.test' }, libraries: [] }),
    resources: state({ libraries: [] }),
    'registry-pipelines': state({ default: 'lexical', pipelines: [pipeline] }),
    'registry-entry': state({ type: 'dkb', selectedVersion: { version: '1.0.0', builds: [] } }),
  };
  const calls = [];
  const view = await componentSetup('../../views/RegistryEntryDetailView.vue', { registry: 'registry', kind: 'dkb', namespace: 'test', name: 'knowledge' }, () => {}, {
    '@tanstack/vue-query': { useQuery: (options) => states[Vue.unref(options.queryKey)[0]], useQueryClient: () => ({ invalidateQueries: async () => {} }) },
    'vue-router': { useRouter: () => ({ push: async () => {} }) },
    '../api.js': { startOperation: async (command, input) => { calls.push({ command, input }); return 'operation'; }, followOperation: () => () => {}, cancelOperation: async () => {} },
  });
  assert.equal(view.canRequestBuild.value, true);
  const assertBlocked = () => { assert.equal(view.canRequestBuild.value, false); view.submitBuild(); assert.equal(calls.length, 0); };
  for (const name of ['registry-context', 'registry-entry', 'registry-pipelines']) for (const flag of ['isFetching', 'isError']) {
    states[name][flag].value = true; assertBlocked(); states[name][flag].value = false;
  }
  states['registry-pipelines'].data.value.pipelines[0].available = false;
  assertBlocked();
  states['registry-pipelines'].data.value.pipelines[0].available = true;
  view.selectedBuildPipeline.value = 'removed-recipe'; assertBlocked(); view.selectedBuildPipeline.value = 'lexical';
  view.selectedVersion.value = '2.0.0'; assertBlocked(); view.selectedVersion.value = '1.0.0';
  states['registry-entry'].data.value.selectedVersion.builds = [{ retrievalProfileDigest: 'retrieval', compatibilityDigest: 'compatible' }];
  assertBlocked();
  states['registry-entry'].data.value.selectedVersion.builds = [];
  assert.equal(view.canRequestBuild.value, true);
  view.submitBuild();
  assert.deepEqual(calls, [{ command: 'registry.build', input: { url: 'https://registry.example.test', identity: '@test/knowledge', version: '1.0.0', pipeline: 'lexical' } }]);
  view.submitBuild();
  assert.equal(calls.length, 1, 'an in-flight request cannot be submitted twice');
});

async function componentSetup(file, props, emit = () => {}, overrides = {}) {
  const filename = new URL(`../apps/console/src/web/components/resource/${file}`, import.meta.url);
  const { descriptor } = parse(await fs.readFile(filename, 'utf8'), { filename: filename.pathname });
  const script = compileScript(descriptor, { id: 'registry-publication-ui' });
  const compiled = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const module = { exports: {} };
  const require = (specifier) => {
    if (Object.hasOwn(overrides, specifier)) return overrides[specifier];
    if (specifier === 'vue') return Vue;
    if (specifier === 'datatables.net-dt') return { default: { render: { text: () => (value) => value } } };
    if (specifier.endsWith('/consoleDataTable.js')) return { consoleTextFilter: () => [], consoleListFilter: () => [], consoleDateFilter: () => [] };
    return {};
  };
  new Function('require', 'module', 'exports', compiled.outputText)(require, module, module.exports);
  return module.exports.default.setup(props, { expose() {}, emit });
}
