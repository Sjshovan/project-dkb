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
} from '../dist/src/protocol/manifest.js';
import {
  applyLibraryLock,
  readLibraryState,
} from '../dist/src/library/state.js';
import { inspectTarget } from '../dist/src/inspect/index.js';
import { resolveKnowledgeTarget } from '../dist/src/knowledge/target.js';
import { healthReport } from '../dist/src/lifecycle/health.js';
import { refreshRuntimeCatalogFromInstalledArtifacts } from '../dist/src/runtime/catalog.js';
import { verifyComposeProject } from '../dist/src/compiler/compile.js';
import { inspectDkbArtifactManifest } from '../dist/src/artifacts/manifest.js';
import { snapshotLibraryArtifacts } from '../dist/src/library/artifactSnapshot.js';

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
  await writeCompilerRecord(dkbRoot, '@test/core', 'CORE-MARKER-19');

  const activated = await refreshRuntimeCatalogFromInstalledArtifacts(root);
  assert.equal(activated.recordCount, 1);
  assert.equal((await verifyComposeProject(root)).ok, true);
  assert.equal((await inspectDkbArtifactManifest(root)).counts.packages, 1);

  await writeLibrary(root, {});
  const removed = await refreshRuntimeCatalogFromInstalledArtifacts(root);
  assert.equal(removed.recordCount, 0);
  assert.equal((await verifyComposeProject(root)).ok, true);
  assert.equal((await inspectDkbArtifactManifest(root)).counts.packages, 0);
});

test('failed Library mutations restore aggregate artifacts byte for byte', async (t) => {
  const root = await tempDirectory(t, 'dkb-library-artifact-rollback-');
  const lockPath = path.join(root, '.dkb', 'artifacts', 'dkb-artifact.lock.json');
  const profilePath = path.join(root, 'dkb-profile.lock.json');
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, 'original-lock\n', 'utf8');
  await fs.writeFile(profilePath, 'original-profile\n', 'utf8');

  const snapshot = await snapshotLibraryArtifacts(root);
  await fs.writeFile(lockPath, 'mutated-lock\n', 'utf8');
  await fs.rm(profilePath);
  await fs.writeFile(path.join(root, '.dkb', 'artifacts', 'new-index.bin'), 'new\n', 'utf8');
  await snapshot.rollback();

  assert.equal(await fs.readFile(lockPath, 'utf8'), 'original-lock\n');
  assert.equal(await fs.readFile(profilePath, 'utf8'), 'original-profile\n');
  await assert.rejects(fs.access(path.join(root, '.dkb', 'artifacts', 'new-index.bin')));
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

async function writeCollection(root, name, members) {
  await writeJson(path.join(root, 'dkb.json'), {
    type: 'collection',
    name,
    members,
  });
}

async function writeCompilerRecord(root, dkbId, marker) {
  const target = path.join(root, '.dkb', 'artifacts', 'llamaindex.compiler.json');
  await writeJson(target, {
    records: [{
      id: `${dkbId}:chunk:1`,
      assetId: `${dkbId}:asset:1`,
      storeId: 'root',
      type: 'filesystem',
      locator: { path: 'knowledge.md', lineStart: 1, lineEnd: 1 },
      assetLocator: { path: 'knowledge.md' },
      title: 'Core evidence',
      text: marker,
      hash: `sha256:${'b'.repeat(64)}`,
      sourceHash: `sha256:${'c'.repeat(64)}`,
      updatedAt: '2026-08-26T12:00:00.000Z',
      chunkOrdinal: 0,
      chunkStart: 0,
      chunkEnd: marker.length,
      metadata: {
        dkb_package_id: dkbId,
        dkb_package_version: '1.0.0',
        dkb_path: 'knowledge.md',
      },
    }],
  });
}

async function writeJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
