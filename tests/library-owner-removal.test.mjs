import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { syncLibrary } from '@sjshovan/dkb-library/resolver.js';
import { readLibraryState } from '@sjshovan/dkb-library/state.js';
import { createRoot, writeJson } from './runtime-query-fixture.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../apps/cli/dist/cli/index.js', import.meta.url));

// Test installed-state/removal semantics, not signing or retrieval quality.
for (const dedicated of [false, true]) {
  test(`${dedicated ? 'Collection' : 'top-level'} uninstall retains direct dependencies and removes only unused vendor state`, async t => {
    const fixture = await removalFixture(t);
    const before = await readLibraryState(fixture.libraryRoot);
    const blocked = await run(fixture, ['uninstall', '@proof/private'], 1);
    assert.match(JSON.parse(blocked.stdout).error.message, /required by collection:@proof\/bundle/u);
    assert.deepEqual(await readLibraryState(fixture.libraryRoot), before);
    const removed = JSON.parse((await run(fixture, [...(dedicated ? ['collection'] : []), 'uninstall', '@proof/bundle'])).stdout);
    assert.equal(removed.collectionId, '@proof/bundle');
    assert.deepEqual(removed.removedDkbs, ['@proof/private']);
    assert.deepEqual(Object.keys((await readLibraryState(fixture.libraryRoot)).entries), ['@proof/shared']);
    assert.equal(await fs.readFile(path.join(fixture.libraryRoot, 'vendor/@proof/shared/source.md'), 'utf8'), 'Shared source');
    for (const name of ['private', 'bundle']) assert.equal(await fs.stat(path.join(fixture.libraryRoot, 'vendor/@proof', name)).then(() => true, () => false), false);
    if (dedicated) {
      const direct = await invoke(fixture, [cli, '--no-progress', 'remove', '@proof/shared', '--library', fixture.libraryRoot], 0);
      assert.match(direct.stdout, /Package: @proof\/shared/u);
      assert.match(direct.stdout, /Done\./u);
      assert.doesNotMatch(direct.stdout, /\u001b\[/u);
    } else {
      const direct = JSON.parse((await run(fixture, ['uninstall', '@proof/shared'])).stdout);
      assert.equal(direct.id, '@proof/shared');
    }
    assert.deepEqual((await readLibraryState(fixture.libraryRoot)).entries, {});
  });
}

test('local Collection uninstall only deactivates; a failed explicit reload remains a post-commit warning', async t => {
  const fixture = await removalFixture(t);
  await writeJson(path.join(fixture.libraryRoot, 'local/dkb.json'), { type: 'collection', name: '@proof/local', members: {} });
  const manifestPath = path.join(fixture.libraryRoot, 'dkb.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.roots['@proof/local'] = { path: 'local' };
  await writeJson(manifestPath, manifest);
  await syncLibrary(fixture.libraryRoot);
  const result = JSON.parse((await run(fixture, ['uninstall', '@proof/local', '--url', 'http://127.0.0.1:1'])).stdout);
  assert.equal(result.status, 'synchronized');
  assert.match(result.warning, /Library update succeeded.*stale/u);
  assert.equal(result.runtimeRefreshes[0].status, 'stale');
  assert.ok(await fs.stat(path.join(fixture.libraryRoot, 'local/dkb.json')));
  assert.equal((await readLibraryState(fixture.libraryRoot)).entries['@proof/local'], undefined);
});

test('native removal commits to the selected Library and releases its lease before Runtime refresh', async t => {
  const fixture = await removalFixture(t);
  await run(fixture, ['uninstall', '@proof/bundle']);
  const { withDkbFileLock } = await import('@sjshovan/dkb-library/locks.js');
  const calls = [];
  const server = createServer(async (request, response) => {
    try {
      calls.push([request.method, request.url]);
      assert.equal(request.headers.authorization, 'Bearer synthetic-admin');
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/api/runtime/reload');
      const result = await withDkbFileLock(fixture.libraryRoot, 'library-mutation', async () => {
        assert.deepEqual((await readLibraryState(fixture.libraryRoot)).entries, {});
        return { status: 'reloaded' };
      }, { timeoutMs: 1000 });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(result));
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const result = JSON.parse((await run(fixture, ['uninstall', '@proof/shared', '--url', `http://127.0.0.1:${server.address().port}`])).stdout);
  assert.equal(result.id, '@proof/shared');
  assert.equal(result.runtimeRefreshes[0].status, 'refreshed');
  assert.deepEqual(calls, [['POST', '/api/runtime/reload']]);
  assert.deepEqual((await readLibraryState(fixture.libraryRoot)).entries, {});
});

for (const command of ['package.uninstall', 'collection.uninstall']) {
  for (const failed of [false, true]) {
    test(`Docker ${command} ${failed ? 'failure' : 'success'} uses the fixed offline CLI, never a host database or Runtime mutation`, async t => {
      const fixture = await createRoot(t);
      const image = `sha256:${'a'.repeat(64)}`;
      const inventory = path.join(fixture.root, 'host.json');
      const at = '2026-10-13T00:00:00.000Z';
      await writeJson(inventory, { format: 'dkb.host.v2', defaults: { library: 'docker' }, stacks: {}, registries: {},
        libraries: { docker: { displayName: 'Owner', storage: { kind: 'docker', volume: 'proof-library', context: 'desktop-linux', image }, registeredAt: at, updatedAt: at } },
        runtimes: { online: { kind: 'docker', library: 'docker', url: 'http://127.0.0.1:7331', registeredAt: at, updatedAt: at } } });
      const args = ['--json-stream', ...(command.startsWith('collection') ? ['collection'] : []), 'uninstall', '@proof/bundle', '--library', 'docker',
        command.startsWith('collection') ? '--runtime-url' : '--url', 'http://127.0.0.1:7331/'];
      const script = `
        import assert from 'node:assert/strict'; import cp from 'node:child_process';
        import { EventEmitter } from 'node:events'; import { PassThrough } from 'node:stream';
        import { syncBuiltinESMExports } from 'node:module';
        const calls=[], image=${JSON.stringify(image)};
        globalThis.fetch=async (url) => { calls.push({url:String(url)}); throw new Error('synthetic offline secret-not-for-output'); };
        cp.spawn=(file,args,options)=>{
          assert.equal(file,'docker'); assert.equal(options.shell,false);
          const command=args.slice(2), child=new EventEmitter();
          child.stdin=new PassThrough(); child.stdout=new PassThrough(); child.stderr=new PassThrough();
          child.kill=()=>true; let input=''; child.stdin.on('data',bytes=>input+=bytes);
          child.stdin.on('finish',()=>setImmediate(()=>{
            let value='', code=0;
            if(command[0]==='context') value=JSON.stringify([{Endpoints:{docker:{Host:'unix:///var/run/docker.sock'}}}]);
            else if(command[0]==='image') value=JSON.stringify([{Id:image,Os:'linux',Config:{Labels:{'dev.dkb.library-owner.protocol':'dkb.library-owner.v1','org.opencontainers.image.version':'0.2.0'}}}]);
            else if(command[0]==='volume') value=JSON.stringify([{Name:'proof-library',Driver:'local',Scope:'local',Options:null,Mountpoint:'/var/lib/docker/volumes/proof-library/_data'}]);
            else if(command[0]==='create') {
              assert.equal(command[command.indexOf('--network')+1],'none');
              assert.equal(command.filter(v=>v==='--mount').length,1);
              assert.equal(command[command.indexOf('--mount')+1],'type=volume,src=proof-library,dst=/library,volume-nocopy');
              value='b'.repeat(64);
            } else if(command[0]==='start') {
              const request=JSON.parse(input); calls.push({request});
              assert.equal(request.command,${JSON.stringify(command)});
              assert.deepEqual(request.input,{identity:'@proof/bundle'});
              const events=[{event:'start',label:'Uninstalling'}];
              if(${failed}) {code=1;events.push({event:'failure',error:{code:'library_recovery_required',message:'Run dkb library recover --library "/library".'}},{event:'completion',status:'failed'});}
              else events.push({event:'result',value:{status:'removed',collectionId:'@proof/bundle',removedDkbs:['@proof/private'],libraryRoot:'/library'}},{event:'completion',status:'succeeded'});
              value=events.map((fields,sequence)=>JSON.stringify({format:'dkb.command-event.v1',sequence,timestamp:new Date().toISOString(),...fields})).join('\\n')+'\\n';
            } else {assert.deepEqual(command.slice(0,2),['container','ls']);}
            child.stdout.write(value); child.emit('close',code);
          })); return child;
        };
        syncBuiltinESMExports();
        process.on('exit',()=>process.stderr.write('ROUTING:'+JSON.stringify(calls)+'\\n'));
        process.argv=[process.execPath,...${JSON.stringify(args)}];
        await import(${JSON.stringify(new URL('../apps/cli/dist/cli/index.js', import.meta.url).href)});
      `;
      const result = await invoke(fixture, ['--input-type=module', '-e', script], failed ? 1 : 0, inventory);
      const events = result.stdout.trim().split('\n').map(JSON.parse);
      const calls = JSON.parse(result.stderr.match(/ROUTING:(.*)/u)[1]);
      assert.equal(calls.filter(item => item.request).length, 1);
      assert.equal(events.filter(event => event.event === 'completion').length, 1);
      if (failed) {
        assert.equal(calls.filter(item => item.url).length, 0);
        assert.equal(events.filter(event => event.event === 'result').length, 0);
        assert.match(events.find(event => event.event === 'failure').error.message, /--library "docker"/u);
      } else {
        assert.equal(calls.filter(item => item.url).length, 1, 'Explicit and registered refresh URLs must deduplicate');
        assert.equal(events.filter(event => event.event === 'result').length, 1);
        assert.equal(events.at(-1).status, 'succeeded');
        assert.match(events.find(event => event.event === 'result').value.warning, /Library update succeeded/u);
      }
      assert.equal(await fs.stat(path.join(fixture.root, '.dkb')).then(() => true, () => false), false);
    });
  }
}

async function removalFixture(t) {
  const fixture = await createRoot(t);
  await writeJson(path.join(fixture.libraryRoot, 'dkb.json'), { type: 'library', name: 'Removal', roots: {
    '@proof/shared': { version: '1.0.0' }, '@proof/bundle': { revision: 1 },
  } });
  for (const name of ['shared', 'private']) {
    const root = path.join(fixture.libraryRoot, 'vendor/@proof', name);
    await writeJson(path.join(root, 'dkb.json'), { type: 'dkb', name: `@proof/${name}`, version: '1.0.0' });
    await fs.writeFile(path.join(root, 'source.md'), name === 'shared' ? 'Shared source' : 'Private source');
    await writeJson(path.join(root, '.dkb/builds/retained-state.json'), { fixture: true });
  }
  await writeJson(path.join(fixture.libraryRoot, 'vendor/@proof/bundle/dkb.json'), { type: 'collection', name: '@proof/bundle',
    members: { '@proof/shared': '1.0.0', '@proof/private': '1.0.0' }, meta: { revision: 1 } });
  await syncLibrary(fixture.libraryRoot);
  return fixture;
}

async function run(fixture, args, code = 0) {
  return invoke(fixture, [cli, '--json', ...args, '--library', fixture.libraryRoot], code);
}
async function invoke(fixture, args, code, inventory = path.join(fixture.root, 'host.json')) {
  const env = { ...process.env, DKB_HOST_INVENTORY: inventory, DKB_CLI_CONFIG: path.join(fixture.root, 'config.json'),
    DKB_GLOBAL_ROOT: path.join(fixture.root, 'global'), DKB_RUNTIME_CREDENTIALS_ROOT: path.join(fixture.root, 'credentials'),
    DKB_RUNTIME_ADMIN_TOKEN: 'synthetic-admin', DKB_FORCE_TTY: '0' };
  delete env.DKB_LIBRARY_PATH;
  let result;
  try { result = { code: 0, ...await execute(process.execPath, args, { cwd: fixture.root, env, windowsHide: true, timeout: 30_000 }) }; }
  catch (error) { assert.equal(error.killed, false, error.message); result = { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  assert.equal(result.code, code, result.stdout + result.stderr);
  return result;
}
