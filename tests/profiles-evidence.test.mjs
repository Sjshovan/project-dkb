import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertMatchingRetrievalProfiles,
  retrievalProfileLockForCompilerResults,
  validateRetrievalProfileLock,
} from '@dkb/pipeline/profile.js';
import { buildEvidenceIr, validateEvidenceIr } from '@dkb/protocol/evidence/ir.js';
import { stableHash } from '@dkb/protocol/contracts/hash.js';
import {
  evidenceBuildLock,
  retrievalBuildLock,
  validateRetrievalBuildLock,
} from '@dkb/protocol/builds.js';
import { compileComposeProject, verifyComposeProject } from '@dkb/compiler/compile.js';
import {
  readLlamaIndexCompilerBundleManifest,
  writeLlamaIndexCompilerBundle,
} from '@dkb/providers-bundled/llamaindexArtifacts.js';
import { analyzeSourceUnits } from '@dkb/compiler/sourceAnalysis.js';
import {
  activateStoredPackageBuild,
  listPackageBuilds,
  mergeStoredPackageBuilds,
  validatePackageBuildGraph,
  writePackageBuildGraph,
} from '@dkb/library/builds.js';

const image = 'dkb-compiler-llamaindex:0.3.7';

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

test('profile locks reject model, dimension, and digest mismatches', () => {
  const small = resolvedProfile('BAAI/bge-small-en-v1.5', 384);
  const smallLock = retrievalProfileLockForCompilerResults(small, [compilerResult(small.embedding.model, 384)], {
    generatedAt: '2026-08-25T00:00:00.000Z',
  });
  const base = resolvedProfile('BAAI/bge-base-en-v1.5', 768);
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
    /expected profile digest/i,
  );
});

test('Evidence IR is reusable across retrieval profiles and changes only with its Evidence Profile', () => {
  const small = resolvedProfile('BAAI/bge-small-en-v1.5', 384);
  const smallResult = compilerResult(small.embedding.model, 384);
  const base = resolvedProfile('BAAI/bge-base-en-v1.5', 768);
  const baseResult = compilerResult(base.embedding.model, 768);
  const evidenceProfileDigest = stableHash({ parser: 'docling', chunker: 'hybrid-v1' });
  const alternateEvidenceProfileDigest = stableHash({ parser: 'docling', chunker: 'hybrid-v2' });
  const smallIr = buildEvidenceIr([smallResult], { evidenceProfileDigest });
  const baseIr = buildEvidenceIr([baseResult], { evidenceProfileDigest });
  const alternateIr = buildEvidenceIr([smallResult], { evidenceProfileDigest: alternateEvidenceProfileDigest });

  assert.equal(smallIr.evidence[0].evidenceId, baseIr.evidence[0].evidenceId);
  assert.equal(smallIr.evidenceDigest, baseIr.evidenceDigest);
  assert.equal(smallIr.evidence[0].sourceId, alternateIr.evidence[0].sourceId);
  assert.notEqual(smallIr.evidence[0].evidenceId, alternateIr.evidence[0].evidenceId);
  assert.notEqual(smallIr.evidenceDigest, alternateIr.evidenceDigest);
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

test('build locks bind retrieval artifacts to one exact Evidence Build', () => {
  const packageIdentity = { id: '@test/proof-safe', version: '1.0.0' };
  const sourceDigest = stableHash({ source: 'proof' });
  const evidenceProfileDigest = stableHash({ ingestion: 'proof' });
  const evidenceDigest = stableHash({ evidence: 'proof' });
  const evidence = evidenceBuildLock({
    package: { ...packageIdentity, sourceDigest },
    evidenceProfileDigest,
    evidenceDigest,
    recordCount: 1,
    chunkCount: 1,
    generatedAt: '2026-08-27T00:00:00.000Z',
  });
  const retrieval = retrievalBuildLock({
    package: packageIdentity,
    evidenceProfileDigest: evidence.evidenceProfileDigest,
    evidenceDigest: evidence.evidenceDigest,
    retrievalProfileDigest: stableHash({ retrieval: 'tei-faiss' }),
    compatibilityDigest: stableHash({ compatibility: 'tei-faiss' }),
    artifactTreeDigest: stableHash({ artifacts: ['index.faiss'] }),
    generatedAt: '2026-08-27T00:00:00.000Z',
  });

  assert.throws(
    () => validateRetrievalBuildLock({ ...retrieval, evidenceDigest: stableHash({ evidence: 'other' }) }),
    /expected Retrieval Build digest/i,
  );
});

test('stored Retrieval Builds switch atomically without recompiling and keep Evidence IR in its own layer', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-multi-build-switch-'));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const artifacts = path.join(root, '.dkb', 'artifacts');
  await fs.mkdir(artifacts, { recursive: true });

  const packageIdentity = {
    id: '@test/multi-build',
    version: '1.0.0',
    sourceDigest: stableHash({ source: 'multi-build' }),
  };
  const small = resolvedProfile('BAAI/bge-small-en-v1.5', 384);
  const base = resolvedProfile('BAAI/bge-base-en-v1.5', 768);
  const evidence = buildEvidenceIr([compilerResult(small.embedding.model, 384)], {
    evidenceProfileDigest: small.evidenceProfileDigest,
  });
  const smallLock = retrievalProfileLockForCompilerResults(small, [compilerResult(small.embedding.model, 384)]);
  const baseLock = retrievalProfileLockForCompilerResults(base, [compilerResult(base.embedding.model, 768)]);

  await fs.writeFile(path.join(artifacts, 'evidence.ir.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(artifacts, 'selected.index'), 'small\n', 'utf8');
  const smallGraph = await writePackageBuildGraph({
    root,
    package: packageIdentity,
    evidence,
    retrievalProfile: smallLock,
    target: 'fastembed-small',
  });

  await fs.writeFile(path.join(artifacts, 'selected.index'), 'base\n', 'utf8');
  const baseGraph = await writePackageBuildGraph({
    root,
    package: packageIdentity,
    evidence,
    retrievalProfile: baseLock,
    target: 'fastembed-base',
  });
  const builds = await listPackageBuilds(root);
  assert.equal(builds.evidence.length, 1);
  assert.equal(builds.retrieval.length, 2);
  await assert.rejects(
    fs.access(path.join(smallGraph.retrievalPath, 'artifacts', 'evidence.ir.json')),
    /ENOENT/,
  );

  const activated = await activateStoredPackageBuild({
    root,
    target: 'fastembed-small',
    evidenceProfileDigest: small.evidenceProfileDigest,
    retrievalProfileDigest: smallLock.profileDigest,
    compatibilityDigest: smallLock.compatibilityDigest,
  });
  assert.equal(await fs.readFile(path.join(artifacts, 'selected.index'), 'utf8'), 'small\n');
  assert.equal(activated.runtime.packages[packageIdentity.id].retrievalBuildDigest, smallGraph.retrieval.retrievalBuildDigest);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(artifacts, 'evidence.ir.json'), 'utf8')),
    evidence,
  );

  await fs.appendFile(path.join(baseGraph.retrievalPath, 'artifacts', 'selected.index'), 'tampered\n');
  await assert.rejects(
    activateStoredPackageBuild({
      root,
      target: 'fastembed-base',
      evidenceProfileDigest: base.evidenceProfileDigest,
      retrievalProfileDigest: baseLock.profileDigest,
      compatibilityDigest: baseLock.compatibilityDigest,
    }),
    /artifact tree is corrupt/i,
  );
  assert.equal(await fs.readFile(path.join(artifacts, 'selected.index'), 'utf8'), 'small\n');
  assert.equal((await validatePackageBuildGraph(root)).runtime.target, 'fastembed-small');
});

test('downloaded package layers retain existing compatible builds and reject digest-path collisions', async (t) => {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-build-merge-source-'));
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-build-merge-destination-'));
  t.after(() => Promise.all([
    fs.rm(source, { force: true, recursive: true }),
    fs.rm(destination, { force: true, recursive: true }),
  ]));
  const generatedAt = '2026-08-28T00:00:00.000Z';
  const packageIdentity = {
    id: '@test/merge-builds',
    version: '1.0.0',
    sourceDigest: stableHash({ source: 'merge-builds' }),
  };
  const small = resolvedProfile('BAAI/bge-small-en-v1.5', 384);
  const base = resolvedProfile('BAAI/bge-base-en-v1.5', 768);
  const evidence = buildEvidenceIr([compilerResult(small.embedding.model, 384)], {
    evidenceProfileDigest: small.evidenceProfileDigest,
  });
  const smallLock = retrievalProfileLockForCompilerResults(small, [compilerResult(small.embedding.model, 384)], { generatedAt });
  const baseLock = retrievalProfileLockForCompilerResults(base, [compilerResult(base.embedding.model, 768)], { generatedAt });

  for (const root of [source, destination]) {
    const artifacts = path.join(root, '.dkb', 'artifacts');
    await fs.mkdir(artifacts, { recursive: true });
    await fs.writeFile(path.join(artifacts, 'evidence.ir.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    await fs.writeFile(path.join(artifacts, 'selected.index'), 'small\n', 'utf8');
    await writePackageBuildGraph({
      root,
      package: packageIdentity,
      evidence,
      retrievalProfile: smallLock,
      target: 'fastembed-small',
      generatedAt,
    });
  }

  const sourceArtifacts = path.join(source, '.dkb', 'artifacts');
  await fs.writeFile(path.join(sourceArtifacts, 'selected.index'), 'base\n', 'utf8');
  const baseGraph = await writePackageBuildGraph({
    root: source,
    package: packageIdentity,
    evidence,
    retrievalProfile: baseLock,
    target: 'fastembed-base',
    generatedAt,
  });

  const merged = await mergeStoredPackageBuilds(source, destination);
  assert.equal(merged.copied.length, 1);
  assert.equal(merged.reused.length, 2);
  const builds = await listPackageBuilds(destination);
  assert.equal(builds.evidence.length, 1);
  assert.equal(builds.retrieval.length, 2);

  const destinationBase = path.join(destination, path.relative(source, baseGraph.retrievalPath));
  await fs.appendFile(path.join(destinationBase, 'artifacts', 'selected.index'), 'collision\n', 'utf8');
  await assert.rejects(
    mergeStoredPackageBuilds(source, destination),
    /Stored Build collision/i,
  );
});

test('generated retrieval profile locks do not invalidate package source hashes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-profile-source-hash-'));
  t.after(() => fs.rm(root, { force: true, recursive: true }));

  await fs.writeFile(path.join(root, 'dkb.json'), `${JSON.stringify({
    manifestVersion: 1,
    type: 'dkb',
    name: '@test/profile-hash-proof',
    displayName: 'Profile hash proof',
    version: '1.0.0',
    permissions: { read: true, write: false },
  }, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(root, 'knowledge.md'), '# Proof\n\nStable source text.\n', 'utf8');
  await writeTestPipeline(root);

  await compileComposeProject(root, { mode: 'package', force: true });
  const graph = await validatePackageBuildGraph(root);
  assert.equal(graph.runtime.target, 'default');
  assert.equal(graph.runtime.packages['@test/profile-hash-proof'].evidenceDigest, graph.evidence.evidenceDigest);
  assert.equal(graph.runtime.packages['@test/profile-hash-proof'].retrievalBuildDigest, graph.retrieval.retrievalBuildDigest);

  const copiedManifest = path.join(graph.retrievalPath, 'artifacts', 'dkb-artifact.json');
  const originalCopiedManifest = await fs.readFile(copiedManifest);
  await fs.appendFile(copiedManifest, '\n');
  await assert.rejects(validatePackageBuildGraph(root), /artifact tree mismatch/i);
  await fs.writeFile(copiedManifest, originalCopiedManifest);
  await validatePackageBuildGraph(root);
  await fs.writeFile(path.join(root, 'dkb-profile.lock.json'), '{"generated":"derived"}\n', 'utf8');

  const verification = await verifyComposeProject(root);
  assert.equal(verification.ok, true, JSON.stringify(verification.checks));

  // Published packages may omit provider-specific compiler shards. Verification
  // must use the normalized portable index before raw provider/index records.
  await fs.rm(path.join(root, '.dkb', 'artifacts', 'llamaindex.compiler.manifest.json'), { force: true });
  await fs.rm(path.join(root, '.dkb', 'artifacts', 'llamaindex.compiler.json'), { force: true });
  await fs.rm(path.join(root, '.dkb', 'artifacts', 'llamaindex.records'), { force: true, recursive: true });

  const packagedVerification = await verifyComposeProject(root);
  assert.equal(packagedVerification.ok, true, JSON.stringify(packagedVerification.checks));
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

function resolvedProfile(model, dimensions) {
  const evidenceProfileDigest = stableHash({ ingestion: '@dkb/llamaindex', parser: 'docling', chunker: 'hybrid-v1' });
  const retrievalProfileDigest = stableHash({ evidenceProfileDigest, embedding: '@dkb/fastembed', model, dimensions, index: '@dkb/faiss' });
  return {
    target: 'test',
    evidenceProfileDigest,
    retrievalProfileDigest,
    configDigest: `config:${model}`,
    providerBuildDigest: `providers:${model}`,
    providers: [],
    processors: [],
    compiler: '@dkb/llamaindex',
    indexMode: 'packaged',
    embedding: {
      adapter: '@dkb/fastembed',
      model,
      dimensions,
    },
    compatibility: {
      evidenceProfileDigest,
      embeddingProvider: '@dkb/fastembed',
      embeddingSpace: model,
      dimensions,
      metric: 'cosine',
      normalized: true,
      indexFormat: 'IndexIDMap2(IndexFlatIP)',
      protocol: 'dkb.evidence.v1',
    },
  };
}

async function writeTestPipeline(root) {
  const pluginRoot = path.join(root, '.dkb', 'plugins', '@test', 'pipeline');
  await fs.mkdir(pluginRoot, { recursive: true });
  await fs.writeFile(path.join(root, '.dkb', 'config.json'), `${JSON.stringify({
    format: 'dkb.config.v1',
    targets: {
      default: {
        ingestion: '@test/pipeline',
        embedding: '@test/pipeline',
        index: '@test/pipeline',
        retrieval: '@test/pipeline',
      },
    },
  }, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(pluginRoot, 'plugin.mjs'), `
import fs from 'node:fs/promises';
import path from 'node:path';
export const id = '@test/pipeline';
export const version = '1.0.0';
export function setup(context) {
  context.registerProvider({
    kind: 'ingestion',
    async compile({ dkb }) {
      const text = await fs.readFile(path.join(dkb.root, 'knowledge.md'), 'utf8');
      return {
        records: [{
          id: 'test-record', chunkId: 'test-record', text,
          metadata: {
            assetId: 'knowledge.md', storeId: 'filesystem', type: 'filesystem',
            locator: { path: 'knowledge.md', chunk: 0 }, assetLocator: { path: 'knowledge.md' },
            title: 'knowledge.md', hash: 'sha256:test-record', updatedAt: '2026-08-27T00:00:00.000Z',
            chunkOrdinal: 0, chunkStart: 0, chunkEnd: text.length,
            sourceMetadata: { dkb_path: 'knowledge.md', dkb_source_hash: 'sha256:test-source' },
          },
        }],
        receipt: { providerId: id, providerVersion: version, build: {} },
      };
    },
  });
  context.registerProvider({
    kind: 'embedding',
    async embedDocuments({ texts }) { return texts.map(() => [1]); },
    async embedQuery() { return [1]; },
    compatibility() { return { embeddingSpace: 'test', dimensions: 1, metric: 'cosine', normalized: true }; },
  });
  context.registerProvider({
    kind: 'index', mode: 'packaged', format: 'test.index.v1',
    async compilePackage({ root, compiled }) {
      const target = path.join(root, '.dkb', 'artifacts', 'test-index.json');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify(compiled.records));
      return { providerId: id, providerVersion: version, build: { recordCount: compiled.records.length } };
    },
    async validatePackage() { return { documentCount: 1 }; },
    async openRuntime() { return null; },
  });
  context.registerProvider({ kind: 'retrieval', protocol: 'dkb.evidence.v1' });
}
`, 'utf8');
}
