import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import * as Vue from 'vue';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';

const helperPath = new URL('../apps/console/src/web/components/resource/runtimeAuditPresentation.ts', import.meta.url);
const { outputText } = ts.transpileModule(await fs.readFile(helperPath, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const presentation = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const routesSource = await fs.readFile(new URL('../apps/console/src/web/resourceRoutes.ts', import.meta.url), 'utf8');
const routesModule = ts.transpileModule(routesSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const routes = await import(`data:text/javascript;base64,${Buffer.from(routesModule.outputText).toString('base64')}`);
const profile = { target: 'historical-target', evidenceProfileDigest: 'evidence-profile', retrievalProfileDigest: 'retrieval-profile', compatibilityDigest: 'compatibility' };
const admitted = { admission: 'admitted', runtime: { id: 'recorded-runtime', activationDigest: 'activation' }, library: { id: 'historical-library', generation: 3, stateDigest: 'state' }, pipeline: profile };

test('audit table slot renderers preserve resolved cell values for search and sorting', () => {
  const renderer = presentation.auditSlotRender('#audit-value');
  assert.equal(renderer.display, '#audit-value');
  for (const value of ['historical-library', '@test/knowledge', 'success', 'sha256:exact-build', '{"path":"manual.md"}', 'https://example.test/citation', 0, null]) {
    assert.equal(renderer._(value), value);
  }
});

test('audit table columns filter and sort their actual resolved scalar cells', async () => {
  const event = { ...admitted, query: 'marine marker', outcome: 'success', channel: 'cli', resultCount: 1, recordedAt: '2026-09-03T12:00:00Z' };
  const table = await setupComponent('components/resource/RuntimeAuditDataTable.vue', { rows: [event], libraries: [] });
  for (const [name, expected] of [['query', 'marine marker'], ['outcome', 'success'], ['library', 'historical-library']]) {
    assertResolvedCell(table.columns.value.find((column) => column.name === name), event, expected);
  }
  assertResolvedCell(table.columns.value.find((column) => column.name === 'library'), { ...event, library: null }, 'Not admitted');
  const drawer = await setupComponent('components/resource/RuntimeAuditDetailsDrawer.vue', { open: true, event, runtimeName: 'host-runtime', libraries: [], pipelines: [], packages: [] });
  const pkg = { id: '@test/marine', version: '1.0.0', evidenceDigest: 'sha256:evidence', retrievalBuildDigest: 'sha256:retrieval' };
  for (const column of drawer.packageColumns.filter((column) => typeof column.render === 'object' && '_' in column.render)) {
    assertResolvedCell(column, pkg, pkg[column.name]);
  }
  const citation = { evidenceId: 'evidence-1', packageId: pkg.id, packageVersion: pkg.version, locator: { path: 'source/manual.md', start: 0 }, url: 'https://runtime.example/evidence-1' };
  for (const [name, expected] of [['evidenceId', citation.evidenceId], ['packageId', pkg.id], ['locator', JSON.stringify(citation.locator, null, 2)], ['url', citation.url]]) {
    assertResolvedCell(drawer.citationColumns.find((column) => column.name === name), citation, expected);
  }
});

function assertResolvedCell(column, row, expected) {
  const cell = typeof column.data === 'function' ? column.data(row, 'filter') : row[column.data];
  for (const type of ['filter', 'sort', 'type']) assert.equal(column.render._(cell, type, row), expected, `${column.name} ${type}`);
}

async function setupComponent(file, props) {
  const filename = new URL(`../apps/console/src/web/${file}`, import.meta.url);
  const { descriptor } = parse(await fs.readFile(filename, 'utf8'), { filename: filename.pathname });
  const script = compileScript(descriptor, { id: 'runtime-audit-columns' });
  const compiled = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const module = { exports: {} };
  // Exercise the SFC's actual column definitions without mounting a browser table.
  // Display slots are irrelevant here: DataTables resolves data before invoking
  // the orthogonal filter/sort/type renderer with that scalar cell value.
  const require = (specifier) => {
    if (specifier === 'vue') return Vue;
    if (specifier === 'datatables.net-dt') return { default: { render: { text: () => (value) => value } } };
    if (specifier.endsWith('/runtimeAuditPresentation.js')) return presentation;
    if (specifier.endsWith('/consoleDataTable.js')) return { consoleTextFilter: () => [], consoleListFilter: () => [], consoleDateFilter: () => [] };
    return {};
  };
  new Function('require', 'module', 'exports', compiled.outputText)(require, module, module.exports);
  return module.exports.default.setup(props, { expose() {}, emit() {} });
}

test('audit presentation does not substitute current resources for rejected or unavailable historical identities', () => {
  const rejected = { admission: 'rejected_before_admission', runtime: { id: null, activationDigest: null }, library: null, pipeline: null };
  const libraries = [{ name: 'current-host-library', libraryId: 'current-library' }, { name: 'old-host-library', libraryId: 'historical-library' }];
  assert.equal(presentation.auditAdmissionLabel(rejected), 'Not admitted');
  assert.deepEqual(presentation.auditLibraryReference(rejected, libraries), { id: 'Not admitted', detail: 'No Library build graph was admitted.' });
  assert.equal(presentation.auditRuntimeReference(rejected, 'recorded-runtime', 'current-runtime-alias'), undefined);
  assert.equal(presentation.auditPipelineAvailable(rejected, [{ name: profile.target, ...profile }]), false);
  assert.equal(presentation.auditLibraryReference(admitted, libraries).name, 'old-host-library');
  assert.equal(presentation.auditLibraryReference(admitted, [libraries[0]]).name, undefined);
  assert.match(presentation.auditLibraryReference(admitted, [libraries[0]]).detail, /historical Library/);
  assert.equal(presentation.auditLibraryReference(admitted, [libraries[1], { name: 'duplicate', libraryId: 'historical-library' }]).name, undefined);
  assert.equal(presentation.auditLibraryReference(admitted, [{ name: 'historical-library' }]).name, undefined, 'an alias is never treated as canonical identity');
});

test('audit Runtime, Pipeline, and package links require exact available identities', () => {
  assert.equal(presentation.auditRuntimeReference(admitted, 'different-runtime', 'current-alias'), undefined);
  assert.equal(presentation.auditRuntimeReference(admitted, 'recorded-runtime', 'host-alias'), 'host-alias');
  const target = { name: profile.target, ...profile };
  assert.equal(presentation.auditPipelineAvailable(admitted, [target]), true);
  for (const field of ['name', 'evidenceProfileDigest', 'retrievalProfileDigest', 'compatibilityDigest']) {
    assert.equal(presentation.auditPipelineAvailable(admitted, [{ ...target, [field]: 'changed' }]), false, field);
  }
  const packages = [{ id: '@test/knowledge', version: '1.0.0', status: 'installed' }];
  assert.equal(presentation.auditPackageAvailable('@test/knowledge', '1.0.0', packages), true);
  assert.equal(presentation.auditPackageAvailable('@test/knowledge', '2.0.0', packages), false);
  assert.equal(presentation.auditPackageAvailable('@other/knowledge', '1.0.0', packages), false);
  assert.equal(presentation.auditPackageAvailable('@test/knowledge', '1.0.0', [{ ...packages[0], status: 'broken' }]), false);
});

test('audit drawer hides cached package links during refresh errors and pending checks', async () => {
  const props = Vue.reactive({ open: true, event: admitted, runtimeName: 'runtime', libraries: [{ name: 'historical', libraryId: admitted.library.id }], pipelines: [],
    packages: [{ id: '@test/knowledge', version: '1.0.0', status: 'installed' }], packagesPending: false, packagesError: undefined });
  const drawer = await setupComponent('components/resource/RuntimeAuditDetailsDrawer.vue', props);
  assert.equal(drawer.packageLink('@test/knowledge', '1.0.0'), true);
  props.packagesPending = true;
  assert.equal(drawer.packageLink('@test/knowledge', '1.0.0'), false);
  props.packagesPending = false;
  props.packagesError = 'Library inspection unavailable';
  assert.equal(drawer.packageLink('@test/knowledge', '1.0.0'), false, 'cached data must not contradict the unavailable notice');
  props.packagesError = undefined;
  props.packages = [];
  assert.equal(drawer.packageLink('@test/knowledge', '1.0.0'), false);
});

test('historical build navigation opens only the exact retained version, kind, and digest', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const evidence = `sha256:${'b'.repeat(64)}`;
  const input = { identity: '@test/knowledge', version: '1.0.0', kind: 'retrieval', digest, evidenceDigest: evidence };
  const build = { kind: 'retrieval', buildDigest: digest, evidenceDigest: evidence };
  const detail = { identity: input.identity, version: input.version, kind: 'dkb', status: 'installed', builds: [build] };
  assert.equal(presentation.retainedAuditBuild(detail, input), build);
  for (const changed of [{ version: '2.0.0' }, { identity: '@other/knowledge' }, { status: 'broken' }, { builds: [] }, { builds: [build, build] }]) assert.equal(presentation.retainedAuditBuild({ ...detail, ...changed }, input), undefined);
  assert.equal(presentation.retainedAuditBuild(detail, { ...input, evidenceDigest: digest }), undefined);
  assert.equal(presentation.retainedAuditBuild(detail, { ...input, kind: 'evidence' }), undefined);
  const selection = { version: '1.0.0', kind: 'retrieval', buildDigest: digest };
  const url = new URL(routes.installedBuildRoute('historical-library', input.identity, selection), 'http://localhost');
  assert.equal(url.searchParams.get('view'), 'builds');
  assert.deepEqual(routes.parseInstalledBuildSelection(Object.fromEntries(url.searchParams)).selection, selection);
  for (const invalid of [{ version: '1.0.0', buildKind: 'retrieval', build: '../private' }, { version: ['1.0.0'], buildKind: 'evidence', build: digest }, { build: digest }, { version: '1.0.0', buildKind: 'profile', build: digest }]) {
    assert.equal(routes.parseInstalledBuildSelection(invalid).selection, undefined);
    assert.match(routes.parseInstalledBuildSelection(invalid).error, /no substitute/i);
  }
});

test('audit citations preserve safe recorded URLs and reject active content or credentials', () => {
  const url = 'https://runtime.example.test/evidence/item?build=exact#source';
  assert.equal(presentation.safeAuditCitationUrl(url), url);
  for (const unsafe of ['javascript:alert(1)', 'data:text/html,evil', 'file:///C:/private', '//elsewhere.test', 'https://user:secret@example.test', 'not a url', '', null]) {
    assert.equal(presentation.safeAuditCitationUrl(unsafe), undefined, String(unsafe));
  }
  assert.equal(presentation.auditDate('not a timestamp'), 'Recorded time unavailable');
  assert.equal(presentation.auditElapsed({ elapsedMs: 0 }), '0 ms');
  assert.equal(presentation.auditElapsed({ elapsedMs: Infinity }), 'Not recorded');
  assert.equal(presentation.auditElapsed(null), 'Not recorded');
  assert.match(presentation.auditJson({ path: '<img src=x onerror=alert(1)>', text: '資料' }), /資料/);
});

test('Runtime audit components compile with nullable admission and complete chain surfaces', async () => {
  for (const file of ['components/resource/RuntimeAuditDataTable.vue', 'components/resource/RuntimeAuditDetailsDrawer.vue', 'components/resource/AuditBuildReference.vue', 'components/resource/EvidenceDetailsDrawer.vue', 'components/resource/BuildChain.vue', 'views/RuntimeDetailView.vue', 'views/InstalledEntryDetailView.vue']) {
    const filename = new URL(`../apps/console/src/web/${file}`, import.meta.url).pathname;
    const { descriptor, errors } = parse(await fs.readFile(new URL(`../apps/console/src/web/${file}`, import.meta.url), 'utf8'), { filename });
    assert.deepEqual(errors, []);
    const script = compileScript(descriptor, { id: 'runtime-audit-test' });
    const template = compileTemplate({ source: descriptor.template.content, filename, id: 'runtime-audit-test', compilerOptions: { bindingMetadata: script.bindings } });
    assert.deepEqual(template.errors, [], file);
  }
});
