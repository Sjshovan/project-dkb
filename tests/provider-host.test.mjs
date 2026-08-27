import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DKB_CONFIG_FORMAT, resolveContextConfig } from '../dist/src/providers/config.js';
import { DkbProviderHost, pluginPath } from '../dist/src/providers/host.js';
import { addPlugin, linkPlugin, listPlugins, removePlugin, setPipelineTarget } from '../dist/src/providers/management.js';
import { compileDkbWithProviderHost } from '../dist/src/providers/runner.js';
import { stableHash } from '@dkb/protocol/contracts/hash.js';
import { compileComposeProject } from '../dist/src/compiler/compile.js';
import { readEvidenceIr } from '@dkb/protocol/evidence/ir.js';
import { readSourceIndex } from '../dist/src/indexes/sourceIndex.js';
import { readRetrievalProfileLock } from '../dist/src/profiles/retrievalProfile.js';

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
    context.registerProvider({ kind: 'index', mode: 'packaged', format: 'test.v1', async openRuntime() { return null; } });
    context.registerProvider({ kind: 'retrieval', protocol: 'test.evidence.v1' });
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

test('separate parser, chunker, embedder, and middleware providers share one compilation contract', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-separate-'));
  const library = path.join(root, 'library');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = (id, setup) => ({ id, version: '1.0.0', setup });
  const bundled = [
    provider('@test/parser', (context) => context.registerProvider({ kind: 'parser', async parse() { return [{ id: 'doc', path: 'proof.md', text: 'parsed', metadata: {} }]; } })),
    provider('@test/chunker', (context) => context.registerProvider({ kind: 'chunker', async chunk({ documents }) { return [{ id: 'chunk', documentId: documents[0].id, text: `${documents[0].text}-chunked`, metadata: {} }]; } })),
    provider('@test/embedder', (context) => context.registerProvider({ kind: 'embedding', async embedDocuments({ texts }) { return texts.map(() => [0.5, 0.5]); }, async embedQuery() { return [0.5, 0.5]; }, compatibility() { return { embeddingSpace: 'test', dimensions: 2, metric: 'cosine', normalized: true }; } })),
    provider('@test/index', (context) => context.registerProvider({ kind: 'index', mode: 'packaged', format: 'test.v1', async openRuntime() { return null; } })),
    provider('@test/retrieval', (context) => context.registerProvider({ kind: 'retrieval', protocol: 'test.evidence.v1' })),
    provider('@test/document-mutator', (context) => context.registerProcessor({ id: '@test/document-mutator', version: '1.0.0', stage: 'document', mutate(value) { return { ...value, text: `${value.text}-document` }; } })),
    provider('@test/chunk-mutator', (context) => context.registerProcessor({ id: '@test/chunk-mutator', version: '1.0.0', stage: 'chunk', mutate(value) { return { ...value, text: `${value.text}-chunk` }; } })),
    provider('@test/record-mutator', (context) => context.registerProcessor({ id: '@test/record-mutator', version: '1.0.0', stage: 'record', mutate(value) { return { ...value, text: `${value.text}-record` }; } })),
  ];
  await writeJson(path.join(library, '.dkb/config.json'), {
    format: DKB_CONFIG_FORMAT,
    targets: {
      default: {
        parser: '@test/parser',
        chunker: '@test/chunker',
        embedding: '@test/embedder',
        index: '@test/index',
        retrieval: '@test/retrieval',
        processors: ['@test/document-mutator', '@test/chunk-mutator', '@test/record-mutator'],
      },
    },
  });
  const host = await DkbProviderHost.create({ root: library, globalRoot: path.join(root, 'global'), bundled });
  t.after(() => host.dispose());
  const compiled = await compileDkbWithProviderHost(host, {
    root: library,
    manifestPath: path.join(library, 'dkb.json'),
    manifestHash: 'sha256:test',
    manifest: { manifestVersion: 1, type: 'dkb', id: '@test/proof', name: '@test/proof', version: '1.0.0', adapter: 'folder', entrypoint: '.', permissions: { read: true, write: false } },
  });

  assert.equal(compiled.documents[0].text, 'parsed-document');
  assert.equal(compiled.chunks[0].text, 'parsed-document-chunked-chunk');
  assert.equal(compiled.records[0].text, 'parsed-document-chunked-chunk-record');
  assert.deepEqual(compiled.records[0].embedding, [0.5, 0.5]);
  assert.deepEqual(compiled.receipts.slice(-3).map((receipt) => receipt.build.stage), ['document', 'chunk', 'record']);
});

test('separate providers compile a complete package without a LlamaIndex-native result', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-separate-package-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeJson(path.join(root, 'dkb.json'), {
    manifestVersion: 1,
    type: 'dkb',
    name: '@test/separate-package',
    displayName: 'Separate package',
    version: '1.0.0',
    permissions: { read: true, write: false },
  });
  await fs.writeFile(path.join(root, 'proof.md'), 'SOURCE-PROOF-14', 'utf8');
  await writeJson(path.join(root, '.dkb/config.json'), {
    format: DKB_CONFIG_FORMAT,
    targets: {
      default: {
        parser: '@test/separate',
        chunker: '@test/separate',
        embedding: '@test/separate',
        index: '@test/separate',
        retrieval: '@test/separate',
        processors: ['@test/separate'],
      },
    },
  });
  const plugin = pluginPath(path.join(root, '.dkb/plugins'), '@test/separate');
  await fs.mkdir(path.dirname(plugin), { recursive: true });
  await fs.writeFile(plugin, `
import fs from 'node:fs/promises';
import path from 'node:path';
export const id = '@test/separate';
export const version = '1.0.0';
export function setup(context) {
  context.registerProvider({ kind: 'parser', async parse() { return [{ id: 'proof', path: 'proof.md', text: 'SOURCE-PROOF-14', metadata: {} }]; } });
  context.registerProvider({ kind: 'chunker', async chunk({ documents }) { return [{ id: 'proof-chunk', documentId: documents[0].id, text: documents[0].text, metadata: {} }]; } });
  context.registerProvider({ kind: 'embedding', async embedDocuments({ texts }) { return texts.map(() => [0.6, 0.8]); }, async embedQuery() { return [0.6, 0.8]; }, compatibility() { return { embeddingSpace: 'test-space-v1', dimensions: 2, metric: 'cosine', normalized: true }; } });
  context.registerProvider({
    kind: 'index', mode: 'packaged', format: 'test.index.v1',
    async compilePackage({ root, compiled }) {
      const target = path.join(root, '.dkb', 'artifacts', 'test-index.json');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify(compiled.records));
      return { providerId: id, providerVersion: version, build: { recordCount: compiled.records.length } };
    },
    async validatePackage() { return { documentCount: 1 }; },
    async openRuntime() { return null; },
  });
  context.registerProvider({ kind: 'retrieval', protocol: 'dkb.evidence.v1' });
  context.registerProcessor({ id, version, stage: 'record', mutate(value) { return { ...value, text: value.text + '-MUTATED' }; } });
}
`, 'utf8');

  const result = await compileComposeProject(root, { force: true, mode: 'package' });
  const [sourceIndex, evidence, profile, indexRecords] = await Promise.all([
    readSourceIndex(root),
    readEvidenceIr(root),
    readRetrievalProfileLock(root),
    fs.readFile(path.join(root, '.dkb/artifacts/test-index.json'), 'utf8').then(JSON.parse),
  ]);

  assert.equal(result.recordCount, 1);
  assert.match(sourceIndex.units[0].text, /SOURCE-PROOF-14-MUTATED/);
  assert.equal(evidence.evidence[0].text, 'SOURCE-PROOF-14-MUTATED');
  assert.equal(indexRecords[0].text, 'SOURCE-PROOF-14-MUTATED');
  assert.equal(profile.profile.compiler.id, '@test/separate');
  assert.equal(profile.profile.index.provider, '@test/separate');
  assert.equal(profile.compatibility.dimensions, 2);
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

test('pipeline activation rejects incompatible installed artifacts without changing configuration', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-compatible-promote-'));
  const library = path.join(root, 'library');
  const globalRoot = path.join(root, 'global');
  const configPath = path.join(library, '.dkb/config.json');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await setPipelineTarget({
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
  const compatibility = {
    embeddingSpace: 'BAAI/bge-small-en-v1.5',
    dimensions: 384,
    metric: 'cosine',
    normalized: true,
    indexFormat: 'IndexIDMap2(IndexFlatIP)',
    protocol: 'dkb.evidence.v1',
  };
  const profile = {
    compiler: { adapter: '@dkb/llamaindex', id: 'test', image: 'test', imageDigest: null },
    embedding: { adapter: '@dkb/fastembed', model: compatibility.embeddingSpace, modelRevision: null, modelDigest: null, dimensions: 384, metric: 'cosine', normalized: true, queryMode: 'query', documentMode: 'passage' },
    extraction: { richParser: 'test', richChunker: 'test', fallbackParser: 'test', fallbackChunker: 'test' },
    target: 'default',
    configDigest: 'sha256:test',
    providerBuildDigest: 'sha256:test',
    providers: [],
    processors: [],
    index: { provider: '@dkb/faiss', mode: 'packaged', format: compatibility.indexFormat },
    retrieval: { provider: '@dkb/hybrid', protocol: compatibility.protocol },
  };
  const compatibilityDigest = stableHash(compatibility);
  await writeJson(path.join(library, 'dkb-profile.lock.json'), {
    format: 'dkb.retrieval-profile.v2',
    profile,
    buildDigest: stableHash(profile),
    compatibility,
    compatibilityDigest,
    profileDigest: compatibilityDigest,
    generatedAt: new Date().toISOString(),
  });

  await assert.rejects(setPipelineTarget({
    root: library,
    globalRoot,
    name: 'base',
    activate: true,
    patch: {
      ingestion: '@dkb/llamaindex',
      embedding: '@dkb/fastembed',
      index: '@dkb/faiss',
      retrieval: '@dkb/hybrid',
      processors: [],
      options: { '@dkb/fastembed': { model: 'BAAI/bge-base-en-v1.5', dimensions: 768 } },
    },
  }), /Cannot activate pipeline target "base".*Save it with --no-activate/);
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
  context.registerProvider({ kind: 'index', mode: 'packaged', format: 'test.v1', async openRuntime() { return null; } });
  context.registerProvider({ kind: 'retrieval', protocol: 'test.evidence.v1' });
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
