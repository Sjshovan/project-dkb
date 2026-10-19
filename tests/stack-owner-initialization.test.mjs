import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DEFAULT_DKB_DISTRIBUTION as distribution } from '@sjshovan/dkb-distribution-default';
import { applyLibraryLock } from '@sjshovan/dkb-library/state.js';
import { initializeRuntimeBinding, inspectRuntimeSelection } from '@sjshovan/dkb-runtime/runtime/state.js';
import { withRuntimeMutation } from '@sjshovan/dkb-runtime/runtime/mutation.js';
import { planStackOwnerRequest, STACK_OWNER_FORMAT } from '../apps/cli/dist/stack/ownerContract.js';
import { initializeStackOwner } from '../apps/cli/dist/stack/ownerInitialization.js';
import { createRoot, createQueryFixture, writeJson } from './runtime-query-fixture.mjs';

const request = input => ({ format: STACK_OWNER_FORMAT, command: 'binding.initialize',
  input: { scopeDigest: `sha256:${'a'.repeat(64)}`, runtimeId: 'owner-runtime', ...input } });
async function fixture(t) {
  const f = await createRoot(t);
  f.paths = { libraryRoot: f.libraryRoot, runtimeRoot: f.runtimeRoot, compilerRoot: path.join(f.root, 'compiler') };
  for (const dir of Object.values(f.paths)) await fs.mkdir(path.join(dir, '.dkb'), { recursive: true });
  await writeJson(path.join(f.libraryRoot, 'dkb.json'), { type: 'library', name: 'Shared Library', roots: {} });
  await applyLibraryLock(f.libraryRoot, { library: { name: 'Shared Library' }, generation: 1,
    entries: {}, resolvedAt: '2026-10-13T00:00:00.000Z' });
  await writeJson(path.join(f.libraryRoot, '.dkb/config.json'), { format: 'dkb.config.v2', activeTarget: 'default' });
  f.initialize = input => initializeStackOwner(distribution, f.paths, request(input));
  return f;
}

test('first-binding requests reject paths, code, credentials, noncanonical identity and arbitrary operations', () => {
  assert.deepEqual(planStackOwnerRequest(request()), request());
  for (const input of [{ runtimeId: 'Owner' }, { runtimeId: 'owner-' }, { runtimeId: '-owner' }, { runtimeId: '' },
    { runtimeId: 'a'.repeat(129) }, { libraryRoot: '/other' }, { target: 'default' }, { environment: {} },
    { token: 'do-not-accept' }, { scopeDigest: 'unbound' }, { allowedTargets: ['default', 'default'] }, { runtimeTarget: '--help' }]) {
    assert.throws(() => planStackOwnerRequest(request(input)), { code: 'invalid_stack_owner_request' });
  }
});

test('owner creates only the first binding and retry returns it without touching Library/configuration/activation', async t => {
  const f = await fixture(t);
  const saved = await Promise.all(['dkb.json', 'dkb-lock.json', '.dkb/config.json'].map(name => fs.readFile(path.join(f.libraryRoot, name))));
  const first = await f.initialize({ runtimeTarget: 'fastembed-faiss' });
  assert.equal(first.runtime.id, 'owner-runtime'); assert.equal(first.runtime.state, 'inactive');
  assert.equal(first.runtime.target, 'fastembed-faiss'); assert.equal(first.runtime.activationDigest, null);
  assert.deepEqual(await f.initialize({ runtimeTarget: 'fastembed-faiss' }), first);
  const before = await inspectRuntimeSelection(f.runtimeRoot);
  const other = await f.initialize({ runtimeTarget: 'default' });
  assert.equal(other.plan.runtimeTarget, 'default'); assert.equal(other.runtime.target, 'fastembed-faiss');
  assert.deepEqual(await inspectRuntimeSelection(f.runtimeRoot), before);
  assert.deepEqual(await Promise.all(['dkb.json', 'dkb-lock.json', '.dkb/config.json'].map(name => fs.readFile(path.join(f.libraryRoot, name)))), saved);
  for (const root of [f.runtimeRoot, f.paths.compilerRoot]) await assert.rejects(fs.access(path.join(root, '.dkb/config.json')), { code: 'ENOENT' });
});

test('existing active Runtime remains byte-identical even when another initial target is requested', async t => {
  const f = await createQueryFixture(t);
  const paths = { libraryRoot: f.libraryRoot, runtimeRoot: f.runtimeRoot, compilerRoot: path.join(f.root, 'compiler') };
  await fs.mkdir(paths.compilerRoot);
  const before = await inspectRuntimeSelection(f.runtimeRoot);
  const result = await initializeStackOwner(distribution, paths, request({ runtimeId: 'recovery', runtimeTarget: 'fastembed-faiss' }));
  assert.equal(result.runtime.state, 'current'); assert.equal(result.runtime.target, 'fixture');
  assert.deepEqual(await inspectRuntimeSelection(f.runtimeRoot), before);
});

test('first-binding operation refuses a foreign Runtime identity or remounted Library', async t => {
  const f = await fixture(t);
  await f.initialize(); const before = await inspectRuntimeSelection(f.runtimeRoot);
  await assert.rejects(f.initialize({ runtimeId: 'someone-else' }), { code: 'stack_owner_runtime_mismatch' });
  assert.deepEqual(await inspectRuntimeSelection(f.runtimeRoot), before);
  const otherRoot = path.join(f.root, 'other-runtime');
  await initializeRuntimeBinding(otherRoot, { runtimeId: 'owner-runtime', libraryRoot: f.libraryRoot, runtimeLibraryRoot: '/other', target: 'default' });
  const otherBefore = await inspectRuntimeSelection(otherRoot);
  await assert.rejects(initializeStackOwner(distribution, { ...f.paths, runtimeRoot: otherRoot }, request()), { code: 'stack_owner_library_mismatch' });
  assert.deepEqual(await inspectRuntimeSelection(otherRoot), otherBefore);
});

test('initialization preserves pending configuration and activation recovery records without repairing them', async t => {
  const f = await fixture(t);
  for (const [name, code] of [['stack-configuration.json', 'stack_owner_recovery_required'],
    ['runtime-selection.transaction.json', 'runtime_activation_recovery_required'],
    ['runtime-selection.transaction.json.replace-proof', 'runtime_activation_recovery_required']]) {
    const file = path.join(f.runtimeRoot, '.dkb', name);
    await fs.writeFile(file, 'preserve interrupted operation');
    await assert.rejects(f.initialize(), { code });
    assert.equal(await fs.readFile(file, 'utf8'), 'preserve interrupted operation');
    await fs.rm(file);
    assert.deepEqual(await inspectRuntimeSelection(f.runtimeRoot), { binding: null, activation: null });
  }
});

test('broken or unavailable selected recipe prevents first binding without silently choosing the default', async t => {
  const f = await fixture(t);
  await assert.rejects(f.initialize({ runtimeTarget: 'missing-target' }));
  await fs.writeFile(path.join(f.runtimeRoot, '.dkb/config.json'), '{broken');
  await assert.rejects(f.initialize());
  assert.equal(await fs.readFile(path.join(f.runtimeRoot, '.dkb/config.json'), 'utf8'), '{broken');
  assert.deepEqual(await inspectRuntimeSelection(f.runtimeRoot), { binding: null, activation: null });
});

test('concurrent initializers serialize and cannot claim one Runtime volume for different identities', async t => {
  const f = await fixture(t);
  const outcomes = await Promise.allSettled([f.initialize({ runtimeId: 'first' }), f.initialize({ runtimeId: 'second' })]);
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(value => value.status === 'rejected').reason.code, 'stack_owner_runtime_mismatch');
  const after = await inspectRuntimeSelection(f.runtimeRoot);
  assert.equal(after.activation, null);
  assert.equal(after.binding.runtimeId, outcomes.find(value => value.status === 'fulfilled').value.runtime.id);
});

test('initialization waits for Runtime ownership instead of recovering or replacing a live writer', async t => {
  const f = await fixture(t), held = Promise.withResolvers(), release = Promise.withResolvers();
  const writer = withRuntimeMutation(f.runtimeRoot, async () => { held.resolve(); await release.promise; });
  await held.promise; let finished = false;
  const initialization = f.initialize().then(value => { finished = true; return value; });
  try { await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false); }
  finally { release.resolve(); await writer; }
  assert.equal((await initialization).runtime.state, 'inactive');
});

test('a real initializer death after binding promotion is retry-safe and does not manufacture activation', async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs/promises';
    import {DKB_RUNTIME_BINDING_PATH} from '@sjshovan/dkb-protocol/paths.js';
    import {DEFAULT_DKB_DISTRIBUTION as distribution} from '@sjshovan/dkb-distribution-default';
    import {initializeStackOwner} from ${JSON.stringify(new URL('../apps/cli/dist/stack/ownerInitialization.js', import.meta.url).href)};
    const rename=fs.rename;
    fs.rename=async(from,to)=>{await rename(from,to);if(String(to).replaceAll('\\\\','/').endsWith(DKB_RUNTIME_BINDING_PATH)){
      console.log('binding-promoted');setInterval(()=>{},1000);await new Promise(()=>{});
    }};
    await initializeStackOwner(distribution,${JSON.stringify(f.paths)},${JSON.stringify(request())});
  `], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const closed = once(child, 'close'); let output = '', errors = '', timer;
  const ready = new Promise(resolve => child.stdout.on('data', bytes => { output += bytes; if (output.includes('binding-promoted')) resolve(); }));
  child.stderr.on('data', bytes => { errors += bytes; });
  try {
    await Promise.race([ready, closed.then(() => { throw new Error(errors || 'Initializer ended before promotion'); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Initializer did not promote its binding')), 15_000); })]);
  } finally {
    clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed;
  }
  const before = await inspectRuntimeSelection(f.runtimeRoot);
  assert.equal(before.binding.runtimeId, 'owner-runtime'); assert.equal(before.activation, null);
  const result = await f.initialize({ runtimeTarget: 'fastembed-faiss' });
  assert.equal(result.runtime.target, 'default'); assert.equal(result.runtime.state, 'inactive');
  assert.deepEqual(await inspectRuntimeSelection(f.runtimeRoot), before);
});
