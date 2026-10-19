import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { DEFAULT_DKB_DISTRIBUTION as distribution } from '@sjshovan/dkb-distribution-default';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { inspectRuntimeSelection } from '@sjshovan/dkb-runtime/runtime/state.js';
import { switchRuntimePipelineFromRegistry } from '@sjshovan/dkb-runtime/runtime/pipelineSwitch.js';
import { DEFAULT_DKB_RUNTIME_CONTEXT as runtime } from '@sjshovan/dkb-runtime/defaultComposition.js';
import { startOwnedStack, recoverOwnedStackStartup, STACK_OWNER_STARTUP_JOURNAL } from '../apps/cli/dist/stack/ownerStartup.js';
import { configureStackOwner } from '../apps/cli/dist/stack/ownerConfiguration.js';
import { inspectStackOwnerState } from '../apps/cli/dist/stack/ownerInspection.js';
import { stackOwnerScopeDigest, STACK_OWNER_FORMAT } from '../apps/cli/dist/stack/ownerContract.js';
import { createQueryFixture } from './runtime-query-fixture.mjs';

const read = file => fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const configurationFiles = async f => Promise.all(['compiler', 'runtime'].map(key => read(path.join(f.paths[`${key}Root`], '.dkb/config.json'))));
async function fixture(t, wasRunning = true) {
  const f = await createQueryFixture(t);
  f.paths = { libraryRoot: f.libraryRoot, runtimeRoot: f.runtimeRoot, compilerRoot: path.join(f.root, 'compiler') };
  await fs.mkdir(path.join(f.paths.compilerRoot, '.dkb'), { recursive: true });
  f.name = 'owned';
  const previous = process.env.DKB_STACK_STATE_ROOT;
  process.env.DKB_STACK_STATE_ROOT = path.join(f.root, 'host');
  t.after(() => { if (previous === undefined) delete process.env.DKB_STACK_STATE_ROOT; else process.env.DKB_STACK_STATE_ROOT = previous; });
  f.environment = path.join(process.env.DKB_STACK_STATE_ROOT, f.name, 'stack.env');
  f.journal = path.join(process.env.DKB_STACK_STATE_ROOT, '.control', f.name, STACK_OWNER_STARTUP_JOURNAL);
  f.composeFile = path.join(f.root, 'compose.yaml');
  const compose = 'services: {}\n';
  await fs.writeFile(f.composeFile, compose);
  const owner = { context: 'desktop-linux', image: `sha256:${'c'.repeat(64)}`, libraryVolume: 'shared-library', runtimeVolume: 'one-runtime', compilerVolume: 'one-compiler' };
  const expected = await inspectStackOwnerState(distribution, f.paths, { format: STACK_OWNER_FORMAT, command: 'inspect', input: {} });
  const images = Object.fromEntries(distribution.services.filter(service => expected.plan.requiredServices.includes(service.id) && service.image)
    .map(service => [service.id, { reference: service.image, digest: `sha256:${'b'.repeat(64)}` }]));
  const environment = Object.entries({ DKB_STACK_NAME: f.name, DKB_DOCKER_CONTEXT: owner.context, DKB_CLI_IMAGE: owner.image,
    DKB_LIBRARY_VOLUME: owner.libraryVolume, DKB_RUNTIME_VOLUME: owner.runtimeVolume, DKB_COMPILER_CONTEXT_VOLUME: owner.compilerVolume,
    DKB_COMPILER_DEFAULT_TARGET: expected.plan.compilerTarget, DKB_RUNTIME_PIPELINE_TARGET: expected.plan.runtimeTarget }).map(([key, value]) => `${key}=${value}`).join('\n');
  f.plan = { owner, configuration: { format: STACK_OWNER_FORMAT, command: 'configure', input: { id: randomUUID(), scopeDigest: stackOwnerScopeDigest(owner), expected, images } },
    composeFile: f.composeFile, composeDigest: stableHash(compose), before: wasRunning ? `${environment}\nDKB_RUNTIME_PORT=7001\n` : null,
    after: `${environment}\nDKB_RUNTIME_PORT=7002\n`, wasRunning, registration: { library: 'shared', runtime: 'one', registry: 'registry' } };
  await fs.mkdir(path.dirname(f.environment), { recursive: true });
  if (f.plan.before) await fs.writeFile(f.environment, f.plan.before);
  f.original = { files: await configurationFiles(f), selection: await inspectRuntimeSelection(f.runtimeRoot) };
  f.calls = [];
  f.transport = async (suppliedOwner, request) => {
    assert.deepEqual(suppliedOwner, owner);
    f.calls.push(request.command);
    assert.equal(JSON.parse(await fs.readFile(f.journal)).journal.plan.configuration.input.id, request.input.id, 'host journal precedes every dispatch');
    return configureStackOwner(distribution, f.paths, request);
  };
  f.actions = {
    async start(plan) { f.calls.push('start'); assert.equal(await read(f.environment), plan.after); },
    async stop() { f.calls.push('stop'); },
    async activate() { f.calls.push('activate'); await switchRuntimePipelineFromRegistry({ runtime, stateRoot: f.runtimeRoot, target: 'fixture' }); },
    async register(plan) { f.calls.push('register'); await fs.writeFile(path.join(f.root, 'registered.json'), JSON.stringify(plan.registration)); },
  };
  return f;
}
const start = f => startOwnedStack(distribution, f.name, f.plan, f.actions, f.transport);
const recover = f => recoverOwnedStackStartup(distribution, f.name, f.actions, f.transport);
async function redirectStackDirectory(f) {
  const directory = path.dirname(f.environment), outside = path.join(f.root, 'outside-stack');
  assert.equal(path.dirname(directory), path.join(f.root, 'host'));
  await fs.rename(directory, outside);
  await fs.symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
  return path.join(outside, 'stack.env');
}
async function assertRestored(f) {
  assert.equal(await read(f.environment), f.plan.before);
  assert.deepEqual(await configurationFiles(f), f.original.files);
  assert.deepEqual(await inspectRuntimeSelection(f.runtimeRoot), f.original.selection);
  assert.equal(await read(f.journal), null);
  assert.equal(await read(path.join(f.root, 'registered.json')), null);
}

test('owner startup journals before dispatch and registers only after real activation acknowledgement', async t => {
  const f = await fixture(t);
  assert.equal(await start(f), 'committed');
  assert.deepEqual(f.calls, ['configure', 'start', 'activate', 'configuration.commit', 'register']);
  assert.equal(await read(f.environment), f.plan.after);
  assert.equal(await read(f.journal), null);
  assert.equal((await inspectRuntimeSelection(f.runtimeRoot)).activation.generation, f.original.selection.activation.generation + 1);
  assert.equal(await recover(f), 'none');
});

test('failed or undispatched preparation restores without starting or stopping services', async t => {
  const f = await fixture(t), transport = f.transport;
  f.transport = async (owner, request) => { if (request.command === 'configure') throw new Error('owner dispatch unavailable'); return transport(owner, request); };
  await assert.rejects(start(f), { code: 'stack_startup_failed' });
  assert.deepEqual(f.calls, ['configuration.cancel']);
  await assertRestored(f);
  await assert.rejects(configureStackOwner(distribution, f.paths, f.plan.configuration), { code: 'stack_owner_already_settled' });
});

for (const stage of ['start', 'activate']) test(`failed ${stage} restores exact previous topology without changing Runtime selection`, async t => {
  const f = await fixture(t), original = f.actions[stage];
  let first = true;
  f.actions[stage] = async (...args) => { if (first) { first = false; throw new Error('failed service'); } return original(...args); };
  await assert.rejects(start(f), { code: 'stack_startup_failed' });
  assert.ok(f.calls.includes('stop'));
  await assertRestored(f);
});

test('new Stack startup failure removes only its environment, not owner data or host recovery control', async t => {
  const f = await fixture(t, false);
  f.actions.start = async () => { throw new Error('initial service failed'); };
  await assert.rejects(start(f), { code: 'stack_startup_failed' });
  await assertRestored(f);
  await fs.access(path.join(f.libraryRoot, 'dkb.json'));
  await fs.access(path.join(path.dirname(f.journal), '.dkb/locks/stack-control.lease.sqlite'));
});

test('lost activation and owner acknowledgement replies retain committed selection without stopping services', async t => {
  const f = await fixture(t), activate = f.actions.activate, transport = f.transport;
  f.actions.activate = async () => { await activate(); throw new Error('lost HTTP reply'); };
  f.transport = async (owner, request) => { const result = await transport(owner, request); if (request.command === 'configuration.commit') throw new Error('lost owner receipt'); return result; };
  assert.equal(await start(f), 'committed');
  assert.equal(f.calls.includes('stop'), false);
  assert.equal(await read(f.environment), f.plan.after);
  assert.equal(await read(f.journal), null);
});

test('partial registration failure retains exact operation and retry never activates or starts again', async t => {
  const f = await fixture(t), register = f.actions.register;
  f.actions.register = async plan => { await register(plan); throw new Error('host inventory temporarily unavailable'); };
  await assert.rejects(start(f), { code: 'stack_recovery_required' });
  const activated = await inspectRuntimeSelection(f.runtimeRoot);
  await fs.access(f.journal);
  f.calls.length = 0;
  f.actions.register = register;
  assert.equal(await recover(f), 'committed');
  assert.deepEqual(f.calls, ['configuration.cancel', 'register']);
  assert.deepEqual(await inspectRuntimeSelection(f.runtimeRoot), activated);
  assert.equal(await read(f.journal), null);
});

test('owner unavailable during rollback retains host intent until exact acknowledgement is available', async t => {
  const f = await fixture(t), transport = f.transport;
  f.actions.start = async () => { throw new Error('failed startup'); };
  f.transport = async (owner, request) => { if (request.command === 'configuration.cancel') throw new Error('owner offline'); return transport(owner, request); };
  await assert.rejects(start(f), { code: 'stack_recovery_required' });
  assert.equal(f.calls.includes('stop'), false);
  assert.equal(await read(f.environment), f.plan.after);
  f.transport = transport;
  f.actions.start = async plan => { f.calls.push('restart'); assert.equal(plan.after, f.plan.before); };
  assert.equal(await recover(f), 'rolled_back');
  await assertRestored(f);
});

test('failed previous-service restart keeps the journal and retries only acknowledged host restoration', async t => {
  const f = await fixture(t);
  f.actions.start = async () => { throw new Error('service unavailable'); };
  await assert.rejects(start(f), { code: 'stack_recovery_required' });
  assert.equal(await read(f.environment), f.plan.before);
  assert.deepEqual(await configurationFiles(f), f.original.files);
  f.calls.length = 0;
  f.actions.start = async plan => { f.calls.push('restart'); assert.equal(plan.after, f.plan.before); };
  assert.equal(await recover(f), 'rolled_back');
  assert.deepEqual(f.calls, ['configuration.cancel', 'stop', 'restart']);
  await assertRestored(f);
});

test('malformed host recovery never dispatches owner operations or modifies either state', async t => {
  const f = await fixture(t), transport = f.transport;
  f.transport = async () => { throw new Error('disconnected'); };
  await assert.rejects(start(f), { code: 'stack_recovery_required' });
  const saved = JSON.parse(await fs.readFile(f.journal));
  for (const mutation of [entry => { entry.digest = `sha256:${'f'.repeat(64)}`; }, entry => { entry.journal.name = 'another'; entry.digest = stableHash(entry.journal); },
    entry => { entry.journal.plan.owner.libraryVolume = 'different'; entry.digest = stableHash(entry.journal); }]) {
    const value = structuredClone(saved); mutation(value); const bytes = JSON.stringify(value);
    await fs.writeFile(f.journal, bytes);
    f.transport = transport;
    await assert.rejects(recover(f), { code: 'stack_recovery_required' });
    assert.equal(await read(f.journal), bytes);
    assert.equal(await read(f.environment), f.plan.before);
    assert.deepEqual(await configurationFiles(f), f.original.files);
  }
  assert.deepEqual(f.calls, []);
});

test('callbacks cannot rewrite the journal plan through shared object references', async t => {
  const f = await fixture(t), startServices = f.actions.start, register = f.actions.register;
  f.actions.start = async plan => { await startServices(plan); plan.after = 'corrupted by callback'; plan.owner.libraryVolume = 'other'; };
  f.actions.register = async plan => { await register(plan); plan.registration.library = 'changed'; };
  assert.equal(await start(f), 'committed');
  assert.equal(await read(f.environment), f.plan.after);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'registered.json'))).library, f.plan.registration.library);
});

test('linked Stack directory rejects startup before owner dispatch or outside environment changes', async t => {
  const f = await fixture(t), outside = await redirectStackDirectory(f);
  await assert.rejects(start(f), { code: 'stack_recovery_required' });
  assert.deepEqual(f.calls, []);
  assert.equal(await read(outside), f.plan.before);
  assert.equal(await read(f.journal), null);
  assert.deepEqual(await configurationFiles(f), f.original.files);
});

test('linked Stack directory rejects recovery before owner settlement and preserves its journal', async t => {
  const f = await fixture(t), transport = f.transport;
  f.transport = async () => { throw new Error('disconnected'); };
  await assert.rejects(start(f), { code: 'stack_recovery_required' });
  const journal = await read(f.journal), outside = await redirectStackDirectory(f);
  f.transport = transport;
  await assert.rejects(recover(f), { code: 'stack_recovery_required' });
  assert.deepEqual(f.calls, []);
  assert.equal(await read(outside), f.plan.before);
  assert.equal(await read(f.journal), journal);
  assert.deepEqual(await configurationFiles(f), f.original.files);
});

test('service callback cannot redirect Stack files and proceed into activation', async t => {
  const f = await fixture(t);
  let outside;
  f.actions.start = async () => { outside = await redirectStackDirectory(f); };
  await assert.rejects(start(f), { code: 'stack_recovery_required' });
  assert.deepEqual(f.calls, ['configure']);
  assert.equal(await read(outside), f.plan.after);
  assert.deepEqual(await inspectRuntimeSelection(f.runtimeRoot), f.original.selection);
  await fs.access(f.journal);
});

test('registration callback cannot redirect Stack files and erase the recovery record', async t => {
  const f = await fixture(t);
  let outside;
  f.actions.register = async () => { outside = await redirectStackDirectory(f); };
  await assert.rejects(start(f), { code: 'stack_recovery_required' });
  assert.equal(await read(outside), f.plan.after);
  assert.equal(f.calls.includes('stop'), false);
  assert.equal(f.calls.includes('configuration.cancel'), false);
  await fs.access(f.journal);
});

for (const drift of ['environment', 'compose', 'owner']) test(`unrelated ${drift} changes preserve recovery and never overwrite operator state`, async t => {
  const f = await fixture(t);
  f.actions.start = async () => {
    if (drift === 'environment') await fs.writeFile(f.environment, 'operator-owned=unchanged\n');
    if (drift === 'compose') await fs.writeFile(f.composeFile, 'operator changed distribution\n');
    if (drift === 'owner') await fs.writeFile(path.join(f.runtimeRoot, '.dkb/config.json'), '{operator change');
    throw new Error('interrupted start');
  };
  await assert.rejects(start(f), { code: 'stack_recovery_required' });
  assert.equal(f.calls.includes('stop'), false);
  const retained = await read(f.journal);
  await assert.rejects(recover(f), { code: 'stack_recovery_required' });
  assert.equal(await read(f.journal), retained);
});

test('malformed, mismatched-storage and changed-Compose plans fail before any owner dispatch', async t => {
  const f = await fixture(t);
  for (const change of [{ owner: { ...f.plan.owner, libraryVolume: 'wrong-library' } }, { registration: { library: '../../bad' } },
    { after: f.plan.after.replace('DKB_RUNTIME_VOLUME=one-runtime', 'DKB_RUNTIME_VOLUME=other-runtime') }, { arbitrary: 'command' }]) {
    await assert.rejects(startOwnedStack(distribution, f.name, { ...f.plan, ...change }, f.actions, f.transport), { code: 'invalid_stack_startup_plan' });
  }
  await fs.writeFile(f.composeFile, 'changed\n');
  await assert.rejects(start(f), { code: 'stack_recovery_required' });
  assert.deepEqual(f.calls, []);
  assert.equal(await read(f.journal), null);
});

for (const phase of ['before-dispatch', 'prepared', 'env-staged', 'env-promoted', 'services-started', 'activated', 'registered']) {
  test(`real host process death at ${phase} settles from owner state without replaying activation`, async t => {
    const f = await fixture(t);
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs/promises';
      import {DEFAULT_DKB_DISTRIBUTION as distribution} from '@sjshovan/dkb-distribution-default';
      import {DEFAULT_DKB_RUNTIME_CONTEXT as runtime} from '@sjshovan/dkb-runtime/defaultComposition.js';
      import {switchRuntimePipelineFromRegistry} from '@sjshovan/dkb-runtime/runtime/pipelineSwitch.js';
      import {startOwnedStack} from ${JSON.stringify(new URL('../apps/cli/dist/stack/ownerStartup.js', import.meta.url).href)};
      import {configureStackOwner} from ${JSON.stringify(new URL('../apps/cli/dist/stack/ownerConfiguration.js', import.meta.url).href)};
      const input=JSON.parse(await new Promise(resolve=>{let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>resolve(s));}));
      const pause=async()=>{console.log('ready');setInterval(()=>{},1000);await new Promise(()=>{});};
      const phase=${JSON.stringify(phase)},rename=fs.rename;
      fs.rename=async(from,to)=>{if(to===input.environment&&phase.startsWith('env-')){if(phase==='env-promoted')await rename(from,to);await pause();}return rename(from,to);};
      const transport=async(owner,request)=>{if(request.command==='configure'&&phase==='before-dispatch')await pause();const result=await configureStackOwner(distribution,input.paths,request);if(request.command==='configure'&&phase==='prepared')await pause();return result;};
      await startOwnedStack(distribution,input.name,input.plan,{
        async start(){if(phase==='services-started')await pause();},async stop(){},
        async activate(){await switchRuntimePipelineFromRegistry({runtime,stateRoot:input.paths.runtimeRoot,target:'fixture'});if(phase==='activated')await pause();},
        async register(){await fs.writeFile(input.registered,'partial registration');if(phase==='registered')await pause();}
      },transport);
    `], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const closed = once(child, 'close');
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
    let output = '', errors = '', timer;
    const ready = new Promise(resolve => child.stdout.on('data', data => { output += data; if (output.includes('ready')) resolve(); }));
    child.stderr.on('data', data => { errors += data; });
    child.stdin.end(JSON.stringify({ name: f.name, plan: f.plan, paths: f.paths, environment: f.environment, registered: path.join(f.root, 'registered.json') }));
    try { await Promise.race([ready, closed.then(() => { throw new Error(errors); }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Host checkpoint not reached')), 20_000); })]); }
    finally { clearTimeout(timer); }
    child.kill('SIGKILL'); await closed;
    const committed = ['activated', 'registered'].includes(phase);
    assert.equal(await recover(f), committed ? 'committed' : 'rolled_back');
    assert.equal(f.calls.includes('activate'), false);
    if (committed) { assert.equal(await read(f.environment), f.plan.after); assert.equal(f.calls.includes('stop'), false); }
    else await assertRestored(f);
    assert.equal(await read(f.journal), null);
    assert.equal(await recover(f), 'none');
    assert.equal(await read(`${f.environment}.owner-startup.tmp`), null);
  });
}
