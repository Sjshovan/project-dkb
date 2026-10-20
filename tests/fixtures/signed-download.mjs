import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, sign } from 'node:crypto';
import { canonicalJson, stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { validateInstallPlan } from '@sjshovan/dkb-protocol/builds.js';
import { createDkbPackageArchive, createDkbSourceArchive } from '@sjshovan/dkb-library/archive.js';
import { createSignedPackageReceipt, generateSigningKeyPair } from '@sjshovan/dkb-library/signing.js';
import { hashPortablePackageTree } from '@sjshovan/dkb-library/packageTree.js';
import { listPackageBuilds, writePackageBuildGraph } from '@sjshovan/dkb-library/builds.js';
import { createQueryFixture } from '../runtime-query-fixture.mjs';

/** Real signed layers for transport tests, using the existing synthetic lexical fixture. */
export async function signedDownloadFixture(t, options = {}) {
  const fixture = await createQueryFixture(t, options);
  const sourceArchive = path.join(fixture.root, 'source.dkbpkg');
  await createDkbSourceArchive(fixture.packageRoot, sourceArchive);
  const sourceBytes = await fs.readFile(sourceArchive);
  const sourceDigest = digest(sourceBytes);
  const builds = await listPackageBuilds(fixture.packageRoot);
  const currentEvidence = builds.evidence[0], currentRetrieval = builds.retrieval[0];
  const evidencePath = currentEvidence.path;
  const retrievalPath = currentRetrieval.path;
  const json = async name => JSON.parse(await fs.readFile(name, 'utf8'));
  const evidenceLock = await json(path.join(evidencePath, 'evidence.lock.json'));
  const retrievalLock = await json(path.join(retrievalPath, 'retrieval.lock.json'));
  // Registry builds bind the immutable source archive identity rather than the local source-tree identity.
  const graph = await writePackageBuildGraph({
    root: path.join(fixture.root, 'signed-build'),
    package: { id: fixture.packageId, version: fixture.version, sourceDigest },
    evidence: await json(path.join(evidencePath, 'evidence.ir.json')),
    retrievalProfile: await json(path.join(retrievalPath, 'dkb-profile.lock.json')),
    evidenceProviderReceipts: evidenceLock.providerReceipts, retrievalProviderReceipts: retrievalLock.providerReceipts,
    artifactsRoot: path.join(retrievalPath, 'artifacts'), target: 'fixture', generatedAt: '2026-10-13T00:00:00.000Z',
  });
  const pairs = options.keyPairs ?? { publisher: generateSigningKeyPair(), registry: generateSigningKeyPair() };
  const signedAt = '2026-10-13T00:00:00.000Z';
  const keys = Object.entries(pairs).map(([role, pair]) => ({ id: `${role}-key`, subjectType: role,
    subjectId: role === 'publisher' ? '@test' : 'test-registry', algorithm: 'ed25519', publicKeyPem: pair.publicKeyPem,
    publicKeyFingerprint: pair.publicKeyFingerprint, status: 'active', createdAt: signedAt }));
  const packageIdentity = { id: fixture.packageId, version: fixture.version, sourceHash: sourceDigest };
  const signature = (role, content) => ({ ...(role === 'publisher' ? { accountId: '@test' } : { registryId: 'test-registry' }),
    keyId: `${role}-key`, publicKeyFingerprint: pairs[role].publicKeyFingerprint, algorithm: 'ed25519', signedAt,
    value: sign(null, Buffer.from(canonicalJson(content)), pairs[role].privateKeyPem).toString('base64') });
  const receipt = (type, payload, parentReceiptHash) => {
    const content = { type: `${type}.signing-content`, version: 1, package: packageIdentity,
      ...(parentReceiptHash ? { parentReceiptHash } : {}), payloadHash: stableHash(payload), payload };
    return { ...content, type, publisher: signature('publisher', content), registry: signature('registry', content) };
  };
  const missing = path => ({ path, profileDigest: null, digest: null, status: 'not_built' });
  const source = createSignedPackageReceipt({ format: 'dkb.compile-receipt.v2',
    registry: { id: fixture.packageId, name: fixture.packageId, version: fixture.version },
    packages: { [fixture.packageId]: { id: fixture.packageId, name: fixture.packageId, version: fixture.version, path: null,
      manifestHash: digest(await fs.readFile(path.join(fixture.packageRoot, 'dkb.json'))),
      sourceInventoryHash: stableHash({ source: fixture.packageId }), recordCount: graph.evidence.recordCount, stores: [] } },
    builds: { evidence: missing('.dkb/builds/evidence'), retrieval: { ...missing('.dkb/builds/retrieval'), target: 'fixture', compatibilityDigest: null } },
  }, {
    package: { id: fixture.packageId, name: fixture.packageId, version: fixture.version, publisherId: '@test', registryId: 'test-registry' },
    packageTreeHash: (await hashPortablePackageTree(fixture.packageRoot)).hash,
    publisher: { accountId: '@test', keyId: 'publisher-key', privateKeyPem: pairs.publisher.privateKeyPem },
    registry: { registryId: 'test-registry', keyId: 'registry-key', privateKeyPem: pairs.registry.privateKeyPem }, signedAt,
  });
  const evidence = receipt('dkb.evidence.receipt', { sourceReceiptHash: stableHash(source),
    evidenceProfileDigest: graph.evidence.evidenceProfileDigest, evidenceDigest: graph.evidence.evidenceDigest }, stableHash(source));
  const fields = { target: 'fixture', evidenceProfileDigest: graph.evidence.evidenceProfileDigest, evidenceDigest: graph.evidence.evidenceDigest,
    retrievalProfileDigest: graph.retrieval.retrievalProfileDigest, retrievalBuildDigest: graph.retrieval.retrievalBuildDigest,
    compatibilityDigest: graph.retrieval.compatibilityDigest };
  const retrieval = receipt('dkb.retrieval.receipt', { ...fields, evidenceReceiptHash: stableHash(evidence) }, stableHash(evidence));
  const bytes = { source: sourceBytes };
  for (const [kind, root] of [['evidence', graph.evidencePath], ['retrieval', graph.retrievalPath]]) {
    const archive = path.join(fixture.root, `${kind}.archive`);
    await createDkbPackageArchive(root, archive);
    bytes[kind] = await fs.readFile(archive);
  }
  const artifacts = Object.entries({ source, evidence, retrieval }).map(([kind, value]) => ({ kind,
    digest: digest(bytes[kind]), mediaType: `application/vnd.dkb.${kind}+gzip`, bytes: bytes[kind].length,
    url: `/api/layers/${kind}`, receiptHash: stableHash(value), receipt: value }));
  const payload = { format: 'dkb.install-plan.v1', package: { id: fixture.packageId, version: fixture.version, sourceDigest }, ...fields, artifacts };
  return { ...fixture, graph, keys, bytes, plan: validateInstallPlan({ ...payload, receipt: receipt('dkb.install-plan.receipt', payload) }) };
}

const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
