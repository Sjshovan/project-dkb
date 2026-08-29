import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compileComposeProject, ensurePackageBuildForTarget } from '@sjshovan/dkb-compiler/compile.js';
import {
  activateStoredPackageBuild,
  listPackageBuilds,
  readRuntimeLock,
  writeRuntimeLock,
} from '@sjshovan/dkb-library/builds.js';
import { applyLibraryLock } from '@sjshovan/dkb-library/state.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { refreshRuntimeCatalogFromInstalledArtifacts } from '../services/runtime/dist/runtime/catalog.js';
import { switchRuntimePipelineFromRegistry } from '../services/runtime/dist/runtime/pipelineSwitch.js';
import { DEFAULT_DKB_RUNTIME_CONTEXT } from '../services/runtime/dist/defaultComposition.js';

test('Runtime switches retained package builds atomically without contacting the Registry', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-runtime-pipeline-switch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'knowledge');
  const packageId = '@test/runtime-switch';

  await writeJson(path.join(root, 'dkb.json'), {
    type: 'library',
    name: 'Runtime switch proof',
    roots: { [packageId]: { path: 'knowledge' } },
  });
  await writeJson(path.join(packageRoot, 'dkb.json'), {
    manifestVersion: 1,
    type: 'dkb',
    name: packageId,
    version: '1.0.0',
    permissions: { read: true, write: false },
  });
  await fs.writeFile(path.join(packageRoot, 'knowledge.md'), 'The retained build marker is PIPELINE-SWITCH-42.\n', 'utf8');
  await writePipelinePlugins(root);

  await compileComposeProject(packageRoot, { mode: 'package', force: true, target: 'fast', contextRoot: root });
  const fast = await readRuntimeLock(packageRoot);
  const localPreparation = await ensurePackageBuildForTarget(packageRoot, { target: 'tei', contextRoot: root });
  assert.equal(localPreparation.preparation, 'retrieval_compiled');
  assert.equal((await readRuntimeLock(packageRoot)).target, 'fast');
  const preparedBuilds = await listPackageBuilds(packageRoot);
  const preparedTei = preparedBuilds.retrieval.find((item) => item.profileDigest === localPreparation.retrievalProfileDigest);
  assert.ok(preparedTei);
  const preparedTeiLock = JSON.parse(await fs.readFile(path.join(preparedTei.path, 'retrieval.lock.json'), 'utf8'));
  const tei = {
    evidenceProfileDigest: localPreparation.evidenceProfileDigest,
    retrievalProfileDigest: localPreparation.retrievalProfileDigest,
    compatibilityDigest: preparedTeiLock.compatibilityDigest,
  };
  assert.equal(fast.evidenceProfileDigest, tei.evidenceProfileDigest);
  assert.notEqual(fast.retrievalProfileDigest, tei.retrievalProfileDigest);

  await activateStoredPackageBuild({
    root: packageRoot,
    target: 'fast',
    evidenceProfileDigest: fast.evidenceProfileDigest,
    retrievalProfileDigest: fast.retrievalProfileDigest,
    compatibilityDigest: fast.compatibilityDigest,
  });
  await applyLibraryLock(root, {
    library: { name: 'Runtime switch proof' },
    generation: 1,
    entries: {
      [packageId]: {
        identity: packageId,
        kind: 'dkb',
        source: 'local',
        version: '1.0.0',
        digest: stableHash({ package: packageId, version: '1.0.0' }),
        path: 'knowledge',
        requiredBy: [`root:${packageId}`],
        installedAt: '2026-08-28T00:00:00.000Z',
      },
    },
    resolvedAt: '2026-08-28T00:00:00.000Z',
  });
  await refreshRuntimeCatalogFromInstalledArtifacts(root);
  await writeRuntimeLock(root, {
    ...fast,
    packages: { [packageId]: fast.packages[packageId] },
  });

  const switched = await switchRuntimePipelineFromRegistry({
    runtime: DEFAULT_DKB_RUNTIME_CONTEXT,
    stateRoot: root,
    target: 'tei',
    registryUrl: 'http://127.0.0.1:1',
    timeoutMs: 50,
  });
  assert.equal(switched.previousTarget, 'fast');
  assert.equal(switched.target, 'tei');
  assert.deepEqual(switched.packages.map((item) => item.preparation), ['retained']);
  assert.equal((await readRuntimeLock(root)).target, 'tei');
  assert.equal((await readRuntimeLock(packageRoot)).target, 'tei');

  const switchedBack = await switchRuntimePipelineFromRegistry({
    runtime: DEFAULT_DKB_RUNTIME_CONTEXT,
    stateRoot: root,
    target: 'fast',
    registryUrl: 'http://127.0.0.1:1',
    timeoutMs: 50,
  });
  assert.deepEqual(switchedBack.packages.map((item) => item.preparation), ['retained']);
  assert.equal((await readRuntimeLock(root)).target, 'fast');

  const builds = await listPackageBuilds(packageRoot);
  assert.equal(builds.evidence.length, 1);
  assert.equal(builds.retrieval.length, 2);

  const teiBuild = builds.retrieval.find((item) => item.profileDigest === tei.retrievalProfileDigest);
  assert.ok(teiBuild);
  await fs.appendFile(path.join(teiBuild.path, 'artifacts', 'test-index.json'), '\ncorrupt\n', 'utf8');
  const beforeRootLock = await fs.readFile(path.join(root, '.dkb', 'runtime.lock.json'));
  const beforePackageLock = await fs.readFile(path.join(packageRoot, '.dkb', 'runtime.lock.json'));
  const beforeConfig = await fs.readFile(path.join(root, '.dkb', 'config.json'));

  await assert.rejects(
    switchRuntimePipelineFromRegistry({
      runtime: DEFAULT_DKB_RUNTIME_CONTEXT,
      stateRoot: root,
      target: 'tei',
      registryUrl: 'http://127.0.0.1:1',
      timeoutMs: 50,
    }),
    /artifact tree is corrupt/i,
  );
  assert.deepEqual(await fs.readFile(path.join(root, '.dkb', 'runtime.lock.json')), beforeRootLock);
  assert.deepEqual(await fs.readFile(path.join(packageRoot, '.dkb', 'runtime.lock.json')), beforePackageLock);
  assert.deepEqual(await fs.readFile(path.join(root, '.dkb', 'config.json')), beforeConfig);
  assert.equal((await readRuntimeLock(root)).target, 'fast');
});

async function writePipelinePlugins(root) {
  await writeJson(path.join(root, '.dkb', 'config.json'), {
    format: 'dkb.config.v2',
    activeTarget: 'fast',
    targets: {
      fast: {
        evidence: '@test/core',
        embedding: '@test/fast',
        index: '@test/core',
        retrieval: '@test/core',
      },
      tei: {
        evidence: '@test/core',
        embedding: '@test/tei',
        index: '@test/core',
        retrieval: '@test/core',
      },
    },
  });
  await writePlugin(root, '@test', 'core', `
import fs from 'node:fs/promises';
import path from 'node:path';
export const apiVersion = 2;
export const id = '@test/core';
export const version = '1.0.0';
export function setup(context) {
  context.registerProvider({
    kind: 'evidence',
    async compile({ dkb }) {
      const text = await fs.readFile(path.join(dkb.root, 'knowledge.md'), 'utf8');
      return {
        records: [{
          id: 'record-1', chunkId: 'record-1', text,
          metadata: {
            assetId: 'knowledge.md', storeId: 'filesystem', type: 'filesystem',
            locator: { path: 'knowledge.md', chunk: 0 }, assetLocator: { path: 'knowledge.md' },
            title: 'knowledge.md', hash: 'sha256:record-1', updatedAt: '2026-08-28T00:00:00.000Z',
            chunkOrdinal: 0, chunkStart: 0, chunkEnd: text.length,
            sourceMetadata: { dkb_path: 'knowledge.md', dkb_source_hash: 'sha256:source-1' },
          },
        }],
        receipt: { providerId: id, providerVersion: version, build: {} },
      };
    },
  });
  context.registerProvider({
    kind: 'index', mode: 'packaged', format: 'test.index.v1',
    async compilePackage({ artifactsRoot, compiled }) {
      const target = path.join(artifactsRoot, 'test-index.json');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify(compiled.records));
      return { providerId: id, providerVersion: version, build: { recordCount: compiled.records.length } };
    },
    async validatePackage({ artifactsRoot }) {
      const records = JSON.parse(await fs.readFile(path.join(artifactsRoot, 'test-index.json'), 'utf8'));
      return { documentCount: records.length };
    },
    async openRuntime() { return null; },
  });
  context.registerProvider({ kind: 'retrieval', protocol: 'dkb.evidence.v1', openRuntime() { return { providerId: '@test/retrieval', protocol: 'dkb.evidence.v1', async search() { return { hits: [], trace: {} }; }, close() {} }; } });
}
`);
  await writePlugin(root, '@test', 'fast', embeddingPlugin('@test/fast', 'fast-space', 0.25));
  await writePlugin(root, '@test', 'tei', embeddingPlugin('@test/tei', 'tei-space', 0.75));
}

function embeddingPlugin(id, space, value) {
  return `
export const apiVersion = 2;
export const id = '${id}';
export const version = '1.0.0';
export function setup(context) {
  context.registerProvider({
    kind: 'embedding',
    async embedDocuments({ texts }) { return texts.map(() => [${value}]); },
    async embedQuery() { return [${value}]; },
    compatibility() { return { embeddingSpace: '${space}', dimensions: 1, metric: 'cosine', normalized: true }; },
  });
}
`;
}

async function writePlugin(root, namespace, name, source) {
  const target = path.join(root, '.dkb', 'plugins', namespace, name, 'plugin.mjs');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, source, 'utf8');
}

async function writeJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
