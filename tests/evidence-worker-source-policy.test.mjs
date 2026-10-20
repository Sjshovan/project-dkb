import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { EVIDENCE_DOCLING_LLAMAINDEX_PLUGIN as plugin } from '@sjshovan/dkb-evidence-docling-llamaindex/plugin.js';
import { validatePipelineRecords } from '@sjshovan/dkb-pipeline/validation.js';

const executeFile = promisify(execFileCallback);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('public bundled Evidence provider rejects manifest connection instructions before transport or environment resolution', async (t) => {
  const root = await temporaryRoot(t);
  const { options, provider } = await evidenceProvider();
  for (const sources of [
    [{ id: 'live', kind: 'database', connection: 'fixture-secret-dsn', developmentOnly: true }],
    [{ id: 'live', kind: 'database', connectionEnv: 'DKB_TEST_NONEXISTENT_CONNECTION_REFERENCE' }],
    [], null, 'malformed',
  ]) {
    const dkb = { root, manifest: { id: '@proof/no-live-input', version: '1.0.0',
      stores: [{ id: 'local', type: 'filesystem', path: '.' }], meta: { llamaIndex: { sources } } } };
    await assert.rejects(provider.compile({ dkb, options }), (error) => {
      assert.equal(error.code, 'unsupported_source_configuration');
      assert.match(error.message, /immutable database snapshot.*package-owned SQLite or JSON/u);
      assert.doesNotMatch(error.message, /fixture-secret-dsn|DKB_TEST_NONEXISTENT_CONNECTION_REFERENCE/u);
      return true;
    });
  }
  assert.deepEqual(await fs.readdir(root), [], 'rejected manifest configuration must not create a compiler job or derived files');
});

test('worker rejects direct live requests while package-owned SQLite retains actual source hashes and rows', async (t) => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  try { await executeFile(python, ['--version']); } catch (error) {
    if (error.code === 'ENOENT') return t.skip('Python is required for worker source policy checks');
    throw error;
  }
  const root = await temporaryRoot(t);
  const sourceRoot = path.join(root, 'source');
  await fs.mkdir(sourceRoot);
  const result = await executeFile(python, ['-B', path.join(repository, 'tests/evidence-worker-source-policy-fixture.py'),
    path.join(repository, 'providers/evidence-docling-llamaindex/python'), sourceRoot], { timeout: 30_000 });
  const worker = JSON.parse(result.stdout);
  assert.equal(worker.rejectedRequests, 4);
  assert.equal(worker.rejectedPaths, 2);
  assert.notEqual(worker.beforeSourceHash, worker.afterSourceHash);
  assert.match(worker.after[0].text, /SQLITE-UPDATED-53/u);

  let received;
  const fixtureErrors = [];
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/compile', 'The source-policy fixture only implements completed compile jobs');
      const buffers = [];
      for await (const chunk of request) buffers.push(chunk);
      received = JSON.parse(Buffer.concat(buffers).toString('utf8'));
      assert.equal(typeof received.jobId, 'string');
      assert.equal(typeof received.jobToken, 'string');
      const { options } = await evidenceProvider();
      const identity = plugin.identity({ options });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ format: 'dkb.llamaindex.compile.v2', compiler: {
        id: 'llamaindex.docling.evidence', model: received.model, modelRevision: received.modelRevision,
        evidenceOptions: received.evidenceOptions,
        modelAssetsDigest: identity.external.find((entry) => entry.name === 'docling-assets').digest,
      }, records: worker.after, job: {
        format: 'dkb.evidence.worker-job.v1', jobId: received.jobId,
        jobTokenHash: `sha256:${createHash('sha256').update(received.jobToken).digest('hex')}`,
        status: 'completed', safeToCleanup: true, terminated: true,
      } }));
    } catch (error) { fixtureErrors.push(error); response.statusCode = 500; response.end('{}'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const environment = { DKB_LLAMA_COMPILER_SERVICE_URL: `http://127.0.0.1:${server.address().port}`,
    DKB_LLAMA_COMPILER_SERVICE_ROOT: path.join(root, 'service'), DKB_LLAMA_COMPILER_SERVICE: '1', DKB_LLAMA_RECORD_CACHE: '0' };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const { options, provider } = await evidenceProvider();
  const dkb = { root: sourceRoot, manifest: { id: '@proof/database-snapshot', version: '1.0.0',
    stores: [{ id: 'snapshot', type: 'sqlite', path: 'facts.sqlite' }] } };
  const compiled = await provider.compile({ dkb, options });
  assert.equal(Object.hasOwn(received.request, 'externalSources'), false);
  assert.deepEqual(received.request.stores, [{ id: 'snapshot', type: 'sqlite', path: 'facts.sqlite' }]);
  const records = validatePipelineRecords(compiled.records, plugin.id);
  assert.equal(records.length, 1);
  assert.equal(records[0].provenance.sourceType, 'sqlite');
  assert.equal(records[0].provenance.sourceHash, worker.afterSourceHash);
  assert.deepEqual(records[0].provenance.locator, { type: 'row', table: 'facts', primaryKey: '1' });
  assert.deepEqual(records[0].provenance.assetLocator, { type: 'row', table: 'facts', primaryKey: '1', path: 'facts.sqlite' });
  assert.match(records[0].text, /SQLITE-UPDATED-53/u);
  assert.doesNotThrow(() => validatePipelineRecords(records.map((record) => ({ ...record,
    provenance: { ...record.provenance, sourceType: 'database' } })), '@fixture/trusted-database-provider'));
  assert.deepEqual(await fs.readdir(path.join(root, 'service/jobs')), []);
  assert.deepEqual(fixtureErrors, []);
});

async function evidenceProvider() {
  const result = await plugin.optionsSchema['~standard'].validate({});
  assert.ok(result.value, JSON.stringify(result.issues));
  let provider;
  plugin.setup({ options: result.value, registerProvider: (value) => { provider = value; } });
  return { options: result.value, provider };
}

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-evidence-source-policy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
