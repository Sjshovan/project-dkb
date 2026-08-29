import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DKB_CONFIG_FORMAT, resolveContextConfig } from '@sjshovan/dkb-pipeline/config.js';
import { resolveBuildProfiles } from '@sjshovan/dkb-pipeline/buildProfiles.js';
import { DkbProviderHost, pluginPath } from '@sjshovan/dkb-pipeline/host.js';
import { DEFAULT_DKB_DISTRIBUTION } from '@sjshovan/dkb-distribution-default';
import { addPlugin, linkPlugin, listPlugins, removePlugin, setPipelineTarget } from '../apps/cli/dist/providers/management.js';
import { compileDkbWithProviderHost } from '@sjshovan/dkb-compiler/pipelineRunner.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { compileComposeProject, compileRetrievalFromEvidence } from '@sjshovan/dkb-compiler/compile.js';
import { validateEvidenceIr } from '@sjshovan/dkb-protocol/evidence/ir.js';
import { meilisearchIndexId, meilisearchIndexPrefix } from '@sjshovan/dkb-index-meilisearch/meilisearchProvider.js';
import { readRetrievalProfileLock, resolveProviderRetrievalProfile } from '@sjshovan/dkb-pipeline/profile.js';
import { listPackageBuilds, validatePackageBuildGraph } from '@sjshovan/dkb-library/builds.js';
import { readEvidenceCatalog } from '@sjshovan/dkb-library/evidenceCatalog.js';

const allPlugin = {
  apiVersion: 2,
  id: '@test/all',
  version: '1.0.0',
  setup(context) {
    context.registerProvider({ kind: 'evidence', async compile() { return { records: [], receipt: { providerId: '@test/all', providerVersion: '1.0.0', build: {} } }; } });
    context.registerProvider({
      kind: 'embedding',
      async embedDocuments({ texts }) { return texts.map(() => [1]); },
      async embedQuery() { return [1]; },
      compatibility(options) {
        return {
          embeddingSpace: 'test-space',
          dimensions: Number(options.dimensions ?? 1),
          metric: 'cosine',
          normalized: true,
        };
      },
    });
    context.registerProvider({ kind: 'index', mode: 'packaged', format: 'test.v1', async openRuntime() { return null; } });
    context.registerProvider({ kind: 'retrieval', protocol: 'test.evidence.v1', openRuntime() { return { providerId: '@test/retrieval', protocol: 'test.evidence.v1', async search() { return { hits: [], trace: {} }; }, close() {} }; } });
  },
};

function distributionWith(plugins, defaults = DEFAULT_DKB_DISTRIBUTION.defaults) {
  return { ...DEFAULT_DKB_DISTRIBUTION, defaults, plugins };
}

test('bundled 384, 768, FastEmbed, and TEI targets share Evidence IR only when ingestion is identical', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-bundled-spaces-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const targets = ['default', 'fastembed-faiss', 'fastembed-faiss-768', 'tei-faiss', 'tei-faiss-768'];
  const resolved = [];

  for (const target of targets) {
    const host = await DkbProviderHost.create({
      root,
      globalRoot: path.join(root, 'global'),
      distribution: DEFAULT_DKB_DISTRIBUTION,
      target,
    });
    try {
      resolved.push(await resolveBuildProfiles(host));
    } finally {
      await host.dispose();
    }
  }

  assert.equal(new Set(resolved.map((profile) => profile.evidence.profileDigest)).size, 1);
  assert.equal(new Set(resolved.map((profile) => profile.retrieval.profileDigest)).size, 4);
  assert.deepEqual(resolved.map((profile) => profile.retrieval.embedding.dimensions), [384, 384, 768, 384, 768]);
  assert.equal(resolved[0].retrieval.profileDigest, resolved[3].retrieval.profileDigest);
  assert.equal(resolved[0].retrieval.compatibilityDigest, resolved[3].retrieval.compatibilityDigest);
  assert.notEqual(resolved[1].retrieval.compatibilityDigest, resolved[3].retrieval.compatibilityDigest);
  assert.equal(resolved[4].retrieval.embedding.modelRevision, 'a5beb1e3e68b9ab74eb54cfd186867f64f240e1a');
});

test('Meilisearch managed indexes isolate compatibility spaces for the same package release', () => {
  const root = path.resolve('runtime-proof');
  const prefix = meilisearchIndexPrefix(root, 'Proof Library', '@test/package', '1.0.0');
  const fast = meilisearchIndexId(root, 'Proof Library', '@test/package', '1.0.0', stableHash({ space: 'fastembed' }));
  const tei = meilisearchIndexId(root, 'Proof Library', '@test/package', '1.0.0', stableHash({ space: 'tei' }));

  assert.match(fast, new RegExp(`^${prefix}_`));
  assert.match(tei, new RegExp(`^${prefix}_`));
  assert.notEqual(fast, tei);
  assert.equal(
    fast,
    meilisearchIndexId(root, 'Proof Library', '@test/package', '1.0.0', stableHash({ space: 'fastembed' })),
  );
});

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
        evidence: '@test/all',
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

  const resolved = await resolveContextConfig(contextRoot, { defaults: DEFAULT_DKB_DISTRIBUTION.defaults, globalRoot });

  assert.deepEqual(resolved.target.processors, []);
  assert.deepEqual(resolved.target.options['@test/all'], {
    shared: 'global',
    local: true,
    nested: { one: 1, two: 2 },
  });
});

test('context configuration rejects pre-v2 documents instead of applying a legacy reader', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-config-version-'));
  const contextRoot = path.join(root, 'library');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeJson(path.join(contextRoot, '.dkb/config.json'), { activeTarget: 'default' });

  await assert.rejects(
    resolveContextConfig(contextRoot, {
      defaults: DEFAULT_DKB_DISTRIBUTION.defaults,
      globalRoot: path.join(root, 'global'),
    }),
    /format must be dkb\.config\.v2/u,
  );
});

test('provider configuration rejects inline secrets and accepts environment references', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-secrets-'));
  const contextRoot = path.join(root, 'library');
  const configPath = path.join(contextRoot, '.dkb/config.json');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = targetConfig('@test/all');
  config.targets.default.options = { '@test/all': { apiKey: 'must-not-live-here' } };
  await writeJson(configPath, config);

  await assert.rejects(resolveContextConfig(contextRoot, { defaults: DEFAULT_DKB_DISTRIBUTION.defaults, globalRoot: path.join(root, 'global') }), /cannot store apiKey/i);

  config.targets.default.options = { '@test/all': { apiKeyEnv: 'TEST_PROVIDER_API_KEY' } };
  await writeJson(configPath, config);
  const resolved = await resolveContextConfig(contextRoot, { defaults: DEFAULT_DKB_DISTRIBUTION.defaults, globalRoot: path.join(root, 'global') });
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

  const host = await DkbProviderHost.create({ root: contextRoot, globalRoot, distribution: distributionWith([allPlugin]) });
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
  const first = await DkbProviderHost.create({ root: contextRoot, globalRoot, distribution: distributionWith([allPlugin]) });
  const firstDigest = first.describe().buildDigest;
  await first.dispose();

  await fs.writeFile(path.join(path.dirname(entrypoint), 'implementation.txt'), 'changed', 'utf8');
  const second = await DkbProviderHost.create({ root: contextRoot, globalRoot, distribution: distributionWith([allPlugin]) });
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
  await fs.writeFile(local, 'export const apiVersion = 2; export const id = "@test/wrong"; export const version = "1"; export function setup() {}\n', 'utf8');
  await writeJson(path.join(contextRoot, '.dkb/config.json'), targetConfig('@test/all'));

  await assert.rejects(
    DkbProviderHost.create({ root: contextRoot, globalRoot, distribution: distributionWith([allPlugin]) }),
    /Invalid plugin.*expected exports apiVersion=2, id=@test\/all/i,
  );
});

test('plugin API v1 is rejected instead of being loaded through a compatibility path', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-api-v1-'));
  const globalRoot = path.join(root, 'global');
  const contextRoot = path.join(root, 'library');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const local = pluginPath(path.join(contextRoot, '.dkb/plugins'), '@test/all');
  await fs.mkdir(path.dirname(local), { recursive: true });
  await fs.writeFile(local, 'export const apiVersion = 1; export const id = "@test/all"; export const version = "1"; export function setup() {}\n', 'utf8');
  await writeJson(path.join(contextRoot, '.dkb/config.json'), targetConfig('@test/all'));

  await assert.rejects(
    DkbProviderHost.create({ root: contextRoot, globalRoot, distribution: distributionWith([allPlugin]) }),
    /Invalid plugin.*expected exports apiVersion=2, id=@test\/all/i,
  );
});

test('processor order is deterministic and hosts dispose independently', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-processors-'));
  const globalRoot = path.join(root, 'global');
  const firstRoot = path.join(root, 'first');
  const secondRoot = path.join(root, 'second');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const processor = (id, suffix) => ({
    apiVersion: 2,
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
  const first = await DkbProviderHost.create({ root: firstRoot, globalRoot, distribution: distributionWith(bundled) });
  const second = await DkbProviderHost.create({ root: secondRoot, globalRoot, distribution: distributionWith(bundled) });
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
  const provider = (id, setup) => ({ apiVersion: 2, id, version: '1.0.0', setup });
  const bundled = [
    provider('@test/parser', (context) => context.registerProvider({ kind: 'parser', async parse() { return [{ id: 'doc', path: 'proof.md', text: 'parsed', metadata: {} }]; } })),
    provider('@test/chunker', (context) => context.registerProvider({ kind: 'chunker', async chunk({ documents }) { return [{ id: 'chunk', documentId: documents[0].id, text: `${documents[0].text}-chunked`, metadata: {} }]; } })),
    provider('@test/embedder', (context) => context.registerProvider({ kind: 'embedding', async embedDocuments({ texts }) { return texts.map(() => [0.5, 0.5]); }, async embedQuery() { return [0.5, 0.5]; }, compatibility() { return { embeddingSpace: 'test', dimensions: 2, metric: 'cosine', normalized: true }; } })),
    provider('@test/index', (context) => context.registerProvider({ kind: 'index', mode: 'packaged', format: 'test.v1', async openRuntime() { return null; } })),
    provider('@test/retrieval', (context) => context.registerProvider({ kind: 'retrieval', protocol: 'test.evidence.v1', openRuntime() { return { providerId: '@test/retrieval', protocol: 'test.evidence.v1', async search() { return { hits: [], trace: {} }; }, close() {} }; } })),
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
  const host = await DkbProviderHost.create({ root: library, globalRoot: path.join(root, 'global'), distribution: distributionWith(bundled) });
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
  assert.equal('embedding' in compiled.records[0], false);
  assert.deepEqual(compiled.vectors, [{ evidenceId: compiled.records[0].id, values: [0.5, 0.5] }]);
  assert.deepEqual(
    compiled.receipts
      .filter((receipt) => receipt.build.kind === 'processor')
      .map((receipt) => receipt.build.stage),
    ['document', 'chunk', 'record'],
  );
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
        embedding: '@test/initial-embedding',
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
export const apiVersion = 2;
export const id = '@test/separate';
export const version = '1.0.0';
export function setup(context) {
  context.registerProvider({ kind: 'parser', async parse({ dkb }) { const counter = path.join(dkb.root, '.dkb', 'parse-count.txt'); await fs.mkdir(path.dirname(counter), { recursive: true }); const count = Number.parseInt(await fs.readFile(counter, 'utf8').catch(() => '0'), 10); await fs.writeFile(counter, String(count + 1)); return [{ id: 'proof', path: 'proof.md', text: 'SOURCE-PROOF-14', metadata: {} }]; } });
  context.registerProvider({ kind: 'chunker', async chunk({ documents }) { return [{ id: 'proof-chunk', documentId: documents[0].id, text: documents[0].text, metadata: {} }]; } });
  context.registerProvider({
    kind: 'index', mode: 'packaged', format: 'test.index.v1',
    async compilePackage({ artifactsRoot, compiled }) {
      const target = path.join(artifactsRoot, 'test-index.json');
      const vectors = new Map(compiled.vectors.map((vector) => [vector.evidenceId, vector.values]));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify(compiled.records.map((record) => ({ ...record, embedding: vectors.get(record.id) }))));
      return { providerId: id, providerVersion: version, build: { recordCount: compiled.records.length } };
    },
    async validatePackage() { return { documentCount: 1 }; },
    async openRuntime() { return null; },
  });
  context.registerProvider({ kind: 'retrieval', protocol: 'dkb.evidence.v1', openRuntime() { return { providerId: '@test/retrieval', protocol: 'dkb.evidence.v1', async search() { return { hits: [], trace: {} }; }, close() {} }; } });
  context.registerProcessor({ id, version, stage: 'record', mutate(value) { return { ...value, text: value.text + '-MUTATED' }; } });
}
`, 'utf8');
  const initialEmbedding = pluginPath(path.join(root, '.dkb/plugins'), '@test/initial-embedding');
  await fs.mkdir(path.dirname(initialEmbedding), { recursive: true });
  await fs.writeFile(initialEmbedding, `
export const apiVersion = 2;
export const id = '@test/initial-embedding';
export const version = '1.0.0';
export function setup(context) {
  context.registerProvider({ kind: 'embedding', async embedDocuments({ texts }) { return texts.map(() => [0.6, 0.8]); }, async embedQuery() { return [0.6, 0.8]; }, compatibility() { return { embeddingSpace: 'test-space-v1', dimensions: 2, metric: 'cosine', normalized: true }; } });
}
`, 'utf8');
  const alternate = pluginPath(path.join(root, '.dkb/plugins'), '@test/alternate');
  await fs.mkdir(path.dirname(alternate), { recursive: true });
  await fs.writeFile(alternate, `
export const apiVersion = 2;
export const id = '@test/alternate';
export const version = '1.0.0';
export function setup(context) {
  context.registerProvider({ kind: 'embedding', async embedDocuments({ texts }) { return texts.map(() => [1, 0]); }, async embedQuery() { return [1, 0]; }, compatibility() { return { embeddingSpace: 'test-space-v2', dimensions: 2, metric: 'cosine', normalized: true }; } });
}
`, 'utf8');
  const config = JSON.parse(await fs.readFile(path.join(root, '.dkb/config.json'), 'utf8'));
  config.targets.alternate = {
    parser: '@test/separate',
    chunker: '@test/separate',
    embedding: '@test/alternate',
    index: '@test/separate',
    retrieval: '@test/separate',
    processors: ['@test/separate'],
  };
  await writeJson(path.join(root, '.dkb/config.json'), config);

  const result = await compileComposeProject(root, { force: true, mode: 'package' });
  const graph = await validatePackageBuildGraph(root);
  const [catalog, evidence, profile, indexRecords] = await Promise.all([
    Promise.resolve(readEvidenceCatalog(graph.evidencePath)),
    fs.readFile(path.join(graph.evidencePath, 'evidence.ir.json'), 'utf8').then(JSON.parse).then(validateEvidenceIr),
    readRetrievalProfileLock(graph.retrievalPath),
    fs.readFile(path.join(graph.retrievalPath, 'artifacts', 'test-index.json'), 'utf8').then(JSON.parse),
  ]);

  assert.equal(result.recordCount, 1);
  assert.equal(result.profile.statistics.corpus.sourceFiles, 1);
  assert.equal(result.profile.statistics.corpus.evidenceRecords, 1);
  assert.equal(result.profile.statistics.corpus.recordsPerSource.max, 1);
  assert.ok(result.profile.statistics.storage.totalDerivedBytes > 0);
  assert.ok(result.profile.statistics.diskCapacity.retrieval[0].requiredFreeBytes > 0);
  assert.match(catalog.records[0].text, /SOURCE-PROOF-14-MUTATED/);
  assert.equal(evidence.evidence[0].text, 'SOURCE-PROOF-14-MUTATED');
  assert.equal(indexRecords[0].text, 'SOURCE-PROOF-14-MUTATED');
  assert.equal('compiler' in profile.profile, false);
  assert.equal('extraction' in profile.profile, false);
  assert.deepEqual(profile.profile.evidence.providers.map((provider) => provider.kind), ['parser', 'chunker']);
  assert.deepEqual(profile.profile.evidence.providers.map((provider) => provider.id), ['@test/separate', '@test/separate']);
  assert.deepEqual(profile.profile.retrieval.providers.map((provider) => provider.kind), ['embedding', 'index', 'retrieval']);
  assert.equal(profile.profile.index.provider, '@test/separate');
  assert.equal(profile.compatibility.dimensions, 2);
  assert.equal(await fs.readFile(path.join(root, '.dkb/parse-count.txt'), 'utf8'), '1');

  await compileRetrievalFromEvidence(root, evidence, { target: 'alternate' });
  const alternateGraph = await validatePackageBuildGraph(root);
  const alternateEvidence = validateEvidenceIr(JSON.parse(await fs.readFile(path.join(alternateGraph.evidencePath, 'evidence.ir.json'), 'utf8')));
  const alternateProfile = await readRetrievalProfileLock(alternateGraph.retrievalPath);
  const alternateIndex = JSON.parse(await fs.readFile(path.join(alternateGraph.retrievalPath, 'artifacts', 'test-index.json'), 'utf8'));

  assert.equal(await fs.readFile(path.join(root, '.dkb/parse-count.txt'), 'utf8'), '1');
  assert.equal(alternateEvidence.evidenceDigest, evidence.evidenceDigest);
  assert.equal(alternateProfile.profile.evidence.profileDigest, profile.profile.evidence.profileDigest);
  assert.notEqual(alternateProfile.profileDigest, profile.profileDigest);
  assert.deepEqual(alternateIndex[0].embedding, [1, 0]);
});

test('embedding cache reuses exact text within one space and misses after a space change', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-embedding-cache-'));
  const counterPath = path.join(root, 'embed-count.txt');
  const previousCounter = process.env.DKB_TEST_EMBED_COUNTER;
  process.env.DKB_TEST_EMBED_COUNTER = counterPath;
  t.after(async () => {
    if (previousCounter === undefined) delete process.env.DKB_TEST_EMBED_COUNTER;
    else process.env.DKB_TEST_EMBED_COUNTER = previousCounter;
    await fs.rm(root, { recursive: true, force: true });
  });
  await writeJson(path.join(root, 'dkb.json'), {
    manifestVersion: 1,
    type: 'dkb',
    name: '@test/embedding-cache',
    version: '1.0.0',
    permissions: { read: true, write: false },
  });
  await fs.writeFile(path.join(root, 'knowledge.md'), 'CACHE-SPACE-55', 'utf8');
  await writeJson(path.join(root, '.dkb/config.json'), {
    format: DKB_CONFIG_FORMAT,
    activeTarget: 'first',
    targets: {
      first: {
        evidence: '@test/cache-core',
        embedding: '@test/cache-embedding',
        index: '@test/cache-core',
        retrieval: '@test/cache-core',
        options: { '@test/cache-embedding': { space: 'first', value: 0.25 } },
      },
      second: {
        evidence: '@test/cache-core',
        embedding: '@test/cache-embedding',
        index: '@test/cache-core',
        retrieval: '@test/cache-core',
        options: { '@test/cache-embedding': { space: 'second', value: 0.75 } },
      },
    },
  });
  const core = pluginPath(path.join(root, '.dkb/plugins'), '@test/cache-core');
  await fs.mkdir(path.dirname(core), { recursive: true });
  await fs.writeFile(core, `
import fs from 'node:fs/promises';
import path from 'node:path';
export const apiVersion = 2;
export const id = '@test/cache-core';
export const version = '1.0.0';
export function setup(context) {
  context.registerProvider({
    kind: 'evidence',
    async compile({ dkb }) {
      const text = await fs.readFile(path.join(dkb.root, 'knowledge.md'), 'utf8');
      return { records: [{ id: 'cache', chunkId: 'cache', text, embedding: [999], metadata: { assetId: 'knowledge.md', storeId: 'filesystem', type: 'filesystem', locator: { path: 'knowledge.md' }, assetLocator: { path: 'knowledge.md' }, title: 'knowledge.md', hash: 'sha256:cache', updatedAt: '2026-08-28T00:00:00.000Z', chunkOrdinal: 0, chunkStart: 0, chunkEnd: text.length, sourceMetadata: { dkb_path: 'knowledge.md', dkb_source_hash: 'sha256:cache-source' } } }], receipt: { providerId: id, providerVersion: version, build: {} } };
    },
  });
  context.registerProvider({ kind: 'index', mode: 'packaged', format: 'cache.index.v1', async compilePackage({ artifactsRoot, compiled }) { const target = path.join(artifactsRoot, 'cache-index.json'); const vectors = new Map(compiled.vectors.map((vector) => [vector.evidenceId, vector.values])); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, JSON.stringify(compiled.records.map((record) => ({ ...record, embedding: vectors.get(record.id) })))); return { providerId: id, providerVersion: version, build: {} }; }, async validatePackage() { return { documentCount: 1 }; }, async openRuntime() { return null; } });
  context.registerProvider({ kind: 'retrieval', protocol: 'dkb.evidence.v1', openRuntime() { return { providerId: '@test/retrieval', protocol: 'dkb.evidence.v1', async search() { return { hits: [], trace: {} }; }, close() {} }; } });
}
`, 'utf8');
  const embedding = pluginPath(path.join(root, '.dkb/plugins'), '@test/cache-embedding');
  await fs.mkdir(path.dirname(embedding), { recursive: true });
  await fs.writeFile(embedding, `
import fs from 'node:fs/promises';
export const apiVersion = 2;
export const id = '@test/cache-embedding';
export const version = '1.0.0';
export function setup(context) {
  context.registerProvider({
    kind: 'embedding',
    async embedDocuments({ texts, options }) { const target = process.env.DKB_TEST_EMBED_COUNTER; const count = Number.parseInt(await fs.readFile(target, 'utf8').catch(() => '0'), 10); await fs.writeFile(target, String(count + 1)); return texts.map(() => [Number(options.value)]); },
    async embedQuery({ options }) { return [Number(options.value)]; },
    compatibility(options) { return { embeddingSpace: String(options.space), dimensions: 1, metric: 'cosine', normalized: true }; },
  });
}
`, 'utf8');

  await compileComposeProject(root, { force: true, mode: 'package', target: 'first' });
  await compileComposeProject(root, { force: true, mode: 'package', target: 'first' });
  assert.equal(await fs.readFile(counterPath, 'utf8'), '1');
  const firstGraph = await validatePackageBuildGraph(root);
  const firstIndex = JSON.parse(await fs.readFile(path.join(firstGraph.retrievalPath, 'artifacts', 'cache-index.json'), 'utf8'));
  assert.deepEqual(firstIndex[0].embedding, [0.25]);

  await compileComposeProject(root, { force: true, mode: 'package', target: 'second' });
  assert.equal(await fs.readFile(counterPath, 'utf8'), '2');
  const builds = await listPackageBuilds(root);
  assert.equal(builds.evidence.length, 1);
  assert.equal(builds.retrieval.length, 2);

  await fs.writeFile(path.join(root, '.dkb', 'cache', 'embeddings.sqlite'), 'not a sqlite database', 'utf8');
  await compileComposeProject(root, { force: true, mode: 'package', target: 'first' });
  assert.equal(await fs.readFile(counterPath, 'utf8'), '3');
  assert.ok((await fs.readdir(path.join(root, '.dkb', 'cache'))).some((name) => name.startsWith('embeddings.sqlite.corrupt-')));
  assert.equal((await listPackageBuilds(root)).retrieval.length, 2);
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

  const listed = await listPlugins({ distribution: DEFAULT_DKB_DISTRIBUTION, root: library, globalRoot });
  assert.ok(listed.some((entry) => entry.id === '@test/copied' && entry.scope === 'local' && entry.valid));
  assert.ok(listed.some((entry) => entry.id === '@test/linked' && entry.scope === 'global' && entry.valid));
  assert.ok(listed.some((entry) => entry.id === '@dkb/index-faiss' && entry.scope === 'bundled' && entry.selected));

  assert.equal((await removePlugin({ distribution: DEFAULT_DKB_DISTRIBUTION, root: library, globalRoot, id: '@test/copied' })).removed, true);
  assert.equal((await removePlugin({ distribution: DEFAULT_DKB_DISTRIBUTION, root: library, globalRoot, id: '@test/linked', scope: 'global' })).removed, true);
});

test('pipeline changes validate before atomic promotion and preserve the prior configuration on failure', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-promote-'));
  const library = path.join(root, 'library');
  const globalRoot = path.join(root, 'global');
  const configPath = path.join(library, '.dkb/config.json');
  const distribution = distributionWith([allPlugin], targetConfig('@test/all'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const promoted = await setPipelineTarget({
    distribution,
    root: library,
    globalRoot,
    name: 'default',
    activate: true,
    patch: {
      evidence: '@test/all',
      embedding: '@test/all',
      index: '@test/all',
      retrieval: '@test/all',
      processors: [],
    },
  });
  const before = await fs.readFile(configPath, 'utf8');
  assert.equal(promoted.target, 'default');

  await assert.rejects(setPipelineTarget({
    distribution,
    root: library,
    globalRoot,
    name: 'broken',
    activate: true,
    patch: {
      evidence: '@missing/evidence',
      embedding: '@test/all',
      index: '@test/all',
      retrieval: '@test/all',
    },
  }), /Selected plugin @missing\/evidence was not found/);
  assert.equal(await fs.readFile(configPath, 'utf8'), before);
});

test('pipeline activation rejects incompatible installed artifacts without changing configuration', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-compatible-promote-'));
  const library = path.join(root, 'library');
  const globalRoot = path.join(root, 'global');
  const configPath = path.join(library, '.dkb/config.json');
  const distribution = distributionWith([allPlugin], targetConfig('@test/all'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await setPipelineTarget({
    distribution,
    root: library,
    globalRoot,
    name: 'default',
    activate: true,
    patch: {
      evidence: '@test/all',
      embedding: '@test/all',
      index: '@test/all',
      retrieval: '@test/all',
      processors: [],
    },
  });
  const before = await fs.readFile(configPath, 'utf8');
  const host = await DkbProviderHost.create({ root: library, globalRoot, distribution });
  const resolved = await resolveProviderRetrievalProfile(host);
  await host.dispose();
  const { evidenceProfileDigest, retrievalProfileDigest } = resolved;
  const compatibilityDigest = stableHash(resolved.compatibility);
  await writeJson(path.join(library, '.dkb', 'runtime.lock.json'), {
    format: 'dkb.runtime-lock.v2',
    target: 'default',
    evidenceProfileDigest,
    retrievalProfileDigest,
    compatibilityDigest,
    packages: {},
    generation: 1,
    generatedAt: new Date().toISOString(),
  });

  await assert.rejects(setPipelineTarget({
    distribution,
    root: library,
    globalRoot,
    name: 'base',
    activate: true,
    patch: {
      evidence: '@test/all',
      embedding: '@test/all',
      index: '@test/all',
      retrieval: '@test/all',
      processors: [],
      options: { '@test/all': { dimensions: 2 } },
    },
  }), /Cannot activate pipeline target "base".*Save it with --no-activate/);
  assert.equal(await fs.readFile(configPath, 'utf8'), before);
});

function targetConfig(id, processors = []) {
  return {
    format: DKB_CONFIG_FORMAT,
    targets: {
      default: { evidence: id, embedding: id, index: id, retrieval: id, processors },
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
export const apiVersion = 2;
export const id = '@test/all';
export const version = '${version}';
export function setup(context) {
  context.registerProvider({ kind: 'evidence', async compile() { return { records: [], receipt: { providerId: id, providerVersion: version, build: { source: '${source}' } } }; } });
  context.registerProvider({ kind: 'embedding', async embedDocuments({ texts }) { return texts.map(() => [${Number(version[0])}]); }, async embedQuery() { return [${Number(version[0])}]; }, compatibility() { return { dimensions: 1 }; } });
  context.registerProvider({ kind: 'index', mode: 'packaged', format: 'test.v1', async openRuntime() { return null; } });
  context.registerProvider({ kind: 'retrieval', protocol: 'test.evidence.v1', openRuntime() { return { providerId: '@test/retrieval', protocol: 'test.evidence.v1', async search() { return { hits: [], trace: {} }; }, close() {} }; } });
}
`, 'utf8');
}

async function writePluginSource(target, id, version) {
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'helper.txt'), 'support', 'utf8');
  await fs.writeFile(path.join(target, 'plugin.mjs'), `
export const apiVersion = 2;
export const id = '${id}';
export const version = '${version}';
export function setup(context) {
  context.registerProcessor({ id, version, stage: 'record', mutate(value) { return value; } });
}
`, 'utf8');
}
