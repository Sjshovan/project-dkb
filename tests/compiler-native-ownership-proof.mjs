// Explicit, local-only compiler ownership proof. Never mounts an existing user Library.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerDockerProcess } from '../apps/cli/dist/host/dockerOwnerProcess.js';
import { assertLocalOwnerVolume } from '../apps/cli/dist/host/libraryOwner.js';
import { createCompilerOwnershipFixture } from './compiler-ownership-fixture.mjs';

if (process.argv.length !== 3 || process.argv[2] !== '--run') throw new Error('Run explicitly: node tests/compiler-native-ownership-proof.mjs --run');
const context = (await raw(['context', 'show'])).trim();
const docker = args => raw(['--context', context, ...args]);
const endpoint = JSON.parse(await docker(['context', 'inspect', context]))[0]?.Endpoints?.docker?.Host;
assert.match(endpoint, /^(?:unix:\/\/\/[^\0\r\n]+|npipe:\/{4}\.\/pipe\/[^/\\\s]+)$/u, 'Use a local Docker engine.');
const image = (await docker(['image', 'inspect', 'dkb-cli:owner-candidate', '--format', '{{.Id}}'])).trim();
assert.match(image, /^sha256:[a-f0-9]{64}$/u);
const id = randomUUID(), volume = `dkb-compiler-ownership-${id}`, label = `dev.dkb.compiler-ownership-proof=${id}`;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-compiler-ownership-proof-'));
const containers = [], checks = [];
let created = false;
const mount = name => ['--mount', `type=bind,src=${fileURLToPath(new URL(name, import.meta.url))},dst=/workspace/tests/${name},readonly`];
const common = ['--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--label', label, '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m', '--mount', `type=volume,src=${volume},dst=/state,volume-nocopy`,
  '--env', 'DKB_GLOBAL_ROOT=/tmp/global', '--env', 'DKB_CLI_CONFIG=/tmp/config.json', '--env', 'DKB_HOST_INVENTORY=/tmp/host.json',
  ...mount('compiler-ownership-fixture.mjs')];
const imports = `import assert from 'node:assert/strict'; import fs from 'node:fs/promises';
  import {compileComposeProject,COMPILE_LOCK_PATH} from '@sjshovan/dkb-compiler/compile.js';
  import {withDkbFileLock} from '@sjshovan/dkb-library/locks.js';
  import {createCompilerOwnershipFixture,waitForCompilerMarker} from './tests/compiler-ownership-fixture.mjs';`;
const run = source => docker(['run', '--rm', ...common, '--entrypoint', 'node', image, '--input-type=module', '-e', imports + source]);
const record = check => { checks.push(check); console.log(JSON.stringify({ check, status: 'passed' })); };

try {
  await docker(['volume', 'create', '--driver', 'local', '--label', label, volume]); created = true;
  assertLocalOwnerVolume(JSON.parse(await docker(['volume', 'inspect', volume]))[0], volume);
  const output = await docker(['run', '--rm', ...common, '--env', 'TMPDIR=/state', ...mount('compiler-native-ownership.test.mjs'), ...mount('compiler-context.test.mjs'),
    '--entrypoint', 'node', image, '--test', 'tests/compiler-native-ownership.test.mjs', 'tests/compiler-context.test.mjs']);
  assert.match(output, /# tests 10\b/u); assert.match(output, /# fail 0\b/u); assert.match(output, /# skipped 0\b/u);
  record('packaged compiler passes ownership, cancellation, single-host lifecycle and drift rejection tests on a Linux volume');

  await run(`await createCompilerOwnershipFixture('/state/held'); await fs.mkdir('/state/other');`);
  const name = `${volume}-owner`;
  await docker(['create', '--name', name, ...common, '--entrypoint', 'node', image, '--input-type=module', '-e', imports + `
    const running=compileComposeProject('/state/held/source',{target:'ownership',contextRoot:'/state/held'});
    await waitForCompilerMarker('/state/held/control','started'); console.log('ready'); await running;
  `]);
  containers.push(name); await docker(['start', name]);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const [info] = JSON.parse(await docker(['container', 'inspect', name]));
    assert.equal(info.State.Running, true, await docker(['logs', name]));
    if ((await docker(['logs', name])).trim() === 'ready') { ready = true; break; }
    await delay(50);
  }
  assert.equal(ready, true, 'Compiler owner never entered its selected Evidence provider');
  await docker(['pause', name]);
  await run(`
    await assert.rejects(withDkbFileLock('/state/held/source','compile',async()=>assert.fail('paused compiler bypassed'),{timeoutMs:100}),{code:'library_busy'});
    const abort=new AbortController(),reason=new Error('cancel competing compiler');
    const timer=setTimeout(()=>abort.abort(reason),150);
    try {await assert.rejects(compileComposeProject('/state/held/source',{target:'ownership',contextRoot:'/state/held',signal:abort.signal}),e=>e===reason);}
    finally {clearTimeout(timer);}
    await withDkbFileLock('/state/other','compile',async()=>{});
  `);
  record('paused real compiler excludes competitors; queued cancellation is prompt and other package roots remain independent');
  await docker(['unpause', name]); await docker(['kill', '--signal', 'KILL', name]);
  const [stopped] = JSON.parse(await docker(['container', 'inspect', name]));
  assert.equal(stopped.State.Running, false); assert.equal(stopped.State.ExitCode, 137);
  await run(`
    await fs.writeFile('/state/held/control/finish','yes'); await fs.writeFile('/state/held/control/cleanup-confirmed','yes');
    await assert.rejects(compileComposeProject('/state/held/source',{target:'ownership',contextRoot:'/state/held'}),/fixture compile stopped/);
    await withDkbFileLock('/state/held/source','compile',async()=>{});
    assert.equal(await fs.readFile('/state/held/source/knowledge.md','utf8'),'Preserve this source.\\n');
    assert.ok((await fs.stat('/state/held/source/'+COMPILE_LOCK_PATH)).isFile());
    await assert.rejects(fs.access('/state/held/source/.dkb/locks/compile.lock'),{code:'ENOENT'});
  `);
  record('confirmed compiler death permits a new selected-provider run without deleting or aging a guard');

  if (process.platform === 'win32') {
    const fixture = await createCompilerOwnershipFixture(root);
    await docker(['run', '--rm', ...common, '--mount', `type=bind,src=${fixture.source},dst=/foreign`,
      '--entrypoint', 'node', image, '--input-type=module', '-e', imports + `
        await assert.rejects(compileComposeProject('/foreign'),{code:'compile_storage_unsupported'});
      `]);
    assert.deepEqual((await fs.readdir(fixture.source)).sort(), ['dkb.json', 'knowledge.md']);
    record('Windows-shared source is rejected before opening or creating compiler state');
  }
  console.log(JSON.stringify({ status: 'passed', image, context, checks: checks.length, userResourcesChanged: false }));
} finally {
  for (const name of containers) {
    const [info] = JSON.parse(await docker(['container', 'inspect', name]));
    assert.equal(info.Config.Labels['dev.dkb.compiler-ownership-proof'], id);
    if (info.State.Paused) await docker(['unpause', name]);
    await docker(['container', 'rm', '--force', info.Id]);
  }
  if (created) {
    const [info] = JSON.parse(await docker(['volume', 'inspect', volume]));
    assert.equal(info.Labels['dev.dkb.compiler-ownership-proof'], id);
    await docker(['volume', 'rm', volume]);
  }
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('dkb-compiler-ownership-proof-'));
  await fs.rm(root, { recursive: true, force: true });
}

async function raw(args) {
  const result = await ownerDockerProcess(args, { timeoutMs: 45_000 });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout;
}
