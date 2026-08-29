import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertMatchingRetrievalProfiles,
  retrievalProfileLockForCompiledPipelines,
  validateRetrievalProfileLock,
} from '@sjshovan/dkb-pipeline/profile.js';
import { buildEvidenceIr, validateEvidenceIr } from '@sjshovan/dkb-protocol/evidence/ir.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import {
  evidenceBuildLock,
  retrievalBuildLock,
  validateRetrievalBuildLock,
} from '@sjshovan/dkb-protocol/builds.js';
import { compileComposeProject, verifyComposeProject } from '@sjshovan/dkb-compiler/compile.js';
import {
  activateStoredPackageBuild,
  listPackageBuilds,
  mergeStoredPackageBuilds,
  validatePackageBuildGraph,
  writePackageBuildGraph,
} from '@sjshovan/dkb-library/builds.js';

const image = 'dkb-evidence-docling-llamaindex:0.1.0';

function compilerResult(model, dimensions) {
  return {
    documents: [],
    chunks: [],
    receipts: [],
    records: [{
      id: 'chunk-1',
      chunkId: 'chunk-1',
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
  const smallLock = retrievalProfileLockForCompiledPipelines(small, [compilerResult(small.embedding.model, 384)], {
    generatedAt: '2026-08-25T00:00:00.000Z',
  });
  const base = resolvedProfile('BAAI/bge-base-en-v1.5', 768);
  const baseLock = retrievalProfileLockForCompiledPipelines(base, [compilerResult(base.embedding.model, 768)], {
    generatedAt: '2026-08-25T00:00:00.000Z',
  });

  assert.throws(() => assertMatchingRetrievalProfiles(smallLock, baseLock, 'proof-safe'), /profile mismatch/i);
  assert.throws(
    () => retrievalProfileLockForCompiledPipelines(small, [compilerResult(small.embedding.model, 768)]),
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
    dkb_updated_at: '2026-08-25T00:00:00.000Z',
  });

  const broken = structuredClone(smallIr);
  broken.chunks[0].evidenceId = 'sha256:missing';
  assert.throws(() => validateEvidenceIr(broken), /missing evidence/i);
});

test('build locks bind retrieval artifacts to one exact Evidence Build', () => {
  const packageIdentity = { id: '@test/proof-safe', version: '1.0.0' };
  const sourceDigest = stableHash({ source: 'proof' });
  const evidenceProfileDigest = stableHash({ evidence: 'proof' });
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
  const smallLock = retrievalProfileLockForCompiledPipelines(small, [compilerResult(small.embedding.model, 384)]);
  const baseLock = retrievalProfileLockForCompiledPipelines(base, [compilerResult(base.embedding.model, 768)]);

  await fs.writeFile(path.join(artifacts, 'evidence.ir.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(artifacts, 'selected.index'), 'small\n', 'utf8');
  const smallGraph = await writePackageBuildGraph({
    root,
    package: packageIdentity,
    evidence,
    retrievalProfile: smallLock,
    artifactsRoot: artifacts,
    target: 'fastembed-small',
  });

  await fs.writeFile(path.join(artifacts, 'selected.index'), 'base\n', 'utf8');
  const baseGraph = await writePackageBuildGraph({
    root,
    package: packageIdentity,
    evidence,
    retrievalProfile: baseLock,
    artifactsRoot: artifacts,
    target: 'fastembed-base',
  });
  const builds = await listPackageBuilds(root);
  assert.equal(builds.evidence.length, 1);
  assert.equal(builds.retrieval.length, 2);
  await assert.rejects(
    fs.access(path.join(smallGraph.retrievalPath, 'artifacts', 'evidence.ir.json')),
    /ENOENT/,
  );
  await fs.rm(artifacts, { recursive: true, force: true });

  const activated = await activateStoredPackageBuild({
    root,
    target: 'fastembed-small',
    evidenceProfileDigest: small.evidenceProfileDigest,
    retrievalProfileDigest: smallLock.profileDigest,
    compatibilityDigest: smallLock.compatibilityDigest,
  });
  await assert.rejects(fs.access(artifacts), /ENOENT/);
  assert.equal(activated.runtime.packages[packageIdentity.id].retrievalBuildDigest, smallGraph.retrieval.retrievalBuildDigest);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(smallGraph.evidencePath, 'evidence.ir.json'), 'utf8')),
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
  await assert.rejects(fs.access(artifacts), /ENOENT/);
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
  const smallLock = retrievalProfileLockForCompiledPipelines(small, [compilerResult(small.embedding.model, 384)], { generatedAt });
  const baseLock = retrievalProfileLockForCompiledPipelines(base, [compilerResult(base.embedding.model, 768)], { generatedAt });

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
      artifactsRoot: artifacts,
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
    artifactsRoot: sourceArtifacts,
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

test('immutable Retrieval Build profiles are validated and retired root profiles are never Runtime input', async (t) => {
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

  const copiedManifest = path.join(graph.retrievalPath, 'artifacts', 'test-index.json');
  const originalCopiedManifest = await fs.readFile(copiedManifest);
  await fs.appendFile(copiedManifest, '\n');
  await assert.rejects(validatePackageBuildGraph(root), /artifact tree mismatch/i);
  await fs.writeFile(copiedManifest, originalCopiedManifest);
  await validatePackageBuildGraph(root);
  const profilePath = path.join(graph.retrievalPath, 'dkb-profile.lock.json');
  const originalProfile = await fs.readFile(profilePath);
  const changedProfile = JSON.parse(originalProfile.toString('utf8'));
  changedProfile.compatibilityDigest = `sha256:${'f'.repeat(64)}`;
  await fs.writeFile(profilePath, `${JSON.stringify(changedProfile, null, 2)}\n`, 'utf8');
  await assert.rejects(validatePackageBuildGraph(root), /profile|compatibility/i);
  await fs.writeFile(profilePath, originalProfile);
  await fs.writeFile(path.join(root, 'dkb-profile.lock.json'), '{"retired":"not-runtime-input"}\n', 'utf8');

  const verification = await verifyComposeProject(root);
  assert.equal(verification.ok, true, JSON.stringify(verification.checks));

  const packagedVerification = await verifyComposeProject(root);
  assert.equal(packagedVerification.ok, true, JSON.stringify(packagedVerification.checks));
});

function resolvedProfile(model, dimensions) {
  const evidenceProfileDigest = stableHash({ evidence: '@dkb/evidence-docling-llamaindex', parser: 'docling', chunker: 'hybrid-v1' });
  const retrievalProfileDigest = stableHash({ evidenceProfileDigest, embedding: '@dkb/embedding-fastembed', model, dimensions, index: '@dkb/index-faiss' });
  const providers = [
    providerReceipt('@dkb/evidence-docling-llamaindex', 'evidence'),
    providerReceipt('@dkb/embedding-fastembed', 'embedding'),
    providerReceipt('@dkb/index-faiss', 'index'),
    providerReceipt('@dkb/retrieval-hybrid', 'retrieval'),
  ];
  return {
    target: 'test',
    evidenceProfileDigest,
    retrievalProfileDigest,
    configDigest: `config:${model}`,
    providerBuildDigest: `providers:${model}`,
    providers,
    processors: [],
    compiler: '@dkb/evidence-docling-llamaindex',
    indexMode: 'packaged',
    embedding: {
      adapter: '@dkb/embedding-fastembed',
      model,
      dimensions,
    },
    compatibility: {
      evidenceProfileDigest,
      embeddingProvider: '@dkb/embedding-fastembed',
      embeddingSpace: model,
      dimensions,
      metric: 'cosine',
      normalized: true,
      indexFormat: 'IndexIDMap2(IndexFlatIP)',
      protocol: 'dkb.evidence.v1',
    },
  };
}

function providerReceipt(id, kind) {
  return {
    id,
    version: '1.0.0',
    kind,
    source: 'bundled',
    sourcePath: `bundled:${id}`,
    sourceDigest: stableHash({ id, kind, version: '1.0.0' }),
  };
}

async function writeTestPipeline(root) {
  const pluginRoot = path.join(root, '.dkb', 'plugins', '@test', 'pipeline');
  await fs.mkdir(pluginRoot, { recursive: true });
  await fs.writeFile(path.join(root, '.dkb', 'config.json'), `${JSON.stringify({
    format: 'dkb.config.v2',
    targets: {
      default: {
        evidence: '@test/pipeline',
        embedding: '@test/pipeline',
        index: '@test/pipeline',
        retrieval: '@test/pipeline',
      },
    },
  }, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(pluginRoot, 'plugin.mjs'), `
import fs from 'node:fs/promises';
import path from 'node:path';
export const apiVersion = 2;
export const id = '@test/pipeline';
export const version = '1.0.0';
export function setup(context) {
  context.registerProvider({
    kind: 'evidence',
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
    async compilePackage({ artifactsRoot, compiled }) {
      const target = path.join(artifactsRoot, 'test-index.json');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify(compiled.records));
      return { providerId: id, providerVersion: version, build: { recordCount: compiled.records.length } };
    },
    async validatePackage() { return { documentCount: 1 }; },
    async openRuntime() { return null; },
  });
  context.registerProvider({ kind: 'retrieval', protocol: 'dkb.evidence.v1', openRuntime() { return { providerId: '@test/retrieval', protocol: 'dkb.evidence.v1', async search() { return { hits: [], trace: {} }; }, close() {} }; } });
}
`, 'utf8');
}
