import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compileComposeProject, ensurePackageBuildForTarget } from '@sjshovan/dkb-compiler/compile.js';
import { listPackageBuilds } from '@sjshovan/dkb-library/builds.js';
import { applyLibraryLock } from '@sjshovan/dkb-library/state.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DKB_RUNTIME_ACTIVATION_PATH } from '@sjshovan/dkb-protocol/paths.js';
import { ensureRuntimeState, writeRuntimeBinding } from '../services/runtime/dist/runtime/activation.js';
import { runtimeStatus } from '../services/runtime/dist/runtime/libraryState.js';
import { switchRuntimePipelineFromRegistry } from '../services/runtime/dist/runtime/pipelineSwitch.js';
import { getOrOpenRuntimeQueryContext } from '../services/runtime/dist/runtime/querySnapshot.js';
import { DEFAULT_DKB_RUNTIME_CONTEXT } from '../services/runtime/dist/defaultComposition.js';

test('two Runtimes share one Library while keeping independent Pipeline activation and rollback', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-shared-library-runtimes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const libraryRoot = path.join(root, 'library');
  const packageRoot = path.join(libraryRoot, 'knowledge');
  const fastRuntimeRoot = path.join(root, 'runtime-fast');
  const teiRuntimeRoot = path.join(root, 'runtime-tei');
  const packageId = '@test/runtime-switch';

  await writeJson(path.join(libraryRoot, 'dkb.json'), {
    type: 'library', name: 'Shared Runtime Library', roots: { [packageId]: { path: 'knowledge' } },
  });
  await writeJson(path.join(packageRoot, 'dkb.json'), {
    manifestVersion: 1, type: 'dkb', name: packageId, version: '1.0.0', permissions: { read: true, write: false },
  });
  await fs.writeFile(path.join(packageRoot, 'knowledge.md'), 'The retained build marker is PIPELINE-SWITCH-42.\n', 'utf8');
  await writePipelinePlugins(libraryRoot);

  await compileComposeProject(packageRoot, { mode: 'package', force: true, target: 'fast', contextRoot: libraryRoot });
  const teiPreparation = await ensurePackageBuildForTarget(packageRoot, { target: 'tei', contextRoot: libraryRoot });
  assert.equal(teiPreparation.preparation, 'retrieval_compiled');
  await applyLibraryLock(libraryRoot, libraryLock(packageId, 1));
  await Promise.all([
    writeRuntimeBinding(fastRuntimeRoot, { runtimeId: 'fast-runtime', libraryRoot, target: 'fast' }),
    writeRuntimeBinding(teiRuntimeRoot, { runtimeId: 'tei-runtime', libraryRoot, target: 'tei' }),
  ]);

  const fast = await switchRuntimePipelineFromRegistry({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: fastRuntimeRoot, target: 'fast' });
  const tei = await switchRuntimePipelineFromRegistry({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: teiRuntimeRoot, target: 'tei' });
  const fastState = await ensureRuntimeState(fastRuntimeRoot);
  const teiState = await ensureRuntimeState(teiRuntimeRoot);

  assert.equal(fast.target, 'fast');
  assert.equal(tei.target, 'tei');
  assert.equal(fastState.libraryRoot, teiState.libraryRoot);
  assert.equal(fast.evidenceProfileDigest, tei.evidenceProfileDigest);
  assert.equal(fastState.activation.packages[packageId].evidenceDigest, teiState.activation.packages[packageId].evidenceDigest);
  assert.notEqual(fast.compatibilityDigest, tei.compatibilityDigest);
  assert.notEqual(fastState.activation.packages[packageId].retrievalBuildDigest, teiState.activation.packages[packageId].retrievalBuildDigest);
  assert.equal(JSON.stringify(fastState.activation).includes(libraryRoot), false);
  await assert.rejects(fs.access(path.join(libraryRoot, ...DKB_RUNTIME_ACTIVATION_PATH.split('/'))));

  const teiActivationBefore = await activationBytes(teiRuntimeRoot);
  await switchRuntimePipelineFromRegistry({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: fastRuntimeRoot, target: 'tei' });
  assert.deepEqual(await activationBytes(teiRuntimeRoot), teiActivationBefore);
  assert.equal((await runtimeStatus(teiRuntimeRoot)).target, 'tei');

  const builds = await listPackageBuilds(packageRoot);
  assert.equal(builds.evidence.length, 1);
  assert.equal(builds.retrieval.length, 2);
  const teiBuild = builds.retrieval.find((item) => item.profileDigest === teiPreparation.retrievalProfileDigest);
  assert.ok(teiBuild);
  await fs.appendFile(path.join(teiBuild.path, 'artifacts', 'test-index.json'), '\ncorrupt\n', 'utf8');
  await switchRuntimePipelineFromRegistry({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: fastRuntimeRoot, target: 'fast' });
  const fastActivationBefore = await activationBytes(fastRuntimeRoot);
  await assert.rejects(
    switchRuntimePipelineFromRegistry({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: fastRuntimeRoot, target: 'tei' }),
    /artifact tree mismatch/i,
  );
  assert.deepEqual(await activationBytes(fastRuntimeRoot), fastActivationBefore);

  await applyLibraryLock(libraryRoot, libraryLock(packageId, 2));
  assert.equal((await runtimeStatus(fastRuntimeRoot)).stale, true);
  assert.equal((await runtimeStatus(teiRuntimeRoot)).stale, true);
  await assert.rejects(
    getOrOpenRuntimeQueryContext(await ensureRuntimeState(fastRuntimeRoot), 'Shared Runtime Library', DEFAULT_DKB_RUNTIME_CONTEXT),
    /Runtime fast-runtime is stale/i,
  );
});

function libraryLock(packageId, generation) {
  return {
    library: { name: 'Shared Runtime Library' }, generation,
    entries: { [packageId]: {
      identity: packageId, kind: 'dkb', source: 'local', version: '1.0.0',
      digest: stableHash({ package: packageId, version: '1.0.0' }), path: 'knowledge',
      requiredBy: [`root:${packageId}`], installedAt: '2026-08-28T00:00:00.000Z',
    } },
    resolvedAt: '2026-08-28T00:00:00.000Z',
  };
}

async function activationBytes(runtimeRoot) {
  return fs.readFile(path.join(runtimeRoot, ...DKB_RUNTIME_ACTIVATION_PATH.split('/')));
}

async function writePipelinePlugins(root) {
  await writeJson(path.join(root, '.dkb', 'config.json'), {
    format: 'dkb.config.v2', activeTarget: 'fast',
    targets: {
      fast: { evidence: '@test/core', embedding: '@test/fast', index: '@test/core', retrieval: '@test/core' },
      tei: { evidence: '@test/core', embedding: '@test/tei', index: '@test/core', retrieval: '@test/core' },
    },
  });
  await writePlugin(root, '@test', 'core', `
import fs from 'node:fs/promises'; import path from 'node:path';
export const apiVersion=2; export const id='@test/core'; export const version='1.0.0';
export function setup(context) {
  context.registerProvider({kind:'evidence',async compile({dkb}){const text=await fs.readFile(path.join(dkb.root,'knowledge.md'),'utf8');return {records:[{id:'record-1',chunkId:'record-1',text,metadata:{assetId:'knowledge.md',storeId:'filesystem',type:'filesystem',locator:{path:'knowledge.md',chunk:0},assetLocator:{path:'knowledge.md'},title:'knowledge.md',hash:'sha256:record-1',updatedAt:'2026-08-28T00:00:00.000Z',chunkOrdinal:0,chunkStart:0,chunkEnd:text.length,sourceMetadata:{dkb_path:'knowledge.md',dkb_source_hash:'sha256:source-1'}}}],receipt:{providerId:id,providerVersion:version,build:{}}};}});
  context.registerProvider({kind:'index',mode:'packaged',format:'test.index.v1',async compilePackage({artifactsRoot,compiled}){const target=path.join(artifactsRoot,'test-index.json');await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,JSON.stringify(compiled.records));return {providerId:id,providerVersion:version,build:{recordCount:compiled.records.length}};},async validatePackage({artifactsRoot}){const records=JSON.parse(await fs.readFile(path.join(artifactsRoot,'test-index.json'),'utf8'));return {documentCount:records.length};},async openRuntime(){return {providerId:id,async search(){return [];},async close(){}};}});
  context.registerProvider({kind:'retrieval',protocol:'dkb.evidence.v1',openRuntime(){return {providerId:'@test/retrieval',protocol:'dkb.evidence.v1',async search(){return {hits:[],trace:{}};},async close(){}};}});
}`);
  await writePlugin(root, '@test', 'fast', embeddingPlugin('@test/fast', 'fast-space', 0.25));
  await writePlugin(root, '@test', 'tei', embeddingPlugin('@test/tei', 'tei-space', 0.75));
}

function embeddingPlugin(id, space, value) {
  return `export const apiVersion=2;export const id='${id}';export const version='1.0.0';export function setup(context){context.registerProvider({kind:'embedding',async embedDocuments({texts}){return texts.map(()=>[${value}]);},async embedQuery(){return [${value}];},compatibility(){return {embeddingSpace:'${space}',dimensions:1,metric:'cosine',normalized:true};},health(){return {ok:true};}});}`;
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
