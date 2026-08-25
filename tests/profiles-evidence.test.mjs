import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertMatchingRetrievalProfiles,
  resolveRetrievalProfile,
  retrievalProfileLockForCompilerResults,
  validateRetrievalProfileLock,
} from '../dist/src/profiles/retrievalProfile.js';
import { buildEvidenceIr, validateEvidenceIr } from '../dist/src/evidence/ir.js';

const image = 'dkb-compiler-llamaindex:0.3.0';

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
