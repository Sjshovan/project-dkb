// Explicit local proof: disposable Linux volume, no user Stack or Library.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerDockerProcess } from '../apps/cli/dist/host/dockerOwnerProcess.js';
import { assertLocalOwnerVolume } from '../apps/cli/dist/host/libraryOwner.js';

if (process.argv.length !== 3 || process.argv[2] !== '--run') throw new Error('Run explicitly: node tests/stack-control-proof.mjs --run');
const context = (await raw(['context', 'show'])).trim();
const docker = args => raw(['--context', context, ...args]);
const endpoint = JSON.parse(await docker(['context', 'inspect', context]))[0]?.Endpoints?.docker?.Host;
assert.match(endpoint, /^(?:unix:\/\/\/[^\0\r\n]+|npipe:\/{4}\.\/pipe\/[^/\\\s]+)$/u);
const image = (await docker(['image', 'inspect', 'dkb-cli:owner-candidate', '--format', '{{.Id}}'])).trim();
assert.match(image, /^sha256:[a-f0-9]{64}$/u);
const id = randomUUID(), volume = `dkb-stack-control-${id}`, label = `dev.dkb.stack-control-proof=${id}`;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-stack-control-proof-'));
const name = `${volume}-owner`, checks = [];
let createdVolume = false, createdContainer = false;
const common = ['--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--label', label, '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m', '--mount', `type=volume,src=${volume},dst=/state,volume-nocopy`,
  '--env', 'DKB_STACK_STATE_ROOT=/state/stacks', '--env', 'DKB_GLOBAL_ROOT=/tmp/global', '--env', 'DKB_CLI_CONFIG=/tmp/config.json',
  '--env', 'DKB_HOST_INVENTORY=/tmp/host.json'];
const imports = `import assert from 'node:assert/strict'; import fs from 'node:fs/promises';
  import {withStackControl} from './apps/cli/dist/stack/control.js';`;
const run = source => docker(['run', '--rm', ...common, '--entrypoint', 'node', image, '--input-type=module', '-e', imports + source]);
const record = check => { checks.push(check); console.log(JSON.stringify({ check, status: 'passed' })); };
try {
  await docker(['volume', 'create', '--driver', 'local', '--label', label, volume]); createdVolume = true;
  assertLocalOwnerVolume(JSON.parse(await docker(['volume', 'inspect', volume]))[0], volume);
  const tests = ['stack-control.test.mjs', 'stack-backup-safety.test.mjs', 'archive-rejection.test.mjs'];
  const mounts = tests.flatMap(file => ['--mount', `type=bind,src=${fileURLToPath(new URL(file, import.meta.url))},dst=/workspace/tests/${file},readonly`]);
  // Release tooling is not shipped in the product image. Mount only the three
  // inert source inputs required to test its archive inspection alongside the CLI.
  for (const file of ['package-distribution.mjs', 'package-policy.mjs', 'lib/package-command.mjs']) {
    mounts.push('--mount', `type=bind,src=${fileURLToPath(new URL(`../scripts/${file}`, import.meta.url))},dst=/workspace/scripts/${file},readonly`);
  }
  const output = await docker(['run', '--rm', ...common, ...mounts, '--env', 'TMPDIR=/state', '--entrypoint', 'node', image,
    '--test', ...tests.map(file => `tests/${file}`)]);
  assert.match(output, /# tests 14\b/u); assert.match(output, /# fail 0\b/u); assert.match(output, /# skipped 0\b/u);
  record('packaged CLI passes fourteen Stack control, backup safety, and archive rejection tests on Linux-local storage');
  await docker(['create', '--name', name, ...common, '--entrypoint', 'node', image, '--input-type=module', '-e', imports + `
    await withStackControl('held',async()=>{console.log('ready');await new Promise(()=>setInterval(()=>{},1000));});
  `]); createdContainer = true;
  await docker(['start', name]);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const [info] = JSON.parse(await docker(['container', 'inspect', name]));
    assert.equal(info.State.Running, true, await docker(['logs', name]));
    if ((await docker(['logs', name])).trim() === 'ready') { ready = true; break; }
    await delay(50);
  }
  assert.equal(ready, true);
  await docker(['pause', name]);
  await run(`await assert.rejects(withStackControl('held',async()=>assert.fail('paused owner bypassed')),{code:'stack_busy'});
    await withStackControl('other',async()=>{});
    await assert.rejects(fs.access('/state/stacks/held/runtime'),{code:'ENOENT'});`);
  await docker(['unpause', name]); await docker(['kill', '--signal', 'KILL', name]);
  const [stopped] = JSON.parse(await docker(['container', 'inspect', name]));
  assert.equal(stopped.State.Running, false); assert.equal(stopped.State.ExitCode, 137);
  await run(`await withStackControl('held',async()=>{});
    assert.ok((await fs.stat('/state/stacks/.control/held/.dkb/locks/stack-control.lease.sqlite')).isFile());`);
  record('paused separate container excludes competing Stack control; confirmed death permits reuse without deleting a guard');
  if (process.platform === 'win32') {
    await docker(['run', '--rm', ...common, '--mount', `type=bind,src=${root},dst=/foreign`, '--env', 'DKB_STACK_STATE_ROOT=/foreign',
      '--entrypoint', 'node', image, '--input-type=module', '-e', imports + `
        await assert.rejects(withStackControl('rejected',async()=>assert.fail('shared storage admitted')),{code:'stack_storage_unsupported'});`]);
    assert.deepEqual(await fs.readdir(root), []);
    record('Windows-shared host control mount rejected before creating state');
  }
  console.log(JSON.stringify({ status: 'passed', image, context, checks: checks.length, userResourcesChanged: false }));
} finally {
  if (createdContainer) {
    const [info] = JSON.parse(await docker(['container', 'inspect', name]));
    assert.equal(info.Config.Labels['dev.dkb.stack-control-proof'], id);
    if (info.State.Paused) await docker(['unpause', name]);
    await docker(['container', 'rm', '--force', info.Id]);
  }
  if (createdVolume) {
    const [info] = JSON.parse(await docker(['volume', 'inspect', volume]));
    assert.equal(info.Labels['dev.dkb.stack-control-proof'], id);
    await docker(['volume', 'rm', volume]);
  }
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('dkb-stack-control-proof-'));
  await fs.rm(root, { recursive: true, force: true });
}
async function raw(args) {
  const result = await ownerDockerProcess(args, { timeoutMs: 45_000 });
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
