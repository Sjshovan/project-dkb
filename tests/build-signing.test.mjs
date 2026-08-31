import assert from 'node:assert/strict';
import { createHash, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson, stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { validateInstallPlan, validateRetrievalBuildGrant } from '@sjshovan/dkb-protocol/builds.js';
import {
  createSignedPackageReceipt,
  fingerprintPublicKey,
  generateSigningKeyPair,
  packageReceiptPayloadMatchesLock,
  verifyLayerReceipt,
} from '@sjshovan/dkb-library/signing.js';
import { materializeDkbInstallPlan } from '@sjshovan/dkb-runtime/runtime/registryInstall.js';

const publisher = generateSigningKeyPair();
const registry = generateSigningKeyPair();
const packageIdentity = {
  id: '@test/signed-builds',
  version: '1.0.0',
  sourceHash: stableHash({ source: 'signed-builds' }),
};

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

test('Retrieval Build grants contain exactly one signed layer bound to an installed Evidence digest', () => {
  const evidenceProfileDigest = stableHash({ profile: 'grant-evidence' });
  const evidenceDigest = stableHash({ evidence: 'grant-evidence' });
  const retrievalProfileDigest = stableHash({ profile: 'grant-retrieval' });
  const compatibilityDigest = stableHash({ compatibility: 'grant-retrieval' });
  const retrievalBuildDigest = stableHash({ build: 'grant-retrieval' });
  const receipt = layerReceipt('dkb.retrieval.receipt', {
    target: 'fastembed-faiss',
    evidenceProfileDigest,
    evidenceDigest,
    retrievalProfileDigest,
    compatibilityDigest,
    retrievalBuildDigest,
  }, stableHash({ receipt: 'evidence' }));
  const grant = validateRetrievalBuildGrant({
    format: 'dkb.retrieval-build-grant.v1',
    package: { id: packageIdentity.id, version: packageIdentity.version, sourceDigest: packageIdentity.sourceHash },
    target: 'fastembed-faiss',
    evidenceProfileDigest,
    evidenceDigest,
    retrievalProfileDigest,
    compatibilityDigest,
    retrievalBuildDigest,
    artifact: layer('retrieval', stableHash(receipt), receipt),
  });

  assert.equal(grant.artifact.kind, 'retrieval');
  assert.equal(grant.retrievalBuildDigest, retrievalBuildDigest);
  assert.throws(
    () => validateRetrievalBuildGrant({ ...grant, artifact: { ...grant.artifact, kind: 'source' } }),
    /one Retrieval layer/u,
  );
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
  const evidenceReceipt = layerReceipt('dkb.evidence.receipt', evidencePayload, sourceReceiptHash);
  const evidenceReceiptHash = stableHash(evidenceReceipt);
  const retrievalPayload = {
    target: 'tei-faiss',
    evidenceProfileDigest: evidencePayload.evidenceProfileDigest,
    evidenceDigest: evidencePayload.evidenceDigest,
    retrievalProfileDigest: stableHash({ profile: 'retrieval-bytes' }),
    compatibilityDigest: stableHash({ compatibility: 'retrieval-bytes' }),
    retrievalBuildDigest: stableHash({ build: 'retrieval-bytes' }),
  };
  const retrievalReceipt = layerReceipt('dkb.retrieval.receipt', retrievalPayload, evidenceReceiptHash);
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
  const plan = validateInstallPlan({ ...payload, receipt: layerReceipt('dkb.install-plan.receipt', payload) });
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

function layerReceipt(type, payload, parentReceiptHash) {
  const content = {
    type: `${type}.signing-content`,
    version: 1,
    package: packageIdentity,
    ...(parentReceiptHash ? { parentReceiptHash } : {}),
    payloadHash: stableHash(payload),
    payload,
  };
  return {
    ...content,
    type,
    publisher: signatureBlock('publisher', publisher, content),
    registry: signatureBlock('registry', registry, content),
  };
}

function signatureBlock(role, key, content) {
  return {
    ...(role === 'publisher' ? { accountId: '@test' } : { registryId: 'test-registry' }),
    keyId: `${role}-key`,
    publicKeyFingerprint: fingerprintPublicKey(key.publicKeyPem),
    algorithm: 'ed25519',
    value: sign(null, Buffer.from(canonicalJson(content), 'utf8'), key.privateKeyPem).toString('base64'),
    signedAt: '2026-08-27T00:00:00.000Z',
  };
}
