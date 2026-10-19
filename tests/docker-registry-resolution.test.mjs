import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRoot, writeJson } from './runtime-query-fixture.mjs';

test('Docker Library Registry resolution preserves precedence and fails closed on owner failure', async t => {
  const { root } = await createRoot(t);
  const stamp = new Date().toISOString(), image = `sha256:${'a'.repeat(64)}`;
  const storage = { kind: 'docker', context: 'desktop-linux', volume: 'proof-library', image };
  const reference = { kind: 'docker', name: 'docker', storage };
  const inventory = { format: 'dkb.host.v2', defaults: { registry: 'selected' }, libraries: {
    docker: { storage, displayName: 'Docker', registry: 'associated', registeredAt: stamp, updatedAt: stamp },
  }, registries: Object.fromEntries(['associated', 'selected'].map(name => [name, {
    url: `https://${name}.example`, registeredAt: stamp, updatedAt: stamp,
  }])), runtimes: {}, stacks: {} };
  const host = path.join(root, 'host.json'), config = path.join(root, 'config.json');
  await writeJson(config, { format: 'dkb.config.v2', registry: { url: 'https://user.example' } });
  for (const scenario of ['argument', 'environment', 'project', 'association', 'selected', 'user', 'default', 'owner-failure']) {
    const state = structuredClone(inventory);
    if (['selected', 'user', 'default'].includes(scenario)) delete state.libraries.docker.registry;
    if (['user', 'default'].includes(scenario)) delete state.defaults.registry;
    await writeJson(host, state);
    const env = { ...process.env, DKB_HOST_INVENTORY: host, DKB_CLI_CONFIG: scenario === 'default' ? path.join(root, 'absent.json') : config };
    delete env.DKB_REGISTRY_URL;
    if (scenario === 'environment') env.DKB_REGISTRY_URL = 'https://environment.example';
    const script = `
      import assert from 'node:assert/strict'; import cp from 'node:child_process';
      import {EventEmitter} from 'node:events'; import {PassThrough} from 'node:stream'; import {syncBuiltinESMExports} from 'node:module';
      let calls=0;
      cp.spawn=(file,args)=>{calls++; assert.equal(file,'docker'); const c=args.slice(2),child=new EventEmitter();
        child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
        child.kill=()=>true;child.stdin.on('finish',()=>setImmediate(()=>{let value='',code=0;
          if(${JSON.stringify(scenario)}==='owner-failure')code=1;
          else if(c[0]==='context')value=JSON.stringify([{Endpoints:{docker:{Host:'unix:///var/run/docker.sock'}}}]);
          else if(c[0]==='image')value=JSON.stringify([{Id:${JSON.stringify(image)},Os:'linux',Config:{Labels:{'dev.dkb.library-owner.protocol':'dkb.library-owner.v1','org.opencontainers.image.version':'0.2.0'}}}]);
          else if(c[0]==='volume')value=JSON.stringify([{Name:'proof-library',Driver:'local',Scope:'local',Options:null,Mountpoint:'/var/lib/docker/volumes/proof-library/_data'}]);
          else if(c[0]==='create')value='b'.repeat(64);
          else if(c[0]==='start')value=[{event:'start',label:'Read'},{event:'result',value:{registryUrl:'https://project.example',registrySource:${JSON.stringify(scenario === 'project' ? 'project' : 'default')}}},{event:'completion',status:'succeeded'}]
            .map((event,sequence)=>JSON.stringify({format:'dkb.command-event.v1',timestamp:new Date().toISOString(),sequence,...event})).join('\\n')+'\\n';
          else assert.deepEqual(c.slice(0,2),['container','ls']);
          child.stdout.write(value);child.emit('close',code);
        }));return child;};
      syncBuiltinESMExports();
      const {configuredRegistry}=await import('./apps/cli/dist/cli/registryConfig.js');
      const options={library:${JSON.stringify(reference)}${scenario === 'argument' ? ",url:'https://argument.example'" : ''}};
      if(${JSON.stringify(scenario)}==='owner-failure') await assert.rejects(configuredRegistry(options),{code:'library_owner_preflight_failed'});
      else {
        const result=await configuredRegistry(options);
        assert.equal(result.source,${JSON.stringify({ association: 'host-library', selected: 'host' }[scenario] ?? scenario)});
        assert.equal(result.url,${JSON.stringify(scenario === 'default' ? 'http://127.0.0.1:8000' : `https://${scenario === 'association' ? 'associated' : scenario}.example`)});
        if(['argument','environment'].includes(${JSON.stringify(scenario)}))assert.equal(calls,0);
        else assert.ok(calls>0);
      }
    `;
    await t.test(scenario, async () => {
      const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env, windowsHide: true, timeout: 15_000 });
      assert.equal(result.stdout, '');
    });
  }
});
