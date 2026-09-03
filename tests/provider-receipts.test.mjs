import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateProviderReceipt } from '@sjshovan/dkb-pipeline/validation.js';
import { compileComposeProject, compileRetrievalFromEvidence } from '@sjshovan/dkb-compiler/compile.js';
import { listPackageBuilds, validatePackageBuildGraph } from '@sjshovan/dkb-library/builds.js';
import { validateEvidenceBuildLock, validateRetrievalBuildLock } from '@sjshovan/dkb-protocol/builds.js';
import { assertProviderExecutionIdentities } from '@sjshovan/dkb-protocol/providerReceipts.js';

test('provider receipt validation rejects lossy, non-finite, executable, and cyclic nested values', () => {
  const cycle = {};
  cycle.self = cycle;
  let getterCalls = 0;
  const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { getterCalls += 1; return 'unstable'; } });
  const hidden = Object.defineProperty({}, 'hidden', { value: 'discarded', enumerable: false });
  const cases = [() => {}, undefined, NaN, Infinity, -Infinity, 2n, new Date(), new Map(), new Set(), cycle, getter, hidden, Array(2), { [Symbol('hidden')]: true }];
  for (const malformed of cases) {
    for (const field of ['build', 'compatibility', 'diagnostics']) {
      assert.throws(() => validateProviderReceipt({ build: {}, [field]: { nested: [malformed] } }, '@test/receipt'),
        (error) => error.code === 'invalid_provider_receipt', `${field} ${String(malformed)}`);
    }
  }
  assert.equal(getterCalls, 0);
  assert.throws(() => validateProviderReceipt({ build: {}, providerId: '@fake/provider' }, '@test/receipt'), /DKB supplies provider identity/u);
  assert.throws(() => validateProviderReceipt({ build: [] }, '@test/receipt'), /build object/u);
});

test('provider receipts are detached and deeply frozen after validation', () => {
  const value = { build: { nested: [{ value: 1 }, null, true, 'text'] }, diagnostics: { elapsedMs: 5 } };
  const receipt = validateProviderReceipt(value, '@test/receipt');
  value.build.nested[0].value = 9;
  assert.equal(receipt.build.nested[0].value, 1);
  assert.equal(Object.isFrozen(receipt.build.nested[0]), true);
  assert.throws(() => { receipt.build.nested[0].value = 3; }, TypeError);
});

test('Evidence and index semantic receipts persist with DKB-owned identities while diagnostics stay outside build identity', async (t) => {
  const root = await receiptFixture(t);
  const first = await compileComposeProject(root, { force: true });
  const graph = await validatePackageBuildGraph(root);
  assert.equal(graph.evidence.format, 'dkb.evidence-build.v2');
  assert.equal(graph.retrieval.format, 'dkb.retrieval-build.v2');
  assert.throws(() => validateEvidenceBuildLock({ ...graph.evidence, format: 'dkb.evidence-build.v1' }), /expected dkb.evidence-build.v2/u);
  assert.throws(() => validateRetrievalBuildLock({ ...graph.retrieval, format: 'dkb.retrieval-build.v1' }), /expected dkb.retrieval-build.v2/u);
  assert.throws(() => validateEvidenceBuildLock({ ...graph.evidence, providerReceipts: undefined }), /providerReceipts/u);
  assert.deepEqual(graph.evidence.providerReceipts.map((receipt) => receipt.kind), ['evidence']);
  assert.deepEqual(graph.retrieval.providerReceipts.map((receipt) => receipt.kind), ['index', 'retrieval']);
  const evidenceReceipt = graph.evidence.providerReceipts[0];
  const indexReceipt = graph.retrieval.providerReceipts[0];
  assert.deepEqual(evidenceReceipt.build, { format: 'test.evidence.v1', recordCount: 1 });
  assert.deepEqual(indexReceipt.build, { format: 'test.index.v1', records: { count: 1, channel: 'lexical' } });
  assert.equal(indexReceipt.providerId, '@test/receipt');
  assert.equal(indexReceipt.providerVersion, '1.0.0');
  assert.equal(indexReceipt.providerIntegrityDigest, graph.profile.profile.retrieval.providers[0].integrityDigest);
  const forgedIdentities = structuredClone(graph.retrieval.providerReceipts);
  forgedIdentities[0].providerId = '@fake/receipt';
  assert.throws(() => assertProviderExecutionIdentities(forgedIdentities, graph.profile, 'retrieval'), /exact resolved provider chain/u);
  assert.equal('diagnostics' in evidenceReceipt, false);
  assert.equal('diagnostics' in indexReceipt, false);
  assert.equal(first.lock.compiled.providerDiagnostics.length, 2);
  assert.ok(first.lock.compiled.providerDiagnostics.every((entry) => Number.isFinite(entry.diagnostics.elapsedMs)));

  const evidence = JSON.parse(await fs.readFile(path.join(graph.evidencePath, 'evidence.ir.json'), 'utf8'));
  const second = await compileRetrievalFromEvidence(root, evidence, { target: 'default' });
  assert.equal(second.retrievalBuildPath, first.retrievalBuildPath);
  const repeated = await compileComposeProject(root, { force: true });
  assert.equal(repeated.retrievalBuildPath, first.retrievalBuildPath);

  const changed = structuredClone(graph.retrieval);
  changed.providerReceipts[0].build.records.count = 2;
  assert.throws(() => validateRetrievalBuildLock(changed), /Retrieval Build digest/u);
  const evidenceLockPath = path.join(graph.evidencePath, 'evidence.lock.json');
  const changedEvidence = structuredClone(graph.evidence);
  changedEvidence.providerReceipts[0].build.recordCount = 2;
  await fs.writeFile(evidenceLockPath, JSON.stringify(changedEvidence));
  await assert.rejects(() => validatePackageBuildGraph(root), /Evidence receipt mismatch/u);
  await fs.writeFile(evidenceLockPath, JSON.stringify(graph.evidence));
});

test('compiler rejects malformed Evidence and index receipts before immutable promotion', async (t) => {
  for (const stage of ['evidence', 'index']) {
    const root = await receiptFixture(t, stage);
    await assert.rejects(() => compileComposeProject(root, { force: true }),
      (error) => error.code === 'invalid_provider_receipt' && /non-finite/u.test(error.message));
    const builds = await listPackageBuilds(root);
    assert.deepEqual(builds.evidence, []);
    assert.deepEqual(builds.retrieval, []);
  }
});

test('a source or semantic receipt collision leaves previous immutable builds intact', async (t) => {
  const root = await receiptFixture(t);
  await compileComposeProject(root, { force: true });
  const before = await validatePackageBuildGraph(root);
  const buildsBefore = await listPackageBuilds(root);
  const lockBefore = await fs.readFile(path.join(before.evidencePath, 'evidence.lock.json'), 'utf8');
  // This file changes source identity without changing this fixture provider's Evidence output.
  await fs.writeFile(path.join(root, 'extra-source.md'), 'A different source release must not reuse a mismatched receipt.');
  await assert.rejects(() => compileComposeProject(root, { force: true }), /build receipt collision/u);
  assert.deepEqual(await listPackageBuilds(root), buildsBefore);
  assert.equal(await fs.readFile(path.join(before.evidencePath, 'evidence.lock.json'), 'utf8'), lockBefore);
  assert.equal((await validatePackageBuildGraph(root)).retrieval.retrievalBuildDigest, before.retrieval.retrievalBuildDigest);
});

test('index providers cannot rewrite another provider execution receipt through compiler input', async (t) => {
  const root = await receiptFixture(t, 'mutate-prior-receipt');
  await compileComposeProject(root, { force: true });
  const graph = await validatePackageBuildGraph(root);
  assert.deepEqual(graph.evidence.providerReceipts[0].build, { format: 'test.evidence.v1', recordCount: 1 });
});

async function receiptFixture(t, malformedStage) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-provider-receipts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'dkb.json'), JSON.stringify({ manifestVersion: 1, type: 'dkb', name: '@test/receipt-package', version: '1.0.0', permissions: { read: true, write: false } }));
  await fs.writeFile(path.join(root, 'proof.md'), 'RECEIPT-PROOF-51');
  await fs.mkdir(path.join(root, '.dkb/plugins/@test/receipt'), { recursive: true });
  await fs.writeFile(path.join(root, '.dkb/config.json'), JSON.stringify({ format: 'dkb.config.v2', targets: { default: {
    evidence: '@test/receipt', embedding: null, index: '@test/receipt', retrieval: '@test/receipt',
    options: { '@test/receipt': malformedStage ? { malformedStage } : {} },
  } } }));
  await fs.writeFile(path.join(root, '.dkb/plugins/@test/receipt/plugin.mjs'), `
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
export const apiVersion = 3;
export const id = '@test/receipt';
export const version = '1.0.0';
export const optionsSchema = { '~standard': { version: 1, vendor: 'test', validate(value) { return { value: value ?? {} }; } } };
export function setup(context) {
  context.registerProvider({ kind: 'evidence', async compile({ dkb, options }) {
    const text = await fs.readFile(path.join(dkb.root, 'proof.md'), 'utf8');
    return { records: [{ id: 'proof', chunkId: 'proof', text, provenance: {
      assetId: 'proof', storeId: 'filesystem', sourceType: 'filesystem', locator: { path: 'proof.md' }, assetLocator: { path: 'proof.md' },
      title: 'Proof', sourceHash: 'sha256:' + createHash('sha256').update(text).digest('hex'), updatedAt: '2026-09-02T00:00:00.000Z', chunkOrdinal: 0, chunkStart: 0, chunkEnd: text.length,
    }, metadata: {} }], receipt: {
      build: options.malformedStage === 'evidence' ? { nested: [NaN] } : { format: 'test.evidence.v1', recordCount: 1 },
      diagnostics: { elapsedMs: performance.now() },
    } };
  } });
  context.registerProvider({ kind: 'index', mode: 'packaged', format: 'test.index.v1', capabilities: { vectors: 'none' },
    async compilePackage({ artifactsRoot, compiled, options }) {
      if (options.malformedStage === 'mutate-prior-receipt') compiled.receipts[0].build = { spoofedByIndex: true };
      await fs.mkdir(artifactsRoot, { recursive: true });
      await fs.writeFile(path.join(artifactsRoot, 'index.json'), JSON.stringify(compiled.records.map(({ id, text }) => ({ id, text }))));
      return { build: options.malformedStage === 'index' ? { nested: [Infinity] } : { format: 'test.index.v1', records: { count: compiled.records.length, channel: 'lexical' } }, diagnostics: { elapsedMs: performance.now() } };
    },
    async validatePackage() { return { documentCount: 1 }; },
    async verifyRuntime() { return { indexId: 'proof', documentCount: 1, status: 'ready' }; },
    async openRuntime() { return null; },
  });
  context.registerProvider({ kind: 'retrieval', protocol: 'dkb.evidence.v1', capabilities: { vectors: 'none' },
    openRuntime() { return { providerId: id, protocol: 'dkb.evidence.v1', async search() { return { hits: [], trace: {} }; }, close() {} }; },
  });
}
`);
  return root;
}
