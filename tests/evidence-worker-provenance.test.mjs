import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { EVIDENCE_DOCLING_LLAMAINDEX_PLUGIN as plugin } from '@sjshovan/dkb-evidence-docling-llamaindex/plugin.js';
import { validatePipelineRecords } from '@sjshovan/dkb-pipeline/validation.js';
import { evidenceSourceRecordFromPipelineRecord } from '@sjshovan/dkb-compiler/records.js';
import { buildEvidenceIr } from '@sjshovan/dkb-protocol/evidence/ir.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';

const execFile = promisify(execFileCallback);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('real Python adapters and public Evidence plugin retain source identity across parsing recipes', async (t) => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  try { await execFile(python, ['--version']); } catch (error) {
    if (error.code === 'ENOENT') return t.skip('Python is required for worker record adapter checks');
    throw error;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-evidence-provenance-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source');
  await fs.mkdir(sourceRoot);
  const source = '<html><body><table><tr><th>Marker</th></tr><tr><td>WHALE-BUBBLE-73</td></tr></table></body></html>';
  await fs.writeFile(path.join(sourceRoot, 'facts.html'), source);
  const result = await execFile(python, ['-B', path.join(repository, 'tests/evidence-worker-provenance-fixture.py'),
    path.join(repository, 'providers/evidence-docling-llamaindex/python'), sourceRoot], { timeout: 30_000 });
  const worker = JSON.parse(result.stdout);
  assert.equal(worker.sourceHash, `sha256:${createHash('sha256').update(source).digest('hex')}`);

  const dkb = { root: sourceRoot, manifest: { id: '@proof/source-anchors', version: '1.0.0',
    stores: [{ id: 'files', type: 'filesystem', path: '.', meta: { includePaths: ['facts.html'] } }] } };
  let selectedRecords = worker.rich;
  let requests = 0;
  const fixtureErrors = [];
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/compile', 'The provenance fixture only implements completed compile jobs');
      const buffers = [];
      for await (const chunk of request) buffers.push(chunk);
      const input = JSON.parse(Buffer.concat(buffers).toString('utf8'));
      assert.equal(typeof input.jobId, 'string');
      assert.equal(typeof input.jobToken, 'string');
      const options = await resolveOptions(input.evidenceOptions);
      const identity = plugin.identity({ options });
      requests++;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ format: 'dkb.llamaindex.compile.v2', compiler: {
        id: 'llamaindex.docling.evidence', model: input.model, modelRevision: input.modelRevision,
        evidenceOptions: input.evidenceOptions,
        modelAssetsDigest: identity.external.find((entry) => entry.name === 'docling-assets').digest,
      }, records: selectedRecords, job: {
        format: 'dkb.evidence.worker-job.v1', jobId: input.jobId,
        jobTokenHash: `sha256:${createHash('sha256').update(input.jobToken).digest('hex')}`,
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

  const evidence = [];
  for (const variant of ['rich', 'plain', 'fallback']) {
    selectedRecords = worker[variant];
    const options = await resolveOptions({ richFiles: variant !== 'plain', richFileFallback: variant === 'fallback' });
    let provider;
    plugin.setup({ options, registerProvider: (value) => { provider = value; } });
    const compiled = await provider.compile({ dkb, options });
    const records = validatePipelineRecords(compiled.records, plugin.id);
    const ir = buildEvidenceIr([{ records: records.map((record) => evidenceSourceRecordFromPipelineRecord(dkb, record)) }],
      { evidenceProfileDigest: stableHash({ variant }) });
    assert.ok(ir.evidence.length > 1);
    for (const record of ir.evidence) {
      assert.equal(record.sourceHash, worker.sourceHash);
      assert.notEqual(record.sourceHash, record.textHash);
      assert.deepEqual(record.assetLocator, { path: 'facts.html' });
    }
    evidence.push(ir);
  }
  assert.equal(new Set(evidence.flatMap((ir) => ir.evidence.map((record) => record.sourceId))).size, 1);
  assert.equal(new Set(evidence.flatMap((ir) => ir.evidence.map((record) => record.assetId))).size, 1);
  assert.equal(new Set(evidence.map((ir) => ir.evidenceDigest)).size, 3);
  assert.ok(evidence[0].evidence.every((record) => record.locator.tableRefs.length === 1));
  assert.ok(evidence[1].evidence.every((record) => record.locator.tableRefs === undefined));
  assert.equal(requests, 3);

  await t.test('old worker records without original source hashes are rejected rather than using text hashes', async () => {
    selectedRecords = worker.rich.map(({ sourceHash: _sourceHash, ...record }) => record);
    const options = await resolveOptions({ richFiles: true, richFileFallback: false });
    let provider;
    plugin.setup({ options, registerProvider: (value) => { provider = value; } });
    await assert.rejects(provider.compile({ dkb, options }), /original source SHA-256 hash/);
  });
  await t.test('only current cache records bound to the original source hash are reused', async () => {
    process.env.DKB_LLAMA_RECORD_CACHE = '1';
    selectedRecords = worker.plain;
    const options = await resolveOptions({ richFiles: false, imageDigest: `sha256:${'a'.repeat(64)}` });
    let provider;
    plugin.setup({ options, registerProvider: (value) => { provider = value; } });
    const compile = () => provider.compile({ dkb, options });
    await compile();
    const beforeReuse = requests;
    const cached = await compile();
    assert.equal(requests, beforeReuse, 'unchanged original source reuses its complete cached records');
    assert.ok(cached.records.every((record) => record.provenance.sourceHash === worker.sourceHash));
    const cacheFile = path.join(sourceRoot, '.dkb/cache/llamaindex-record-cache.json');
    const cache = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    assert.equal(cache.version, 2);
    await fs.writeFile(cacheFile, JSON.stringify({ ...cache, version: 1 }));
    await compile();
    assert.equal(requests, beforeReuse + 1, 'old derived cache cannot bypass the required provenance contract');
    const corrupt = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    Object.values(corrupt.entries)[0].records[0].sourceHash = `sha256:${'b'.repeat(64)}`;
    await fs.writeFile(cacheFile, JSON.stringify(corrupt));
    await compile();
    assert.equal(requests, beforeReuse + 2, 'record/source mismatches cause recompilation, not provenance reuse');
  });
  assert.deepEqual(await fs.readdir(path.join(root, 'service/jobs')), []);
  assert.deepEqual(fixtureErrors, []);
});

async function resolveOptions(input) {
  const result = await plugin.optionsSchema['~standard'].validate(input);
  assert.ok(result.value, JSON.stringify(result.issues));
  return result.value;
}
