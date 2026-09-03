import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { DkbProviderHost, pluginPath } from '@sjshovan/dkb-pipeline/host.js';
import { writeBundledIntegrityReceipt } from '@sjshovan/dkb-pipeline/bundledIntegrity.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-bundled-lazy-loading-'));
  const probeKey = `dkb-lazy-probe-${randomUUID()}`;
  const probe = { imports: [], setups: [] };
  globalThis[probeKey] = probe;
  t.after(async () => {
    delete globalThis[probeKey];
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, probeKey, probe };
}

function moduleSource(item, id, marker, { helper = false, throws = false, local = false } = {}) {
  const identity = { apiVersion: 3, id, version: '1.0.0', protocols: [], artifactFormats: [] };
  return [
    helper ? 'import { implementationMarker } from "./helper.mjs";' : `const implementationMarker = ${JSON.stringify(marker)};`,
    `const probe = globalThis[${JSON.stringify(item.probeKey)}];`,
    `const id = ${JSON.stringify(id)};`,
    'probe.imports.push({ id, marker: implementationMarker });',
    ...(throws ? ['throw new Error("This unselected bundle must never execute");'] : []),
    'export const IMPLEMENTATION_MARKER = implementationMarker;',
    'export const PLUGIN = {',
    '  apiVersion: 3, id, version: "1.0.0", sourceUrl: import.meta.url,',
    `  integrity: ${JSON.stringify(identity)},`,
    '  optionsSchema: { "~standard": { version: 1, vendor: "fixture", validate(value) { return { value: value ?? {} }; } } },',
    '  setup(context) {',
    '    let calls = 0;',
    '    probe.setups.push({ id, root: context.root, label: context.options.label ?? null });',
    '    context.registerProvider({ kind: "evidence", async compile() {',
    '      return { records: [], receipt: { build: { marker: implementationMarker, calls: ++calls, label: context.options.label ?? null, frozen: Object.isFrozen(context.options) } } };',
    '    } });',
    '    context.registerProvider({ kind: "index", mode: "packaged", format: "test.index.v1", capabilities: { vectors: "none" },',
    '      async compilePackage() { return null; }, async validatePackage() { return { documentCount: 0 }; },',
    '      async verifyRuntime() { return { indexId: "test", documentCount: 0, status: "ready" }; }, async openRuntime() { return null; },',
    '    });',
    '    context.registerProvider({ kind: "retrieval", protocol: "dkb.evidence.v1", capabilities: { vectors: "none" },',
    '      openRuntime() { return { providerId: id, protocol: "dkb.evidence.v1", async search() { return { hits: [], trace: {} }; }, close() {} }; },',
    '    });',
    '  },',
    '};',
    ...(local ? ['export default PLUGIN;'] : []),
    '',
  ].join('\n');
}

async function bundle(item, name, marker, options = {}) {
  const id = `@test/${name}`;
  const packageRoot = path.join(item.root, 'bundles', name);
  const entrypoint = path.join(packageRoot, 'dist/plugin.mjs');
  const identity = { apiVersion: 3, id, version: '1.0.0', protocols: [], artifactFormats: [] };
  await fs.mkdir(path.dirname(entrypoint), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: id, version: '1.0.0', type: 'module', files: ['dist/'] }));
  await fs.writeFile(entrypoint, moduleSource(item, id, marker, options));
  if (options.helper) await fs.writeFile(path.join(packageRoot, 'dist/helper.mjs'), `export const implementationMarker = ${JSON.stringify(marker)};\n`);
  const receipt = await writeBundledIntegrityReceipt({ packageRoot, entrypoint, identity });
  return {
    id, packageRoot, entrypoint, identity, receipt,
    reference: { id, version: '1.0.0', sourceUrl: pathToFileURL(entrypoint).href, exportName: 'PLUGIN' },
  };
}

function hostOptions(item, selected, references, name = 'runtime', options = {}) {
  return {
    root: path.join(item.root, name),
    libraryRoot: path.join(item.root, 'library'),
    globalRoot: path.join(item.root, 'global'),
    distribution: {
      id: '@test/lazy-distribution', version: '1.0.0', services: [], plugins: references,
      defaults: { format: 'dkb.config.v2', targets: { default: { evidence: selected.id, index: selected.id, retrieval: selected.id } } },
    },
    ...options,
  };
}

async function evidenceResult(host) { return (await host.provider('evidence').compile({})).receipt.build; }

test('first selection cannot attest a rebuilt receipt to an older canonical ESM import', async (t) => {
  const item = await fixture(t);
  const selected = await bundle(item, 'rebuilt-before-selection', 'old');
  const imported = await import(selected.reference.sourceUrl);
  assert.equal(imported.IMPLEMENTATION_MARKER, 'old');
  await fs.writeFile(selected.entrypoint, moduleSource(item, selected.id, 'new'));
  const rebuilt = await writeBundledIntegrityReceipt(selected);
  assert.notEqual(rebuilt.filesDigest, selected.receipt.filesDigest);
  let host;
  try {
    host = await DkbProviderHost.create(hostOptions(item, selected, [selected.reference]));
  } catch (error) {
    // A loader may reject changed cached code and require a process restart.
    assert.match(error.message, /changed|cached|restart/iu);
    return;
  }
  try {
    assert.equal((await evidenceResult(host)).marker, 'new', 'a new receipt must never label the old cached implementation');
    assert.equal(host.providerIntegrity('evidence').filesDigest, rebuilt.filesDigest);
    await host.assertCurrent();
  } finally { await host.dispose(); }
});

test('unselected bundles are not imported even when their module throws and their receipt is missing', async (t) => {
  const item = await fixture(t);
  const selected = await bundle(item, 'selected-only', 'selected');
  const unused = await bundle(item, 'unused', 'unused', { throws: true });
  await fs.rm(path.join(unused.packageRoot, 'dist/provider.integrity.json'));
  const host = await DkbProviderHost.create(hostOptions(item, selected, [unused.reference, selected.reference]));
  try {
    assert.deepEqual(item.probe.imports, [{ id: selected.id, marker: 'selected' }]);
    assert.equal((await evidenceResult(host)).marker, 'selected');
    assert.equal(item.probe.setups.length, 1);
  } finally { await host.dispose(); }
});

test('missing or stale selected receipts reject before executing the bundled module', async (t) => {
  for (const mode of ['missing', 'stale']) {
    const item = await fixture(t);
    const selected = await bundle(item, `invalid-${mode}`, 'original');
    if (mode === 'missing') await fs.rm(path.join(selected.packageRoot, 'dist/provider.integrity.json'));
    else await fs.writeFile(selected.entrypoint, moduleSource(item, selected.id, 'modified'));
    await assert.rejects(DkbProviderHost.create(hostOptions(item, selected, [selected.reference])), /integrity|receipt/iu);
    assert.deepEqual(item.probe.imports, []);
    assert.deepEqual(item.probe.setups, []);
  }
});

test('bundled literal imports cannot execute unrecorded helpers or undeclared external code', async (t) => {
  for (const mode of ['unshipped', 'escaping', 'undeclared', 'file-url', 'absolute']) {
    const item = await fixture(t);
    const selected = await bundle(item, `import-${mode}`, 'unverified-helper', { helper: true });
    const manifestPath = path.join(selected.packageRoot, 'package.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    let specifier = './helper.mjs';
    if (mode === 'unshipped') {
      manifest.files = ['dist/plugin.mjs', 'dist/provider.integrity.json'];
      await fs.writeFile(manifestPath, JSON.stringify(manifest));
    } else if (mode === 'escaping') {
      specifier = '../../outside.mjs';
      await fs.writeFile(path.join(path.dirname(selected.packageRoot), 'outside.mjs'), 'export const implementationMarker = "outside";\n');
    } else if (mode === 'undeclared') {
      specifier = '@test/undeclared-helper';
      const dependencyRoot = path.join(selected.packageRoot, 'node_modules/@test/undeclared-helper');
      await fs.mkdir(dependencyRoot, { recursive: true });
      await fs.writeFile(path.join(dependencyRoot, 'package.json'), JSON.stringify({ name: specifier, version: '1.0.0', type: 'module', exports: './index.mjs' }));
      await fs.writeFile(path.join(dependencyRoot, 'index.mjs'), 'export const implementationMarker = "undeclared";\n');
    } else if (mode === 'file-url') {
      specifier = pathToFileURL(path.join(selected.packageRoot, 'dist/helper.mjs')).href;
    } else {
      specifier = path.join(selected.packageRoot, 'dist/helper.mjs');
    }
    const source = moduleSource(item, selected.id, 'unverified-helper', { helper: true }).replace('"./helper.mjs"', JSON.stringify(specifier));
    await fs.writeFile(selected.entrypoint, source);
    await writeBundledIntegrityReceipt(selected);
    await assert.rejects(DkbProviderHost.create(hostOptions(item, selected, [selected.reference])), /inventory|allowlist|shipped|outside|escapes|declared runtime dependency/iu);
    assert.deepEqual(item.probe.imports, [], `${mode} must be rejected before importing the entrypoint`);
    assert.deepEqual(item.probe.setups, []);
  }
});

test('shipped relative helpers retain ordinary ESM query and fragment support', async (t) => {
  const item = await fixture(t);
  const selected = await bundle(item, 'shipped-helper-query', 'shipped', { helper: true });
  await fs.writeFile(selected.entrypoint, moduleSource(item, selected.id, 'shipped', { helper: true }).replace('"./helper.mjs"', '"./helper.mjs?fixture=1#module"'));
  await writeBundledIntegrityReceipt(selected);
  const host = await DkbProviderHost.create(hostOptions(item, selected, [selected.reference]));
  try {
    assert.equal((await evidenceResult(host)).marker, 'shipped');
    await host.assertCurrent();
  } finally { await host.dispose(); }
});

test('broken higher-priority overrides fail without importing the bundled replacement', async (t) => {
  for (const mode of ['syntax', 'missing-entry']) {
    const item = await fixture(t);
    const selected = await bundle(item, `override-${mode}`, 'bundle');
    const options = hostOptions(item, selected, [selected.reference]);
    const entrypoint = pluginPath(path.join(options.root, '.dkb/plugins'), selected.id);
    await fs.mkdir(path.dirname(entrypoint), { recursive: true });
    if (mode === 'syntax') await fs.writeFile(entrypoint, 'this is not valid JavaScript !!!');
    await assert.rejects(DkbProviderHost.create(options));
    assert.deepEqual(item.probe.imports, []);
    assert.deepEqual(item.probe.setups, []);
  }
});

test('Runtime, Library, and global overrides resolve before any bundled import', async (t) => {
  for (const scope of ['runtime', 'library', 'global']) {
    const item = await fixture(t);
    const selected = await bundle(item, `valid-${scope}`, 'bundle', { throws: true });
    const options = hostOptions(item, selected, [selected.reference]);
    const pluginsRoot = scope === 'runtime' ? path.join(options.root, '.dkb/plugins')
      : scope === 'library' ? path.join(options.libraryRoot, '.dkb/plugins') : path.join(options.globalRoot, 'plugins');
    const entrypoint = pluginPath(pluginsRoot, selected.id);
    await fs.mkdir(path.dirname(entrypoint), { recursive: true });
    await fs.writeFile(entrypoint, moduleSource(item, selected.id, scope, { local: true }));
    const host = await DkbProviderHost.create(options);
    try {
      assert.equal((await evidenceResult(host)).marker, scope);
      assert.deepEqual(item.probe.imports, [{ id: selected.id, marker: scope }]);
    } finally { await host.dispose(); }
  }
});

test('concurrent hosts admit verified code but maintain separate setup options and provider state', async (t) => {
  const item = await fixture(t);
  const selected = await bundle(item, 'concurrent', 'shared-code');
  const hosts = await Promise.all(['a', 'b'].map((label) => DkbProviderHost.create(hostOptions(item, selected, [selected.reference], `runtime-${label}`, {
    targetOptions: { [selected.id]: { label } },
  }))));
  try {
    assert.notEqual(hosts[0].provider('evidence'), hosts[1].provider('evidence'));
    assert.deepEqual((await Promise.all(hosts.map(evidenceResult))).map(({ label, calls, frozen }) => ({ label, calls, frozen })), [
      { label: 'a', calls: 1, frozen: true }, { label: 'b', calls: 1, frozen: true },
    ]);
    assert.equal((await evidenceResult(hosts[0])).calls, 2);
    assert.equal((await evidenceResult(hosts[1])).calls, 2);
    assert.equal(item.probe.setups.length, 2);
    assert.deepEqual(new Set(item.probe.setups.map((entry) => entry.label)), new Set(['a', 'b']));
    await Promise.all(hosts.map((host) => host.assertCurrent()));
    await hosts[0].dispose();
    assert.equal((await evidenceResult(hosts[1])).calls, 3);
  } finally { await Promise.all(hosts.map((host) => host.dispose())); }
});

test('a host-loaded helper cannot be replaced and re-attested while Node retains its old module', async (t) => {
  const item = await fixture(t);
  const selected = await bundle(item, 'helper-drift', 'old', { helper: true });
  const host = await DkbProviderHost.create(hostOptions(item, selected, [selected.reference], 'runtime-first'));
  try {
    assert.equal((await evidenceResult(host)).marker, 'old');
    const helperPath = path.join(selected.packageRoot, 'dist/helper.mjs');
    const oldStat = await fs.stat(helperPath);
    await fs.writeFile(helperPath, 'export const implementationMarker = "new";\n');
    await fs.utimes(helperPath, oldStat.atime, oldStat.mtime);
    const rebuilt = await writeBundledIntegrityReceipt(selected);
    assert.notEqual(rebuilt.filesDigest, selected.receipt.filesDigest);
    await assert.rejects(host.assertCurrent(), /changed|drift/iu);
    await assert.rejects(DkbProviderHost.create(hostOptions(item, selected, [selected.reference], 'runtime-second')), /changed|cached|restart|loaded/iu);
    assert.equal(item.probe.setups.length, 1, 'rejection must occur before another setup');
    assert.equal(item.probe.imports.length, 1, 'changed helper closure must not be re-imported under a new identity');
  } finally { await host.dispose(); }
});
