import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_DKB_DISTRIBUTION as distribution } from '@sjshovan/dkb-distribution-default';
import { applyLibraryLock } from '@sjshovan/dkb-library/state.js';
import { removeLibraryRoot } from '@sjshovan/dkb-library/resolver.js';
import { withLibraryMutation, writeLibraryMutationFile } from '@sjshovan/dkb-library/mutation.js';
import { initializeRuntimeBinding, inspectRuntimeSelection } from '@sjshovan/dkb-runtime/runtime/state.js';
import { withRuntimeMutation } from '@sjshovan/dkb-runtime/runtime/mutation.js';
import { inspectStackOwnerState } from '../apps/cli/dist/stack/ownerInspection.js';
import { planStackOwnerRequest, validateDockerStackOwner, validateStackOwnerInspection, STACK_OWNER_FORMAT } from '../apps/cli/dist/stack/ownerContract.js';
import { assertRegistryStorageUnambiguous } from '../apps/cli/dist/stack/docker.js';
import { createQueryFixture } from './runtime-query-fixture.mjs';

const request = input => ({ format: STACK_OWNER_FORMAT, command: 'inspect', input: input ?? {} });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-stack-owner-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const paths = { libraryRoot: path.join(root, 'library'), runtimeRoot: path.join(root, 'runtime'), compilerRoot: path.join(root, 'compiler') };
  for (const dir of Object.values(paths)) await fs.mkdir(path.join(dir, '.dkb'), { recursive: true });
  await fs.writeFile(path.join(paths.libraryRoot, 'dkb.json'), JSON.stringify({ type: 'library', name: 'Owner proof', roots: {} }));
  await applyLibraryLock(paths.libraryRoot, { library: { name: 'Owner proof' }, generation: 1, entries: {}, resolvedAt: '2026-10-13T00:00:00.000Z' });
  return { root, paths, inspect: input => inspectStackOwnerState(distribution, paths, request(input)) };
}

test('Stack owner accepts only separated named volumes and a fixed inspection request', () => {
  const owner = { context: 'desktop-linux', image: `sha256:${'a'.repeat(64)}`, libraryVolume: 'proof-library', runtimeVolume: 'proof-runtime', compilerVolume: 'proof-compiler' };
  assert.deepEqual(validateDockerStackOwner(owner), owner);
  const input = request({ compilerTarget: 'default', runtimeTarget: 'fastembed-faiss', allowedTargets: ['default'] });
  assert.deepEqual(planStackOwnerRequest(input), input);
  assert.notEqual(planStackOwnerRequest(input).input.allowedTargets, input.input.allowedTargets);
  for (const change of [{ image: 'latest' }, { runtimeVolume: owner.libraryVolume }, { compilerVolume: '../host' }, { mount: '/host' }, { token: 'not-accepted' }]) {
    assert.throws(() => validateDockerStackOwner({ ...owner, ...change }), { code: 'invalid_stack_owner_request' });
  }
  for (const value of [null, {}, { ...request(), command: 'activate' }, request({ paths: { library: '/elsewhere' } }),
    request({ runtimeTarget: '--help' }), request({ environment: {} }), request({ allowedTargets: ['default', 'default'] }),
    request({ allowedTargets: Array(129).fill('default') }), { ...request(), output: 'raw' }]) {
    assert.throws(() => planStackOwnerRequest(value), { code: 'invalid_stack_owner_request' });
  }
});

test('Stack inspection observes unbound and bound owner state without activating or leaking options', async t => {
  const f = await fixture(t);
  assert.equal((await f.inspect()).runtime.state, 'unbound');
  await initializeRuntimeBinding(f.paths.runtimeRoot, { runtimeId: 'proof-runtime', libraryRoot: f.paths.libraryRoot, target: 'default' });
  const original = await inspectRuntimeSelection(f.paths.runtimeRoot);
  const config = { format: 'dkb.config.v2', activeTarget: 'default', targets: {
    default: { options: { '@dkb/embedding-tei': { privateTestValue: 'synthetic-do-not-echo' } } },
  } };
  await fs.writeFile(path.join(f.paths.runtimeRoot, '.dkb/config.json'), JSON.stringify(config));
  const result = await f.inspect({ runtimeTarget: 'fastembed-faiss' });
  assert.equal(result.runtime.id, 'proof-runtime');
  assert.equal(result.runtime.state, 'inactive');
  assert.equal(result.runtime.target, 'default');
  assert.equal(result.plan.runtimeTarget, 'fastembed-faiss');
  assert.equal(result.library.generation, 1);
  assert.match(result.runtime.selectionDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(result.configDigests.runtime, /^sha256:[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-do-not-echo|privateTestValue/u);
  assert.deepEqual(await inspectRuntimeSelection(f.paths.runtimeRoot), original);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.paths.runtimeRoot, '.dkb/config.json'))), config);
  assert.deepEqual(validateStackOwnerInspection(result), result);
  for (const change of [{ library: { ...result.library, generation: -1 } }, { runtime: { ...result.runtime, state: 'current' } },
    { configDigests: {} }, { plan: { ...result.plan, compilerTargets: [] } }, { credentials: 'rejected' }]) {
    assert.throws(() => validateStackOwnerInspection({ ...result, ...change }), { code: 'invalid_stack_owner_request' });
  }
});

test('Stack observation reports real current and stale activations without refreshing or changing their exact selection', async t => {
  const f = await createQueryFixture(t);
  const paths = { libraryRoot: f.libraryRoot, runtimeRoot: f.runtimeRoot, compilerRoot: path.join(f.root, 'compiler') };
  await fs.mkdir(paths.compilerRoot);
  const before = await inspectRuntimeSelection(f.runtimeRoot);
  const current = await inspectStackOwnerState(distribution, paths, request());
  assert.equal(current.runtime.state, 'current');
  assert.equal(current.runtime.target, 'fixture');
  assert.ok(current.runtime.activationDigest);
  await removeLibraryRoot(f.libraryRoot, f.packageId);
  const stale = await inspectStackOwnerState(distribution, paths, request());
  assert.equal(stale.runtime.state, 'stale');
  assert.equal(stale.runtime.selectionDigest, current.runtime.selectionDigest);
  assert.deepEqual(await inspectRuntimeSelection(f.runtimeRoot), before);
  assert.deepEqual(validateStackOwnerInspection(stale), stale);
});

test('broken higher-precedence recipe fails without falling back or changing binding', async t => {
  const f = await fixture(t);
  await initializeRuntimeBinding(f.paths.runtimeRoot, { runtimeId: 'proof-runtime', libraryRoot: f.paths.libraryRoot, target: 'default' });
  const before = await inspectRuntimeSelection(f.paths.runtimeRoot);
  const file = path.join(f.paths.runtimeRoot, '.dkb/config.json');
  await fs.writeFile(file, '{broken operator config');
  await assert.rejects(f.inspect(), /config|JSON|position|property/iu);
  assert.equal(await fs.readFile(file, 'utf8'), '{broken operator config');
  assert.deepEqual(await inspectRuntimeSelection(f.paths.runtimeRoot), before);
});

test('Stack owner returns the selected public service settings, not arbitrary plugin options', async t => {
  const f = await fixture(t);
  const result = await f.inspect({ compilerTarget: 'tei-faiss-768', runtimeTarget: 'tei-faiss-768' });
  assert.equal(result.plan.serviceEnvironment.DKB_TEI_MODEL, 'BAAI/bge-base-en-v1.5');
  assert.match(result.plan.serviceEnvironment.DKB_TEI_MODEL_REVISION, /^[a-f0-9]{40}$/u);
  assert.match(result.plan.recipeDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(validateStackOwnerInspection(result, distribution), result);
  for (const changes of [
    { NODE_OPTIONS: '--import=untrusted.mjs' },
    { DKB_MEILI_MASTER_KEY: 'never-export-a-secret' },
    { DKB_FASTEMBED_MODEL: 'unselected-provider' },
    { DKB_TEI_MODEL: 'model\nINJECTED=value' },
    { DKB_TEI_MODEL: 'model${UNRELATED_SECRET}' },
  ]) {
    const altered = structuredClone(result);
    Object.assign(altered.plan.serviceEnvironment, changes);
    assert.throws(() => validateStackOwnerInspection(altered, distribution));
  }
  await assert.rejects(f.inspect({ compilerTarget: 'tei-faiss', runtimeTarget: 'tei-faiss-768' }), /different.*model/u);
});

test('owner planning detects changed distribution recipes even when files, labels and service names match', async t => {
  const f = await fixture(t);
  const first = await f.inspect();
  const changed = { ...distribution, defaults: structuredClone(distribution.defaults) };
  changed.defaults.targets.default.options['@dkb/embedding-tei'].dimensions = 769;
  const second = await inspectStackOwnerState(changed, f.paths, request());
  assert.deepEqual(first.configDigests, second.configDigests);
  assert.deepEqual(first.plan.requiredServices, second.plan.requiredServices);
  assert.notEqual(first.plan.recipeDigest, second.plan.recipeDigest);
});

test('Stack owner refuses a Library remount that disagrees with the existing Runtime binding', async t => {
  const f = await fixture(t);
  await initializeRuntimeBinding(f.paths.runtimeRoot, { runtimeId: 'proof-runtime', libraryRoot: f.paths.libraryRoot, runtimeLibraryRoot: '/other-library', target: 'default' });
  const before = await inspectRuntimeSelection(f.paths.runtimeRoot);
  await assert.rejects(f.inspect(), { code: 'stack_owner_library_mismatch' });
  assert.deepEqual(await inspectRuntimeSelection(f.paths.runtimeRoot), before);
});

test('Runtime inspection never repairs pending activation journals or displaced journal backups', async t => {
  const f = await fixture(t);
  for (const name of ['runtime-selection.transaction.json', 'runtime-selection.transaction.json.replace-proof']) {
    const file = path.join(f.paths.runtimeRoot, '.dkb', name);
    await fs.writeFile(file, 'preserve interrupted transaction');
    await assert.rejects(f.inspect(), { code: 'runtime_activation_recovery_required' });
    assert.equal(await fs.readFile(file, 'utf8'), 'preserve interrupted transaction');
    await fs.rm(file);
  }
});

test('Stack observation waits for Runtime ownership and rejects a Library write from another context', async t => {
  const f = await fixture(t);
  const held = Promise.withResolvers(), release = Promise.withResolvers();
  const writer = withRuntimeMutation(f.paths.runtimeRoot, async () => { held.resolve(); await release.promise; });
  await held.promise;
  let finished = false;
  const inspection = f.inspect().then(result => { finished = true; return result; });
  try { await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false); }
  finally { release.resolve(); await writer; }
  assert.equal((await inspection).runtime.state, 'unbound');
  const libraryHeld = Promise.withResolvers(), libraryRelease = Promise.withResolvers();
  const mutation = withLibraryMutation(f.paths.libraryRoot, async () => {
    await writeLibraryMutationFile(f.paths.libraryRoot, path.join(f.paths.libraryRoot, 'marker.txt'), 'pending');
    libraryHeld.resolve(); await libraryRelease.promise;
  });
  await libraryHeld.promise;
  try { await assert.rejects(f.inspect(), { code: 'library_recovery_required' }); }
  finally { libraryRelease.resolve(); await mutation; }
});

test('Stack never silently copies a legacy Registry volume and does not treat Docker failure as absence', async t => {
  const f = await fixture(t), calls = [];
  let status = 0;
  t.mock.method(childProcess, 'spawnSync', (command, args) => {
    calls.push([command, ...args]); return { status, stdout: 'dkb-proof_dkb-registry-data\nunrelated\n', stderr: '' };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const context = { name: 'proof', projectName: 'dkb-proof', root: f.root };
  await assert.rejects(assertRegistryStorageUnambiguous(context), { code: 'stack_migration_required' });
  status = 1;
  await assert.rejects(assertRegistryStorageUnambiguous(context), { code: 'stack_storage_check_failed' });
  assert.deepEqual(calls, Array(2).fill(['docker', 'volume', 'ls', '--format', '{{.Name}}']));
  await assert.rejects(fs.access(path.join(f.root, 'registry')), { code: 'ENOENT' });
});
