import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { DEFAULT_DKB_DISTRIBUTION as distribution } from '@sjshovan/dkb-distribution-default';
import { applyLibraryLock } from '@sjshovan/dkb-library/state.js';
import { removeLibraryRoot } from '@sjshovan/dkb-library/resolver.js';
import { withDkbFileLock } from '@sjshovan/dkb-library/locks.js';
import { initializeRuntimeBinding, inspectRuntimeSelection } from '@sjshovan/dkb-runtime/runtime/state.js';
import { switchRuntimePipelineFromRegistry } from '@sjshovan/dkb-runtime/runtime/pipelineSwitch.js';
import { DEFAULT_DKB_RUNTIME_CONTEXT as runtime } from '@sjshovan/dkb-runtime/defaultComposition.js';
import { inspectStackOwnerState } from '../apps/cli/dist/stack/ownerInspection.js';
import { configureStackOwner, STACK_CONFIGURATION_JOURNAL, STACK_CONFIGURATION_RECEIPT } from '../apps/cli/dist/stack/ownerConfiguration.js';
import { STACK_OWNER_FORMAT, planStackOwnerRequest, stackOwnerScopeDigest } from '../apps/cli/dist/stack/ownerContract.js';
import { createQueryFixture } from './runtime-query-fixture.mjs';

const scopeDigest = `sha256:${'a'.repeat(64)}`;
const inspect = paths => inspectStackOwnerState(distribution, paths, { format: STACK_OWNER_FORMAT, command: 'inspect', input: {} });
const config = (f, key) => path.join(f.paths[`${key}Root`], '.dkb/config.json');
const read = async file => fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const files = async f => ({ compiler: await read(config(f, 'compiler')), runtime: await read(config(f, 'runtime')) });
const images = expected => Object.fromEntries(distribution.services.filter(service => expected.plan.requiredServices.includes(service.id) && service.image)
  .map(service => [service.id, { reference: service.image, digest: `sha256:${'b'.repeat(64)}` }]));
async function request(f) {
  const expected = await inspect(f.paths);
  return { format: STACK_OWNER_FORMAT, command: 'configure', input: { id: randomUUID(), scopeDigest, expected, images: images(expected) } };
}
const settle = (f, prepared, command = 'configuration.rollback', changes = {}) => configureStackOwner(distribution, f.paths, {
  format: STACK_OWNER_FORMAT, command, input: { id: prepared.input.id, scopeDigest, ...changes },
});
const cancelRequest = prepared => ({ format: STACK_OWNER_FORMAT, command: 'configuration.cancel',
  input: { id: prepared.input.id, scopeDigest, expected: prepared.input.expected } });
async function fixture(t, active = false) {
  const f = active ? await createQueryFixture(t) : { root: await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-stack-config-')) };
  if (!active) t.after(async () => { assert.equal(path.dirname(f.root), path.resolve(os.tmpdir())); await fs.rm(f.root, { recursive: true, force: true }); });
  f.paths = { libraryRoot: f.libraryRoot ?? path.join(f.root, 'library'), runtimeRoot: f.runtimeRoot ?? path.join(f.root, 'runtime'), compilerRoot: path.join(f.root, 'compiler') };
  for (const root of Object.values(f.paths)) await fs.mkdir(path.join(root, '.dkb'), { recursive: true });
  if (!active) {
    await fs.writeFile(path.join(f.paths.libraryRoot, 'dkb.json'), JSON.stringify({ type: 'library', name: 'Configuration proof', roots: {} }));
    await applyLibraryLock(f.paths.libraryRoot, { library: { name: 'Configuration proof' }, generation: 1, entries: {}, resolvedAt: '2026-10-13T00:00:00.000Z' });
  }
  f.journal = path.join(f.paths.runtimeRoot, STACK_CONFIGURATION_JOURNAL);
  return f;
}

test('owner configuration accepts typed image identities and binds recovery to all three volumes, not image version', async t => {
  const f = await fixture(t), prepared = await request(f);
  assert.deepEqual(planStackOwnerRequest(prepared), prepared);
  for (const change of [{ environment: {} }, { paths: {} }, { id: '../bad' }, { scopeDigest: 'bad' }, { images: { tei: { reference: 'image; echo x', digest: scopeDigest } } }]) {
    assert.throws(() => planStackOwnerRequest({ ...prepared, input: { ...prepared.input, ...change } }), { code: 'invalid_stack_owner_request' });
  }
  const owner = { context: 'local', libraryVolume: 'library', runtimeVolume: 'runtime', compilerVolume: 'compiler', image: scopeDigest };
  assert.equal(stackOwnerScopeDigest(owner), stackOwnerScopeDigest({ ...owner, image: `sha256:${'b'.repeat(64)}` }));
  assert.notEqual(stackOwnerScopeDigest(owner), stackOwnerScopeDigest({ ...owner, compilerVolume: 'other' }));
});

test('configuration prepares without activation and rolls back exact original bytes, including missing files', async t => {
  const f = await fixture(t);
  await fs.writeFile(config(f, 'compiler'), '{ "format": "dkb.config.v2" }\n');
  const prepared = await request(f), before = await files(f);
  const selection = await inspectRuntimeSelection(f.paths.runtimeRoot);
  assert.equal((await configureStackOwner(distribution, f.paths, prepared)).status, 'prepared');
  assert.notDeepEqual(await files(f), before);
  assert.deepEqual(await inspectRuntimeSelection(f.paths.runtimeRoot), selection);
  await assert.rejects(settle(f, prepared, 'configuration.commit'), { code: 'stack_owner_activation_pending' });
  await assert.rejects(configureStackOwner(distribution, f.paths, prepared), { code: 'stack_owner_recovery_required' });
  assert.equal((await settle(f, prepared)).status, 'rolled_back');
  assert.deepEqual(await files(f), before);
  await assert.rejects(fs.access(f.journal), { code: 'ENOENT' });
  assert.equal((await settle(f, prepared)).status, 'rolled_back');
  await assert.rejects(settle(f, prepared, 'configuration.commit'), { code: 'stack_owner_activation_pending' });
  await assert.rejects(configureStackOwner(distribution, f.paths, prepared), { code: 'stack_owner_already_settled' });
  const next = await request(f);
  assert.equal((await configureStackOwner(distribution, f.paths, next)).status, 'prepared');
  await assert.rejects(settle(f, prepared), { code: 'stack_owner_recovery_required' });
  assert.equal((await settle(f, next)).status, 'rolled_back');
});

test('cancellation before dispatch verifies unchanged state and durably rejects delayed preparation', async t => {
  const f = await fixture(t), prepared = await request(f), before = await files(f);
  const selection = await inspectRuntimeSelection(f.paths.runtimeRoot);
  const cancellation = cancelRequest(prepared);
  assert.deepEqual(planStackOwnerRequest(cancellation), cancellation);
  await assert.rejects(settle(f, prepared), { code: 'stack_owner_recovery_required' });
  assert.equal((await configureStackOwner(distribution, f.paths, cancellation)).status, 'rolled_back');
  assert.deepEqual(await files(f), before);
  assert.deepEqual(await inspectRuntimeSelection(f.paths.runtimeRoot), selection);
  await assert.rejects(fs.access(f.journal), { code: 'ENOENT' });
  await fs.access(path.join(f.paths.runtimeRoot, STACK_CONFIGURATION_RECEIPT));
  assert.equal((await configureStackOwner(distribution, f.paths, cancellation)).status, 'rolled_back');
  const changed = structuredClone(cancellation); changed.input.expected.library.generation++;
  await assert.rejects(configureStackOwner(distribution, f.paths, changed), { code: 'stack_owner_config_drift' });
  await assert.rejects(configureStackOwner(distribution, f.paths, prepared), { code: 'stack_owner_already_settled' });
});

test('unstarted cancellation rejects recipe, Library and Runtime drift without acknowledging or changing state', async t => {
  for (const kind of ['recipe', 'library', 'runtime']) {
    const f = await fixture(t), prepared = await request(f);
    if (kind === 'recipe') await fs.writeFile(config(f, 'compiler'), JSON.stringify({ format: 'dkb.config.v2', activeTarget: 'fastembed-faiss' }));
    if (kind === 'library') await applyLibraryLock(f.paths.libraryRoot, { library: { name: 'Configuration proof' }, generation: 2, entries: {}, resolvedAt: '2026-10-13T00:01:00.000Z' });
    if (kind === 'runtime') await initializeRuntimeBinding(f.paths.runtimeRoot, { runtimeId: 'other', libraryRoot: f.paths.libraryRoot, target: 'fastembed-faiss' });
    const before = await files(f), selection = await inspectRuntimeSelection(f.paths.runtimeRoot);
    await assert.rejects(configureStackOwner(distribution, f.paths, cancelRequest(prepared)), { code: 'stack_owner_config_drift' });
    assert.deepEqual(await files(f), before);
    assert.deepEqual(await inspectRuntimeSelection(f.paths.runtimeRoot), selection);
    await assert.rejects(fs.access(path.join(f.paths.runtimeRoot, STACK_CONFIGURATION_RECEIPT)), { code: 'ENOENT' });
  }
});

test('cancellation settles its own preparation but rejects another operation or changed expectation', async t => {
  const f = await fixture(t), prepared = await request(f), before = await files(f);
  await configureStackOwner(distribution, f.paths, prepared);
  const staged = await files(f), cancellation = cancelRequest(prepared);
  const other = structuredClone(cancellation); other.input.id = randomUUID();
  await assert.rejects(configureStackOwner(distribution, f.paths, other), { code: 'stack_owner_scope_mismatch' });
  const changed = structuredClone(cancellation); changed.input.expected.library.generation++;
  await assert.rejects(configureStackOwner(distribution, f.paths, changed), { code: 'stack_owner_config_drift' });
  assert.deepEqual(await files(f), staged);
  assert.equal((await configureStackOwner(distribution, f.paths, cancellation)).status, 'rolled_back');
  assert.deepEqual(await files(f), before);
});

test('cancellation retains an activation committed before the host received its acknowledgement', async t => {
  const f = await fixture(t, true), prepared = await request(f);
  await configureStackOwner(distribution, f.paths, prepared);
  await switchRuntimePipelineFromRegistry({ stateRoot: f.paths.runtimeRoot, runtime, target: 'fixture' });
  const activated = await inspectRuntimeSelection(f.paths.runtimeRoot), staged = await files(f);
  assert.equal((await configureStackOwner(distribution, f.paths, cancelRequest(prepared))).status, 'committed');
  assert.deepEqual(await inspectRuntimeSelection(f.paths.runtimeRoot), activated);
  assert.deepEqual(await files(f), staged);
});

test('stale plans and unselected image identities fail before journaling or mutation', async t => {
  const f = await fixture(t), prepared = await request(f);
  const changed = { ...distribution, defaults: structuredClone(distribution.defaults) };
  changed.defaults.targets.default.options['@dkb/embedding-tei'].dimensions = 769;
  await assert.rejects(configureStackOwner(changed, f.paths, prepared), { code: 'stack_owner_config_drift' });
  await assert.rejects(fs.access(f.journal), { code: 'ENOENT' });
  await fs.writeFile(config(f, 'runtime'), JSON.stringify({ format: 'dkb.config.v2', activeTarget: 'fastembed-faiss' }));
  const before = await files(f);
  await assert.rejects(configureStackOwner(distribution, f.paths, prepared), { code: 'stack_owner_config_drift' });
  const current = await request(f); current.input.images.unselected = { reference: 'unused:1', digest: scopeDigest };
  await assert.rejects(configureStackOwner(distribution, f.paths, current), { code: 'invalid_stack_owner_request' });
  assert.deepEqual(await files(f), before);
  await assert.rejects(fs.access(f.journal), { code: 'ENOENT' });
});

test('partial configuration promotion recovers both files through the journal', async t => {
  const f = await fixture(t), prepared = await request(f), before = await files(f);
  const rename = fs.rename;
  const mocked = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === config(f, 'runtime')) throw Object.assign(new Error('Synthetic promotion failure'), { code: 'EIO' });
    return rename(from, to);
  });
  await assert.rejects(configureStackOwner(distribution, f.paths, prepared), { code: 'EIO' });
  mocked.mock.restore();
  assert.notEqual((await files(f)).compiler, before.compiler);
  assert.equal((await files(f)).runtime, before.runtime);
  assert.equal((await settle(f, prepared)).status, 'rolled_back');
  assert.deepEqual(await files(f), before);
});

test('wrong storage, corrupt journals and operator edits are retained without partial rollback', async t => {
  const f = await fixture(t), prepared = await request(f);
  await configureStackOwner(distribution, f.paths, prepared);
  const staged = await files(f), journal = await fs.readFile(f.journal, 'utf8');
  await assert.rejects(settle(f, prepared, 'configuration.rollback', { scopeDigest: `sha256:${'c'.repeat(64)}` }), { code: 'stack_owner_scope_mismatch' });
  await fs.writeFile(f.journal, '{broken');
  await assert.rejects(settle(f, prepared), { code: 'stack_owner_recovery_required' });
  assert.deepEqual(await files(f), staged);
  await fs.writeFile(f.journal, journal);
  await fs.writeFile(config(f, 'runtime'), '{operator edit');
  await assert.rejects(settle(f, prepared), { code: 'stack_owner_config_drift' });
  assert.equal(await fs.readFile(config(f, 'runtime'), 'utf8'), '{operator edit');
  assert.equal((await files(f)).compiler, staged.compiler);
  assert.equal(await fs.readFile(f.journal, 'utf8'), journal);
});

test('an unrelated Runtime selection prevents configuration rollback', async t => {
  const f = await fixture(t), prepared = await request(f);
  await configureStackOwner(distribution, f.paths, prepared);
  await initializeRuntimeBinding(f.paths.runtimeRoot, { runtimeId: 'other', libraryRoot: f.paths.libraryRoot, target: 'fastembed-faiss' });
  const state = await inspectRuntimeSelection(f.paths.runtimeRoot), staged = await files(f);
  await assert.rejects(settle(f, prepared), { code: 'stack_owner_selection_drift' });
  assert.deepEqual(await inspectRuntimeSelection(f.paths.runtimeRoot), state);
  assert.deepEqual(await files(f), staged);
});

for (const command of ['configuration.commit', 'configuration.rollback']) test(`a real successful activation is retained on ${command}, including a lost host response`, async t => {
  const f = await fixture(t, true), prepared = await request(f);
  await configureStackOwner(distribution, f.paths, prepared);
  const staged = await files(f);
  await switchRuntimePipelineFromRegistry({ stateRoot: f.paths.runtimeRoot, runtime, target: 'fixture' });
  const activated = await inspectRuntimeSelection(f.paths.runtimeRoot);
  assert.equal((await settle(f, prepared, command)).status, 'committed');
  assert.deepEqual(await files(f), staged);
  assert.deepEqual(await inspectRuntimeSelection(f.paths.runtimeRoot), activated);
  await assert.rejects(fs.access(f.journal), { code: 'ENOENT' });
  assert.equal((await settle(f, prepared, command)).status, 'committed');
  await removeLibraryRoot(f.paths.libraryRoot, f.packageId);
  await assert.rejects(settle(f, prepared, command), { code: 'stack_owner_selection_drift' });
});

test('completion retries reject a changed scope, operator edits and corrupt receipts without mutating anything', async t => {
  const f = await fixture(t), prepared = await request(f);
  await configureStackOwner(distribution, f.paths, prepared);
  await settle(f, prepared);
  await assert.rejects(settle(f, prepared, 'configuration.rollback', { scopeDigest: `sha256:${'c'.repeat(64)}` }), { code: 'stack_owner_scope_mismatch' });
  await fs.writeFile(config(f, 'runtime'), '{operator edit');
  await assert.rejects(settle(f, prepared), { code: 'stack_owner_selection_drift' });
  assert.equal(await read(config(f, 'runtime')), '{operator edit');
  const receipt = path.join(f.paths.runtimeRoot, STACK_CONFIGURATION_RECEIPT);
  await fs.writeFile(receipt, '{broken');
  await assert.rejects(settle(f, prepared), { code: 'stack_owner_recovery_required' });
  await assert.rejects(configureStackOwner(distribution, f.paths, prepared), { code: 'stack_owner_recovery_required' });
  assert.equal(await read(receipt), '{broken');
});

test('activation against a changed Library cannot acknowledge an earlier preparation', async t => {
  const f = await fixture(t, true), prepared = await request(f);
  await configureStackOwner(distribution, f.paths, prepared);
  await removeLibraryRoot(f.paths.libraryRoot, f.packageId);
  await switchRuntimePipelineFromRegistry({ stateRoot: f.paths.runtimeRoot, runtime, target: 'fixture' });
  const activated = await inspectRuntimeSelection(f.paths.runtimeRoot);
  await assert.rejects(settle(f, prepared, 'configuration.commit'), { code: 'stack_owner_selection_drift' });
  assert.deepEqual(await inspectRuntimeSelection(f.paths.runtimeRoot), activated);
  await fs.access(f.journal);
});

test('compiler-context ownership queues configuration across independent Runtime roots', async t => {
  const f = await fixture(t), prepared = await request(f);
  const held = Promise.withResolvers(), release = Promise.withResolvers();
  const writer = withDkbFileLock(f.paths.compilerRoot, 'stack-control', async () => { held.resolve(); await release.promise; });
  await held.promise;
  let completed = false;
  const configuration = configureStackOwner(distribution, f.paths, prepared).then(value => { completed = true; return value; });
  try { await new Promise(resolve => setImmediate(resolve)); assert.equal(completed, false); }
  finally { release.resolve(); await writer; }
  assert.equal((await configuration).status, 'prepared');
  assert.equal((await settle(f, prepared)).status, 'rolled_back');
});

for (const phase of ['staged', 'promoted', 'completion-staged', 'completion-promoted', 'acknowledged', 'unstarted-completion-staged', 'unstarted-completion-promoted']) test(`real owner process death at ${phase} preserves recoverable or acknowledged state`, async t => {
  const f = await fixture(t), prepared = await request(f), before = await files(f);
  const unstarted = phase.startsWith('unstarted-');
  const completing = phase.includes('completion-') || phase === 'acknowledged';
  if (completing && !unstarted) await configureStackOwner(distribution, f.paths, prepared);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs/promises'; import path from 'node:path';
    import {DEFAULT_DKB_DISTRIBUTION as distribution} from '@sjshovan/dkb-distribution-default';
    import {configureStackOwner} from ${JSON.stringify(new URL('../apps/cli/dist/stack/ownerConfiguration.js', import.meta.url).href)};
    const input=JSON.parse(await new Promise(resolve=>{let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>resolve(s));}));
    const phase=${JSON.stringify(phase)}, rename=fs.rename, unlink=fs.unlink;
    const pause=async()=>{console.log('ready');setInterval(()=>{},1000);await new Promise(()=>{});};
    const target=${JSON.stringify(completing)}?path.join(input.paths.runtimeRoot,${JSON.stringify(STACK_CONFIGURATION_RECEIPT)}):path.join(input.paths.compilerRoot,'.dkb/config.json');
    fs.rename=async(from,to)=>{if(to!==target || phase==='acknowledged') return rename(from,to);if(phase.endsWith('promoted')) await rename(from,to);await pause();};
    fs.unlink=async(file)=>{await unlink(file);if(phase==='acknowledged' && file===path.join(input.paths.runtimeRoot,${JSON.stringify(STACK_CONFIGURATION_JOURNAL)})) await pause();};
    await configureStackOwner(distribution,input.paths,input.request);
  `], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const closed = once(child, 'close');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
  let text = '', errors = '', timer;
  child.stderr.on('data', data => { errors += data; });
  const ready = new Promise(resolve => child.stdout.on('data', data => { text += data; if (text.includes('ready')) resolve(); }));
  child.stdin.end(JSON.stringify({ paths: f.paths, request: unstarted ? cancelRequest(prepared) : completing
    ? { format: STACK_OWNER_FORMAT, command: 'configuration.rollback', input: { id: prepared.input.id, scopeDigest } } : prepared }));
  try { await Promise.race([ready, closed.then(() => { throw new Error(errors); }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owner promotion did not start')), 15_000); })]); }
  finally { clearTimeout(timer); }
  child.kill('SIGKILL'); await closed;
  if (phase === 'promoted') assert.notEqual((await files(f)).compiler, before.compiler);
  else assert.deepEqual(await files(f), before);
  const recover = () => unstarted ? configureStackOwner(distribution, f.paths, cancelRequest(prepared)) : settle(f, prepared);
  assert.equal((await recover()).status, 'rolled_back');
  assert.deepEqual(await files(f), before);
  for (const key of ['compiler', 'runtime']) await assert.rejects(fs.access(`${config(f, key)}.stack-${prepared.input.id}.tmp`), { code: 'ENOENT' });
  await assert.rejects(fs.access(`${path.join(f.paths.runtimeRoot, STACK_CONFIGURATION_RECEIPT)}.stack-${prepared.input.id}.tmp`), { code: 'ENOENT' });
  assert.equal((await recover()).status, 'rolled_back');
});
