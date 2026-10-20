import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { compileDkbWithLlamaIndex, cancelLlamaIndexPending } from '@sjshovan/dkb-evidence-docling-llamaindex/compiler.js';

// Explicitly opt in with an already-built, model-baked image. This proof never
// builds/pulls an image or starts/replaces the user's selected compiler service.
test('real Node Evidence service transport preserves warm output and acknowledges cancellation/recovery', {
  skip: !process.env.DKB_EVIDENCE_SERVICE_PROOF_IMAGE, timeout: 600_000,
}, async t => {
  const run = promisify(execFile);
  const docker = (args, timeout = 20_000) => run('docker', args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  const image = process.env.DKB_EVIDENCE_SERVICE_PROOF_IMAGE;
  const inspectedImage = JSON.parse((await docker(['image', 'inspect', image])).stdout)[0];
  assert.match(inspectedImage.Id, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(inspectedImage.Config.Labels['org.dkb.compiler.service.version'], '5');
  const proofId = randomUUID();
  const name = `dkb-node-evidence-proof-${proofId}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-node-evidence-service-proof-'));
  const serviceRoot = path.join(root, 'service');
  const jobsRoot = path.join(serviceRoot, 'jobs');
  const sourceRoot = path.join(root, 'source');
  let containerId;
  let proxy;
  const environment = ['DKB_LLAMA_COMPILER_SERVICE_ROOT', 'DKB_LLAMA_COMPILER_SERVICE_URL',
    'DKB_LLAMA_COMPILER_SERVICE', 'DKB_LLAMA_RECORD_CACHE', 'DKB_TEST_ABORT_LLAMA_AFTER_CHECKPOINT'];
  const previous = new Map(environment.map(key => [key, process.env[key]]));
  t.after(async () => {
    proxy?.closeAllConnections();
    if (proxy?.listening) await new Promise(resolve => proxy.close(resolve));
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    const residual = await docker(['inspect', containerId ?? name]).catch(error => {
      if (/no such (container|object)/iu.test(String(error.stderr))) return null;
      throw error;
    });
    if (residual) {
      const owned = JSON.parse(residual.stdout)[0];
      assert.match(owned.Id, /^[a-f0-9]{64}$/u);
      if (containerId) assert.equal(owned.Id, containerId);
      assert.equal(owned.Image, inspectedImage.Id);
      assert.equal(owned.Config.Labels['org.dkb.proof.owner'], proofId);
      assert.ok(owned.Mounts.some(mount => mount.Destination === '/jobs' && path.resolve(mount.Source) === jobsRoot));
      await docker(['rm', '-f', owned.Id]);
      assert.equal((await docker(['ps', '-a', '--filter', `label=org.dkb.proof.owner=${proofId}`, '--format', '{{.ID}}'])).stdout.trim(), '');
    }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('dkb-node-evidence-service-proof-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(jobsRoot, { recursive: true });
  await fs.mkdir(path.join(sourceRoot, 'sources'), { recursive: true });
  for (const key of environment) delete process.env[key];
  process.env.DKB_LLAMA_COMPILER_SERVICE_ROOT = serviceRoot;
  process.env.DKB_LLAMA_RECORD_CACHE = '0';
  containerId = (await docker(['run', '-d', '--pull=never', '--name', name, '--cpus', '2', '--memory', '6g',
    '--label', `org.dkb.proof.owner=${proofId}`, '-p', '127.0.0.1::8091',
    '--mount', `type=bind,src=${jobsRoot},dst=/jobs`, '-e', 'DKB_COMPILER_JOBS_ROOT=/jobs',
    '-e', 'HF_HUB_OFFLINE=1', '-e', 'TRANSFORMERS_OFFLINE=1', inspectedImage.Id])).stdout.trim();
  assert.match(containerId, /^[a-f0-9]{64}$/u);
  const port = /127\.0\.0\.1:(\d+)/u.exec((await docker(['port', containerId, '8091'])).stdout)?.[1];
  assert.ok(port);
  const upstream = `http://127.0.0.1:${port}`;
  await until(async () => {
    const response = await fetch(`${upstream}/health`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
    if (!response?.ok) return false;
    const health = await response.json();
    return health.ok && health.serviceVersion === '5';
  }, 60_000);

  let controlUnavailable = false;
  proxy = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      if (controlUnavailable && request.url.startsWith('/jobs/')) {
        response.writeHead(503).end('{}');
        return;
      }
      const forwarded = await fetch(`${upstream}${request.url}`, {
        method: request.method, headers: { 'content-type': 'application/json' },
        body: Buffer.concat(chunks), signal: AbortSignal.timeout(300_000),
      });
      const body = await forwarded.text();
      if (!response.destroyed) response.writeHead(forwarded.status, { 'content-type': 'application/json' }).end(body);
    } catch { if (!response.destroyed) response.writeHead(502).end('{}'); }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  process.env.DKB_LLAMA_COMPILER_SERVICE_URL = `http://127.0.0.1:${proxy.address().port}`;

  const pending = new Map();
  let state;
  const execution = {
    async registerPending(value) {
      state = structuredClone(value);
      await fs.access(path.join(state.jobRoot, '.dkb-worker-control.json'));
      const id = randomUUID();
      pending.set(id, state);
      return id;
    },
    async settlePending(id) {
      await assert.rejects(fs.access(pending.get(id).jobRoot), { code: 'ENOENT' });
      pending.delete(id);
    },
  };
  const dkb = { root: sourceRoot, manifest: { id: '@test/real-node-transport', version: '1.0.0',
    stores: [{ id: 'files', type: 'filesystem', path: 'sources' }] } };
  const compile = signal => compileDkbWithLlamaIndex(dkb, { image, imageDigest: inspectedImage.Id, execution, signal, timeoutMs: 240_000 });
  const record = async value => JSON.parse(await fs.readFile(path.join(jobsRoot, '.control', `${hash(value.jobId)}.json`), 'utf8'));
  const status = async value => {
    const response = await fetch(`${upstream}/jobs/status`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: value.jobId, jobToken: value.jobToken }),
      signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    return response.json();
  };
  const source = '# Transport proof\n\nThe blue archive holds twenty-four synthetic evidence cards. Each source is immutable, and every result must preserve its source hash.\n';
  const sourceFile = path.join(sourceRoot, 'sources', 'sample.md');
  await fs.writeFile(sourceFile, source);
  const first = await compile();
  const firstRecord = await record(state);
  const second = await compile();
  const secondRecord = await record(state);
  assert.ok(first.records.length > 0);
  assert.deepEqual(second.records, first.records);
  assert.ok(first.records.every(item => item.sourceHash === `sha256:${hash(source)}`));
  assert.equal(firstRecord.worker.pid, secondRecord.worker.pid, 'uncached successful jobs reuse the persistent child');
  assert.equal(secondRecord.terminated, false);
  assert.equal(pending.size, 0);

  const busySource = Array.from({ length: 16_000 }, (_, index) => `## Synthetic evidence ${index}\n\n${source}`).join('\n');
  let cancelledPid;
  for (const recovery of [false, true]) {
    await fs.writeFile(sourceFile, busySource);
    state = undefined;
    const controller = new AbortController();
    controlUnavailable = recovery;
    const outcome = compile(controller.signal).then(result => ({ result }), error => ({ error }));
    await until(async () => state && (await status(state))?.status === 'running', 60_000);
    cancelledPid = (await record(state)).worker.pid;
    await delay(100);
    assert.equal((await status(state))?.status, 'running', 'cancel actual in-flight work, not an already completed request');
    controller.abort(new DkbError('Proof requested cancellation.', 'compile_cancelled'));
    const result = await outcome;
    assert.equal(result.error?.code, recovery ? 'compile_termination_unconfirmed' : 'compile_cancelled');
    if (recovery) {
      assert.equal(pending.size, 1);
      await fs.access(path.join(state.jobRoot, '.dkb-worker-control.json'));
      await fs.access(path.join(state.jobRoot, 'input', 'sources', 'sample.md'));
      controlUnavailable = false;
      assert.deepEqual(await cancelLlamaIndexPending({ state, options: { image, imageDigest: inspectedImage.Id } }), { safeToCleanup: true });
      await execution.settlePending([...pending.keys()][0]);
      assert.deepEqual(await cancelLlamaIndexPending({ state, options: { image, imageDigest: inspectedImage.Id } }), { safeToCleanup: true },
        'cleanup-before-settlement retry still verifies the matching worker tombstone');
    }
    const acknowledged = await status(state);
    assert.equal(acknowledged.jobId, state.jobId);
    assert.equal(acknowledged.jobTokenHash, `sha256:${hash(state.jobToken)}`);
    assert.equal(acknowledged.status, 'cancelled');
    assert.equal(acknowledged.safeToCleanup, true);
    assert.equal(acknowledged.terminated, true);
    assert.equal(pending.size, 0);
    await assert.rejects(fs.access(state.jobRoot), { code: 'ENOENT' });
    await docker(['exec', containerId, 'python', '-c', `from pathlib import Path; assert not Path('/proc/${cancelledPid}').exists()`]);
    await fs.writeFile(sourceFile, source);
    const replacement = await compile();
    assert.deepEqual(replacement.records, first.records);
    assert.notEqual((await record(state)).worker.pid, cancelledPid);
  }
  assert.equal(await fs.readFile(sourceFile, 'utf8'), source);
  t.diagnostic(`Actual model-baked Evidence image ${inspectedImage.Id}; warm records=${first.records.length}; normal cancel and unavailable-control recovery passed.`);
});

function hash(value) { return createHash('sha256').update(value).digest('hex'); }

async function until(predicate, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  assert.fail('The bounded real-worker proof did not reach its expected state.');
}
