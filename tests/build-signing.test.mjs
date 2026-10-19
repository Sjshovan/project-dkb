import assert from 'node:assert/strict';
import { fixtureProviderReceipts } from './provider-receipt-fixture.mjs';
import { createHash, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson, stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { validateInstallPlan } from '@sjshovan/dkb-protocol/builds.js';
import { buildEvidenceIr } from '@sjshovan/dkb-protocol/evidence/ir.js';
import { retrievalProfileLockForRetrievalPipelines } from '@sjshovan/dkb-pipeline/profile.js';
import { createDkbPackageArchive } from '@sjshovan/dkb-library/archive.js';
import { listPackageBuilds, writePackageBuildGraph } from '@sjshovan/dkb-library/builds.js';
import { hashPortablePackageTree } from '@sjshovan/dkb-library/packageTree.js';
import { readLibraryState } from '@sjshovan/dkb-library/state.js';
import {
  createSignedPackageReceipt,
  fingerprintPublicKey,
  generateSigningKeyPair,
  installPlanReceiptPath,
  packageReceiptPayloadMatchesLock,
  verifyLayerReceipt,
} from '@sjshovan/dkb-library/signing.js';
import {
  attachSignedBuildChain,
  installDkbFromLibraryGrant,
  installDkbFromRuntimeGrant,
  materializeDkbInstallPlan,
  parseRegistryTrustedKeys,
  verifyStoredSignedBuildChain,
} from '@sjshovan/dkb-runtime/runtime/registryInstall.js';
import { ensureRuntimeState } from '@sjshovan/dkb-runtime/runtime/state.js';
import { serveDkbRuntime } from '@sjshovan/dkb-runtime/runtime/server.js';
import { DEFAULT_DKB_RUNTIME_CONTEXT } from '@sjshovan/dkb-runtime/defaultComposition.js';

const publisher = generateSigningKeyPair();
const registry = generateSigningKeyPair();
const packageIdentity = {
  id: '@test/signed-builds',
  version: '1.0.0',
  sourceHash: stableHash({ source: 'signed-builds' }),
};

test('Registry signing-key responses fail closed on unknown key status', () => {
  assert.throws(() => parseRegistryTrustedKeys({
    keys: [{ ...signingKey('registry-key', 'registry', 'test-registry', registry), status: 'future-status' }],
  }), /invalid signing key/u);
});

test('package receipt lock verification includes the signed source inventory binding', () => {
  const sourceInventory = {
    format: 'dkb.source-inventory.v1',
    mediaType: 'application/vnd.dkb.source-inventory+json',
    hash: `sha256:${'a'.repeat(64)}`,
    count: 2,
    bytes: 128,
  };
  const receipt = createSignedPackageReceipt(minimalLock(), {
    package: {
      id: packageIdentity.id,
      name: packageIdentity.id,
      version: packageIdentity.version,
      publisherId: '@test',
      registryId: 'test-registry',
    },
    packageTreeHash: `sha256:${'b'.repeat(64)}`,
    sourceInventory,
    publisher: { accountId: '@test', keyId: 'publisher-key', privateKeyPem: publisher.privateKeyPem },
    registry: { registryId: 'test-registry', keyId: 'registry-key', privateKeyPem: registry.privateKeyPem },
    signedAt: '2026-08-27T00:00:00.000Z',
  });

  assert.equal(packageReceiptPayloadMatchesLock(receipt), true);
  assert.equal(packageReceiptPayloadMatchesLock({
    ...receipt,
    payload: {
      ...receipt.payload,
      sourceInventory: { ...sourceInventory, count: sourceInventory.count + 1 },
    },
  }), false);
});

test('signed install plans bind the exact source, Evidence, and Retrieval chain', async () => {
  const sourceReceiptHash = stableHash({ receipt: 'source' });
  const evidencePayload = {
    sourceReceiptHash,
    evidenceProfileDigest: stableHash({ profile: 'evidence' }),
    evidenceDigest: stableHash({ evidence: 'bytes' }),
  };
  const evidenceReceipt = layerReceipt('dkb.evidence.receipt', evidencePayload, sourceReceiptHash);
  const evidenceReceiptHash = stableHash(evidenceReceipt);
  const retrievalPayload = {
    evidenceReceiptHash,
    evidenceDigest: evidencePayload.evidenceDigest,
    retrievalProfileDigest: stableHash({ profile: 'retrieval' }),
    compatibilityDigest: stableHash({ compatibility: 'retrieval' }),
    retrievalBuildDigest: stableHash({ build: 'retrieval' }),
  };
  const retrievalReceipt = layerReceipt('dkb.retrieval.receipt', retrievalPayload, evidenceReceiptHash);
  const payload = {
    format: 'dkb.install-plan.v1',
    package: { id: packageIdentity.id, version: packageIdentity.version, sourceDigest: packageIdentity.sourceHash },
    target: 'tei-faiss',
    evidenceProfileDigest: evidencePayload.evidenceProfileDigest,
    evidenceDigest: evidencePayload.evidenceDigest,
    retrievalProfileDigest: retrievalPayload.retrievalProfileDigest,
    compatibilityDigest: retrievalPayload.compatibilityDigest,
    retrievalBuildDigest: retrievalPayload.retrievalBuildDigest,
    artifacts: [
      layer('source', sourceReceiptHash, {}),
      layer('evidence', evidenceReceiptHash, evidenceReceipt),
      layer('retrieval', stableHash(retrievalReceipt), retrievalReceipt),
    ],
  };
  const plan = validateInstallPlan({
    ...payload,
    receipt: layerReceipt('dkb.install-plan.receipt', payload),
  });
  const resolver = ({ role }) => role === 'publisher' ? publisher.publicKeyPem : registry.publicKeyPem;

  assert.equal((await verifyLayerReceipt(plan.artifacts[1].receipt, resolver)).ok, true);
  assert.equal((await verifyLayerReceipt(plan.artifacts[2].receipt, resolver)).ok, true);
  assert.equal((await verifyLayerReceipt(plan.receipt, resolver)).ok, true);

  const tampered = structuredClone(plan.receipt);
  tampered.payload.retrievalBuildDigest = stableHash({ build: 'hostile-replacement' });
  const verification = await verifyLayerReceipt(tampered, resolver);
  assert.equal(verification.ok, false);
  assert.ok(verification.checks.some((check) => check.name === 'payload_hash' && !check.ok));
});

test('materialization rejects modified bytes from every signed install layer', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-build-tamper-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pristine = path.join(root, 'pristine');
  await fs.mkdir(pristine, { recursive: true });
  const layerBytes = {
    source: Buffer.from('source archive bytes'),
    evidence: Buffer.from('evidence archive bytes'),
    retrieval: Buffer.from('retrieval archive bytes'),
  };
  for (const [kind, bytes] of Object.entries(layerBytes)) {
    await fs.writeFile(path.join(pristine, layerFilename(kind)), bytes);
  }

  const sourceDigest = fileDigest(layerBytes.source);
  const sourceReceipt = createSignedPackageReceipt(minimalLock(), {
    package: {
      id: packageIdentity.id,
      name: packageIdentity.id,
      version: packageIdentity.version,
      publisherId: '@test',
      registryId: 'test-registry',
    },
    packageTreeHash: stableHash({ tree: 'source-archive-fixture' }),
    publisher: { accountId: '@test', keyId: 'publisher-key', privateKeyPem: publisher.privateKeyPem },
    registry: { registryId: 'test-registry', keyId: 'registry-key', privateKeyPem: registry.privateKeyPem },
    signedAt: '2026-08-27T00:00:00.000Z',
  });
  const sourceReceiptHash = stableHash(sourceReceipt);
  const evidencePayload = {
    sourceReceiptHash,
    evidenceProfileDigest: stableHash({ profile: 'evidence-bytes' }),
    evidenceDigest: stableHash({ evidence: 'layer-bytes' }),
  };
  const evidenceReceipt = layerReceipt('dkb.evidence.receipt', evidencePayload, sourceReceiptHash, sourceDigest);
  const evidenceReceiptHash = stableHash(evidenceReceipt);
  const retrievalPayload = {
    target: 'tei-faiss',
    evidenceReceiptHash,
    evidenceProfileDigest: evidencePayload.evidenceProfileDigest,
    evidenceDigest: evidencePayload.evidenceDigest,
    retrievalProfileDigest: stableHash({ profile: 'retrieval-bytes' }),
    compatibilityDigest: stableHash({ compatibility: 'retrieval-bytes' }),
    retrievalBuildDigest: stableHash({ build: 'retrieval-bytes' }),
  };
  const retrievalReceipt = layerReceipt('dkb.retrieval.receipt', retrievalPayload, evidenceReceiptHash, sourceDigest);
  const payload = {
    format: 'dkb.install-plan.v1',
    package: { id: packageIdentity.id, version: packageIdentity.version, sourceDigest },
    target: retrievalPayload.target,
    evidenceProfileDigest: evidencePayload.evidenceProfileDigest,
    evidenceDigest: evidencePayload.evidenceDigest,
    retrievalProfileDigest: retrievalPayload.retrievalProfileDigest,
    compatibilityDigest: retrievalPayload.compatibilityDigest,
    retrievalBuildDigest: retrievalPayload.retrievalBuildDigest,
    artifacts: [
      archiveLayer('source', layerBytes.source, sourceReceiptHash, sourceReceipt),
      archiveLayer('evidence', layerBytes.evidence, evidenceReceiptHash, evidenceReceipt),
      archiveLayer('retrieval', layerBytes.retrieval, stableHash(retrievalReceipt), retrievalReceipt),
    ],
  };
  const plan = validateInstallPlan({
    ...payload,
    receipt: layerReceipt('dkb.install-plan.receipt', payload, undefined, sourceDigest),
  });
  const trustedKeys = [
    signingKey('publisher-key', 'publisher', '@test', publisher),
    signingKey('registry-key', 'registry', 'test-registry', registry),
  ];

  for (const kind of ['source', 'evidence', 'retrieval']) {
    const layerRoot = path.join(root, `tampered-${kind}`);
    await fs.cp(pristine, layerRoot, { recursive: true });
    await fs.appendFile(path.join(layerRoot, layerFilename(kind)), Buffer.from('-modified'));
    await assert.rejects(
      materializeDkbInstallPlan({
        plan,
        layerRoot,
        destinationRoot: path.join(root, `destination-${kind}`),
        trustedKeys,
      }),
      new RegExp(`Registry ${kind} layer hash mismatch`, 'i'),
    );
  }
});

test('an alternate Evidence Profile attaches only through its exact signed install-plan chain', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-signed-alternate-chain-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'installed');
  const registryBuildRoot = path.join(root, 'registry-build');
  const layerRoot = path.join(root, 'layers');
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.mkdir(registryBuildRoot, { recursive: true });
  await fs.mkdir(layerRoot, { recursive: true });
  const manifest = {
    manifestVersion: 1,
    type: 'dkb',
    name: packageIdentity.id,
    version: packageIdentity.version,
    permissions: { read: true, write: false },
  };
  await fs.writeFile(path.join(packageRoot, 'dkb.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(packageRoot, 'knowledge.md'), 'Signed Registry source.\n');
  await fs.writeFile(path.join(registryBuildRoot, 'dkb.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(registryBuildRoot, 'knowledge.md'), 'Signed Registry source.\n');

  const initial = await writeFixtureBuild(packageRoot, 'initial', 'evidence-v1', 'INITIAL-EVIDENCE');
  const alternate = await writeFixtureBuild(registryBuildRoot, 'alternate', 'evidence-v2', 'ALTERNATE-EVIDENCE');
  assert.notEqual(initial.graph.evidence.evidenceProfileDigest, alternate.graph.evidence.evidenceProfileDigest);

  const packageTreeHash = (await hashPortablePackageTree(packageRoot)).hash;
  const sourceReceipt = createSignedPackageReceipt(minimalLock(), {
    package: {
      id: packageIdentity.id,
      name: packageIdentity.id,
      version: packageIdentity.version,
      publisherId: '@test',
      registryId: 'test-registry',
    },
    packageTreeHash,
    publisher: { accountId: '@test', keyId: 'publisher-key', privateKeyPem: publisher.privateKeyPem },
    registry: { registryId: 'test-registry', keyId: 'registry-key', privateKeyPem: registry.privateKeyPem },
    signedAt: '2026-08-27T00:00:00.000Z',
  });
  await fs.writeFile(path.join(packageRoot, '.dkb-package.json'), `${JSON.stringify(sourceReceipt, null, 2)}\n`);

  const evidenceArchive = path.join(layerRoot, 'evidence.dkbevidence');
  const retrievalArchive = path.join(layerRoot, 'retrieval.dkbbuild');
  await createDkbPackageArchive(alternate.graph.evidencePath, evidenceArchive);
  await createDkbPackageArchive(alternate.graph.retrievalPath, retrievalArchive);
  const sourceReceiptHash = stableHash(sourceReceipt);
  const evidencePayload = {
    sourceReceiptHash,
    evidenceProfileDigest: alternate.graph.evidence.evidenceProfileDigest,
    evidenceDigest: alternate.graph.evidence.evidenceDigest,
  };
  const evidenceReceipt = layerReceipt('dkb.evidence.receipt', evidencePayload, sourceReceiptHash);
  const evidenceReceiptHash = stableHash(evidenceReceipt);
  const retrievalPayload = {
    target: 'alternate',
    evidenceReceiptHash,
    evidenceProfileDigest: alternate.graph.evidence.evidenceProfileDigest,
    evidenceDigest: alternate.graph.evidence.evidenceDigest,
    retrievalProfileDigest: alternate.graph.retrieval.retrievalProfileDigest,
    compatibilityDigest: alternate.graph.retrieval.compatibilityDigest,
    retrievalBuildDigest: alternate.graph.retrieval.retrievalBuildDigest,
  };
  const retrievalReceipt = layerReceipt('dkb.retrieval.receipt', retrievalPayload, evidenceReceiptHash);
  const payload = {
    format: 'dkb.install-plan.v1',
    package: { id: packageIdentity.id, version: packageIdentity.version, sourceDigest: packageIdentity.sourceHash },
    target: 'alternate',
    evidenceProfileDigest: alternate.graph.evidence.evidenceProfileDigest,
    evidenceDigest: alternate.graph.evidence.evidenceDigest,
    retrievalProfileDigest: alternate.graph.retrieval.retrievalProfileDigest,
    compatibilityDigest: alternate.graph.retrieval.compatibilityDigest,
    retrievalBuildDigest: alternate.graph.retrieval.retrievalBuildDigest,
    artifacts: [
      {
        kind: 'source', digest: packageIdentity.sourceHash, mediaType: 'application/vnd.dkb.source+gzip', bytes: 1,
        url: '/api/layers/source', receiptHash: sourceReceiptHash, receipt: sourceReceipt,
      },
      await archiveLayerFromFile('evidence', evidenceArchive, evidenceReceiptHash, evidenceReceipt),
      await archiveLayerFromFile('retrieval', retrievalArchive, stableHash(retrievalReceipt), retrievalReceipt),
    ],
  };
  const plan = validateInstallPlan({ ...payload, receipt: layerReceipt('dkb.install-plan.receipt', payload) });
  const trustedKeys = [
    signingKey('publisher-key', 'publisher', '@test', publisher),
    signingKey('registry-key', 'registry', 'test-registry', registry),
  ];
  const sourceBefore = await hashPortablePackageTree(packageRoot);

  const brokenRoot = path.join(root, 'broken-layers');
  await fs.mkdir(brokenRoot, { recursive: true });
  await fs.copyFile(evidenceArchive, path.join(brokenRoot, 'evidence.dkbevidence'));
  const invalidRetrieval = Buffer.from('not a retrieval archive');
  await fs.writeFile(path.join(brokenRoot, 'retrieval.dkbbuild'), invalidRetrieval);
  const brokenPayload = structuredClone(payload);
  brokenPayload.artifacts[2] = {
    ...brokenPayload.artifacts[2],
    digest: fileDigest(invalidRetrieval),
    bytes: invalidRetrieval.length,
  };
  const brokenPlan = validateInstallPlan({
    ...brokenPayload,
    receipt: layerReceipt('dkb.install-plan.receipt', brokenPayload),
  });
  await assert.rejects(attachSignedBuildChain({
    plan: brokenPlan,
    layerRoot: brokenRoot,
    libraryRoot: root,
    packageRoot,
    trustedKeys,
  }));
  assert.deepEqual(
    { evidence: (await listPackageBuilds(packageRoot)).evidence.length, retrieval: (await listPackageBuilds(packageRoot)).retrieval.length },
    { evidence: 1, retrieval: 1 },
  );

  const graph = await attachSignedBuildChain({ plan, layerRoot, libraryRoot: root, packageRoot, trustedKeys });
  assert.equal(graph.evidence.evidenceDigest, alternate.graph.evidence.evidenceDigest);
  assert.equal(graph.retrieval.retrievalBuildDigest, alternate.graph.retrieval.retrievalBuildDigest);
  const builds = await listPackageBuilds(packageRoot);
  assert.deepEqual({ evidence: builds.evidence.length, retrieval: builds.retrieval.length }, { evidence: 2, retrieval: 2 });
  assert.deepEqual(await hashPortablePackageTree(packageRoot), sourceBefore);
  assert.deepEqual(
    JSON.parse(await fs.readFile(installPlanReceiptPath(packageRoot, stableHash(plan)), 'utf8')),
    plan,
  );
  await verifyStoredSignedBuildChain({ packageRoot, graph, target: plan.target, trustedKeys });
  const resignedPlan = validateInstallPlan({
    ...payload,
    receipt: layerReceipt(
      'dkb.install-plan.receipt',
      payload,
      undefined,
      packageIdentity.sourceHash,
      '2026-08-28T00:00:00.000Z',
    ),
  });
  await attachSignedBuildChain({ plan: resignedPlan, layerRoot, libraryRoot: root, packageRoot, trustedKeys });
  assert.equal((await fs.readdir(path.dirname(installPlanReceiptPath(packageRoot, stableHash(plan))))).length, 2);
});

for (const destination of ['Runtime', 'Library']) {
  test(`${destination} grant installation preserves the signed public origin and reuses source for another build`,
    t => proveGrantedDestination(t, destination));
}

async function proveGrantedDestination(t, destination) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-registry-transport-origin-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source');
  const buildRoot = path.join(root, 'build');
  const layers = path.join(root, 'layers');
  const libraryRoot = path.join(root, 'library');
  const runtimeRoot = path.join(root, 'runtime');
  await Promise.all([
    fs.mkdir(sourceRoot, { recursive: true }),
    fs.mkdir(buildRoot, { recursive: true }),
    fs.mkdir(layers, { recursive: true }),
    fs.mkdir(libraryRoot, { recursive: true }),
  ]);
  const manifest = {
    manifestVersion: 1,
    type: 'dkb',
    name: packageIdentity.id,
    version: packageIdentity.version,
    permissions: { read: true, write: false },
  };
  await fs.writeFile(path.join(sourceRoot, 'dkb.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(sourceRoot, 'knowledge.md'), 'Transport and provenance remain separate.\n');
  await fs.cp(sourceRoot, buildRoot, { recursive: true });
  await fs.writeFile(path.join(libraryRoot, 'dkb.json'), `${JSON.stringify({
    manifestVersion: 1,
    type: 'library',
    name: 'Transport Origin Library',
    roots: {},
  }, null, 2)}\n`);

  const sourceArchive = path.join(layers, 'source.dkbpkg');
  await createDkbPackageArchive(sourceRoot, sourceArchive);
  const sourceBytes = await fs.readFile(sourceArchive);
  const sourceDigest = fileDigest(sourceBytes);
  const compiled = await writeFixtureBuild(buildRoot, 'transport-proof', 'transport-evidence', 'TRANSPORT-PROOF', sourceDigest);
  const evidenceArchive = path.join(layers, 'evidence.dkbevidence');
  const retrievalArchive = path.join(layers, 'retrieval.dkbbuild');
  await createDkbPackageArchive(compiled.graph.evidencePath, evidenceArchive);
  await createDkbPackageArchive(compiled.graph.retrievalPath, retrievalArchive);

  const packageTreeHash = (await hashPortablePackageTree(sourceRoot)).hash;
  const sourceReceipt = createSignedPackageReceipt(installableLock(), {
    package: {
      id: packageIdentity.id,
      name: packageIdentity.id,
      version: packageIdentity.version,
      publisherId: '@test',
      registryId: 'test-registry',
    },
    packageTreeHash,
    publisher: { accountId: '@test', keyId: 'publisher-key', privateKeyPem: publisher.privateKeyPem },
    registry: { registryId: 'test-registry', keyId: 'registry-key', privateKeyPem: registry.privateKeyPem },
    signedAt: '2026-09-02T00:00:00.000Z',
  });
  const sourceReceiptHash = stableHash(sourceReceipt);
  const evidencePayload = {
    sourceReceiptHash,
    evidenceProfileDigest: compiled.graph.evidence.evidenceProfileDigest,
    evidenceDigest: compiled.graph.evidence.evidenceDigest,
  };
  const evidenceReceipt = layerReceipt('dkb.evidence.receipt', evidencePayload, sourceReceiptHash, sourceDigest);
  const evidenceReceiptHash = stableHash(evidenceReceipt);
  const retrievalPayload = {
    evidenceReceiptHash,
    target: 'transport-proof',
    evidenceProfileDigest: compiled.graph.evidence.evidenceProfileDigest,
    evidenceDigest: compiled.graph.evidence.evidenceDigest,
    retrievalProfileDigest: compiled.graph.retrieval.retrievalProfileDigest,
    compatibilityDigest: compiled.graph.retrieval.compatibilityDigest,
    retrievalBuildDigest: compiled.graph.retrieval.retrievalBuildDigest,
  };
  const retrievalReceipt = layerReceipt('dkb.retrieval.receipt', retrievalPayload, evidenceReceiptHash, sourceDigest);
  const payload = {
    format: 'dkb.install-plan.v1',
    package: { id: packageIdentity.id, version: packageIdentity.version, sourceDigest },
    target: 'transport-proof',
    evidenceProfileDigest: compiled.graph.evidence.evidenceProfileDigest,
    evidenceDigest: compiled.graph.evidence.evidenceDigest,
    retrievalProfileDigest: compiled.graph.retrieval.retrievalProfileDigest,
    compatibilityDigest: compiled.graph.retrieval.compatibilityDigest,
    retrievalBuildDigest: compiled.graph.retrieval.retrievalBuildDigest,
    artifacts: [
      await archiveLayerFromFile('source', sourceArchive, sourceReceiptHash, sourceReceipt),
      await archiveLayerFromFile('evidence', evidenceArchive, evidenceReceiptHash, evidenceReceipt),
      await archiveLayerFromFile('retrieval', retrievalArchive, stableHash(retrievalReceipt), retrievalReceipt),
    ],
  };
  const plan = validateInstallPlan({
    ...payload,
    receipt: layerReceipt('dkb.install-plan.receipt', payload, undefined, sourceDigest),
  });
  const trustedKeys = [
    signingKey('publisher-key', 'publisher', '@test', publisher),
    signingKey('registry-key', 'registry', 'test-registry', registry),
  ];
  const substitutedCompatibilityDigest = stableHash({ compatibility: 'signed-plan-substitution' });
  const substitutedRetrievalPayload = {
    ...retrievalPayload,
    compatibilityDigest: substitutedCompatibilityDigest,
  };
  const substitutedRetrievalReceipt = layerReceipt(
    'dkb.retrieval.receipt',
    substitutedRetrievalPayload,
    evidenceReceiptHash,
    sourceDigest,
  );
  const substitutedPayload = {
    ...payload,
    compatibilityDigest: substitutedCompatibilityDigest,
    artifacts: [
      payload.artifacts[0],
      payload.artifacts[1],
      {
        ...payload.artifacts[2],
        receiptHash: stableHash(substitutedRetrievalReceipt),
        receipt: substitutedRetrievalReceipt,
      },
    ],
  };
  const substitutedPlan = validateInstallPlan({
    ...substitutedPayload,
    receipt: layerReceipt('dkb.install-plan.receipt', substitutedPayload, undefined, sourceDigest),
  });
  await assert.rejects(materializeDkbInstallPlan({
    plan: substitutedPlan,
    layerRoot: layers,
    destinationRoot: path.join(root, 'substituted-plan-install'),
    trustedKeys,
  }), /does not satisfy pipeline/u);
  const layerFiles = new Map([
    [plan.artifacts[0].url, { path: sourceArchive, artifact: plan.artifacts[0] }],
    [plan.artifacts[1].url, { path: evidenceArchive, artifact: plan.artifacts[1] }],
    [plan.artifacts[2].url, { path: retrievalArchive, artifact: plan.artifacts[2] }],
  ]);
  const requests = [];
  let downloadFailure;
  const server = http.createServer(async (request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    if (request.url === '/.well-known/dkb-registry-keys.json') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: trustedKeys }));
      return;
    }
    const layer = layerFiles.get(request.url);
    if (layer) {
      if (downloadFailure === 'expired') { response.writeHead(403).end('grant expired'); return; }
      response.setHeader('content-type', layer.artifact.mediaType);
      const bytes = await fs.readFile(layer.path);
      if (downloadFailure === 'corrupt') bytes[0] ^= 1;
      response.end(bytes);
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.equal(typeof address, 'object');
  const transportUrl = `http://127.0.0.1:${address.port}`;
  const publicOrigin = 'https://registry.example.test';
  if (destination === 'Runtime') {
    await ensureRuntimeState(runtimeRoot, {
      libraryRoot,
      runtimeId: 'transport-origin-runtime',
      target: 'transport-proof',
    });
  }
  const installGranted = (input) => destination === 'Runtime'
    ? installDkbFromRuntimeGrant({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, runtimeRoot, ...input })
    : installDkbFromLibraryGrant({ libraryRoot, ...input });
  const request = { registryUrl: publicOrigin, registryTransportUrl: transportUrl, installGrant: `dkb_grant_${'g'.repeat(64)}`, plan };
  const previousToken = process.env.DKB_REGISTRY_TOKEN;
  process.env.DKB_REGISTRY_TOKEN = 'host-bearer-must-not-be-used';
  t.after(() => {
    if (previousToken === undefined) delete process.env.DKB_REGISTRY_TOKEN;
    else process.env.DKB_REGISTRY_TOKEN = previousToken;
  });
  for (const invalid of [{ installGrant: '' }, { installGrant: 'secret\r\nheader' }, { installGrant: 's'.repeat(4097) },
    { registryUrl: 'https://secret-user:secret-password@registry.example.test' },
    { registryTransportUrl: `${transportUrl}?secret=must-not-leak` }]) {
    await assert.rejects(installGranted({ ...request, ...invalid }), error => {
      assert.equal(error.code, 'invalid_install_grant');
      assert.doesNotMatch(error.message, /secret-user|secret-password|must-not-leak|secret\r/u);
      return true;
    });
  }
  assert.equal(requests.length, 0, 'Invalid grant envelopes never contact a service');

  const installed = await installGranted(request);

  assert.equal(installed.status, 'installed');
  assert.equal((await readLibraryState(libraryRoot)).entries[packageIdentity.id].registryUrl, publicOrigin);
  const previousRegistryUrl = process.env.DKB_REGISTRY_URL;
  process.env.DKB_REGISTRY_URL = 'http://registry-web:8000';
  let runtimeServer;
  try {
    if (destination === 'Runtime') {
      runtimeServer = await serveDkbRuntime({
        adminToken: 'signed-discovery-admin',
        readAccess: 'public-read',
        runtime: DEFAULT_DKB_RUNTIME_CONTEXT,
        stateRoot: runtimeRoot,
        host: '127.0.0.1',
        port: 0,
      });
      const runtimeAddress = runtimeServer.address();
      assert.equal(typeof runtimeAddress, 'object');
      const discovery = await fetch(`http://127.0.0.1:${runtimeAddress.port}/.well-known/dkb.json`).then((response) => response.json());
      const advertised = discovery.packages.find((item) => item.id === packageIdentity.id);
      assert.equal(advertised.install.registryUrl, publicOrigin);
      assert.equal(JSON.stringify(discovery).includes('registry-web:8000'), false);
    } else {
      await assert.rejects(fs.access(runtimeRoot), { code: 'ENOENT' });
      await assert.rejects(fs.access(path.join(libraryRoot, '.dkb/runtime.lock.json')), { code: 'ENOENT' });
    }
  } finally {
    if (runtimeServer) {
      await new Promise((resolve, reject) => runtimeServer.close((error) => error ? reject(error) : resolve()));
    }
    if (previousRegistryUrl === undefined) delete process.env.DKB_REGISTRY_URL;
    else process.env.DKB_REGISTRY_URL = previousRegistryUrl;
  }
  assert.deepEqual(requests.map((request) => request.url), [
    '/.well-known/dkb-registry-keys.json',
    '/api/layers/source',
    '/api/layers/evidence',
    '/api/layers/retrieval',
  ]);
  assert.equal(requests[0].authorization, undefined, 'Public key lookup does not inherit host credentials');
  assert.equal(requests.slice(1).every((request) => request.authorization === `DKB-Install-Grant dkb_grant_${'g'.repeat(64)}`), true);

  const replayBegin = requests.length;
  assert.equal((await installGranted(request)).status, 'already_installed');
  assert.deepEqual(requests.slice(replayBegin).map(item => item.url), ['/.well-known/dkb-registry-keys.json']);

  const installedState = await readLibraryState(libraryRoot);
  for (const field of ['evidenceDigest', 'retrievalBuildDigest']) {
    const replacementDigest = stableHash({ requested: field, replacement: true });
    const replacementEvidencePayload = {
      ...evidencePayload,
      ...(field === 'evidenceDigest' ? { evidenceDigest: replacementDigest } : {}),
    };
    const replacementEvidenceReceipt = layerReceipt('dkb.evidence.receipt', replacementEvidencePayload, sourceReceiptHash, sourceDigest);
    const replacementEvidenceReceiptHash = stableHash(replacementEvidenceReceipt);
    const replacementRetrievalPayload = {
      ...retrievalPayload,
      evidenceReceiptHash: replacementEvidenceReceiptHash,
      [field]: replacementDigest,
    };
    const replacementRetrievalReceipt = layerReceipt('dkb.retrieval.receipt', replacementRetrievalPayload, replacementEvidenceReceiptHash, sourceDigest);
    const replacementPayload = {
      ...payload,
      [field]: replacementDigest,
      artifacts: [
        payload.artifacts[0],
        { ...payload.artifacts[1], receiptHash: replacementEvidenceReceiptHash, receipt: replacementEvidenceReceipt },
        { ...payload.artifacts[2], receiptHash: stableHash(replacementRetrievalReceipt), receipt: replacementRetrievalReceipt },
      ],
    };
    const replacementPlan = validateInstallPlan({
      ...replacementPayload,
      receipt: layerReceipt('dkb.install-plan.receipt', replacementPayload, undefined, sourceDigest),
    });
    // A different signed child identity is not satisfied by the retained recipe.
    // An unavailable download must fail, rather than report the old build as installed.
    downloadFailure = 'expired';
    const begin = requests.length;
    await assert.rejects(installGranted({ ...request, plan: replacementPlan }), /403|expired/u);
    assert.deepEqual(requests.slice(begin).map(item => item.url), [
      '/.well-known/dkb-registry-keys.json', '/api/layers/evidence',
    ]);
    assert.deepEqual(await readLibraryState(libraryRoot), installedState);
    assert.equal((await listPackageBuilds(installed.packagePath)).retrieval.length, 1);
  }
  downloadFailure = undefined;

  const alternate = await writeFixtureBuild(
    buildRoot,
    'transport-alternate',
    'transport-evidence-alternate',
    'TRANSPORT-ALTERNATE',
    sourceDigest,
  );
  const alternateEvidenceArchive = path.join(layers, 'evidence-alternate.dkbevidence');
  const alternateRetrievalArchive = path.join(layers, 'retrieval-alternate.dkbbuild');
  await createDkbPackageArchive(alternate.graph.evidencePath, alternateEvidenceArchive);
  await createDkbPackageArchive(alternate.graph.retrievalPath, alternateRetrievalArchive);
  const alternateEvidencePayload = {
    sourceReceiptHash,
    evidenceProfileDigest: alternate.graph.evidence.evidenceProfileDigest,
    evidenceDigest: alternate.graph.evidence.evidenceDigest,
  };
  const alternateEvidenceReceipt = layerReceipt(
    'dkb.evidence.receipt',
    alternateEvidencePayload,
    sourceReceiptHash,
    sourceDigest,
  );
  const alternateEvidenceReceiptHash = stableHash(alternateEvidenceReceipt);
  const alternateRetrievalPayload = {
    evidenceReceiptHash: alternateEvidenceReceiptHash,
    target: 'transport-alternate',
    evidenceProfileDigest: alternate.graph.evidence.evidenceProfileDigest,
    evidenceDigest: alternate.graph.evidence.evidenceDigest,
    retrievalProfileDigest: alternate.graph.retrieval.retrievalProfileDigest,
    compatibilityDigest: alternate.graph.retrieval.compatibilityDigest,
    retrievalBuildDigest: alternate.graph.retrieval.retrievalBuildDigest,
  };
  const alternateRetrievalReceipt = layerReceipt(
    'dkb.retrieval.receipt',
    alternateRetrievalPayload,
    alternateEvidenceReceiptHash,
    sourceDigest,
  );
  const alternatePayload = {
    format: 'dkb.install-plan.v1',
    package: { id: packageIdentity.id, version: packageIdentity.version, sourceDigest },
    target: 'transport-alternate',
    evidenceProfileDigest: alternate.graph.evidence.evidenceProfileDigest,
    evidenceDigest: alternate.graph.evidence.evidenceDigest,
    retrievalProfileDigest: alternate.graph.retrieval.retrievalProfileDigest,
    compatibilityDigest: alternate.graph.retrieval.compatibilityDigest,
    retrievalBuildDigest: alternate.graph.retrieval.retrievalBuildDigest,
    artifacts: [
      { ...await archiveLayerFromFile('source', sourceArchive, sourceReceiptHash, sourceReceipt), url: '/api/layers/source-alternate' },
      { ...await archiveLayerFromFile('evidence', alternateEvidenceArchive, alternateEvidenceReceiptHash, alternateEvidenceReceipt), url: '/api/layers/evidence-alternate' },
      {
        ...await archiveLayerFromFile(
          'retrieval',
          alternateRetrievalArchive,
          stableHash(alternateRetrievalReceipt),
          alternateRetrievalReceipt,
        ),
        url: '/api/layers/retrieval-alternate',
      },
    ],
  };
  const alternatePlan = validateInstallPlan({
    ...alternatePayload,
    receipt: layerReceipt('dkb.install-plan.receipt', alternatePayload, undefined, sourceDigest),
  });
  layerFiles.set(alternatePlan.artifacts[0].url, { path: sourceArchive, artifact: alternatePlan.artifacts[0] });
  layerFiles.set(alternatePlan.artifacts[1].url, { path: alternateEvidenceArchive, artifact: alternatePlan.artifacts[1] });
  layerFiles.set(alternatePlan.artifacts[2].url, { path: alternateRetrievalArchive, artifact: alternatePlan.artifacts[2] });

  const stateBeforeFailure = await readLibraryState(libraryRoot);
  const sourceBeforeFailure = await hashPortablePackageTree(installed.packagePath);
  for (const failure of ['tampered-plan', 'expired', 'corrupt']) {
    const damagedPlan = structuredClone(alternatePlan);
    if (failure === 'tampered-plan') damagedPlan.receipt.payloadHash = `sha256:${'0'.repeat(64)}`;
    downloadFailure = failure;
    const begin = requests.length;
    await assert.rejects(installGranted({ ...request, plan: damagedPlan }), /receipt chain|expired|403|hash mismatch/u);
    assert.deepEqual(await readLibraryState(libraryRoot), stateBeforeFailure);
    assert.deepEqual(await hashPortablePackageTree(installed.packagePath), sourceBeforeFailure);
    assert.equal((await listPackageBuilds(installed.packagePath)).retrieval.length, 1);
    if (failure === 'tampered-plan') assert.deepEqual(requests.slice(begin).map(item => item.url), ['/.well-known/dkb-registry-keys.json']);
  }
  downloadFailure = undefined;
  const originalStatfs = fs.statfs;
  for (const stage of ['download', 'archive']) {
    let checked = false;
    const lowCapacity = t.mock.method(fs, 'statfs', async (...args) => {
      const capacity = await originalStatfs(...args);
      // Preserve a distinct expansion test: allow signed layer downloads, then
      // deny capacity at the build candidate before any archive payload is written.
      if (stage === 'archive' && !String(args[0]).includes('.dkb-build-chain-candidate-')) return capacity;
      checked = true;
      return { ...capacity, bavail: args[1]?.bigint ? 0n : 0 };
    });
    const begin = requests.length;
    try {
      await assert.rejects(installGranted({ ...request, plan: alternatePlan }), { code: `${stage}_capacity_exceeded` });
      assert.equal(checked, true);
      if (stage === 'download') assert.deepEqual(requests.slice(begin).map(item => item.url), ['/.well-known/dkb-registry-keys.json']);
    } finally { lowCapacity.mock.restore(); }
    assert.deepEqual(await readLibraryState(libraryRoot), stateBeforeFailure);
    assert.deepEqual(await hashPortablePackageTree(installed.packagePath), sourceBeforeFailure);
    assert.equal((await listPackageBuilds(installed.packagePath)).retrieval.length, 1);
  }
  const alternateBegin = requests.length;
  const retainedSource = await installGranted({
    registryUrl: publicOrigin,
    registryTransportUrl: transportUrl,
    installGrant: `dkb_grant_${'h'.repeat(64)}`,
    plan: alternatePlan,
  });
  assert.equal(retainedSource.status, 'already_installed');
  assert.deepEqual(requests.slice(alternateBegin).map((request) => request.url), [
    '/.well-known/dkb-registry-keys.json',
    '/api/layers/evidence-alternate',
    '/api/layers/retrieval-alternate',
  ]);
  assert.equal(requests.slice(alternateBegin + 1).every((request) => request.authorization === `DKB-Install-Grant dkb_grant_${'h'.repeat(64)}`), true);
  assert.equal(requests.some(item => String(item.authorization).includes('host-bearer')), false);
  assert.deepEqual(
    { evidence: (await listPackageBuilds(retainedSource.packagePath)).evidence.length, retrieval: (await listPackageBuilds(retainedSource.packagePath)).retrieval.length },
    { evidence: 2, retrieval: 2 },
  );
  assert.deepEqual(
    JSON.parse(await fs.readFile(installPlanReceiptPath(retainedSource.packagePath, stableHash(alternatePlan)), 'utf8')),
    alternatePlan,
  );
}

function layer(kind, receiptHash, receipt) {
  return {
    kind,
    digest: stableHash({ archive: kind }),
    mediaType: `application/vnd.dkb.${kind}+gzip`,
    bytes: 1,
    url: `/api/layers/${kind}`,
    receiptHash,
    receipt,
  };
}

function archiveLayer(kind, bytes, receiptHash, receipt) {
  return {
    kind,
    digest: fileDigest(bytes),
    mediaType: `application/vnd.dkb.${kind}+gzip`,
    bytes: bytes.length,
    url: `/api/layers/${kind}`,
    receiptHash,
    receipt,
  };
}

async function archiveLayerFromFile(kind, archivePath, receiptHash, receipt) {
  const bytes = await fs.readFile(archivePath);
  return {
    kind,
    digest: fileDigest(bytes),
    mediaType: `application/vnd.dkb.${kind}+gzip`,
    bytes: bytes.length,
    url: `/api/layers/${kind}`,
    receiptHash,
    receipt,
  };
}

async function writeFixtureBuild(root, target, evidenceVariant, marker, sourceDigest = packageIdentity.sourceHash) {
  const profile = fixtureProfile(target, evidenceVariant);
  const compiled = fixtureCompilerResult(profile.embedding.space, marker);
  const evidence = buildEvidenceIr([compiled], { evidenceProfileDigest: profile.evidenceProfileDigest });
  const retrievalProfile = retrievalProfileLockForRetrievalPipelines(profile, [compiled], {
    generatedAt: '2026-08-27T00:00:00.000Z',
  });
  const artifactsRoot = path.join(root, `staged-${target}`);
  await fs.mkdir(artifactsRoot, { recursive: true });
  await fs.writeFile(path.join(artifactsRoot, 'index.bin'), `${marker}\n`);
  try {
    return {
      profile,
      graph: await writePackageBuildGraph({
        root,
        package: {
          id: packageIdentity.id,
          version: packageIdentity.version,
          sourceDigest,
        },
        evidence,
        retrievalProfile,
        ...fixtureProviderReceipts(retrievalProfile),
        artifactsRoot,
        target,
        generatedAt: '2026-08-27T00:00:00.000Z',
      }),
    };
  } finally {
    await fs.rm(artifactsRoot, { recursive: true, force: true });
  }
}

function fixtureCompilerResult(embeddingSpace, marker) {
  return {
    documents: [],
    chunks: [],
    receipts: [],
    vectors: [{ evidenceId: 'record-1', values: [0.5] }],
    records: [{
      id: 'record-1',
      chunkId: 'record-1',
      assetId: 'knowledge.md',
      storeId: 'files',
      type: 'filesystem',
      locator: { path: 'knowledge.md', line: 1 },
      assetLocator: { path: 'knowledge.md' },
      title: 'Knowledge',
      text: marker,
      hash: stableHash({ marker }),
      updatedAt: '2026-08-27T00:00:00.000Z',
      chunkOrdinal: 0,
      chunkStart: 0,
      chunkEnd: marker.length,
      metadata: {
        dkb_package_id: packageIdentity.id,
        dkb_package_version: packageIdentity.version,
        dkb_source_hash: stableHash({ source: marker }),
        dkb_path: 'knowledge.md',
        embedding_space: embeddingSpace,
      },
    }],
  };
}

function fixtureProfile(target, evidenceVariant) {
  const evidenceProfileDigest = stableHash({ evidence: evidenceVariant });
  const retrievalProfileDigest = stableHash({ target, evidenceProfileDigest, embedding: 'fixture-space' });
  return {
    target,
    evidenceProfileDigest,
    retrievalProfileDigest,
    configDigest: stableHash({ target, config: true }),
    providerBuildDigest: stableHash({ target, providers: true }),
    providers: [
      fixtureProvider(`@test/${evidenceVariant}`, 'evidence'),
      fixtureProvider('@test/embedding', 'embedding'),
      fixtureProvider('@test/index', 'index'),
      fixtureProvider('@test/retrieval', 'retrieval'),
    ],
    processors: [],
    indexMode: 'packaged',
    embedding: {
      provider: '@test/embedding',
      space: 'fixture-space',
      dimensions: 1,
      queryMode: 'query',
      documentMode: 'passage',
    },
    compatibility: {
      evidenceProfileDigest,
      embeddingProvider: '@test/embedding',
      embeddingSpace: 'fixture-space',
      dimensions: 1,
      metric: 'cosine',
      normalized: true,
      queryTransformDigest: stableHash({ mode: 'query' }),
      documentTransformDigest: stableHash({ mode: 'passage' }),
      indexFormat: 'fixture.index.v1',
      protocol: 'dkb.evidence.v1',
    },
  };
}

function fixtureProvider(id, kind) {
  return {
    id,
    version: '1.0.0',
    kind,
    source: 'bundled',
    sourcePath: `bundled:${id}`,
    sourceDigest: stableHash({ id, kind, source: true }),
    integrityDigest: stableHash({ id, kind, integrity: true }),
  };
}

function layerFilename(kind) {
  return kind === 'source' ? 'source.dkbpkg' : kind === 'evidence' ? 'evidence.dkbevidence' : 'retrieval.dkbbuild';
}

function fileDigest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function minimalLock() {
  const missing = (path) => ({ path, profileDigest: null, digest: null, status: 'not_built' });
  return {
    format: 'dkb.compile-receipt.v2',
    registry: { id: packageIdentity.id, name: packageIdentity.id, version: packageIdentity.version },
    packages: {},
    builds: {
      evidence: missing('.dkb/builds/evidence'),
      retrieval: { ...missing('.dkb/builds/retrieval'), target: 'tei-faiss', compatibilityDigest: null },
    },
  };
}

function installableLock() {
  return {
    ...minimalLock(),
    packages: {
      [packageIdentity.id]: {
        id: packageIdentity.id,
        name: packageIdentity.id,
        version: packageIdentity.version,
        path: null,
        manifestHash: stableHash({ manifest: packageIdentity.id }),
        sourceInventoryHash: stableHash({ inventory: packageIdentity.id }),
        recordCount: 1,
        stores: [],
      },
    },
  };
}

function signingKey(id, subjectType, subjectId, pair) {
  return {
    id,
    subjectType,
    subjectId,
    algorithm: 'ed25519',
    publicKeyPem: pair.publicKeyPem,
    publicKeyFingerprint: pair.publicKeyFingerprint,
    status: 'active',
    createdAt: '2026-08-27T00:00:00.000Z',
  };
}

function layerReceipt(
  type,
  payload,
  parentReceiptHash,
  sourceHash = packageIdentity.sourceHash,
  signedAt = '2026-08-27T00:00:00.000Z',
) {
  const content = {
    type: `${type}.signing-content`,
    version: 1,
    package: { ...packageIdentity, sourceHash },
    ...(parentReceiptHash ? { parentReceiptHash } : {}),
    payloadHash: stableHash(payload),
    payload,
  };
  return {
    ...content,
    type,
    publisher: signatureBlock('publisher', publisher, content, signedAt),
    registry: signatureBlock('registry', registry, content, signedAt),
  };
}

function signatureBlock(role, key, content, signedAt) {
  return {
    ...(role === 'publisher' ? { accountId: '@test' } : { registryId: 'test-registry' }),
    keyId: `${role}-key`,
    publicKeyFingerprint: fingerprintPublicKey(key.publicKeyPem),
    algorithm: 'ed25519',
    value: sign(null, Buffer.from(canonicalJson(content), 'utf8'), key.privateKeyPem).toString('base64'),
    signedAt,
  };
}
