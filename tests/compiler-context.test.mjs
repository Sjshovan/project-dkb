import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compileComposeProject, compileRetrievalFromEvidence } from '@sjshovan/dkb-compiler/compile.js';
import { validatePackageBuildGraph } from '@sjshovan/dkb-library/builds.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-compiler-context-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), log = path.join(root, 'lifecycle.txt'), mode = path.join(root, 'mode.txt');
  const plugin = path.join(root, '.dkb/plugins/@test/context/plugin.mjs');
  const config = path.join(root, '.dkb/config.json');
  await fs.mkdir(path.dirname(plugin), { recursive: true });
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'dkb.json'), JSON.stringify({ manifestVersion: 1, type: 'dkb', name: '@test/context', version: '1.0.0', permissions: { read: true, write: false } }));
  await fs.writeFile(path.join(source, 'knowledge.md'), 'CONTEXT-PROOF');
  await fs.writeFile(config, JSON.stringify({ format: 'dkb.config.v2', targets: { fixture: { evidence: '@test/context', index: '@test/context', retrieval: '@test/context' } } }));
  await fs.writeFile(mode, 'ok');
  await fs.writeFile(plugin, `
import fs from 'node:fs/promises'; import {appendFileSync} from 'node:fs'; import path from 'node:path'; import {createHash} from 'node:crypto'; import {fileURLToPath} from 'node:url';
const log=${JSON.stringify(log)}, mode=${JSON.stringify(mode)}, config=${JSON.stringify(config)};
export const apiVersion=3,id='@test/context',version='1.0.0';
export const optionsSchema={'~standard':{version:1,vendor:'test',validate(value){return {value:value??{}};}}};
export function setup(context) {
  appendFileSync(log,'setup\\n');
  context.registerProvider({kind:'evidence',async dispose(){await fs.appendFile(log,'dispose\\n');},async compile({dkb}){
    const behavior=await fs.readFile(mode,'utf8');
    if(behavior==='fail') throw new Error('primary provider failure');
    if(behavior==='drift'){const value=JSON.parse(await fs.readFile(config,'utf8'));value.targets.fixture.options={[id]:{changed:true}};await fs.writeFile(config,JSON.stringify(value));}
    if(behavior==='code-drift') await fs.appendFile(fileURLToPath(import.meta.url),'\\n// changed implementation\\n');
    const text=await fs.readFile(path.join(dkb.root,'knowledge.md'),'utf8');
    return {records:[{id:'record',chunkId:'chunk',text,metadata:{},provenance:{assetId:'knowledge.md',storeId:'filesystem',sourceType:'filesystem',locator:{path:'knowledge.md'},assetLocator:{path:'knowledge.md'},title:'Proof',sourceHash:'sha256:'+createHash('sha256').update(text).digest('hex'),updatedAt:'2026-01-01T00:00:00.000Z',chunkOrdinal:0,chunkStart:0,chunkEnd:text.length}}],receipt:{build:{}}};
  }});
  context.registerProvider({kind:'index',mode:'packaged',format:'test.context.v1',capabilities:{vectors:'none'},
    async compilePackage({artifactsRoot,compiled}){await fs.mkdir(artifactsRoot,{recursive:true});await fs.writeFile(path.join(artifactsRoot,'records.json'),JSON.stringify(compiled.records.map(({id,text})=>({id,text}))));return {build:{recordCount:compiled.records.length}};},
    async validatePackage(){return {documentCount:1};},async verifyRuntime(){return {indexId:'test',documentCount:1,status:'ready'};},
    async openRuntime(){return {providerId:id,format:'test.context.v1',async search(){return {candidates:[],trace:{}};},async close(){}};}});
  context.registerProvider({kind:'retrieval',protocol:'test.context.v1',capabilities:{vectors:'none'},
    async openRuntime(){return {providerId:id,protocol:'test.context.v1',async search(){return {hits:[],trace:{}};},async close(){}};}});
}
`);
  return { source, log, mode, options: { contextRoot: root, target: 'fixture' } };
}

test('fresh, cached and retrieval-only compilation each own exactly one provider host', async t => {
  const { source, log, options } = await fixture(t);
  const first = await compileComposeProject(source, options);
  assert.equal(first.cacheHit, false);
  assert.equal(await fs.readFile(log, 'utf8'), 'setup\ndispose\n');
  const graph = await validatePackageBuildGraph(source);
  const cached = await compileComposeProject(source, options);
  assert.equal(cached.cacheHit, true);
  const evidence = JSON.parse(await fs.readFile(path.join(graph.evidencePath, 'evidence.ir.json'), 'utf8'));
  const retrieval = await compileRetrievalFromEvidence(source, evidence, options);
  assert.equal(retrieval.retrievalBuildPath, first.retrievalBuildPath);
  assert.equal(await fs.readFile(log, 'utf8'), 'setup\ndispose\n'.repeat(3));
});

test('provider failure disposes the single compilation host without promoting a build', async t => {
  const { source, log, mode, options } = await fixture(t);
  await fs.writeFile(mode, 'fail');
  await assert.rejects(compileComposeProject(source, options), /primary provider failure/);
  assert.equal(await fs.readFile(log, 'utf8'), 'setup\ndispose\n');
  await assert.rejects(fs.access(path.join(source, '.dkb/builds')), { code: 'ENOENT' });
});

for (const behavior of ['drift', 'code-drift']) test(`${behavior} during provider execution preserves the previous immutable build`, async t => {
  const { source, log, mode, options } = await fixture(t);
  const first = await compileComposeProject(source, options);
  const lockPath = path.join(first.retrievalBuildPath, 'retrieval.lock.json');
  const original = await fs.readFile(lockPath, 'utf8');
  await fs.writeFile(mode, behavior);
  await assert.rejects(compileComposeProject(source, { ...options, force: true }), /configuration changed|plugin code, dependency, or plugin precedence changed/);
  assert.equal(await fs.readFile(lockPath, 'utf8'), original);
  assert.equal(await fs.readFile(path.join(source, 'knowledge.md'), 'utf8'), 'CONTEXT-PROOF');
  assert.equal(await fs.readFile(log, 'utf8'), 'setup\ndispose\n'.repeat(2));
});
