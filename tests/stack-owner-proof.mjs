// Explicit isolated proof. No user Stack, inventory, credentials or Library is mounted.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerDockerProcess } from '../apps/cli/dist/host/dockerOwnerProcess.js';
import { runDockerLibraryOwner, assertLocalOwnerVolume } from '../apps/cli/dist/host/libraryOwner.js';
import { inspectDockerStackOwner, initializeDockerStackOwner, configureDockerStackOwner } from '../apps/cli/dist/stack/owner.js';
import { STACK_OWNER_FORMAT, stackOwnerScopeDigest } from '../apps/cli/dist/stack/ownerContract.js';
import { DEFAULT_DKB_DISTRIBUTION as distribution } from '@sjshovan/dkb-distribution-default';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { recoverOwnedStackStartup } from '../apps/cli/dist/stack/ownerStartup.js';

if (process.argv.length !== 3 || process.argv[2] !== '--run') throw new Error('Run explicitly: node tests/stack-owner-proof.mjs --run');
const context = (await raw(['context', 'show'])).trim();
const docker = args => raw(['--context', context, ...args]);
const endpoint = JSON.parse(await docker(['context', 'inspect', context]))[0]?.Endpoints?.docker?.Host;
assert.match(endpoint, /^(?:unix:\/\/\/[^\0\r\n]+|npipe:\/{4}\.\/pipe\/[^/\\\s]+)$/u);
const image = (await docker(['image', 'inspect', 'dkb-cli:owner-candidate', '--format', '{{.Id}}'])).trim();
assert.match(image, /^sha256:[a-f0-9]{64}$/u);
const id = randomUUID(), prefix = `dkb-stack-owner-proof-${id}`, label = `dev.dkb.stack-owner-proof=${id}`;
const owner = { context, image, libraryVolume: `${prefix}-library`, runtimeVolume: `${prefix}-runtime`, compilerVolume: `${prefix}-compiler` };
const second = { ...owner, runtimeVolume: `${prefix}-second` };
const volumes = [], containers = [], checks = [];
const hostRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-stack-coordinator-proof-'));
const previousStateRoot = process.env.DKB_STACK_STATE_ROOT;
process.env.DKB_STACK_STATE_ROOT = hostRoot;
const req = input => ({ format: STACK_OWNER_FORMAT, command: 'inspect', input: input ?? {} });
const common = target => ['--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--label', label, '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
  '--mount', `type=volume,src=${target.libraryVolume},dst=/library,volume-nocopy`,
  '--mount', `type=volume,src=${target.runtimeVolume},dst=/state,volume-nocopy`,
  '--mount', `type=volume,src=${target.compilerVolume},dst=/context,volume-nocopy`,
  '--env', 'DKB_GLOBAL_ROOT=/tmp/global', '--env', 'DKB_HOST_INVENTORY=/tmp/host.json', '--env', 'DKB_CLI_CONFIG=/tmp/config.json'];
const imports = `import assert from 'node:assert/strict'; import fs from 'node:fs/promises';
  import {initializeRuntimeBinding,inspectRuntimeSelection} from '@sjshovan/dkb-runtime/runtime/state.js';
  import {withRuntimeMutation} from '@sjshovan/dkb-runtime/runtime/mutation.js';
  import {switchRuntimePipelineFromRegistry} from '@sjshovan/dkb-runtime/runtime/pipelineSwitch.js';
  import {DEFAULT_DKB_RUNTIME_CONTEXT as runtime} from '@sjshovan/dkb-runtime/defaultComposition.js';`;
const run = (target, source) => docker(['run', '--rm', ...common(target), '--entrypoint', 'node', image, '--input-type=module', '-e', imports + source]);
const record = check => { checks.push(check); console.log(JSON.stringify({ check, status: 'passed' })); };
try {
  for (const volume of [owner.libraryVolume, owner.runtimeVolume, owner.compilerVolume, second.runtimeVolume]) {
    await docker(['volume', 'create', '--driver', 'local', '--label', label, volume]); volumes.push(volume);
    assertLocalOwnerVolume(JSON.parse(await docker(['volume', 'inspect', volume]))[0], volume);
  }
  const initialized = await runDockerLibraryOwner({ context, image, volume: owner.libraryVolume }, {
    format: 'dkb.library-owner.v1', command: 'library.init', input: { displayName: 'Stack owner proof', registryUrl: 'http://127.0.0.1:1' }, output: 'json',
  });
  assert.equal(initialized.code, 0, initialized.stderr || initialized.stdout);
  const initialize = (target, runtimeId, runtimeTarget) => initializeDockerStackOwner(distribution, target, {
    format: STACK_OWNER_FORMAT, command: 'binding.initialize', input: { scopeDigest: stackOwnerScopeDigest(target), runtimeId, runtimeTarget },
  });
  assert.equal((await inspectDockerStackOwner(distribution, owner, req())).runtime.state, 'unbound');
  const initial = await initialize(owner, 'owner-a', 'default');
  assert.deepEqual(await initialize(owner, 'owner-a', 'default'), initial);
  await assert.rejects(initialize(owner, 'foreign', 'default'), { code: 'stack_owner_runtime_mismatch' });
  await initialize(second, 'owner-b', 'fastembed-faiss');
  const first = await inspectDockerStackOwner(distribution, owner, req());
  const alternate = await inspectDockerStackOwner(distribution, second, req());
  assert.deepEqual(first.library, alternate.library);
  assert.equal(first.runtime.id, 'owner-a'); assert.equal(alternate.runtime.id, 'owner-b');
  assert.equal(first.runtime.state, 'inactive'); assert.equal(alternate.runtime.state, 'inactive');
  assert.notEqual(first.runtime.target, alternate.runtime.target);
  const planned = await inspectDockerStackOwner(distribution, owner, req({ runtimeTarget: 'fastembed-faiss' }));
  assert.equal(planned.plan.runtimeTarget, 'fastembed-faiss');
  assert.deepEqual(planned.runtime, first.runtime);
  record('fixed Windows worker initializes two Linux Runtime bindings on one Library; retries preserve identity without activation or host database access');

  // Each independent suite keeps the existing 45-second command bound. Test count
  // growth is not a reason to relax production transport or operation deadlines.
  const suites = [['stack-owner', 10], ['stack-owner-initialization', 9], ['stack-owner-configuration', 22],
    ['stack-owner-startup', 26], ['runtime-owner-routing', 10], ['build-signing', 7], ['registry-client-download', 6], ['archive-rejection', 8],
    ['library-owner-install', 2], ['library-install-transport', 21], ['docker-registry-resolution', 9], ['console-credential-location', 1]];
  for (const [file, count] of suites) {
    const suiteName = `${prefix}-${file}`;
    await docker(['create', '--name', suiteName, ...common(owner), '--env', 'TMPDIR=/state',
      '--mount', `type=bind,src=${fileURLToPath(new URL(`${file}.test.mjs`, import.meta.url))},dst=/workspace/tests/${file}.test.mjs,readonly`,
      '--mount', `type=bind,src=${fileURLToPath(new URL('runtime-query-fixture.mjs', import.meta.url))},dst=/workspace/tests/runtime-query-fixture.mjs,readonly`,
      '--mount', `type=bind,src=${fileURLToPath(new URL('provider-receipt-fixture.mjs', import.meta.url))},dst=/workspace/tests/provider-receipt-fixture.mjs,readonly`,
      '--mount', `type=bind,src=${fileURLToPath(new URL('fixtures', import.meta.url))},dst=/workspace/tests/fixtures,readonly`,
      ...(file === 'archive-rejection' ? ['--mount', `type=bind,src=${fileURLToPath(new URL('../scripts', import.meta.url))},dst=/workspace/scripts,readonly`] : []),
      '--entrypoint', 'node', image, '--test', `tests/${file}.test.mjs`]);
    containers.push(suiteName);
    let tests;
    try {
      tests = await docker(['start', '--attach', suiteName]);
      const [suite] = JSON.parse(await docker(['container', 'inspect', suiteName]));
      assert.equal(suite.State.Running, false);
      assert.equal(suite.State.ExitCode, 0, tests);
    } catch (error) {
      // Killing the attached Docker client does not stop its container. Keep its name
      // for confirmed cleanup, and retain the bounded original test diagnostic.
      const logs = await docker(['logs', '--tail', '100', suiteName]);
      throw new Error(`Packaged ${file} tests failed or exceeded their deadline.\n${logs}`, { cause: error });
    }
    assert.match(tests, new RegExp(`# tests ${count}\\b`, 'u'));
    assert.match(tests, /# fail 0\b/u); assert.match(tests, /# skipped 0\b/u);
    console.log(JSON.stringify({ suite: file, tests: count, status: 'passed' }));
  }
  record(`packaged Linux CLI passes all ${suites.reduce((count, suite) => count + suite[1], 0)} owner, initialization, configuration, recovery, Runtime-routing, signed grant-install and archive-budget tests`);

  // Synthetic image identities exercise configuration plumbing only; no provider or Runtime is started here.
  const images = Object.fromEntries(distribution.services.filter(service => first.plan.requiredServices.includes(service.id) && service.image)
    .map(service => [service.id, { reference: service.image, digest: `sha256:${'b'.repeat(64)}` }]));
  const preparation = { format: STACK_OWNER_FORMAT, command: 'configure', input: {
    id: randomUUID(), scopeDigest: stackOwnerScopeDigest(owner), expected: first, images,
  } };
  assert.equal((await configureDockerStackOwner(owner, preparation)).status, 'prepared');
  assert.deepEqual((await inspectDockerStackOwner(distribution, owner, req())).runtime, first.runtime);
  assert.deepEqual((await inspectDockerStackOwner(distribution, second, req())).runtime, alternate.runtime);
  const rollback = { format: STACK_OWNER_FORMAT, command: 'configuration.rollback', input: {
    id: preparation.input.id, scopeDigest: preparation.input.scopeDigest,
  } };
  await assert.rejects(configureDockerStackOwner(second, rollback), { code: 'stack_owner_scope_mismatch' });
  assert.equal((await configureDockerStackOwner(owner, rollback)).status, 'rolled_back');
  assert.equal((await configureDockerStackOwner(owner, rollback)).status, 'rolled_back');
  assert.deepEqual(await inspectDockerStackOwner(distribution, owner, req()), first);
  record('typed Windows configuration prepares and rolls back Linux files exactly without changing either Runtime; wrong volume scope is rejected');

  const undispatched = structuredClone(preparation); undispatched.input.id = randomUUID();
  const cancel = { format: STACK_OWNER_FORMAT, command: 'configuration.cancel', input: {
    id: undispatched.input.id, scopeDigest: undispatched.input.scopeDigest, expected: first,
  } };
  assert.equal((await configureDockerStackOwner(owner, cancel)).status, 'rolled_back');
  assert.equal((await configureDockerStackOwner(owner, cancel)).status, 'rolled_back');
  await assert.rejects(configureDockerStackOwner(owner, undispatched), { code: 'stack_owner_already_settled' });
  assert.deepEqual(await inspectDockerStackOwner(distribution, owner, req()), first);
  record('host cancellation before owner dispatch is acknowledged from verified state and rejects delayed preparation');

  // Real host death after the isolated Linux owner prepares; Compose actions are intentionally not run.
  const coordinator = { ...structuredClone(preparation), input: { ...structuredClone(preparation.input), id: randomUUID() } };
  const composeFile = path.join(hostRoot, 'fixture-compose.yaml'), compose = 'services: {}\n';
  await fs.writeFile(composeFile, compose);
  const environment = Object.entries({ DKB_STACK_NAME: 'coordinator', DKB_DOCKER_CONTEXT: owner.context, DKB_CLI_IMAGE: owner.image,
    DKB_LIBRARY_VOLUME: owner.libraryVolume, DKB_RUNTIME_VOLUME: owner.runtimeVolume, DKB_COMPILER_CONTEXT_VOLUME: owner.compilerVolume,
    DKB_COMPILER_DEFAULT_TARGET: first.plan.compilerTarget, DKB_RUNTIME_PIPELINE_TARGET: first.plan.runtimeTarget }).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
  const plan = { owner, configuration: coordinator, composeFile, composeDigest: stableHash(compose), before: null, after: environment,
    wasRunning: false, registration: { library: 'coordinator-library', runtime: 'coordinator-runtime', registry: 'coordinator-registry' } };
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {DEFAULT_DKB_DISTRIBUTION as distribution} from '@sjshovan/dkb-distribution-default';
    import {startOwnedStack} from ${JSON.stringify(new URL('../apps/cli/dist/stack/ownerStartup.js', import.meta.url).href)};
    const plan=JSON.parse(await new Promise(resolve=>{let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>resolve(s));}));
    await startOwnedStack(distribution,'coordinator',plan,{async start(){console.log('prepared');setInterval(()=>{},1000);await new Promise(()=>{});},async stop(){},async activate(){throw new Error('unexpected activation');},async register(){throw new Error('unexpected registration');}});
  `], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const closed = once(child, 'close'); let output = '', errors = '', timer;
  const prepared = new Promise(resolve => child.stdout.on('data', data => { output += data; if (output.includes('prepared')) resolve(); }));
  child.stderr.on('data', data => { errors += data; }); child.stdin.end(JSON.stringify(plan));
  try {
    await Promise.race([prepared, closed.then(() => { throw new Error(errors); }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Host preparation did not finish')), 30_000); })]);
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; }
  const calls = [];
  assert.equal(await recoverOwnedStackStartup(distribution, 'coordinator', {
    async start() { calls.push('start'); }, async stop() { calls.push('stop'); },
    async activate() { assert.fail('recovery must not replay activation'); }, async register() { assert.fail('rollback must not register'); },
  }), 'rolled_back');
  assert.deepEqual(calls, ['stop']);
  assert.deepEqual(await inspectDockerStackOwner(distribution, owner, req()), first);
  await assert.rejects(fs.access(path.join(hostRoot, 'coordinator', 'stack.env')), { code: 'ENOENT' });
  record('killed Windows coordinator recovers its exact Linux preparation without repeating activation or losing the host operation identity');

  await run(owner, `await fs.writeFile('/state/.dkb/config.json','{synthetic-secret-do-not-echo');`);
  await assert.rejects(inspectDockerStackOwner(distribution, owner, req()), error => !error.message.includes('synthetic-secret-do-not-echo'));
  await run(owner, `assert.equal(await fs.readFile('/state/.dkb/config.json','utf8'),'{synthetic-secret-do-not-echo'); await fs.rm('/state/.dkb/config.json');`);
  assert.deepEqual((await inspectDockerStackOwner(distribution, owner, req())).runtime, first.runtime);
  record('broken owner configuration fails closed without echoing its contents or changing selection');

  const name = `${prefix}-writer`;
  await docker(['create', '--name', name, ...common(owner), '--entrypoint', 'node', image, '--input-type=module', '-e', imports + `
    await withRuntimeMutation('/state',async()=>{console.log('ready');setInterval(()=>{},1000);await new Promise(()=>{});});`]);
  containers.push(name); await docker(['start', name]);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const [info] = JSON.parse(await docker(['container', 'inspect', name]));
    assert.equal(info.State.Running, true, await docker(['logs', name]));
    if ((await docker(['logs', name])).trim() === 'ready') { ready = true; break; }
    await delay(50);
  }
  assert.equal(ready, true); await docker(['pause', name]);
  const abort = new AbortController(); let finished = false;
  const observation = inspectDockerStackOwner(distribution, owner, req(), abort.signal).then(
    value => { finished = true; return { value }; }, error => { finished = true; return { error }; });
  // Wait for actual worker dispatch, not just a timer which could cancel during preflight.
  let dispatched = false;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      const names = (await docker(['container', 'ls', '--filter', 'label=dev.dkb.owner.operation', '--format', '{{.Names}}'])).trim().split('\n');
      if (names.some(item => item.startsWith('dkb-stack-owner-'))) { dispatched = true; break; }
      await delay(50);
    }
    assert.equal(dispatched, true); assert.equal(finished, false);
    assert.deepEqual((await inspectDockerStackOwner(distribution, second, req())).runtime, alternate.runtime);
  } finally { abort.abort(); await observation; }
  const cancelled = await observation;
  assert.equal(cancelled.error?.code, 'library_owner_cancelled');
  await docker(['unpause', name]); await docker(['kill', '--signal', 'KILL', name]);
  const [stopped] = JSON.parse(await docker(['container', 'inspect', name]));
  assert.equal(stopped.State.Running, false); assert.equal(stopped.State.ExitCode, 137);
  assert.deepEqual((await inspectDockerStackOwner(distribution, owner, req())).runtime, first.runtime);
  record('paused Runtime excludes inspection while another Runtime stays readable; cancellation and process-death cleanup preserve both volumes');
  console.log(JSON.stringify({ status: 'passed', context, image, checks: checks.length, userResourcesChanged: false }));
} catch (error) {
  // Cleanup may itself fail when Docker has not acknowledged an owner operation.
  // Always retain the primary diagnostic instead of showing only a volume error.
  console.error('Stack owner proof failed:', error);
  throw error;
} finally {
  for (const name of containers) {
    const [info] = JSON.parse(await docker(['container', 'inspect', name]));
    assert.equal(info.Config.Labels['dev.dkb.stack-owner-proof'], id);
    if (info.State.Paused) await docker(['unpause', name]);
    await docker(['container', 'rm', '--force', info.Id]);
  }
  for (const volume of volumes) {
    const [info] = JSON.parse(await docker(['volume', 'inspect', volume]));
    assert.equal(info.Labels['dev.dkb.stack-owner-proof'], id);
    await docker(['volume', 'rm', volume]);
  }
  if (previousStateRoot === undefined) delete process.env.DKB_STACK_STATE_ROOT; else process.env.DKB_STACK_STATE_ROOT = previousStateRoot;
  assert.equal(path.dirname(hostRoot), path.resolve(os.tmpdir()));
  assert.ok(path.basename(hostRoot).startsWith('dkb-stack-coordinator-proof-'));
  await fs.rm(hostRoot, { recursive: true, force: true });
}
async function raw(args) {
  const result = await ownerDockerProcess(args, { timeoutMs: 45_000 });
  assert.equal(result.code, 0, result.stderr || result.stdout); return result.stdout;
}
