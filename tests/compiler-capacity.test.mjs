import assert from 'node:assert/strict';
import test from 'node:test';
import {
  distribution,
  summarizeCompilerDeliveryStatistics,
  summarizeEvidenceCorpus,
} from '@dkb/compiler/buildStatistics.js';
import {
  estimateIngestionWorkingBytes,
  estimateRetrievalWorkingBytes,
  evaluateDiskCapacity,
} from '@dkb/compiler/diskCapacity.js';

test('corpus statistics measure chunk density and text volume instead of treating file count as scale', () => {
  const evidence = {
    format: 'dkb.evidence.ir.v3',
    evidenceProfileDigest: 'sha256:profile',
    evidenceDigest: 'sha256:evidence',
    evidence: [
      record('one', 'source-a', 'small.md', 'short'),
      record('two', 'source-b', 'dense.md', 'x'.repeat(2_000)),
      record('three', 'source-b', 'dense.md', 'y'.repeat(3_000)),
    ],
    chunks: [
      chunk('one', 0),
      chunk('two', 0),
      chunk('three', 1),
    ],
  };
  const summary = summarizeEvidenceCorpus(evidence, { files: 2, bytes: 8_000 });

  assert.equal(summary.sourceFiles, 2);
  assert.equal(summary.sourceBytes, 8_000);
  assert.equal(summary.sourceAssets, 2);
  assert.equal(summary.evidenceRecords, 3);
  assert.equal(summary.evidenceTextBytes, 5_005);
  assert.equal(summary.recordsPerSource.max, 2);
  assert.equal(summary.densestSources[0].source, 'dense.md');
  assert.equal(summary.densestSources[0].records, 2);
});

test('capacity estimates grow with source bytes, chunk count, and embedding dimensions', () => {
  const small = estimateRetrievalWorkingBytes({ sourceBytes: 1_000, evidenceTextBytes: 2_000, evidenceRecords: 10 }, 384);
  const dense = estimateRetrievalWorkingBytes({ sourceBytes: 1_000, evidenceTextBytes: 20_000_000, evidenceRecords: 20_000 }, 768);

  assert.ok(estimateIngestionWorkingBytes(100_000_000) > estimateIngestionWorkingBytes(1_000));
  assert.ok(dense > small);
  assert.deepEqual(distribution([1, 2, 3, 100]), {
    count: 4,
    min: 1,
    p50: 2,
    p95: 100,
    max: 100,
    mean: 26.5,
  });

  assert.deepEqual(evaluateDiskCapacity({
    path: 'C:\\proof',
    freeBytes: 1_000,
    reserveBytes: 100,
    estimatedWorkingBytes: 400,
  }), {
    path: 'C:\\proof',
    freeBytes: 1_000,
    reserveBytes: 100,
    estimatedWorkingBytes: 400,
    requiredFreeBytes: 500,
  });
});

test('Registry delivery statistics omit unbounded source and artifact rankings', () => {
  const result = summarizeCompilerDeliveryStatistics({
    corpus: {
      sourceFiles: 2,
      sourceBytes: 1024,
      sourceAssets: 2,
      evidenceRecords: 8,
      evidenceChunks: 8,
      evidenceCharacters: 2048,
      evidenceTextBytes: 2048,
      textBytesPerRecord: distribution([128, 256]),
      recordsPerSource: distribution([3, 5]),
      densestSources: [{ source: 'private/local/path.md', records: 5, textBytes: 1280 }],
    },
    storage: {
      artifactFiles: 4,
      artifactBytes: 4096,
      evidenceBuildBytes: 2048,
      retrievalBuildBytes: 8192,
      totalDerivedBytes: 14336,
      sourceToDerivedRatio: 14,
      largestArtifacts: [{ path: '.dkb/artifacts/large.file', bytes: 8192 }],
    },
    timingsMs: {
      collectState: 3,
      aggregateArtifacts: 4,
      total: 15,
    },
  });

  assert.equal(result.corpus.recordsPerSource.p95, 5);
  assert.equal(result.storage.totalDerivedBytes, 14336);
  assert.deepEqual(result.timingsMs, { collectState: 3, aggregateArtifacts: 4, total: 15 });
  assert.equal('densestSources' in result.corpus, false);
  assert.equal('textBytesPerRecord' in result.corpus, false);
  assert.equal('largestArtifacts' in result.storage, false);
  assert.doesNotMatch(JSON.stringify(result), /private|large\.file/u);
});

function record(id, assetId, sourcePath, text) {
  return {
    evidenceId: id,
    sourceId: `source-${id}`,
    packageId: '@test/corpus',
    packageVersion: '1.0.0',
    storeId: 'default',
    sourceType: 'filesystem',
    sourceHash: `hash-${assetId}`,
    assetId,
    assetLocator: { path: sourcePath },
    locator: { path: sourcePath },
    title: sourcePath,
    text,
    textHash: `hash-${id}`,
    provenance: {},
  };
}

function chunk(evidenceId, ordinal) {
  return {
    chunkId: `chunk-${evidenceId}`,
    evidenceId,
    evidenceProfileDigest: 'sha256:profile',
    ordinal,
    start: 0,
    end: 1,
  };
}
