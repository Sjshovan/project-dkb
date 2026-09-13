import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DkbProviderHost } from '@sjshovan/dkb-pipeline/host.js';
import { DKB_CONFIG_FORMAT } from '@sjshovan/dkb-pipeline/config.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { createDkbPackageArchive } from '@sjshovan/dkb-library/archive.js';
import { RegistryJobControl } from '../services/compiler/dist/registryJobControl.js';
import { RegistryExecutionJournal } from '../services/compiler/dist/registryExecutionJournal.js';
import { bindProviderExecution, pendingExecutionReconciler } from '../services/compiler/dist/providerExecution.js';
import { compileRegistryPackage } from '../services/compiler/dist/registryCompilation.js';
import { readCompilerBuildIdentity } from '../services/compiler/dist/compilerCapabilities.js';
import { materializeBundledProviderFixtures } from './bundled-provider-fixture.mjs';

async function root(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-execution-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function control(lifetime = 60_000) {
  return { registryId: 'recovery-test-registry', jobId: '31', execution: {
    id: randomUUID(), expiresAt: new Date(Date.now() + lifetime).toISOString(),
  } };
}

function fakeHost() {
  const description = { target: 'recovery-test', buildDigest: `sha256:${'1'.repeat(64)}`, providers: [
    { kind: 'evidence', id: '@test/recoverable-evidence', integrityDigest: `sha256:${'2'.repeat(64)}` },
  ] };
  const options = { endpoint: 'http://worker.example.test', secretRef: 'env:TEST_WORKER_TOKEN' };
  const provider = { kind: 'evidence', async cancelPending() { return { safeToCleanup: true }; } };
  return { description, options, selected: provider,
    describe() { return this.description; },
    optionsFor() { return this.options; },
    provider() { return this.selected; },
    async dispose() {},
  };
}

async function journalFor(directory) {
  const base = path.join(directory, '.dkb', 'compiler-cancellations');
  const names = (await fs.readdir(base)).filter((name) => name.endsWith('.execution'));
  assert.equal(names.length, 1, 'one durable execution claim must remain');
  return new RegistryExecutionJournal(path.join(base, names[0]));
}

function unconfirmed() {
  return new DkbError('Test worker has not acknowledged termination.', 'compile_termination_unconfirmed');
}

test('concurrent pending registrations remain distinct and one invocation cannot settle another', async (t) => {
  const directory = await root(t);
  const jobs = new RegistryJobControl(directory);
  const input = control();
  await jobs.run(input, async (_signal, execution) => {
    const owner = execution(fakeHost(), 'evidence');
    const other = execution(fakeHost(), 'evidence');
    const ids = await Promise.all(Array.from({ length: 12 }, (_, index) => owner.registerPending({ job: index })));
    assert.equal(new Set(ids).size, 12);
    const journal = await journalFor(directory);
    assert.deepEqual((await journal.entries()).map(({ pending }) => pending.state.job).sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => index));
    await assert.rejects(other.settlePending(ids[0]), { code: 'invalid_compile_execution' });
    await Promise.all(ids.map((id) => owner.settlePending(id)));
    assert.deepEqual(await journal.entries(), []);
  });
  assert.deepEqual(await fs.readdir(path.join(directory, '.dkb', 'compiler-cancellations')), []);
});

test('abort preserves unconfirmed worker records and reconciliation requires affirmative acknowledgment', async (t) => {
  const directory = await root(t);
  const input = control();
  const jobs = new RegistryJobControl(directory);
  const started = Promise.withResolvers();
  const running = jobs.run(input, async (signal, execution) => {
    await execution(fakeHost(), 'evidence').registerPending({ workerId: 'not-stopped' });
    started.resolve();
    try { await delay(60_000, undefined, { signal }); }
    catch { throw unconfirmed(); }
  });
  const rejected = assert.rejects(running, { code: 'compile_termination_unconfirmed' });
  t.after(() => jobs.close());
  await started.promise;
  assert.equal((await jobs.cancel(input)).status, 'cancelling');
  await rejected;
  const journal = await journalFor(directory);
  const entries = await journal.entries();
  assert.equal(entries.length, 1);
  assert.equal(await journal.ownerHasStopped(), true);
  const noAcknowledgment = new RegistryJobControl(directory, async () => false);
  await assert.rejects(noAcknowledgment.cancel(input), { code: 'compile_termination_unconfirmed' });
  assert.deepEqual(await journal.entries(), entries);
  await assert.rejects(noAcknowledgment.run(input, async () => assert.fail('Cancelled execution was replayed')), { code: 'compile_cancelled' });
  let reconciled;
  const recovered = new RegistryJobControl(directory, async (pending) => { reconciled = pending; return true; });
  assert.equal((await recovered.cancel(input)).status, 'cancelled');
  assert.deepEqual(reconciled, entries[0].pending);
  assert.equal(await journal.exists(), false);
  assert.equal((await recovered.cancel(input)).status, 'cancelled');
});

test('journal authority preserves pending work when a disposal error masks the worker exception', async (t) => {
  const directory = await root(t);
  const jobs = new RegistryJobControl(directory);
  const input = control();
  await assert.rejects(jobs.run(input, async (_signal, execution) => {
    await execution(fakeHost(), 'evidence').registerPending({ workerId: 'masked-worker' });
    try { throw unconfirmed(); }
    finally { throw new Error('Provider disposal failed and masked the original exception'); }
  }), { code: 'compile_termination_unconfirmed' });
  const journal = await journalFor(directory);
  assert.equal((await journal.entries())[0].pending.state.workerId, 'masked-worker');
  await assert.rejects(new RegistryJobControl(directory).cancel(input), { code: 'compile_termination_unconfirmed' });
  assert.equal(await journal.exists(), true);
});

test('explicit unconfirmed termination retains the outer workspace even without a pending record', async (t) => {
  const directory = await root(t);
  const workRoot = path.join(directory, 'work');
  await fs.mkdir(workRoot);
  const workspace = await fs.mkdtemp(path.join(workRoot, 'dkb-registry-compile-'));
  const source = path.join(workspace, 'worker-source.txt');
  await fs.writeFile(source, 'The worker may still own this source.');
  const previous = process.env.DKB_COMPILER_WORK_ROOT;
  process.env.DKB_COMPILER_WORK_ROOT = workRoot;
  t.after(() => {
    if (previous === undefined) delete process.env.DKB_COMPILER_WORK_ROOT;
    else process.env.DKB_COMPILER_WORK_ROOT = previous;
  });
  const input = control();
  await assert.rejects(new RegistryJobControl(directory).run(input, async (_signal, execution) => {
    await execution.registerWorkspace(workspace);
    throw unconfirmed();
  }), { code: 'compile_termination_unconfirmed' });
  const journal = await journalFor(directory);
  assert.deepEqual(await journal.entries(), []);
  assert.equal(await journal.ownerHasStopped(), true);
  let reconciliations = 0;
  const restarted = new RegistryJobControl(directory, async () => { reconciliations++; return true; });
  for (let retry = 0; retry < 2; retry++) {
    await assert.rejects(restarted.cancel(input), { code: 'compile_termination_unconfirmed' });
    assert.equal(await fs.readFile(source, 'utf8'), 'The worker may still own this source.');
    assert.equal(await journal.exists(), true);
  }
  assert.equal(reconciliations, 0, 'No provider handle exists to authorize a safe-cleanup acknowledgement');
});

test('failed untracked-work persistence cannot authorize workspace cleanup after owner release', async (t) => {
  const directory = await root(t);
  const workRoot = path.join(directory, 'work');
  await fs.mkdir(workRoot);
  const workspace = await fs.mkdtemp(path.join(workRoot, 'dkb-registry-compile-'));
  const source = path.join(workspace, 'worker-source.txt');
  await fs.writeFile(source, 'Retain this source when the recovery write fails.');
  const previous = process.env.DKB_COMPILER_WORK_ROOT;
  process.env.DKB_COMPILER_WORK_ROOT = workRoot;
  t.after(() => {
    if (previous === undefined) delete process.env.DKB_COMPILER_WORK_ROOT;
    else process.env.DKB_COMPILER_WORK_ROOT = previous;
  });
  const input = control();
  const originalOpen = fs.open;
  let failedWrites = 0;
  fs.open = async (file, ...arguments_) => {
    if (typeof file === 'string' && path.basename(file) === 'untracked.json') {
      failedWrites++;
      throw Object.assign(new Error('Synthetic recovery storage failure'), { code: 'ENOSPC' });
    }
    return originalOpen(file, ...arguments_);
  };
  try {
    await assert.rejects(new RegistryJobControl(directory).run(input, async (_signal, execution) => {
      await execution.registerWorkspace(workspace);
      throw unconfirmed();
    }), { code: 'compile_termination_unconfirmed' });
  } finally {
    fs.open = originalOpen;
  }
  assert.equal(failedWrites, 1);
  const journal = await journalFor(directory);
  assert.deepEqual(await journal.entries(), []);
  assert.equal(await journal.ownerHasStopped(), true);
  await assert.rejects(fs.access(path.join(journal.root, 'untracked.json')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(journal.root, 'finished.json')), { code: 'ENOENT' });
  let reconciliations = 0;
  const restarted = new RegistryJobControl(directory, async () => { reconciliations++; return true; });
  for (let retry = 0; retry < 2; retry++) {
    await assert.rejects(restarted.cancel(input), { code: 'compile_termination_unconfirmed' });
    assert.equal(await fs.readFile(source, 'utf8'), 'Retain this source when the recovery write fails.');
    assert.equal(await journal.exists(), true);
  }
  assert.equal(reconciliations, 0, 'An absent recovery handle cannot manufacture a stopped-worker acknowledgement');
});

test('real Registry compilation retains worker-referenced scratch despite a generic failure and throwing disposal', async (t) => {
  const directory = await root(t);
  const workRoot = path.join(directory, 'work');
  const sourceRoot = path.join(directory, 'source');
  await fs.mkdir(workRoot);
  await fs.mkdir(sourceRoot);
  const previousWorkRoot = process.env.DKB_COMPILER_WORK_ROOT;
  process.env.DKB_COMPILER_WORK_ROOT = workRoot;
  t.after(() => {
    if (previousWorkRoot === undefined) delete process.env.DKB_COMPILER_WORK_ROOT;
    else process.env.DKB_COMPILER_WORK_ROOT = previousWorkRoot;
  });
  const manifest = JSON.stringify({ manifestVersion: 1, type: 'dkb', name: '@test/recovery-scratch', version: '1.0.0', permissions: { read: true, write: false } });
  await fs.writeFile(path.join(sourceRoot, 'dkb.json'), manifest);
  const archive = path.join(directory, 'source.dkbpkg');
  await createDkbPackageArchive(sourceRoot, archive);
  let workerRoot;
  let disposalAttempts = 0;
  const id = '@test/recovery-scratch-provider';
  const distribution = await materializeBundledProviderFixtures(t, {
    id: '@test/recovery-scratch-distribution', version: '1.0.0', services: [],
    defaults: { format: DKB_CONFIG_FORMAT, activeTarget: 'test', targets: { test: { evidence: id, index: id, retrieval: id } } },
    plugins: [{
      apiVersion: 3, id, version: '1.0.0', sourceUrl: import.meta.url,
      optionsSchema: { '~standard': { version: 1, vendor: 'test', validate(value) { return { value: value ?? {} }; } } },
      integrity: { apiVersion: 3, id, version: '1.0.0', protocols: ['test'], artifactFormats: ['test'] },
      setup(context) {
        context.registerProvider({ kind: 'evidence',
          async compile({ dkb, execution }) {
            assert.ok(execution, 'Registry must supply a durable provider execution context');
            await execution.registerPending({ workerRoot: dkb.root });
            workerRoot = dkb.root;
            await fs.writeFile(path.join(workerRoot, 'worker-output.tmp'), 'worker still owns this path');
            throw new Error('Worker transport failed without a typed cancellation error');
          },
          async dispose() {
            if (workerRoot) { disposalAttempts++; throw new Error('Disposal also failed'); }
          },
        });
        context.registerProvider({ kind: 'index', mode: 'packaged', format: 'test', capabilities: { vectors: 'none' },
          async compilePackage() { assert.fail('Indexing started while Evidence worker is unresolved'); },
          async validatePackage() { return { documentCount: 0 }; },
          async verifyRuntime() { return { indexId: 'test', documentCount: 0, status: 'ready' }; },
          async openRuntime() { return { providerId: id, format: 'test', async search() { return { candidates: [], trace: {} }; }, async close() {} }; },
        });
        context.registerProvider({ kind: 'retrieval', protocol: 'test', capabilities: { vectors: 'none' },
          async openRuntime() { return { providerId: id, protocol: 'test', async search() { return { hits: [], trace: {} }; }, async close() {} }; },
        });
      },
    }],
  });
  const input = control();
  const request = { jobId: input.jobId, request: {
    package: { id: '@test/recovery-scratch', version: '1.0.0', registryId: input.registryId },
    execution: input.execution, target: 'test', expectedCompilerBuildDigest: (await readCompilerBuildIdentity()).buildDigest,
  }, sourceArchive: { fileName: 'source.dkbpkg', contents: (await fs.readFile(archive)).toString('base64') } };
  const jobs = new RegistryJobControl(directory);
  await assert.rejects(jobs.run(input, (signal, execution) => compileRegistryPackage(request, {
    distribution, contextRoot: directory, signal, execution,
  })), { code: 'compile_termination_unconfirmed' });
  assert.ok(disposalAttempts > 0);
  assert.equal(await fs.readFile(path.join(workerRoot, 'worker-output.tmp'), 'utf8'), 'worker still owns this path');
  assert.equal(await fs.readFile(path.join(sourceRoot, 'dkb.json'), 'utf8'), manifest);
  assert.equal((await (await journalFor(directory)).entries())[0].pending.state.workerRoot, workerRoot);
  assert.ok((await fs.readdir(workRoot)).length > 0);
  const recovery = new RegistryJobControl(directory, async (pending) => {
    assert.equal(pending.state.workerRoot, workerRoot);
    return true;
  });
  assert.equal((await recovery.cancel(input)).status, 'cancelled');
  assert.deepEqual(await fs.readdir(workRoot), [], 'Confirmed recovery also removes the exact outer Registry staging directory');
  assert.equal(await fs.readFile(path.join(sourceRoot, 'dkb.json'), 'utf8'), manifest, 'Original source is never moved or removed');
});

for (const delivery of ['json', 'binary']) {
  test(`unsettled worker records block ${delivery} delivery even after valid compilation`, async (t) => {
    const directory = await root(t);
    const workRoot = path.join(directory, 'work');
    const sourceRoot = path.join(directory, 'source');
    await fs.mkdir(workRoot);
    await fs.mkdir(sourceRoot);
    const previousWorkRoot = process.env.DKB_COMPILER_WORK_ROOT;
    process.env.DKB_COMPILER_WORK_ROOT = workRoot;
    t.after(() => {
      if (previousWorkRoot === undefined) delete process.env.DKB_COMPILER_WORK_ROOT;
      else process.env.DKB_COMPILER_WORK_ROOT = previousWorkRoot;
    });
    const manifest = JSON.stringify({ manifestVersion: 1, type: 'dkb', name: '@test/unsettled-delivery', version: '1.0.0', permissions: { read: true, write: false } });
    const knowledge = 'Synthetic valid Evidence must not bypass worker acknowledgement.';
    const sourceHash = `sha256:${createHash('sha256').update(knowledge).digest('hex')}`;
    await fs.writeFile(path.join(sourceRoot, 'dkb.json'), manifest);
    await fs.writeFile(path.join(sourceRoot, 'knowledge.md'), knowledge);
    const archive = path.join(directory, 'source.dkbpkg');
    await createDkbPackageArchive(sourceRoot, archive);
    let workerRoot;
    let indexed = false;
    let delivered = false;
    const id = '@test/unsettled-delivery-provider';
    const distribution = await materializeBundledProviderFixtures(t, {
      id: '@test/unsettled-delivery-distribution', version: '1.0.0', services: [],
      defaults: { format: DKB_CONFIG_FORMAT, activeTarget: 'test', targets: { test: { evidence: id, index: id, retrieval: id } } },
      plugins: [{
        apiVersion: 3, id, version: '1.0.0', sourceUrl: import.meta.url,
        optionsSchema: { '~standard': { version: 1, vendor: 'test', validate(value) { return { value: value ?? {} }; } } },
        integrity: { apiVersion: 3, id, version: '1.0.0', protocols: ['test'], artifactFormats: ['test'] },
        setup(context) {
          context.registerProvider({ kind: 'evidence', async compile({ dkb, execution }) {
            workerRoot = dkb.root;
            await execution.registerPending({ workerRoot });
            return { records: [{
              id: 'knowledge', chunkId: 'knowledge', text: knowledge,
              provenance: {
                assetId: 'knowledge.md', storeId: 'filesystem', sourceType: 'filesystem',
                locator: { path: 'knowledge.md', chunk: 0 }, assetLocator: { path: 'knowledge.md' },
                title: 'knowledge.md', sourceHash, updatedAt: '2026-09-13T00:00:00.000Z',
                chunkOrdinal: 0, chunkStart: 0, chunkEnd: knowledge.length,
              },
              metadata: { dkb_path: 'knowledge.md', dkb_source_hash: sourceHash },
            }], receipt: { build: {} } };
          } });
          context.registerProvider({ kind: 'index', mode: 'packaged', format: 'test', capabilities: { vectors: 'none' },
            async compilePackage({ artifactsRoot, compiled }) {
              indexed = true;
              assert.equal(compiled.records.length, 1);
              await fs.mkdir(artifactsRoot, { recursive: true });
              await fs.writeFile(path.join(artifactsRoot, 'records.json'), JSON.stringify(compiled.records));
              return { build: { recordCount: 1 } };
            },
            async validatePackage() { return { documentCount: 1 }; },
            async verifyRuntime() { return { indexId: 'test', documentCount: 1, status: 'ready' }; },
            async openRuntime() { return { providerId: id, format: 'test', async search() { return { candidates: [], trace: {} }; }, async close() {} }; },
          });
          context.registerProvider({ kind: 'retrieval', protocol: 'test', capabilities: { vectors: 'none' },
            async openRuntime() { return { providerId: id, protocol: 'test', async search() { return { hits: [], trace: {} }; }, async close() {} }; },
          });
        },
      }],
    });
    const input = control();
    const request = { jobId: input.jobId, request: {
      package: { id: '@test/unsettled-delivery', version: '1.0.0', registryId: input.registryId },
      execution: input.execution, target: 'test', expectedCompilerBuildDigest: (await readCompilerBuildIdentity()).buildDigest,
    }, sourceArchive: { fileName: 'source.dkbpkg', contents: (await fs.readFile(archive)).toString('base64') } };
    const jobs = new RegistryJobControl(directory);
    await assert.rejects(jobs.run(input, async (signal, execution) => {
      const result = await compileRegistryPackage(request, {
        distribution, contextRoot: directory, signal, execution,
        ...(delivery === 'binary' ? { deliver: async () => { delivered = true; } } : {}),
      });
      if (delivery === 'json') delivered = true;
      return result;
    }), { code: 'compile_termination_unconfirmed' });
    assert.equal(indexed, true, 'Valid records reach a successful index build, not an unrelated fixture error');
    assert.equal(delivered, false, 'Neither a JSON response nor the binary delivery callback may observe a result');
    assert.equal(await fs.readFile(path.join(workerRoot, 'knowledge.md'), 'utf8'), knowledge);
    const journal = await journalFor(directory);
    assert.equal((await journal.entries()).length, 1);
    let acknowledgements = 0;
    const recovery = new RegistryJobControl(directory, async (pending) => {
      assert.equal(pending.state.workerRoot, workerRoot);
      await fs.access(workerRoot);
      acknowledgements++;
      return true;
    });
    assert.equal((await recovery.cancel(input)).status, 'cancelled');
    assert.equal(acknowledgements, 1);
    assert.equal(await journal.exists(), false);
    assert.deepEqual(await fs.readdir(workRoot), []);
    assert.equal(await fs.readFile(path.join(sourceRoot, 'dkb.json'), 'utf8'), manifest);
    assert.equal(await fs.readFile(path.join(sourceRoot, 'knowledge.md'), 'utf8'), knowledge);
  });
}

test('expired executions retain pending workers instead of pruning or replaying them', async (t) => {
  const directory = await root(t);
  const input = control();
  const jobs = new RegistryJobControl(directory);
  await assert.rejects(jobs.run(input, async (_signal, execution) => {
    await execution(fakeHost(), 'evidence').registerPending({ workerId: 'expired-worker' });
    throw unconfirmed();
  }), { code: 'compile_termination_unconfirmed' });
  input.execution.expiresAt = new Date(Date.now() - 1000).toISOString();
  const journal = await journalFor(directory);
  const entries = await journal.entries();
  const restarted = new RegistryJobControl(directory, async () => false);
  await assert.rejects(restarted.cancel(input), { code: 'compile_termination_unconfirmed' });
  await assert.rejects(restarted.run(input, async () => assert.fail('Expired execution was replayed')), { code: 'compile_expired' });
  assert.deepEqual(await journal.entries(), entries);
});

test('a second control instance cannot reconcile a live owner even after it requests cancellation', async (t) => {
  const directory = await root(t);
  const input = control();
  const owner = new RegistryJobControl(directory);
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let reconciliations = 0;
  const observer = new RegistryJobControl(directory, async () => { reconciliations++; return true; });
  const running = owner.run(input, async (_signal, execution) => {
    await execution(fakeHost(), 'evidence').registerPending({ workerId: 'live-owner' });
    started.resolve();
    await finish.promise;
    throw unconfirmed();
  });
  const rejected = assert.rejects(running, { code: 'compile_termination_unconfirmed' });
  t.after(() => { finish.resolve(); owner.close(); });
  await started.promise;
  await assert.rejects(observer.run(input, async () => assert.fail('A second owner started work')), { code: 'compile_termination_unconfirmed' });
  assert.equal((await observer.cancel(input)).status, 'cancelling');
  assert.equal(reconciliations, 0);
  const journal = await journalFor(directory);
  assert.equal(await journal.ownerHasStopped(), false);
  finish.resolve();
  await rejected;
  assert.equal((await observer.cancel(input)).status, 'cancelled');
  assert.equal(reconciliations, 1);
});

for (const change of ['missing', 'id', 'integrity', 'build', 'options', 'target']) {
  test(`recovery rejects ${change} provider identity drift before invoking cancellation`, async (t) => {
    const directory = await root(t);
    const host = fakeHost();
    const pending = { ...bindProviderExecution(host, 'evidence'), state: { workerId: 'pinned-worker' } };
    if (change === 'missing') host.description.providers = [];
    if (change === 'id') host.description.providers[0].id = '@test/replacement';
    if (change === 'integrity') host.description.providers[0].integrityDigest = `sha256:${'3'.repeat(64)}`;
    if (change === 'build') host.description.buildDigest = `sha256:${'4'.repeat(64)}`;
    if (change === 'options') host.options.endpoint = 'http://replacement.example.test';
    if (change === 'target') host.description.target = 'replacement';
    let cancelled = 0;
    let disposed = 0;
    host.selected.cancelPending = async () => { cancelled++; return { safeToCleanup: true }; };
    host.dispose = async () => { disposed++; };
    t.mock.method(DkbProviderHost, 'create', async () => host);
    await assert.rejects(pendingExecutionReconciler({}, directory)(pending), {
      code: change === 'missing' ? 'compile_provider_missing' : 'compile_termination_unconfirmed',
    });
    assert.equal(cancelled, 0);
    assert.equal(disposed, 1);
  });
}

test('recovery supplies exact bound state and options and requires literal safeToCleanup true', async (t) => {
  const directory = await root(t);
  const host = fakeHost();
  const pending = { ...bindProviderExecution(host, 'evidence'), state: { workerId: 'exact-worker' } };
  t.mock.method(DkbProviderHost, 'create', async () => host);
  const reconcile = pendingExecutionReconciler({}, directory);
  for (const acknowledgment of [undefined, {}, { safeToCleanup: false }, { safeToCleanup: 'true' }, { safeToCleanup: true }]) {
    host.selected.cancelPending = async (input) => {
      assert.deepEqual(input.state, pending.state);
      assert.deepEqual(input.options, host.options);
      assert.ok(input.signal instanceof AbortSignal);
      assert.equal(input.signal.aborted, false);
      return acknowledgment;
    };
    assert.equal(await reconcile(pending), acknowledgment?.safeToCleanup === true);
  }
  delete host.selected.cancelPending;
  assert.equal(await reconcile(pending), false);
});

test('a killed compiler owner leaves a recoverable worker record and cannot authorize cleanup by itself', { timeout: 15_000 }, async (t) => {
  const directory = await root(t);
  const input = control();
  const moduleUrl = new URL('../services/compiler/dist/registryJobControl.js', import.meta.url).href;
  const source = `
    import { RegistryJobControl } from ${JSON.stringify(moduleUrl)};
    const host = (${fakeHost.toString()})();
    const jobs = new RegistryJobControl(process.argv[1]);
    const keepAlive = setInterval(() => {}, 1000);
    await jobs.run(JSON.parse(process.argv[2]), async (_signal, execution) => {
      await execution(host, 'evidence').registerPending({ workerId: 'orphaned-worker' });
      process.send({ ready: true });
      await new Promise(() => {});
    });
    clearInterval(keepAlive);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source, directory, JSON.stringify(input)], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
  });
  const exited = once(child, 'exit');
  let diagnostic = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { diagnostic += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(8000) }).catch((error) => {
    throw new Error(`Child did not persist its execution: ${diagnostic}`, { cause: error });
  });
  assert.equal(ready.ready, true);
  const journal = await journalFor(directory);
  assert.equal(await journal.ownerHasStopped(), false);
  let reconciliations = 0;
  const restarted = new RegistryJobControl(directory, async () => { reconciliations++; return false; });
  assert.equal((await restarted.cancel(input)).status, 'cancelling');
  assert.equal(reconciliations, 0);
  child.kill('SIGKILL');
  await exited;
  assert.equal(await journal.ownerHasStopped(), true);
  await assert.rejects(restarted.cancel(input), { code: 'compile_termination_unconfirmed' });
  assert.equal(reconciliations, 1);
  assert.equal((await journal.entries())[0].pending.state.workerId, 'orphaned-worker');
  assert.equal((await new RegistryJobControl(directory, async () => true).cancel(input)).status, 'cancelled');
  assert.equal(await journal.exists(), false);
});
