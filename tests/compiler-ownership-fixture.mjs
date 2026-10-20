import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// A real selected provider whose cleanup is controlled outside the immutable source tree.
export async function createCompilerOwnershipFixture(root) {
  const source = path.join(root, 'source'), control = path.join(root, 'control');
  const plugin = path.join(root, '.dkb', 'plugins', '@test', 'ownership', 'plugin.mjs');
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(control, { recursive: true });
  await fs.mkdir(path.dirname(plugin), { recursive: true });
  await fs.writeFile(path.join(source, 'dkb.json'), JSON.stringify({ manifestVersion: 1, type: 'dkb', name: '@test/ownership', version: '1.0.0', permissions: { read: true, write: false } }));
  await fs.writeFile(path.join(source, 'knowledge.md'), 'Preserve this source.\n');
  await fs.writeFile(path.join(root, '.dkb', 'config.json'), JSON.stringify({ format: 'dkb.config.v2', targets: { ownership: { evidence: '@test/ownership', index: '@test/ownership', retrieval: '@test/ownership' } } }));
  await fs.writeFile(plugin, `
import fs from 'node:fs/promises'; import path from 'node:path'; import {setTimeout as delay} from 'node:timers/promises';
const control=${JSON.stringify(control)};
const exists=name=>fs.access(path.join(control,name)).then(()=>true,()=>false);
export const apiVersion=3,id='@test/ownership',version='1.0.0';
export const optionsSchema={'~standard':{version:1,vendor:'test',validate(value){return {value:value??{}};}}};
export function setup(context) {
  context.registerProvider({kind:'evidence',async compile({signal}){
    await fs.writeFile(path.join(control,'started'),'ready');
    try { while(!await exists('finish')) await delay(25,undefined,{signal}); }
    finally {
      await fs.writeFile(path.join(control,'cleanup'),'pending');
      while(!await exists('cleanup-confirmed')) await delay(10);
    }
    throw new Error('fixture compile stopped');
  }});
  context.registerProvider({kind:'index',mode:'packaged',format:'test.ownership.v1',capabilities:{vectors:'none'},
    async compilePackage(){throw new Error('Stopped Evidence reached indexing');},async validatePackage(){return {documentCount:0};},
    async verifyRuntime(){return {indexId:'test',documentCount:0,status:'ready'};},
    async openRuntime(){return {providerId:id,format:'test.ownership.v1',async search(){return {candidates:[],trace:{}};},async close(){}};}});
  context.registerProvider({kind:'retrieval',protocol:'test.ownership.v1',capabilities:{vectors:'none'},
    async openRuntime(){return {providerId:id,protocol:'test.ownership.v1',async search(){return {hits:[],trace:{}};},async close(){}};}});
}
`);
  return { root, source, control };
}

export async function waitForCompilerMarker(control, name) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await fs.access(path.join(control, name)).then(() => true, () => false)) return;
    await delay(25);
  }
  throw new Error(`Compiler did not reach ${name}`);
}
