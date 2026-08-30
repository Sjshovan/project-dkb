import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  discoverLibraryEntries,
  loadLibrary,
  loadManifest,
  uniqueLoadedDkbs,
} from '@sjshovan/dkb-protocol/manifest.js';
import {
  applyLibraryLock,
  readLibraryState,
} from '@sjshovan/dkb-library/state.js';
import { inspectTarget } from '../apps/cli/dist/inspect/index.js';
import { resolveKnowledgeTarget } from '../apps/cli/dist/knowledge/target.js';
import { healthReport } from '../apps/cli/dist/lifecycle/health.js';
import { refreshRuntimeCatalogFromInstalledArtifacts } from '../services/runtime/dist/runtime/catalog.js';
import { compileComposeProject } from '@sjshovan/dkb-compiler/compile.js';
import { snapshotRuntimeReceipts } from '@sjshovan/dkb-library/runtimeSnapshot.js';
import { validatePackageBuildGraph, verifyKnowledgeBuilds, writeRuntimeLock } from '@sjshovan/dkb-library/builds.js';
import {
  inspectInstalledPackage,
  listInstalledPackageContents,
  previewInstalledPackageFile,
  verifyInstalledPackage,
} from '@sjshovan/dkb-library/packageInfo.js';

test('hard-cutover manifests reject legacy types and unscoped DKB identities', async (t) => {
  const root = await tempDirectory(t, 'dkb-manifest-cutover-');

  await writeJson(path.join(root, 'dkb.json'), {
    type: 'package',
    name: 'legacy',
    version: '1.0.0',
  });
  await assert.rejects(loadManifest(root), /must be equal to one of the allowed values/);

  await writeJson(path.join(root, 'dkb.json'), {
    type: 'dkb',
    name: 'unscoped',
    version: '1.0.0',
  });
  await assert.rejects(loadManifest(root), /must match pattern/);
});

test('Library discovery is flat and manifest type determines each entry kind', async (t) => {
  const root = await tempDirectory(t, 'dkb-flat-library-');
  await writeLibrary(root, {});
  await writeDkb(path.join(root, 'alpha'), '@test/alpha', '1.0.0');
  await writeCollection(path.join(root, 'bundle'), '@test/bundle', { '@test/alpha': '1.0.0' });
  await writeDkb(path.join(root, 'container', 'nested'), '@test/nested', '1.0.0');

  const entries = await discoverLibraryEntries(root);
  assert.deepEqual(entries.map((entry) => [entry.manifest.name, entry.manifest.type]), [
    ['@test/alpha', 'dkb'],
    ['@test/bundle', 'collection'],
  ]);
});

test('filesystem presence does not activate local or vendor knowledge', async (t) => {
  const root = await tempDirectory(t, 'dkb-inactive-library-');
  await writeLibrary(root, {});
  await writeDkb(path.join(root, 'local-copy'), '@test/local-copy', '1.0.0');
  await writeDkb(path.join(root, 'vendor', '@vendor', 'reference'), '@vendor/reference', '2.4.1');

  const library = await loadLibrary(root);
  assert.equal(library.dkbs.length, 0);
  assert.equal(library.collections.length, 0);
});

test('active Collection roots resolve exact member versions without copying DKBs', async (t) => {
  const root = await tempDirectory(t, 'dkb-collection-library-');
  await writeLibrary(root, {
    '@test/toolbox': { path: 'toolbox' },
  });
  await writeCollection(path.join(root, 'toolbox'), '@test/toolbox', {
    '@test/core': '1.3.0',
    '@vendor/reference': '2.4.1',
  });
  await writeDkb(path.join(root, 'core'), '@test/core', '1.3.0');
  await writeDkb(path.join(root, 'vendor', '@vendor', 'reference'), '@vendor/reference', '2.4.1');

  const library = await loadLibrary(root);
  assert.equal(library.collections.length, 1);
  assert.equal(library.dkbs.length, 0);
  assert.deepEqual(library.collections[0].dkbs.map((dkb) => `${dkb.manifest.id}@${dkb.manifest.version}`), [
    '@test/core@1.3.0',
    '@vendor/reference@2.4.1',
  ]);

  await applyLibraryLock(root, {
    library: { name: 'Test Library' },
    generation: 1,
    entries: {
      '@test/toolbox': {
        identity: '@test/toolbox', kind: 'collection', source: 'local', revision: 1, path: 'toolbox',
        requiredBy: ['root:@test/toolbox'], installedAt: '2026-08-30T12:00:00.000Z',
      },
      '@test/core': {
        identity: '@test/core', kind: 'dkb', source: 'local', version: '1.3.0', path: 'core',
        requiredBy: ['collection:@test/toolbox'], installedAt: '2026-08-30T12:00:00.000Z',
      },
      '@vendor/reference': {
        identity: '@vendor/reference', kind: 'dkb', source: 'registry', version: '2.4.1', digest: `sha256:${'d'.repeat(64)}`,
        path: 'vendor/@vendor/reference', requiredBy: ['collection:@test/toolbox'], installedAt: '2026-08-30T12:00:00.000Z',
      },
    },
    resolvedAt: '2026-08-30T12:00:00.000Z',
  });
  const collectionDetail = await inspectInstalledPackage(root, '@test/toolbox');
  assert.equal(collectionDetail.kind, 'collection');
  assert.equal(collectionDetail.activeBuild, undefined);
  assert.deepEqual(collectionDetail.members.map((member) => [member.identity, member.resolved, member.status, member.direct]), [
    ['@test/core', '1.3.0', 'installed', true],
    ['@vendor/reference', '2.4.1', 'installed', true],
  ]);

  await writeDkb(path.join(root, 'vendor', '@vendor', 'reference'), '@vendor/reference', '3.0.0');
  await assert.rejects(loadLibrary(root), /Version conflict for @vendor\/reference/);
});

test('the applied-state ledger distinguishes installed entries from broken content', async (t) => {
  const root = await tempDirectory(t, 'dkb-library-ledger-');
  const installedRoot = path.join(root, 'vendor', '@vendor', 'reference');
  await writeLibrary(root, { '@vendor/reference': { version: '2.4.1' } });
  await writeDkb(installedRoot, '@vendor/reference', '2.4.1');

  const lock = {
    library: { name: 'Test Library' },
    generation: 1,
    entries: {
      '@vendor/reference': {
        identity: '@vendor/reference',
        kind: 'dkb',
        source: 'registry',
        version: '2.4.1',
        digest: `sha256:${'a'.repeat(64)}`,
        path: 'vendor/@vendor/reference',
        registryUrl: 'https://registry.example',
        requiredBy: ['root:@vendor/reference'],
        installedAt: '2026-08-26T12:00:00.000Z',
      },
    },
    resolvedAt: '2026-08-26T12:00:00.000Z',
  };

  const applied = await applyLibraryLock(root, lock);
  assert.equal(applied.entries['@vendor/reference'].status, 'installed');

  await fs.rm(path.join(installedRoot, 'dkb.json'));
  const broken = await readLibraryState(root);
  assert.equal(broken.entries['@vendor/reference'].status, 'broken');
});

test('shared Collection members are indexed once and Library-facing commands resolve the hard-cut type', async (t) => {
  const root = await tempDirectory(t, 'dkb-shared-library-');
  await writeLibrary(root, {
    '@test/first': { path: 'first' },
    '@test/second': { path: 'second' },
  });
  await writeCollection(path.join(root, 'first'), '@test/first', { '@test/core': '1.0.0' });
  await writeCollection(path.join(root, 'second'), '@test/second', { '@test/core': '1.0.0' });
  await writeDkb(path.join(root, 'core'), '@test/core', '1.0.0');

  const library = await loadLibrary(root);
  assert.equal(uniqueLoadedDkbs(library.collections.flatMap((collection) => collection.dkbs)).length, 1);

  const target = await resolveKnowledgeTarget(root);
  assert.equal(target.type, 'library');
  assert.equal(target.includedDkbs.length, 1);
  assert.equal(target.duplicateDkbRoots.length, 1);

  const inspected = await inspectTarget(root);
  assert.equal(inspected.type, 'library');
  assert.deepEqual(inspected.dkbs.map((dkb) => dkb.id), ['@test/core']);

  const health = await healthReport(root);
  assert.equal(health.type, 'library');
  assert.equal(health.status, 'degraded');
  assert.match(health.checks.find((check) => check.name === 'manifest').detail, /^library:/);
});

test('activating precompiled knowledge refreshes Library integrity metadata without recompilation', async (t) => {
  const root = await tempDirectory(t, 'dkb-library-artifact-refresh-');
  const dkbRoot = path.join(root, 'core');
  await writeLibrary(root, { '@test/core': { path: 'core' } });
  await writeDkb(dkbRoot, '@test/core', '1.0.0');
  await writeTestPipeline(dkbRoot);
  await compileComposeProject(dkbRoot, { force: true, mode: 'package' });
  await fs.mkdir(path.join(dkbRoot, 'guides'), { recursive: true });
  await fs.writeFile(path.join(dkbRoot, 'guides', 'usage.md'), '# Safe preview\n\n<script>alert(1)</script>\n', 'utf8');
  await fs.writeFile(path.join(dkbRoot, 'diagram.svg'), '<svg onload="alert(1)"></svg>\n', 'utf8');
  await fs.writeFile(path.join(dkbRoot, 'large.txt'), 'x'.repeat((256 * 1024) + 100), 'utf8');
  await fs.writeFile(path.join(dkbRoot, '.dkb', 'private.txt'), 'not portable\n', 'utf8');
  await applyLibraryLock(root, {
    library: { name: 'Test Library' },
    generation: 1,
    entries: {
      '@test/core': {
        identity: '@test/core', kind: 'dkb', source: 'local', version: '1.0.0', path: 'core',
        requiredBy: ['root:@test/core'], installedAt: '2026-08-30T12:00:00.000Z',
      },
    },
    resolvedAt: '2026-08-30T12:00:00.000Z',
  });
  const graph = await validatePackageBuildGraph(dkbRoot);
  const packageLockPath = path.join(graph.retrievalPath, 'retrieval.lock.json');
  const packageLock = await fs.readFile(packageLockPath, 'utf8');

  const activated = await refreshRuntimeCatalogFromInstalledArtifacts(root);
  assert.equal(activated.recordCount, 1);
  assert.equal(activated.packageCount, 1);
  assert.equal(await fs.readFile(packageLockPath, 'utf8'), packageLock);
  await validatePackageBuildGraph(dkbRoot);
  await writeRuntimeLock(root, graph.runtime);
  const verified = await verifyKnowledgeBuilds(root);
  assert.equal(verified.ok, true, JSON.stringify(verified.checks));
  assert.equal(verified.type, 'library');
  assert.equal(verified.checks.some((check) => check.name === 'build.@test/core' && check.ok), true);

  const detail = await inspectInstalledPackage(root, '@test/core');
  assert.equal(detail.format, 'dkb.installed-entry-detail.v1');
  assert.equal(detail.activeBuild.evidenceDigest, graph.evidence.evidenceDigest);
  assert.equal(detail.sourceSummary.evidenceRecords, 1);
  assert.equal(detail.provenance.receiptStatus, 'not_applicable');
  assert.equal(detail.integrity.status, 'passed');

  const contents = await listInstalledPackageContents({ libraryRoot: root, identity: '@test/core', directory: '.' });
  assert.deepEqual(contents.entries.map((entry) => entry.name), ['diagram.svg', 'dkb.json', 'guides', 'knowledge.md', 'large.txt']);
  assert.equal(contents.entries.some((entry) => entry.name === '.dkb'), false);
  assert.equal(contents.entries.find((entry) => entry.name === 'diagram.svg').previewable, false);
  assert.equal(contents.entries.find((entry) => entry.name === 'knowledge.md').evidenceRecords, 1);
  const firstPage = await listInstalledPackageContents({ libraryRoot: root, identity: '@test/core', directory: '.', limit: 2 });
  assert.deepEqual(firstPage.entries.map((entry) => entry.name), ['diagram.svg', 'dkb.json']);
  assert.equal(firstPage.nextCursor, 'dkb.json');
  const secondPage = await listInstalledPackageContents({ libraryRoot: root, identity: '@test/core', directory: '.', cursor: firstPage.nextCursor, limit: 2 });
  assert.deepEqual(secondPage.entries.map((entry) => entry.name), ['guides', 'knowledge.md']);

  const preview = await previewInstalledPackageFile({ libraryRoot: root, identity: '@test/core', file: 'guides/usage.md' });
  assert.equal(preview.previewable, true);
  assert.match(preview.content, /<script>alert\(1\)<\/script>/u);
  const image = await previewInstalledPackageFile({ libraryRoot: root, identity: '@test/core', file: 'diagram.svg' });
  assert.equal(image.previewable, false);
  assert.equal(image.content, undefined);
  const truncated = await previewInstalledPackageFile({ libraryRoot: root, identity: '@test/core', file: 'large.txt' });
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.bytesRead, 256 * 1024);
  await assert.rejects(
    previewInstalledPackageFile({ libraryRoot: root, identity: '@test/core', file: '../outside.txt' }),
    /not part of the portable package tree/u,
  );

  const packageVerification = await verifyInstalledPackage({ libraryRoot: root, identity: '@test/core' });
  assert.equal(packageVerification.status, 'passed');
  assert.equal(packageVerification.checks.find((check) => check.id === 'package.receipt').status, 'not_applicable');

  await writeLibrary(root, {});
  const removed = await refreshRuntimeCatalogFromInstalledArtifacts(root);
  assert.equal(removed.recordCount, 0);
  assert.equal(removed.packageCount, 0);
});

test('failed Library mutations restore mutable Runtime receipts byte for byte', async (t) => {
  const root = await tempDirectory(t, 'dkb-runtime-receipt-rollback-');
  const lockPath = path.join(root, '.dkb', 'runtime.lock.json');
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, 'original-lock\n', 'utf8');

  const snapshot = await snapshotRuntimeReceipts(root);
  await fs.writeFile(lockPath, 'mutated-lock\n', 'utf8');
  const cachePath = path.join(root, '.dkb', 'cache', 'compile-cache.json');
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, 'new-cache\n', 'utf8');
  await snapshot.rollback();

  assert.equal(await fs.readFile(lockPath, 'utf8'), 'original-lock\n');
  await assert.rejects(fs.access(cachePath));
});

async function tempDirectory(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeLibrary(root, roots) {
  await writeJson(path.join(root, 'dkb.json'), {
    type: 'library',
    name: 'Test Library',
    roots,
  });
}

async function writeDkb(root, name, version) {
  await writeJson(path.join(root, 'dkb.json'), {
    type: 'dkb',
    name,
    version,
    permissions: { read: true, write: false },
  });
  await fs.writeFile(path.join(root, 'knowledge.md'), `${name} evidence\n`, 'utf8');
}

async function writeTestPipeline(root) {
  const pluginRoot = path.join(root, '.dkb', 'plugins', '@test', 'pipeline');
  await writeJson(path.join(root, '.dkb', 'config.json'), {
    format: 'dkb.config.v2',
    targets: {
      default: {
        evidence: '@test/pipeline',
        embedding: '@test/pipeline',
        index: '@test/pipeline',
        retrieval: '@test/pipeline',
      },
    },
  });
  await fs.mkdir(pluginRoot, { recursive: true });
  await fs.writeFile(path.join(pluginRoot, 'plugin.mjs'), `
import fs from 'node:fs/promises';
import path from 'node:path';
export const apiVersion = 2;
export const id = '@test/pipeline';
export const version = '1.0.0';
export function setup(context) {
  context.registerProvider({
    kind: 'evidence',
    async compile({ dkb }) {
      const text = await fs.readFile(path.join(dkb.root, 'knowledge.md'), 'utf8');
      return {
        records: [{
          id: 'test-record', chunkId: 'test-record', text,
          metadata: {
            assetId: 'knowledge.md', storeId: 'filesystem', type: 'filesystem',
            locator: { path: 'knowledge.md', chunk: 0 }, assetLocator: { path: 'knowledge.md' },
            title: 'knowledge.md', hash: 'sha256:test-record', updatedAt: '2026-08-27T00:00:00.000Z',
            chunkOrdinal: 0, chunkStart: 0, chunkEnd: text.length,
            sourceMetadata: { dkb_path: 'knowledge.md', dkb_source_hash: 'sha256:test-source' },
          },
        }],
        receipt: { providerId: id, providerVersion: version, build: {} },
      };
    },
  });
  context.registerProvider({
    kind: 'embedding',
    async embedDocuments({ texts }) { return texts.map(() => [1]); },
    async embedQuery() { return [1]; },
    compatibility() { return { embeddingSpace: 'test', dimensions: 1, metric: 'cosine', normalized: true }; },
  });
  context.registerProvider({
    kind: 'index', mode: 'packaged', format: 'test.index.v1',
    async compilePackage({ artifactsRoot, compiled }) {
      const target = path.join(artifactsRoot, 'test-index.json');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify(compiled.records));
      return { providerId: id, providerVersion: version, build: { recordCount: compiled.records.length } };
    },
    async validatePackage() { return { documentCount: 1 }; },
    async openRuntime() { return null; },
  });
  context.registerProvider({ kind: 'retrieval', protocol: 'dkb.evidence.v1', openRuntime() { return { providerId: '@test/retrieval', protocol: 'dkb.evidence.v1', async search() { return { hits: [], trace: {} }; }, close() {} }; } });
}
`, 'utf8');
}

async function writeCollection(root, name, members) {
  await writeJson(path.join(root, 'dkb.json'), {
    type: 'collection',
    name,
    members,
  });
}

async function writeJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
