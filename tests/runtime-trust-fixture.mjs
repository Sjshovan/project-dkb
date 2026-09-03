import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, sign } from 'node:crypto';
import { canonicalJson, stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { validateInstallPlan } from '@sjshovan/dkb-protocol/builds.js';
import { createSignedPackageReceipt, generateSigningKeyPair, DKB_INSTALL_PLAN_RECEIPT_PATH } from '@sjshovan/dkb-library/signing.js';
import { hashPortablePackageTree } from '@sjshovan/dkb-library/packageTree.js';
import { validateStoredPackageBuild } from '@sjshovan/dkb-library/builds.js';
import { applyLibraryLock } from '@sjshovan/dkb-library/state.js';
import { ensureRuntimeState } from '@sjshovan/dkb-runtime/runtime/state.js';
import { closeRuntimeQuerySnapshot } from '../services/runtime/dist/runtime/querySnapshot.js';
import { pinRegistryTrustedKeys, registryTrustPath } from '../services/runtime/dist/runtime/registryTrust.js';
import { verifyStoredSignedBuildChain } from '@sjshovan/dkb-runtime/runtime/registryInstall.js';
import { createDkbPackageArchive } from '@sjshovan/dkb-library/archive.js';

/** Convert an isolated editable fixture into a correctly signed, retained release. */
export async function signRuntimeFixture(fixture, { downloadable = false } = {}) {
  await closeRuntimeQuerySnapshot(fixture.runtimeRoot);
  const instance = await ensureRuntimeState(fixture.runtimeRoot);
  const graph = await validateStoredPackageBuild(fixture.packageRoot, instance.activation.packages[fixture.packageId]);
  const origin = 'https://offline-registry.example.test';
  const sourceHash = graph.evidence.package.sourceDigest;
  const packageTreeHash = (await hashPortablePackageTree(fixture.packageRoot)).hash;
  const publisher = generateSigningKeyPair();
  const registry = generateSigningKeyPair();
  const signedAt = '2026-09-03T00:00:00.000Z';
  const packageIdentity = { id: fixture.packageId, version: '1.0.0', sourceHash };
  const keys = [
    key('publisher', '@test', publisher),
    key('registry', 'test-registry', registry),
  ];
  function key(subjectType, subjectId, pair) {
    return { id: `${subjectType}-key`, subjectType, subjectId, algorithm: 'ed25519', publicKeyPem: pair.publicKeyPem, publicKeyFingerprint: pair.publicKeyFingerprint, status: 'active', createdAt: signedAt };
  }
  const notBuilt = (path) => ({ path, profileDigest: null, digest: null, status: 'not_built' });
  const source = createSignedPackageReceipt({
    format: 'dkb.compile-receipt.v2', registry: { id: fixture.packageId, name: fixture.packageId, version: '1.0.0' }, packages: {},
    builds: { evidence: notBuilt('.dkb/builds/evidence'), retrieval: { ...notBuilt('.dkb/builds/retrieval'), target: 'fast', compatibilityDigest: null } },
  }, {
    package: { id: fixture.packageId, name: fixture.packageId, version: '1.0.0', publisherId: '@test', registryId: 'test-registry' }, packageTreeHash,
    publisher: { accountId: '@test', keyId: 'publisher-key', privateKeyPem: publisher.privateKeyPem },
    registry: { registryId: 'test-registry', keyId: 'registry-key', privateKeyPem: registry.privateKeyPem }, signedAt,
  });
  function receipt(type, payload, parentReceiptHash) {
    const content = { type: `${type}.signing-content`, version: 1, package: packageIdentity, ...(parentReceiptHash ? { parentReceiptHash } : {}), payloadHash: stableHash(payload), payload };
    function signature(role, pair) {
      return { ...(role === 'publisher' ? { accountId: '@test' } : { registryId: 'test-registry' }), keyId: `${role}-key`, publicKeyFingerprint: pair.publicKeyFingerprint, algorithm: 'ed25519', value: sign(null, Buffer.from(canonicalJson(content)), pair.privateKeyPem).toString('base64'), signedAt };
    }
    return { ...content, type, publisher: signature('publisher', publisher), registry: signature('registry', registry) };
  }
  const evidence = receipt('dkb.evidence.receipt', { sourceReceiptHash: stableHash(source), evidenceProfileDigest: graph.evidence.evidenceProfileDigest, evidenceDigest: graph.evidence.evidenceDigest }, stableHash(source));
  const fields = { target: instance.target, evidenceProfileDigest: graph.evidence.evidenceProfileDigest, evidenceDigest: graph.evidence.evidenceDigest, retrievalProfileDigest: graph.retrieval.retrievalProfileDigest, retrievalBuildDigest: graph.retrieval.retrievalBuildDigest, compatibilityDigest: graph.retrieval.compatibilityDigest };
  const retrieval = receipt('dkb.retrieval.receipt', { ...fields, evidenceReceiptHash: stableHash(evidence) }, stableHash(evidence));
  const layerBytes = new Map();
  if (downloadable) {
    for (const [kind, buildPath] of [['evidence', graph.evidencePath], ['retrieval', graph.retrievalPath]]) {
      const archive = path.join(fixture.root, `${kind}.archive`);
      await createDkbPackageArchive(buildPath, archive);
      layerBytes.set(kind, await fs.readFile(archive));
    }
  }
  const layer = (kind, value) => ({ kind, digest: kind === 'source' ? sourceHash : layerBytes.has(kind) ? `sha256:${createHash('sha256').update(layerBytes.get(kind)).digest('hex')}` : stableHash({ archive: kind }), mediaType: `application/vnd.dkb.${kind}+gzip`, bytes: layerBytes.get(kind)?.length ?? 1, url: `/api/layers/${kind}`, receiptHash: stableHash(value), receipt: value });
  const payload = { format: 'dkb.install-plan.v1', package: { id: fixture.packageId, version: '1.0.0', sourceDigest: sourceHash }, ...fields, artifacts: [layer('source', source), layer('evidence', evidence), layer('retrieval', retrieval)] };
  const plan = validateInstallPlan({ ...payload, receipt: receipt('dkb.install-plan.receipt', payload) });
  const sourcePath = path.join(fixture.packageRoot, '.dkb-package.json');
  const planPath = path.join(fixture.packageRoot, DKB_INSTALL_PLAN_RECEIPT_PATH);
  await fs.writeFile(sourcePath, JSON.stringify(source));
  await fs.mkdir(path.dirname(planPath), { recursive: true });
  await fs.writeFile(planPath, JSON.stringify(plan));
  await verifyStoredSignedBuildChain({ packageRoot: fixture.packageRoot, graph, target: instance.target, trustedKeys: keys });
  await pinRegistryTrustedKeys({ libraryRoot: fixture.libraryRoot, registryUrl: origin, keys });
  await applyLibraryLock(fixture.libraryRoot, {
    library: { name: 'Warm Runtime Library' }, generation: 2, resolvedAt: signedAt,
    entries: { [fixture.packageId]: { identity: fixture.packageId, kind: 'dkb', source: 'registry', version: '1.0.0', digest: packageTreeHash, path: 'knowledge', registryUrl: origin, requiredBy: [`root:${fixture.packageId}`], installedAt: signedAt } },
  });
  return { ...fixture, sourcePath, planPath, plan, graph, keys, origin, layerBytes, trustPath: registryTrustPath(fixture.libraryRoot, origin) };
}
