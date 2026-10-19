// Opt-in proof with the installed CLI image: two containers, native storage, no user Runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerDockerProcess } from '../apps/cli/dist/host/dockerOwnerProcess.js';
import { assertLocalOwnerVolume } from '../apps/cli/dist/host/libraryOwner.js';

if (process.argv.length !== 3 || process.argv[2] !== '--run') throw new Error('Run explicitly: node tests/runtime-native-ownership-proof.mjs --run');
const context = (await raw(['context', 'show'])).trim();
const docker = args => raw(['--context', context, ...args]);
const endpoint = JSON.parse(await docker(['context', 'inspect', context]))[0]?.Endpoints?.docker?.Host;
assert.match(endpoint, /^(?:unix:\/\/\/[^\0\r\n]+|npipe:\/{4}\.\/pipe\/[^/\\\s]+)$/u, 'Use a local Docker engine.');
const image = (await docker(['image', 'inspect', 'dkb-cli:owner-candidate', '--format', '{{.Id}}'])).trim();
assert.match(image, /^sha256:[a-f0-9]{64}$/u);
const id = randomUUID(), volume = `dkb-runtime-ownership-${id}`, label = `dev.dkb.runtime-ownership-proof=${id}`;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-runtime-ownership-proof-'));
const containers = [];
const checks = [];
let created = false;
const common = ['--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--label', label, '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m', '--mount', `type=volume,src=${volume},dst=/state,volume-nocopy`];
const imports = `import assert from 'node:assert/strict';
  import {withRuntimeMutation,withRuntimeQuery} from '@sjshovan/dkb-runtime/runtime/mutation.js';
  import {withDkbFileLock} from '@sjshovan/dkb-library/locks.js';`;
const run = source => docker(['run', '--rm', ...common, '--entrypoint', 'node', image, '--input-type=module', '-e', imports + source]);
const record = check => { checks.push(check); console.log(JSON.stringify({ check, status: 'passed' })); };

try {
  await docker(['volume', 'create', '--driver', 'local', '--label', label, volume]);
  created = true;
  assertLocalOwnerVolume(JSON.parse(await docker(['volume', 'inspect', volume]))[0], volume);
  const suite = fileURLToPath(new URL('./runtime-native-ownership.test.mjs', import.meta.url));
  const output = await docker(['run', '--rm', ...common,
    '--env', 'DKB_GLOBAL_ROOT=/tmp/global', '--env', 'DKB_CLI_CONFIG=/tmp/config.json', '--env', 'DKB_HOST_INVENTORY=/tmp/host.json',
    '--mount', `type=bind,src=${suite},dst=/workspace/tests/runtime-native-ownership.test.mjs,readonly`,
    '--entrypoint', 'node', image, '--test', 'tests/runtime-native-ownership.test.mjs']);
  assert.match(output, /# fail 0\b/u);
  assert.match(output, /# skipped 0\b/u);
  record('packaged Runtime passes native ownership, concurrent query, authority and process-death tests in Linux');

  const queryFixture = fileURLToPath(new URL('./runtime-query-fixture.mjs', import.meta.url));
  await docker(['run', '--rm', ...common, '--env', 'TMPDIR=/state',
    '--env', 'DKB_GLOBAL_ROOT=/tmp/global', '--env', 'DKB_CLI_CONFIG=/tmp/config.json', '--env', 'DKB_HOST_INVENTORY=/tmp/host.json',
    '--mount', `type=bind,src=${queryFixture},dst=/workspace/tests/runtime-query-fixture.mjs,readonly`,
    '--entrypoint', 'node', image, '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import fs from 'node:fs/promises';
      import {createQueryFixture} from './tests/runtime-query-fixture.mjs';
      import {removeLibraryRoot} from '@sjshovan/dkb-library/resolver.js';
      import {initializeRuntimeBinding,closeRuntimeQuerySnapshot} from '@sjshovan/dkb-runtime/runtime/state.js';
      import {switchRuntimePipelineFromRegistry,refreshRuntimeActivation} from '@sjshovan/dkb-runtime/runtime/pipelineSwitch.js';
      import {searchRuntime} from '@sjshovan/dkb-runtime/runtime/queryAccess.js';
      import {DEFAULT_DKB_RUNTIME_CONTEXT as runtime} from '@sjshovan/dkb-runtime/defaultComposition.js';
      const cleanup=[], second='/state/second-bound-runtime';
      try {
        const fixture=await createQueryFixture({after(fn){cleanup.push(fn);}});
        await initializeRuntimeBinding(second,{runtimeId:'second',libraryRoot:fixture.libraryRoot,target:'fixture'});
        await switchRuntimePipelineFromRegistry({stateRoot:second,runtime,target:'fixture'});
        const search=stateRoot=>searchRuntime({stateRoot,runtime,query:'RECOVERY-MARKER'});
        const [firstResult,secondResult]=await Promise.all([search(fixture.runtimeRoot),search(second)]);
        assert.equal(firstResult.results.length,1);
        assert.equal(secondResult.results.length,1);
        assert.equal(firstResult.results[0].evidenceId,secondResult.results[0].evidenceId);
        await removeLibraryRoot(fixture.libraryRoot,fixture.packageId);
        await assert.rejects(search(fixture.runtimeRoot),/stale|changed/i);
        await assert.rejects(search(second),/stale|changed/i);
        await refreshRuntimeActivation({stateRoot:fixture.runtimeRoot,runtime});
        assert.equal((await search(fixture.runtimeRoot)).results.length,0);
        await assert.rejects(search(second),/stale|changed/i);
        await refreshRuntimeActivation({stateRoot:second,runtime});
        assert.equal((await search(second)).results.length,0);
        assert.match(await fs.readFile(fixture.packageRoot+'/knowledge.md','utf8'),/RECOVERY-MARKER/);
      } finally {
        await closeRuntimeQuerySnapshot(second);
        for(const dispose of cleanup.reverse())await dispose();
      }
    `]);
  record('two Linux-volume Runtime activations share evidence, reject deactivated knowledge and refresh independently');
  await run(`await withRuntimeMutation('/state/a',async()=>{}); await withRuntimeMutation('/state/b',async()=>{});`);

  const reader = await hold('reader', 'withRuntimeQuery');
  await docker(['pause', reader]);
  await run(`
    await withRuntimeQuery('/state/a',async()=>{});
    await assert.rejects(withDkbFileLock('/state/a','runtime-mutation',async()=>assert.fail('paused reader bypassed'),{timeoutMs:100}),{code:'library_busy'});
    await withRuntimeMutation('/state/b',async()=>{});
  `);
  record('paused container query admits another query, excludes writers and does not block another Runtime');
  await terminate(reader);
  await run(`await withRuntimeMutation('/state/a',async()=>{});`);
  record('query owner death releases native ownership without deleting or aging a lock file');

  const writer = await hold('writer', 'withRuntimeMutation');
  await docker(['pause', writer]);
  await run(`
    for(const purpose of ['read','mutation']) {
      await assert.rejects(withDkbFileLock('/state/a','runtime-mutation',async()=>assert.fail('paused writer bypassed'),{purpose,timeoutMs:100}),{code:'library_busy'});
    }
    await withRuntimeQuery('/state/b',async()=>{});
  `);
  await terminate(writer);
  await run(`await withRuntimeQuery('/state/a',async()=>{}); await withRuntimeMutation('/state/a',async()=>{});`);
  record('paused container writer excludes readers and writers until confirmed termination, then acquisition succeeds');

  if (process.platform === 'win32') {
    await docker(['run', '--rm', ...common, '--mount', `type=bind,src=${root},dst=/foreign`, '--entrypoint', 'node', image,
      '--input-type=module', '-e', imports + `
        await assert.rejects(withRuntimeMutation('/foreign/new-runtime',async()=>assert.fail('shared mount admitted')),{code:'runtime_storage_unsupported'});
        await assert.rejects(withRuntimeQuery('/foreign',async()=>assert.fail('shared read admitted')),{code:'runtime_storage_unsupported'});
      `]);
    assert.deepEqual(await fs.readdir(root), [], 'Unsupported mount must not gain a Runtime or database.');
    record('Windows shared Runtime mount is rejected before creating state or opening a database');
  }
  console.log(JSON.stringify({ status: 'passed', image, context, checks: checks.length, userResourcesChanged: false }));
} finally {
  for (const name of containers) {
    const [info] = JSON.parse(await docker(['container', 'inspect', name]));
    assert.equal(info.Config.Labels['dev.dkb.runtime-ownership-proof'], id);
    if (info.State.Paused) await docker(['unpause', name]);
    await docker(['container', 'rm', '--force', info.Id]);
  }
  if (created) {
    const [info] = JSON.parse(await docker(['volume', 'inspect', volume]));
    assert.equal(info.Labels['dev.dkb.runtime-ownership-proof'], id);
    await docker(['volume', 'rm', volume]);
  }
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('dkb-runtime-ownership-proof-'));
  await fs.rm(root, { recursive: true, force: true });
}

async function hold(suffix, operation) {
  const name = `${volume}-${suffix}`;
  await docker(['create', '--name', name, ...common, '--entrypoint', 'node', image, '--input-type=module', '-e', imports + `
    await ${operation}('/state/a',async()=>{
      console.log('ready'); setInterval(()=>{},1000); await new Promise(()=>{});
    });`]);
  containers.push(name);
  await docker(['start', name]);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const [info] = JSON.parse(await docker(['container', 'inspect', name]));
    assert.equal(info.State.Running, true, await docker(['logs', name]));
    if ((await docker(['logs', name])).trim() === 'ready') return name;
    await delay(50);
  }
  throw new Error(`Proof owner did not acquire its lease: ${name}`);
}
async function terminate(name) {
  await docker(['unpause', name]);
  await docker(['kill', '--signal', 'KILL', name]);
  const [info] = JSON.parse(await docker(['container', 'inspect', name]));
  assert.equal(info.State.Running, false);
  assert.equal(info.State.ExitCode, 137);
}
async function raw(args) {
  const result = await ownerDockerProcess(args, { timeoutMs: 45_000 });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout;
}
