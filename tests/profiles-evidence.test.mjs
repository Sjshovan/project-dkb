import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertMatchingRetrievalProfiles,
  resolveRetrievalProfile,
  retrievalProfileLockForCompilerResults,
  validateRetrievalProfileLock,
} from '../dist/src/profiles/retrievalProfile.js';
import { buildEvidenceIr, validateEvidenceIr } from '../dist/src/evidence/ir.js';
import { compileComposeProject, verifyComposeProject } from '../dist/src/compiler/compile.js';
import {
  readLlamaIndexCompilerBundleManifest,
  writeLlamaIndexCompilerBundle,
} from '../dist/src/compiler/llamaindexArtifacts.js';
import { analyzeSourceUnits } from '../dist/src/compiler/sourceAnalysis.js';

const image = 'dkb-compiler-llamaindex:0.3.6';

function compilerResult(model, dimensions) {
  return {
    compiler: {
      id: 'llamaindex.fastembed.onnx',
      model,
      image,
    },
    records: [{
      id: 'chunk-1',
      assetId: 'asset-1',
      storeId: 'files',
      type: 'filesystem',
      locator: { path: 'facts.md', line: 1 },
      assetLocator: { path: 'facts.md' },
      title: 'Facts',
      text: 'The durable marker is SAFE-SOURCE-91.',
      hash: 'sha256:text',
      updatedAt: '2026-08-25T00:00:00.000Z',
      chunkOrdinal: 0,
      chunkStart: 0,
      chunkEnd: 37,
      metadata: {
        dkb_package_id: 'proof-safe',
        dkb_package_version: '1.0.0',
        dkb_source_hash: 'sha256:source',
        dkb_path: 'facts.md',
        internal_transient_value: 'must-not-cross-evidence-boundary',
      },
      embedding: Array(dimensions).fill(0.125),
    }],
  };
}

test('built-in FastEmbed profiles resolve to 384 and 768 dimensions', () => {
  assert.equal(resolveRetrievalProfile(undefined, 'BAAI/bge-small-en-v1.5').embedding.dimensions, 384);
  assert.equal(resolveRetrievalProfile(undefined, 'BAAI/bge-base-en-v1.5').embedding.dimensions, 768);
  assert.equal(resolveRetrievalProfile({
    compiler: 'llamaindex',
    embedding: { adapter: 'fastembed', model: 'BAAI/bge-small-en-v1.5', dimensions: 384 },
  }, 'BAAI/bge-base-en-v1.5').embedding.dimensions, 768);
  assert.throws(
    () => resolveRetrievalProfile(undefined, 'unregistered/model'),
    /not registered/,
  );
});

test('profile locks reject model, dimension, and digest mismatches', () => {
  const small = resolveRetrievalProfile(undefined, 'BAAI/bge-small-en-v1.5');
  const smallLock = retrievalProfileLockForCompilerResults(small, [compilerResult(small.embedding.model, 384)], {
    generatedAt: '2026-08-25T00:00:00.000Z',
  });
  const base = resolveRetrievalProfile(undefined, 'BAAI/bge-base-en-v1.5');
  const baseLock = retrievalProfileLockForCompilerResults(base, [compilerResult(base.embedding.model, 768)], {
    generatedAt: '2026-08-25T00:00:00.000Z',
  });

  assert.throws(() => assertMatchingRetrievalProfiles(smallLock, baseLock, 'proof-safe'), /profile mismatch/i);
  assert.throws(
    () => retrievalProfileLockForCompilerResults(small, [compilerResult(small.embedding.model, 768)]),
    /dimension mismatch/i,
  );
  assert.throws(
    () => validateRetrievalProfileLock({ ...smallLock, profileDigest: 'sha256:tampered' }),
    /expected digest/i,
  );
});

test('Evidence IR stays embedding-free and preserves identity across profiles', () => {
  const small = resolveRetrievalProfile(undefined, 'BAAI/bge-small-en-v1.5');
  const smallResult = compilerResult(small.embedding.model, 384);
  const smallLock = retrievalProfileLockForCompilerResults(small, [smallResult]);
  const base = resolveRetrievalProfile(undefined, 'BAAI/bge-base-en-v1.5');
  const baseResult = compilerResult(base.embedding.model, 768);
  const baseLock = retrievalProfileLockForCompilerResults(base, [baseResult]);
  const smallIr = buildEvidenceIr([smallResult], smallLock);
  const baseIr = buildEvidenceIr([baseResult], baseLock);

  assert.equal(smallIr.evidence[0].evidenceId, baseIr.evidence[0].evidenceId);
  assert.notEqual(smallIr.profileDigest, baseIr.profileDigest);
  assert.equal('embedding' in smallIr.evidence[0], false);
  assert.deepEqual(smallIr.evidence[0].provenance, {
    dkb_package_id: 'proof-safe',
    dkb_package_version: '1.0.0',
    dkb_path: 'facts.md',
    dkb_source_hash: 'sha256:source',
  });

  const broken = structuredClone(smallIr);
  broken.chunks[0].evidenceId = 'sha256:missing';
  assert.throws(() => validateEvidenceIr(broken), /missing evidence/i);
});

test('generated retrieval profile locks do not invalidate package source hashes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-profile-source-hash-'));
  t.after(() => fs.rm(root, { force: true, recursive: true }));

  await fs.writeFile(path.join(root, 'dkb.json'), `${JSON.stringify({
    manifestVersion: 1,
    type: 'package',
    name: 'Profile hash proof',
    package: 'profile-hash-proof',
    version: '1.0.0',
    permissions: { read: true, write: false },
  }, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(root, 'knowledge.md'), '# Proof\n\nStable source text.\n', 'utf8');

  await compileComposeProject(root, { compiler: 'native', force: true });
  await fs.writeFile(path.join(root, 'dkb-profile.lock.json'), '{"generated":"derived"}\n', 'utf8');

  const verification = await verifyComposeProject(root);
  assert.equal(verification.ok, true, JSON.stringify(verification.checks));
});

test('compiler bundles serialize compact Float32 embeddings as portable JSON arrays', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-float32-bundle-'));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const result = compilerResult('BAAI/bge-small-en-v1.5', 384);
  result.records[0].embedding = Float32Array.from(result.records[0].embedding);

  await writeLlamaIndexCompilerBundle(root, result, { writeAggregate: false });

  const manifest = await readLlamaIndexCompilerBundleManifest(root);
  const shard = JSON.parse(await fs.readFile(path.join(root, manifest.sources[0].recordsPath), 'utf8'));
  assert.equal(Array.isArray(shard.records[0].embedding), true);
  assert.equal(shard.records[0].embedding.length, 384);
});

test('large package source analysis skips unbounded all-pairs lexical graphs', () => {
  const units = Array.from({ length: 5_001 }, (_, index) => ({
    id: `chunk-${index.toString().padStart(5, '0')}`,
    assetId: `asset-${index.toString().padStart(5, '0')}`,
    dkbId: 'large-package',
    storeId: 'files',
    type: 'filesystem',
    locator: { path: `file-${index}.txt` },
    assetLocator: { path: `file-${index}.txt` },
    title: `Source ${index}`,
    text: 'Every record shares the same rarekeyword marker.',
    keywords: ['rarekeyword'],
    capabilities: { read: true, search: true },
    hash: `sha256:${index}`,
    updatedAt: '2026-08-25T00:00:00.000Z',
    chunkOrdinal: 0,
    chunkStart: 0,
    chunkEnd: 49,
  }));

  const analysis = analyzeSourceUnits(units);
  assert.equal(analysis.sourceUnits.length, 5_001);
  assert.equal(analysis.sourceEdges.length, 0);
});
