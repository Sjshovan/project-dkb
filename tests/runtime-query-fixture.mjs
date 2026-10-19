import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compileComposeProject } from '@sjshovan/dkb-compiler/compile.js';
import { applyLibraryLock } from '@sjshovan/dkb-library/state.js';
import { closeRuntimeQuerySnapshot, initializeRuntimeBinding } from '@sjshovan/dkb-runtime/runtime/state.js';
import { switchRuntimePipelineFromRegistry } from '@sjshovan/dkb-runtime/runtime/pipelineSwitch.js';
import { searchRuntime } from '@sjshovan/dkb-runtime/runtime/queryAccess.js';
import { DEFAULT_DKB_RUNTIME_CONTEXT as runtime } from '@sjshovan/dkb-runtime/defaultComposition.js';

async function stopChild(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await child.closed;
}
function search(fixture) { return searchRuntime({ stateRoot: fixture.runtimeRoot, runtime, query: 'RECOVERY-MARKER' }); }

export async function createRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-runtime-library-recovery-'));
  const fixture = { root, libraryRoot: path.join(root, 'library'), runtimeRoot: path.join(root, 'runtime'), children: [], disposers: [] };
  t.after(async () => {
    for (const child of fixture.children) await stopChild(child);
    for (const dispose of fixture.disposers) await dispose();
    await closeRuntimeQuerySnapshot(fixture.runtimeRoot);
    await fs.rm(root, { recursive: true, force: true });
  });
  return fixture;
}

export async function createQueryFixture(t, { packageId = '@test/knowledge', version = '1.0.0' } = {}) {
  const fixture = await createRoot(t);
  fixture.packageId = packageId;
  fixture.version = version;
  fixture.packageRoot = path.join(fixture.libraryRoot, 'knowledge');
  await writeJson(path.join(fixture.libraryRoot, 'dkb.json'), { type: 'library', name: 'Recovery Query Library', roots: { [fixture.packageId]: { path: 'knowledge' } } });
  await writeJson(path.join(fixture.packageRoot, 'dkb.json'), { manifestVersion: 1, type: 'dkb', name: fixture.packageId, version, permissions: { read: true, write: false } });
  await fs.writeFile(path.join(fixture.packageRoot, 'knowledge.md'), 'The retained marker is RECOVERY-MARKER.\n');
  await writeJson(path.join(fixture.libraryRoot, '.dkb', 'config.json'), {
    format: 'dkb.config.v2', activeTarget: 'fixture', targets: { fixture: { evidence: '@test/recovery', index: '@test/recovery', retrieval: '@test/recovery' } },
  });
  const pluginPath = path.join(fixture.libraryRoot, '.dkb', 'plugins', '@test', 'recovery', 'plugin.mjs');
  await fs.mkdir(path.dirname(pluginPath), { recursive: true });
  await fs.writeFile(pluginPath, `
import fs from 'node:fs/promises'; import path from 'node:path'; import {createHash} from 'node:crypto';
export const apiVersion=3,id='@test/recovery',version='1.0.0'; export const optionsSchema={'~standard':{version:1,vendor:'test',validate(value){return {value:value??{}};}}};
export function setup(context){
context.registerProvider({kind:'evidence',async compile({dkb}){const text=await fs.readFile(path.join(dkb.root,'knowledge.md'),'utf8'),sourceHash='sha256:'+createHash('sha256').update(text).digest('hex');return {records:[{id:'record-1',chunkId:'record-1',text,provenance:{assetId:'knowledge.md',storeId:'filesystem',sourceType:'filesystem',locator:{path:'knowledge.md',chunk:0},assetLocator:{path:'knowledge.md'},title:'knowledge.md',sourceHash,updatedAt:'2026-09-14T00:00:00.000Z',chunkOrdinal:0,chunkStart:0,chunkEnd:text.length},metadata:{dkb_path:'knowledge.md',dkb_source_hash:sourceHash}}],receipt:{build:{}}};}});
context.registerProvider({kind:'index',mode:'packaged',format:'test.recovery.v1',capabilities:{vectors:'none'},async compilePackage({artifactsRoot,compiled}){await fs.mkdir(artifactsRoot,{recursive:true});await fs.writeFile(path.join(artifactsRoot,'index.json'),JSON.stringify(compiled.records));return {build:{recordCount:compiled.records.length}};},async validatePackage({artifactsRoot}){return {documentCount:JSON.parse(await fs.readFile(path.join(artifactsRoot,'index.json'),'utf8')).length};},async verifyRuntime(){return {indexId:'fixture',documentCount:1,status:'ready'};},async openRuntime(){return null;}});
context.registerProvider({kind:'retrieval',protocol:'dkb.evidence.v1',capabilities:{vectors:'none'},openRuntime({evidence}){return {providerId:id,protocol:'dkb.evidence.v1',async search(){return {hits:evidence.records.map(record=>({evidenceId:record.evidenceId,score:1,channels:['lexical']})),trace:{mode:'fixture'}};},async close(){}};}});
}
`);
  await compileComposeProject(fixture.packageRoot, { force: true, target: 'fixture', contextRoot: fixture.libraryRoot });
  await applyLibraryLock(fixture.libraryRoot, {
    library: { name: 'Recovery Query Library' }, generation: 1, entries: { [fixture.packageId]: {
      identity: fixture.packageId, kind: 'dkb', source: 'local', version, digest: `sha256:${'e'.repeat(64)}`, path: 'knowledge',
      requiredBy: [`root:${fixture.packageId}`], installedAt: '2026-09-14T00:00:00.000Z',
    } }, resolvedAt: '2026-09-14T00:00:00.000Z',
  });
  await initializeRuntimeBinding(fixture.runtimeRoot, { runtimeId: 'recovery', libraryRoot: fixture.libraryRoot, target: 'fixture' });
  await switchRuntimePipelineFromRegistry({ stateRoot: fixture.runtimeRoot, runtime, target: 'fixture' });
  assert.equal((await search(fixture)).results.length, 1);
  return fixture;
}

export async function writeJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
