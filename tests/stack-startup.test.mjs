import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_DKB_DISTRIBUTION } from '@sjshovan/dkb-distribution-default';
import { compileComposeProject } from '@sjshovan/dkb-compiler/compile.js';
import { addLibraryRoot } from '@sjshovan/dkb-library/resolver.js';
import { DEFAULT_DKB_RUNTIME_CONTEXT as runtime } from '@sjshovan/dkb-runtime/defaultComposition.js';
import { ensureRuntimeState } from '@sjshovan/dkb-runtime/runtime/state.js';
import { switchRuntimeLibrary, switchRuntimePipelineFromRegistry } from '@sjshovan/dkb-runtime/runtime/pipelineSwitch.js';
import { searchRuntime } from '@sjshovan/dkb-runtime/runtime/queryAccess.js';
import { closeQueryContext } from '@sjshovan/dkb-runtime/runtime/queryCache.js';
import { withStackStartup } from '../apps/cli/dist/stack/startup.js';
import { readDkbStack, readEnvironmentFile, writeEnvironmentFile, writeAtomic } from '../apps/cli/dist/stack/context.js';
import { runCompose } from '../apps/cli/dist/stack/docker.js';

test('Stack failure before Docker preserves an admitted warm Runtime and exact configuration', async (t) => {
  const f = await fixture(t);
  await assert.rejects(withStackStartup(f.distribution, f.name, async (startup) => {
    await startup.configure(async () => {
      await configure(f, 'b');
      const configPath = path.join(f.runtimeRoot, '.dkb/config.json');
      await json(configPath, { ...JSON.parse(await fs.readFile(configPath)), activeTarget: 'b' });
    });
    await assert.rejects(query(f, 'STACK-FIRST-42'), /configuration|changed|drift/iu);
    throw new Error('Docker is unavailable');
  }), /Docker is unavailable/u);
  await assertPreviousReady(f);
  assert.deepEqual(f.docker.calls, []);
});

test('ordinary same-Pipeline Stack restart commits a new admission without rolling back unchanged configuration', async (t) => {
  const f = await fixture(t);
  const before = await ensureRuntimeState(f.runtimeRoot);
  await withStackStartup(f.distribution, f.name, async (startup) => {
    const context = await startup.configure(() => readDkbStack(f.distribution, f.name));
    await startup.changeServices(context, () => runCompose(context, ['up', '-d']));
    await startup.activate(context, () => switchRuntimePipelineFromRegistry({ runtime, stateRoot: f.runtimeRoot, target: 'a' }));
  });
  const after = await ensureRuntimeState(f.runtimeRoot);
  assert.equal(after.target, 'a');
  assert.equal(after.activation.generation, before.activation.generation + 1);
  assert.deepEqual(after.activation.packages, before.activation.packages);
  assert.deepEqual(await files(f), f.beforeFiles);
  assert.equal((await query(f, 'STACK-FIRST-42')).results.length, 1);
  assert.equal(f.docker.calls.some((call) => call.command === 'down'), false);
  await assert.rejects(fs.access(path.join(f.stackRoot, 'startup-recovery.json')), { code: 'ENOENT' });
});

test('Stack remount followed by rejected activation restores the old mount, config and admitted Runtime', async (t) => {
  const f = await fixture(t);
  await assert.rejects(withStackStartup(f.distribution, f.name, async (startup) => {
    const context = await startup.configure(() => configure(f, 'broken'));
    await startup.changeServices(context, () => runCompose(context, ['up', '-d']));
    assert.equal(f.docker.mount, f.libraryB);
    await startup.activate(context, () => switchRuntimeLibrary({ runtime, stateRoot: f.runtimeRoot, libraryRoot: f.libraryB, target: 'broken' }));
  }), /missing|not found|not installed/iu);
  await assertPreviousReady(f);
  assert.equal(f.docker.mount, f.libraryA);
  assert.deepEqual(f.docker.calls.map((call) => call.command), ['ps', 'up', 'down', 'up']);
});

test('Stack failed Compose up restores the previous running topology without writing activation', async (t) => {
  const f = await fixture(t);
  f.docker.failNextUp = true;
  await assert.rejects(withStackStartup(f.distribution, f.name, async (startup) => {
    const context = await startup.configure(() => configure(f, 'b'));
    await startup.changeServices(context, () => runCompose(context, ['up', '-d']));
  }), /fixture Compose failure/u);
  await assertPreviousReady(f);
  assert.equal(f.docker.mount, f.libraryA);
});

test('Stack recognizes committed activation when the admin response is lost and does not roll it back', async (t) => {
  const f = await fixture(t);
  await withStackStartup(f.distribution, f.name, async (startup) => {
    const context = await startup.configure(() => configure(f, 'b'));
    await startup.changeServices(context, () => runCompose(context, ['up', '-d']));
    await startup.activate(context, async () => {
      await switchRuntimeLibrary({ runtime, stateRoot: f.runtimeRoot, libraryRoot: f.libraryB, target: 'b' });
      throw new Error('admin response lost after commit');
    });
  });
  assert.equal((await ensureRuntimeState(f.runtimeRoot)).target, 'b');
  assert.equal(f.docker.mount, f.libraryB);
  assert.equal((await query(f, 'STACK-SECOND-84')).results.length, 1);
  assert.equal(f.docker.calls.some((call) => call.command === 'down'), false);
  await assert.rejects(fs.access(path.join(f.stackRoot, 'startup-recovery.json')), { code: 'ENOENT' });
});

test('Stack recovery never overwrites a concurrently committed different activation', async (t) => {
  const f = await fixture(t);
  let concurrent;
  await assert.rejects(withStackStartup(f.distribution, f.name, async (startup) => {
    const context = await startup.configure(() => configure(f, 'b'));
    await startup.changeServices(context, () => runCompose(context, ['up', '-d']));
    await startup.activate(context, async () => {
      await switchRuntimeLibrary({ runtime, stateRoot: f.runtimeRoot, libraryRoot: f.libraryB, target: 'a' });
      concurrent = await activation(f);
      throw new Error('concurrent operator selection');
    });
  }), (error) => error.code === 'stack_recovery_required' && /changed concurrently/u.test(error.message) && /dkb stack up rollback/u.test(error.message));
  assert.deepEqual(await activation(f), concurrent);
  assert.equal((await ensureRuntimeState(f.runtimeRoot)).target, 'a');
  assert.equal(f.docker.mount, f.libraryB);
  assert.equal((await query(f, 'STACK-SECOND-84')).results.length, 1);
  assert.equal(f.docker.calls.some((call) => call.command === 'down'), false);
  assert.ok(await fs.readFile(path.join(f.stackRoot, 'startup-recovery.json'), 'utf8'));
});

test('Stack retains recovery configuration when restoration fails and retries it before the next attempt', async (t) => {
  const f = await fixture(t);
  await assert.rejects(withStackStartup(f.distribution, f.name, async (startup) => {
    const context = await startup.configure(() => configure(f, 'b'));
    await startup.changeServices(context, () => runCompose(context, ['up', '-d']));
    f.docker.failNextUp = true;
    throw new Error('health check failed');
  }), (error) => error.code === 'stack_recovery_required' && /Previous configuration is retained/u.test(error.message));
  assert.deepEqual(await activation(f), f.beforeActivation);
  await assert.rejects(withStackStartup(f.distribution, f.name, async () => {
    assert.equal(f.docker.mount, f.libraryA);
    throw new Error('next attempt stopped before mutation');
  }), /next attempt stopped before mutation/u);
  await assertPreviousReady(f);
});

test('Stack rejects malformed recovery expectations without changing admitted state', async (t) => {
  const f = await fixture(t);
  const names = ['stack.env', 'compiler-context/.dkb/config.json', 'runtime/.dkb/config.json'];
  const saved = Object.fromEntries(names.map((name, index) => [name, f.beforeFiles[index]]));
  const binding = await fs.readFile(path.join(f.runtimeRoot, '.dkb/runtime-binding.json'), 'utf8');
  for (const expected of [false, 0, '', [], { target: 'a', library: { id: 'known', generation: -1, stateDigest: `sha256:${'a'.repeat(64)}` } }]) {
    await json(path.join(f.stackRoot, 'startup-recovery.json'), {
      format: 'dkb.stack-startup.v1', files: saved, written: saved, selection: { binding, activation: f.beforeActivation.toString() },
      servicesChanged: false, wasRunning: false, expected,
    });
    await assert.rejects(withStackStartup(f.distribution, f.name, async () => assert.fail('invalid recovery admitted')), /Invalid Stack startup recovery expectation/u);
    assert.deepEqual(await files(f), f.beforeFiles);
    assert.deepEqual(await activation(f), f.beforeActivation);
  }
  assert.deepEqual(f.docker.calls, []);
});

test('competing Stack starts reclaim an abandoned lease without deleting the new owner lock', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-stack-startup-lock-'));
  const previousRoot = process.env.DKB_STACK_STATE_ROOT;
  process.env.DKB_STACK_STATE_ROOT = root;
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.DKB_STACK_STATE_ROOT;
    else process.env.DKB_STACK_STATE_ROOT = previousRoot;
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const deadPid = 2147483647;
  const nativeKill = process.kill.bind(process);
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid === deadPid) throw Object.assign(new Error('fixture abandoned process'), { code: 'ESRCH' });
    return nativeKill(pid, signal);
  });
  const lockPath = path.join(root, 'lease', 'startup.lock');
  await json(lockPath, { token: 'abandoned', pid: deadPid, host: os.hostname() });
  let release;
  let reportEntered;
  let entered = 0;
  const hold = new Promise((resolve) => { release = resolve; });
  const firstEntered = new Promise((resolve) => { reportEntered = resolve; });
  const action = async () => { entered++; reportEntered(); await hold; return 'finished'; };
  const runs = [withStackStartup(DEFAULT_DKB_DISTRIBUTION, 'lease', action), withStackStartup(DEFAULT_DKB_DISTRIBUTION, 'lease', action)];
  let timeout;
  let results;
  const deadline = new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Competing Stack starts did not enforce one owner')), 5_000); });
  try {
    await assert.rejects(Promise.race([...runs, deadline]), (error) => error.code === 'stack_busy');
    await Promise.race([firstEntered, deadline]);
    const owner = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    assert.equal(owner.pid, process.pid);
    assert.notEqual(owner.token, 'abandoned');
    assert.equal(entered, 1);
  } finally { clearTimeout(timeout); release(); results = await Promise.allSettled(runs); }
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.code === 'stack_busy').length, 1);
  await assert.rejects(fs.access(lockPath), { code: 'ENOENT' });
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-stack-startup-'));
  const previousRoot = process.env.DKB_STACK_STATE_ROOT;
  process.env.DKB_STACK_STATE_ROOT = root;
  const name = 'rollback';
  const stackRoot = path.join(root, name);
  const runtimeRoot = path.join(stackRoot, 'runtime');
  const libraryA = path.join(root, 'library-a');
  const libraryB = path.join(root, 'library-b');
  const f = { root, name, stackRoot, runtimeRoot, libraryA, libraryB };
  t.after(async () => {
    await closeQueryContext(runtimeRoot);
    if (previousRoot === undefined) delete process.env.DKB_STACK_STATE_ROOT;
    else process.env.DKB_STACK_STATE_ROOT = previousRoot;
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const recipe = { evidence: '@test/stack', index: '@test/stack', retrieval: '@test/stack' };
  const config = { format: 'dkb.config.v2', activeTarget: 'a', targets: { a: recipe, b: recipe, broken: { ...recipe, evidence: '@test/missing' } } };
  for (const [library, marker] of [[libraryA, 'STACK-FIRST-42'], [libraryB, 'STACK-SECOND-84']]) {
    await json(path.join(library, 'dkb.json'), { type: 'library', name: path.basename(library), roots: {} });
    await json(path.join(library, '.dkb/config.json'), config);
    const packageRoot = path.join(library, 'knowledge');
    await json(path.join(packageRoot, 'dkb.json'), { manifestVersion: 1, type: 'dkb', name: '@test/stack-rollback', version: '1.0.0', permissions: { read: true, write: false } });
    await fs.writeFile(path.join(packageRoot, 'knowledge.md'), `The operational marker is ${marker}.\n`);
    await writeAtomic(path.join(library, '.dkb/plugins/@test/stack/plugin.mjs'), plugin);
    await compileComposeProject(packageRoot, { target: 'a', contextRoot: library });
    await addLibraryRoot(library, '@test/stack-rollback');
  }
  await json(path.join(runtimeRoot, '.dkb/config.json'), config);
  await json(path.join(stackRoot, 'compiler-context/.dkb/config.json'), config);
  f.distribution = { ...DEFAULT_DKB_DISTRIBUTION, services: DEFAULT_DKB_DISTRIBUTION.services.filter((service) => ['registry', 'runtime'].includes(service.id)) };
  await writeEnvironmentFile(path.join(stackRoot, 'stack.env'), {
    DKB_STACK_NAME: name, DKB_STACK_STATE: stackRoot, DKB_COMPILER_DEFAULT_TARGET: 'a', DKB_RUNTIME_PIPELINE_TARGET: 'a',
    DKB_LIBRARY_HOST_PATH: libraryA, DKB_REGISTRY_PORT: '18432', DKB_RUNTIME_PORT: '18433',
  });
  await ensureRuntimeState(runtimeRoot, { runtimeId: 'rollback-runtime', libraryRoot: libraryA, target: 'a' });
  await switchRuntimePipelineFromRegistry({ runtime, stateRoot: runtimeRoot, target: 'a' });
  assert.equal((await query(f, 'STACK-FIRST-42')).results.length, 1);
  f.beforeActivation = await activation(f);
  f.beforeFiles = await files(f);
  const docker = { mount: libraryA, calls: [], failNextUp: false };
  const mocked = t.mock.method(childProcess, 'spawnSync', (command, args) => {
    assert.equal(command, 'docker');
    assert.equal(args[0], 'compose');
    const operation = args.find((arg) => ['ps', 'down', 'up'].includes(arg));
    assert.ok(operation, `Unexpected mocked Docker operation ${args.join(' ')}`);
    docker.calls.push({ command: operation });
    if (operation === 'ps') return { status: 0, stdout: docker.mount ? 'fixture-container\n' : '', stderr: '' };
    if (operation === 'down') docker.mount = null;
    if (operation === 'up') {
      if (docker.failNextUp) { docker.failNextUp = false; return { status: 1, stderr: 'fixture Compose failure', stdout: '' }; }
      const source = readFileSync(path.join(stackRoot, 'stack.env'), 'utf8');
      docker.mount = source.split(/\r?\n/u).find((line) => line.startsWith('DKB_LIBRARY_HOST_PATH=')).slice('DKB_LIBRARY_HOST_PATH='.length);
    }
    return { status: 0, stdout: '', stderr: '' };
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  f.docker = docker;
  return f;
}

async function configure(f, target) {
  const values = await readEnvironmentFile(path.join(f.stackRoot, 'stack.env'));
  await writeEnvironmentFile(path.join(f.stackRoot, 'stack.env'), { ...values, DKB_LIBRARY_HOST_PATH: f.libraryB, DKB_RUNTIME_PIPELINE_TARGET: target });
  const compiler = path.join(f.stackRoot, 'compiler-context/.dkb/config.json');
  await json(compiler, { ...JSON.parse(await fs.readFile(compiler)), activeTarget: 'b' });
  return { ...await readDkbStack(f.distribution, f.name), libraryRoot: f.libraryB, runtimeTarget: target };
}
async function assertPreviousReady(f) {
  assert.deepEqual(await files(f), f.beforeFiles);
  assert.deepEqual(await activation(f), f.beforeActivation);
  assert.equal((await query(f, 'STACK-FIRST-42')).results.length, 1);
  await assert.rejects(fs.access(path.join(f.stackRoot, 'startup-recovery.json')), { code: 'ENOENT' });
}
const files = async (f) => Promise.all(['stack.env', 'compiler-context/.dkb/config.json', 'runtime/.dkb/config.json'].map((file) => fs.readFile(path.join(f.stackRoot, file), 'utf8')));
const activation = (f) => fs.readFile(path.join(f.runtimeRoot, '.dkb/runtime-activation.lock.json'));
const query = (f, query) => searchRuntime({ runtime, stateRoot: f.runtimeRoot, query });
async function json(file, value) { await writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`); }

const plugin = `
import fs from 'node:fs/promises'; import path from 'node:path'; import {createHash} from 'node:crypto';
export const apiVersion=3; export const id='@test/stack'; export const version='1.0.0';
export const optionsSchema={'~standard':{version:1,vendor:'test',validate(value){return {value:value??{}};}}};
export function setup(context){
context.registerProvider({kind:'evidence',async compile({dkb}){const text=await fs.readFile(path.join(dkb.root,'knowledge.md'),'utf8');return {records:[{id:'one',chunkId:'one',text,provenance:{assetId:'knowledge.md',storeId:'filesystem',sourceType:'filesystem',locator:{path:'knowledge.md',chunk:0},assetLocator:{path:'knowledge.md'},title:'Knowledge',sourceHash:'sha256:'+createHash('sha256').update(text).digest('hex'),updatedAt:'2026-09-01T00:00:00.000Z',chunkOrdinal:0,chunkStart:0,chunkEnd:text.length},metadata:{}}],receipt:{build:{}}};}});
context.registerProvider({kind:'index',mode:'packaged',format:'test.stack.v1',capabilities:{vectors:'optional'},async compilePackage({artifactsRoot,compiled}){await fs.mkdir(artifactsRoot,{recursive:true});await fs.writeFile(path.join(artifactsRoot,'records.json'),JSON.stringify(compiled.records));return {build:{records:compiled.records.length}};},async validatePackage(){return {documentCount:1};},async verifyRuntime(){return {documentCount:1,status:'ready'};},async openRuntime(){return null;}});
context.registerProvider({kind:'retrieval',protocol:'dkb.evidence.v1',capabilities:{vectors:'optional'},openRuntime({evidence}){return {providerId:id,protocol:'dkb.evidence.v1',async search({query}){return {hits:evidence.records.filter(record=>record.text.includes(query)).map(record=>({evidenceId:record.evidenceId,score:0.99,channels:['lexical'],matchedTokens:query.toLowerCase().split('-')})),trace:{mode:'fixture'}};},async close(){}};}});
}
`;
