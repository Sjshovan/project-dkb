import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compileComposeProject, compileKnowledgeTarget } from '@sjshovan/dkb-compiler/compile.js';
import { listPackageBuilds, validatePackageBuildGraph } from '@sjshovan/dkb-library/builds.js';

test('Library compilation builds editable DKBs independently and retains Registry packages', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-compiler-library-target-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const libraryRoot = path.join(root, 'library');
  const editableRoots = [path.join(libraryRoot, 'alpha'), path.join(libraryRoot, 'beta')];
  const registryRoot = path.join(libraryRoot, 'vendor', '@vendor', 'reference');
  await writeJson(path.join(libraryRoot, 'dkb.json'), {
    type: 'library',
    name: 'Compiler Library',
    roots: {
      '@test/alpha': { path: 'alpha' },
      '@test/beta': { path: 'beta' },
      '@vendor/reference': { version: '2.0.0' },
    },
  });
  await writePipeline(libraryRoot);

  for (const [index, packageRoot] of editableRoots.entries()) {
    await writeJson(path.join(packageRoot, 'dkb.json'), {
      manifestVersion: 1,
      type: 'dkb',
      name: `@test/${index === 0 ? 'alpha' : 'beta'}`,
      version: '1.0.0',
      permissions: { read: true, write: false },
    });
    await fs.writeFile(path.join(packageRoot, 'knowledge.md'), `Editable package ${index + 1}.\n`, 'utf8');
  }
  await writeJson(path.join(registryRoot, 'dkb.json'), {
    manifestVersion: 1,
    type: 'dkb',
    name: '@vendor/reference',
    version: '2.0.0',
    permissions: { read: true, write: false },
  });
  await fs.writeFile(path.join(registryRoot, 'knowledge.md'), 'Signed Registry knowledge.\n', 'utf8');

  const first = await compileKnowledgeTarget(libraryRoot, { force: true });
  assert.equal(first.type, 'library');
  assert.equal(first.packageCount, 2);
  assert.equal(first.registryPackageCount, 1);
  assert.equal(first.recordCount, 2);
  assert.deepEqual(first.packages.map((entry) => entry.id), ['@test/alpha', '@test/beta']);
  assert.deepEqual(first.registryPackages.map((entry) => entry.id), ['@vendor/reference']);
  assert.equal(first.registryPackages[0].status, 'retained');

  for (const packageRoot of editableRoots) {
    const graph = await validatePackageBuildGraph(packageRoot);
    assert.ok(graph.evidencePath.startsWith(packageRoot));
    assert.ok(graph.retrievalPath.startsWith(packageRoot));
  }
  const registryBuilds = await listPackageBuilds(registryRoot);
  assert.deepEqual(registryBuilds.evidence, []);
  assert.deepEqual(registryBuilds.retrieval, []);

  const cached = await compileKnowledgeTarget(libraryRoot);
  assert.equal(cached.type, 'library');
  assert.equal(cached.cacheHit, true);
  assert.equal(cached.packages.every((entry) => entry.cacheHit), true);

  await assert.rejects(
    compileComposeProject(libraryRoot),
    /PackageVersion compilation requires a DKB manifest/,
  );
});

test('Collections remain dependency manifests and cannot be compiled as packages', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-compiler-collection-target-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeJson(path.join(root, 'dkb.json'), {
    manifestVersion: 1,
    type: 'collection',
    name: '@test/bundle',
    members: {},
  });

  await assert.rejects(
    compileKnowledgeTarget(root),
    /Collection @test\/bundle does not have Evidence or Retrieval Builds/,
  );
});

async function writePipeline(root) {
  await writeJson(path.join(root, '.dkb', 'config.json'), {
    format: 'dkb.config.v2',
    activeTarget: 'fixture',
    targets: {
      fixture: {
        evidence: '@test/compiler-fixture',
        embedding: '@test/compiler-fixture',
        index: '@test/compiler-fixture',
        retrieval: '@test/compiler-fixture',
      },
    },
  });
  const plugin = path.join(root, '.dkb', 'plugins', '@test', 'compiler-fixture', 'plugin.mjs');
  await fs.mkdir(path.dirname(plugin), { recursive: true });
  await fs.writeFile(plugin, `
import fs from 'node:fs/promises';
import path from 'node:path';
export const apiVersion = 3;
export const id = '@test/compiler-fixture';
export const version = '1.0.0';
export const optionsSchema = { '~standard': { version: 1, vendor: 'test', validate(value) { return { value: value ?? {} }; } } };
export function setup(context) {
  context.registerProvider({
    kind: 'evidence',
    async compile({ dkb }) {
      const text = await fs.readFile(path.join(dkb.root, 'knowledge.md'), 'utf8');
      return { records: [{
        id: 'knowledge', chunkId: 'knowledge', text,
        provenance: {
          assetId: 'knowledge.md', storeId: 'filesystem', sourceType: 'filesystem',
          locator: { path: 'knowledge.md', chunk: 0 }, assetLocator: { path: 'knowledge.md' },
          title: 'knowledge.md', sourceHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          updatedAt: '2026-09-02T00:00:00.000Z', chunkOrdinal: 0, chunkStart: 0, chunkEnd: text.length,
        },
        metadata: { dkb_path: 'knowledge.md', dkb_source_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      }], receipt: { build: {} } };
    },
  });
  context.registerProvider({
    kind: 'embedding',
    async embedDocuments({ texts }) { return texts.map(() => [1]); },
    async embedQuery() { return [1]; },
    compatibility() { return { embeddingSpace: 'fixture-space', dimensions: 1, metric: 'cosine', normalized: true }; },
  });
  context.registerProvider({
    kind: 'index', mode: 'packaged', format: 'fixture.index.v1', capabilities: { vectors: 'required' },
    async compilePackage({ artifactsRoot, compiled }) {
      await fs.mkdir(artifactsRoot, { recursive: true });
      await fs.writeFile(path.join(artifactsRoot, 'fixture.json'), JSON.stringify(compiled.records));
      return { build: { recordCount: compiled.records.length } };
    },
    async validatePackage({ artifactsRoot }) {
      const records = JSON.parse(await fs.readFile(path.join(artifactsRoot, 'fixture.json'), 'utf8'));
      return { documentCount: records.length };
    },
    async verifyRuntime() { return { indexId: 'fixture', documentCount: 1, status: 'ready' }; },
    async openRuntime() { return null; },
  });
  context.registerProvider({
    kind: 'retrieval', protocol: 'dkb.evidence.v1', capabilities: { vectors: 'optional' },
    openRuntime() { return { providerId: id, protocol: 'dkb.evidence.v1', async search() { return { hits: [], trace: {} }; }, async close() {} }; },
  });
}
`, 'utf8');
}

async function writeJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
