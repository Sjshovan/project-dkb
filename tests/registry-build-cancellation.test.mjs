import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DKB_CONFIG_FORMAT } from '@sjshovan/dkb-pipeline/config.js';
import { createDkbPackageArchive } from '@sjshovan/dkb-library/archive.js';
import { serveDkbRegistryCompiler } from '@sjshovan/dkb-compiler/server.js';
import { RegistryJobControl } from '../services/compiler/dist/registryJobControl.js';
import { compileRegistryPackage } from '../services/compiler/dist/registryCompilation.js';
import { readCompilerBuildIdentity } from '../services/compiler/dist/compilerCapabilities.js';
import { materializeBundledProviderFixtures } from './bundled-provider-fixture.mjs';

async function root(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-compiler-cancel-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function control(overrides = {}) {
  return { registryId: 'test-registry', jobId: '17', execution: { id: randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString() }, ...overrides };
}

test('Registry compilation rejects missing or changed installed compiler identity before reading source', async (t) => {
  const directory = await root(t);
  for (const expectedCompilerBuildDigest of [undefined, `sha256:${'9'.repeat(64)}`]) {
    await assert.rejects(compileRegistryPackage({ jobId: 'drift', request: { expectedCompilerBuildDigest }, sourceArchive: { contents: '' } }, { contextRoot: directory, distribution: {} }), { code: 'compiler_build_drift' });
  }
  assert.deepEqual(await fs.readdir(directory), []);
});

test('compiler cancellation aborts active work, waits for cleanup, and persists across server instances', async (t) => {
  const directory = await root(t);
  const jobs = new RegistryJobControl(directory);
  const input = control();
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let cleaned = false;
  const running = jobs.run(input, async (signal) => {
    started();
    try { await delay(60_000, undefined, { signal }); }
    finally { await delay(5); cleaned = true; }
  });
  const rejected = assert.rejects(running, /abort|cancel/iu);
  await ready;
  assert.equal((await jobs.cancel(input)).status, 'cancelling');
  assert.equal(cleaned, false);
  await rejected;
  assert.equal(cleaned, true);
  assert.equal((await jobs.cancel(input)).status, 'cancelled');
  const restarted = new RegistryJobControl(directory);
  await assert.rejects(restarted.run(input, async () => assert.fail('Cancelled job restarted')), { code: 'compile_cancelled' });
  assert.equal(await restarted.run({ ...input, execution: { ...input.execution, id: randomUUID() } }, async () => 'new execution'), 'new execution');
  assert.equal(await restarted.run({ ...input, registryId: 'other-registry' }, async () => 'other Registry'), 'other Registry');
});

test('compiler rejects duplicate active executions and expires deadlines without work', async (t) => {
  const jobs = new RegistryJobControl(await root(t));
  // Filesystem setup must finish before the fixture advances its short deadline.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const input = control({ execution: { id: randomUUID(), expiresAt: new Date(Date.now() + 500).toISOString() } });
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const running = jobs.run(input, async (signal) => { started(); await delay(60_000, undefined, { signal }); });
  const rejected = assert.rejects(running, /abort|deadline/iu);
  try {
    await Promise.race([ready, running]);
    await assert.rejects(jobs.run(input, async () => {}), { code: 'compile_already_running' });
    t.mock.timers.tick(500);
    await rejected;
    await assert.rejects(jobs.run(input, async () => assert.fail('Expired job started')), { code: 'compile_expired' });
    for (const execution of [undefined, { id: 'not-uuid', expiresAt: new Date().toISOString() }, { id: randomUUID(), expiresAt: new Date(Date.now() + 48 * 3600_000).toISOString() }]) {
      await assert.rejects(jobs.run(control({ execution }), async () => {}), { code: 'invalid_compile_execution' });
    }
  } finally {
    jobs.close();
    await rejected.catch(() => {});
  }
});

test('compiler prunes only expired cancellation markers and still rejects expired replay', async (t) => {
  const directory = await root(t);
  const jobs = new RegistryJobControl(directory);
  const input = control({ execution: { id: randomUUID(), expiresAt: new Date(Date.now() + 30).toISOString() } });
  await jobs.cancel(input);
  const markers = path.join(directory, '.dkb', 'compiler-cancellations');
  await fs.writeFile(path.join(markers, 'unrelated.txt'), 'keep');
  await delay(40);
  await new RegistryJobControl(directory).cancel(input);
  assert.deepEqual(await fs.readdir(markers), ['unrelated.txt']);
  await assert.rejects(new RegistryJobControl(directory).run(input, async () => {}), { code: 'compile_expired' });
});

test('compiler HTTP cancellation rejects a delayed request and survives a restart', async (t) => {
  const directory = await root(t);
  const before = process.env.DKB_CONTEXT_ROOT;
  const previousToken = process.env.DKB_COMPILER_SERVICE_TOKEN;
  const serviceToken = randomUUID();
  process.env.DKB_CONTEXT_ROOT = directory;
  process.env.DKB_COMPILER_SERVICE_TOKEN = serviceToken;
  t.after(() => { if (before === undefined) delete process.env.DKB_CONTEXT_ROOT; else process.env.DKB_CONTEXT_ROOT = before; });
  t.after(() => { if (previousToken === undefined) delete process.env.DKB_COMPILER_SERVICE_TOKEN; else process.env.DKB_COMPILER_SERVICE_TOKEN = previousToken; });
  const input = control();
  for (let turn = 0; turn < 2; turn++) {
    const server = await serveDkbRegistryCompiler({ host: '127.0.0.1', port: 0 });
    try {
      const url = `http://127.0.0.1:${server.address().port}`;
      if (!turn) {
        const response = await fetch(`${url}/compile/cancel`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${serviceToken}` }, body: JSON.stringify(input) });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).status, 'cancelled');
      }
      const rejected = await fetch(`${url}/compile`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${serviceToken}` },
        body: JSON.stringify({ jobId: input.jobId, request: { package: { registryId: input.registryId }, execution: input.execution } }),
      });
      assert.equal(rejected.status, 409);
      assert.equal((await rejected.json()).error, 'compile_cancelled');
    } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  }
});

test('compiler HTTP control interrupts its synchronous running request through a trusted local provider', async (t) => {
  const directory = await root(t);
  const source = path.join(directory, 'source');
  const work = path.join(directory, 'work');
  const pluginRoot = path.join(directory, '.dkb', 'plugins', '@test', 'http-cancel');
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(work);
  await fs.mkdir(pluginRoot, { recursive: true });
  const serviceToken = randomUUID();
  const environment = Object.fromEntries(['DKB_CONTEXT_ROOT', 'DKB_COMPILER_WORK_ROOT', 'DKB_COMPILER_ALLOWED_TARGETS', 'DKB_COMPILER_DEFAULT_TARGET', 'DKB_COMPILER_SERVICE_TOKEN'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { DKB_CONTEXT_ROOT: directory, DKB_COMPILER_WORK_ROOT: work, DKB_COMPILER_ALLOWED_TARGETS: 'http-test', DKB_COMPILER_DEFAULT_TARGET: 'http-test', DKB_COMPILER_SERVICE_TOKEN: serviceToken });
  t.after(() => { for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  await fs.writeFile(path.join(directory, '.dkb', 'config.json'), JSON.stringify({ format: DKB_CONFIG_FORMAT, activeTarget: 'http-test', targets: { 'http-test': { evidence: '@test/http-cancel', index: '@test/http-cancel', retrieval: '@test/http-cancel' } } }));
  const started = path.join(directory, 'started');
  const stopped = path.join(directory, 'stopped');
  await fs.writeFile(path.join(pluginRoot, 'plugin.mjs'), `
import fs from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
export const apiVersion = 3;
export const id = '@test/http-cancel';
export const version = '1.0.0';
export const optionsSchema = { '~standard': { version: 1, vendor: 'test', validate(value) { return { value: value ?? {} }; } } };
export function setup(context) {
  context.registerProvider({ kind: 'evidence', async compile({ signal }) {
    await fs.writeFile(${JSON.stringify(started)}, String(signal instanceof AbortSignal));
    try { await setTimeout(60000, undefined, { signal }); }
    finally { await fs.writeFile(${JSON.stringify(stopped)}, String(signal.aborted)); }
    return { records: [], receipt: { build: {} } };
  }});
  context.registerProvider({ kind: 'index', mode: 'packaged', format: 'test', capabilities: { vectors: 'none' },
    async compilePackage() { throw new Error('Canceled Evidence cannot reach indexing'); }, async validatePackage() { return { documentCount: 0 }; },
    async verifyRuntime() { return { indexId: 'test', documentCount: 0, status: 'ready' }; },
    async openRuntime() { return { providerId: id, format: 'test', async search() { return { candidates: [], trace: {} }; }, async close() {} }; }
  });
  context.registerProvider({ kind: 'retrieval', protocol: 'test', capabilities: { vectors: 'none' },
    async openRuntime() { return { providerId: id, protocol: 'test', async search() { return { hits: [], trace: {} }; }, async close() {} }; }
  });
}
`);
  await fs.writeFile(path.join(source, 'dkb.json'), JSON.stringify({ manifestVersion: 1, type: 'dkb', name: '@test/http-cancel', version: '1.0.0', permissions: { read: true, write: false } }));
  await fs.writeFile(path.join(source, 'proof.md'), 'Preserved source');
  const archive = path.join(directory, 'source.dkbpkg');
  await createDkbPackageArchive(source, archive);
  const server = await serveDkbRegistryCompiler({ host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${server.address().port}`;
  const input = control();
  try {
    const running = fetch(`${url}/compile`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${serviceToken}` },
      body: JSON.stringify({ jobId: input.jobId, request: { package: { registryId: input.registryId }, execution: input.execution, target: 'http-test', expectedCompilerBuildDigest: (await readCompilerBuildIdentity()).buildDigest }, sourceArchive: { fileName: 'source.dkbpkg', contents: (await fs.readFile(archive)).toString('base64') } }),
    });
    for (let attempts = 0; ; attempts++) {
      if (await fs.access(started).then(() => true, () => false)) break;
      if (attempts > 250) assert.fail('The HTTP compiler did not start its Evidence provider');
      await delay(20);
    }
    assert.equal(await fs.readFile(started, 'utf8'), 'true');
    const response = await fetch(`${url}/compile/cancel`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${serviceToken}` }, body: JSON.stringify(input) });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).status, 'cancelling');
    const compiled = await running;
    assert.equal(compiled.status, 409);
    assert.equal((await compiled.json()).error, 'compile_cancelled');
    assert.equal(await fs.readFile(stopped, 'utf8'), 'true');
    assert.deepEqual(await fs.readdir(work), []);
  } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

for (const blockedStage of ['evidence', 'index']) {
  test(`Registry compilation passes cancellation into the actual ${blockedStage} provider and removes scratch output`, async (t) => {
    const directory = await root(t);
    const source = path.join(directory, 'source');
    const work = path.join(directory, 'work');
    await fs.mkdir(source);
    await fs.mkdir(work);
    const oldWork = process.env.DKB_COMPILER_WORK_ROOT;
    process.env.DKB_COMPILER_WORK_ROOT = work;
    t.after(() => { if (oldWork === undefined) delete process.env.DKB_COMPILER_WORK_ROOT; else process.env.DKB_COMPILER_WORK_ROOT = oldWork; });
    await fs.writeFile(path.join(source, 'dkb.json'), JSON.stringify({ manifestVersion: 1, type: 'dkb', name: '@test/cancellation', displayName: 'Cancellation', version: '1.0.0', permissions: { read: true, write: false } }));
    await fs.mkdir(path.join(source, 'docs'));
    await fs.writeFile(path.join(source, 'docs', 'readme.md'), 'Cancellation source');
    const archive = path.join(directory, 'source.dkbpkg');
    await createDkbPackageArchive(source, archive);
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    let signalReceived;
    const block = async (signal) => {
      signalReceived = signal;
      started();
      await delay(60_000, undefined, { signal });
    };
    const id = '@test/cancel-provider';
    const distribution = await materializeBundledProviderFixtures(t, {
      id: '@test/cancel-distribution', version: '1.0.0',
      defaults: { format: DKB_CONFIG_FORMAT, activeTarget: 'test', targets: { test: { evidence: id, index: id, retrieval: id } } },
      services: [],
      plugins: [{
        apiVersion: 3, id, version: '1.0.0', sourceUrl: import.meta.url,
        optionsSchema: { '~standard': { version: 1, vendor: 'test', validate(value) { return { value: value ?? {} }; } } },
        integrity: { apiVersion: 3, id, version: '1.0.0', protocols: ['test'], artifactFormats: ['test'] },
        setup(context) {
          context.registerProvider({ kind: 'evidence', async compile({ signal }) { if (blockedStage === 'evidence') await block(signal); return { records: [], receipt: { build: {} } }; } });
          context.registerProvider({
            kind: 'index', mode: 'packaged', format: 'test', capabilities: { vectors: 'none' },
            async compilePackage({ signal }) { if (blockedStage === 'index') await block(signal); return { build: {} }; },
            async validatePackage() { return { documentCount: 0 }; }, async verifyRuntime() { return { indexId: 'test', documentCount: 0, status: 'ready' }; },
            async openRuntime() { return { providerId: id, format: 'test', async search() { return { candidates: [], trace: {} }; }, async close() {} }; },
          });
          context.registerProvider({ kind: 'retrieval', protocol: 'test', capabilities: { vectors: 'none' }, async openRuntime() { return { providerId: id, protocol: 'test', async search() { return { hits: [], trace: {} }; }, async close() {} }; } });
        },
      }],
    });
    const jobs = new RegistryJobControl(directory);
    const input = control();
    const request = { jobId: input.jobId, request: { package: { id: '@test/cancellation', version: '1.0.0', registryId: input.registryId }, target: 'test', execution: input.execution, expectedCompilerBuildDigest: (await readCompilerBuildIdentity()).buildDigest }, sourceArchive: { fileName: 'source.dkbpkg', contents: (await fs.readFile(archive)).toString('base64') } };
    const running = jobs.run(input, (signal) => compileRegistryPackage(request, { distribution, contextRoot: directory, signal }));
    const rejected = assert.rejects(running, /abort|cancel/iu);
    await Promise.race([ready, running]);
    assert.ok(signalReceived instanceof AbortSignal);
    await jobs.cancel(input);
    await rejected;
    assert.equal(signalReceived.aborted, true);
    assert.deepEqual(await fs.readdir(work), []);
  });
}
