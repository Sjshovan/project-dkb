import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { signedDownloadFixture } from './fixtures/signed-download.mjs';
import { installRegistryCollection } from '@sjshovan/dkb-runtime/runtime/collections.js';
import { readLibraryState } from '@sjshovan/dkb-library/state.js';
import { DKB_INSTALL_PLAN_RECEIPT_PATH } from '@sjshovan/dkb-library/signing.js';
import { registryPackagePath } from '@sjshovan/dkb-protocol/identity.js';
import { syncLibrary, addLibraryRoot, removeLibraryRoot } from '@sjshovan/dkb-library/resolver.js';
import { collectionClient, collectionSnapshot } from './fixtures/collection-download.mjs';
import { generateSigningKeyPair } from '@sjshovan/dkb-library/signing.js';
import { createRoot, writeJson } from './runtime-query-fixture.mjs';

async function setup(t) {
  const fixture = await signedDownloadFixture(t);
  const libraryRoot = path.join(fixture.root, 'collection-consumer');
  await fs.mkdir(libraryRoot);
  await fs.writeFile(path.join(libraryRoot, 'dkb.json'), JSON.stringify({ type: 'library', name: 'Collection consumer', roots: {} }));
  const member = { id: fixture.packageId, version: '1.0.0', digest: fixture.plan.artifacts[0].receipt.payload.packageTreeHash };
  let downloads = 0;
  const client = {
    baseUrl: 'https://registry.example',
    async collectionRevision(id, revision = 1) {
      const manifest = { type: 'collection', id, name: 'Synthetic Collection', revision, members: [member] };
      const digest = `sha256:${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}`;
      return { collectionId: id, revision, digest, manifest: { ...manifest, digest } };
    },
    async packageRelease() { return { packageId: member.id, version: member.version, packageTreeHash: member.digest, status: 'published' }; },
    async publicKeys() { return { keys: fixture.keys }; },
    async installPlan() { return fixture.plan; },
    async writeInstallLayer(artifact, destination) { downloads++; await fs.writeFile(destination, fixture.bytes[artifact.kind]); },
  };
  const install = (collectionId = '@test/bundle', options = {}) => installRegistryCollection({ client, collectionId, libraryRoot, ...options });
  return { ...fixture, libraryRoot, client, install, downloads: () => downloads,
    receiptPath: path.join(registryPackagePath(libraryRoot, fixture.packageId), DKB_INSTALL_PLAN_RECEIPT_PATH) };
}

for (const [description, nextCollection] of [['same revision retry', '@test/bundle'], ['shared member reuse', '@test/another']]) {
  test(`Collection ${description} rejects a corrupt retained member receipt without mutation`, async t => {
    const fixture = await setup(t);
    assert.equal((await fixture.install()).status, 'installed');
    await fs.writeFile(fixture.receiptPath, '{"forged":true}');
    const before = await readLibraryState(fixture.libraryRoot);
    const downloads = fixture.downloads();
    await assert.rejects(() => fixture.install(nextCollection), /receipt|signed|verification|install.plan/i);
    assert.deepEqual(await readLibraryState(fixture.libraryRoot), before);
    assert.equal(fixture.downloads(), downloads);
    assert.equal(await fs.readFile(fixture.receiptPath, 'utf8'), '{"forged":true}');
  });
}

test('Collection verifies its exact immutable revision digest before downloading any member', async t => {
  const fixture = await setup(t);
  const revision = await fixture.client.collectionRevision('@test/bundle');
  fixture.client.collectionRevision = async () => ({ ...revision, digest: `sha256:${'f'.repeat(64)}` });
  await assert.rejects(() => fixture.install(), /collection.*digest|snapshot/i);
  assert.equal(fixture.downloads(), 0);
  assert.deepEqual((await readLibraryState(fixture.libraryRoot)).entries, {});
});

test('Collection validates member plan signatures before downloading any member', async t => {
  const fixture = await setup(t);
  fixture.client.installPlan = async () => ({ ...fixture.plan, target: 'substituted-target' });
  await assert.rejects(() => fixture.install(), /signature|receipt|plan/i);
  assert.equal(fixture.downloads(), 0);
  assert.deepEqual((await readLibraryState(fixture.libraryRoot)).entries, {});
});

test('Collection retry verifies retained source contents as well as signed receipts', async t => {
  const fixture = await setup(t);
  await fixture.install();
  await fs.writeFile(path.join(registryPackagePath(fixture.libraryRoot, fixture.packageId), 'knowledge.md'), 'Tampered source');
  const before = await readLibraryState(fixture.libraryRoot);
  await assert.rejects(() => fixture.install(), /source|tree|digest/i);
  assert.deepEqual(await readLibraryState(fixture.libraryRoot), before);
});

test('Collection retry verifies the installed Collection snapshot before reporting success', async t => {
  const fixture = await setup(t);
  await fixture.install();
  const manifestPath = path.join(registryPackagePath(fixture.libraryRoot, '@test/bundle'), 'dkb.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  await writeJson(manifestPath, { ...manifest, displayName: 'Tampered Collection' });
  const before = await readLibraryState(fixture.libraryRoot);
  await assert.rejects(() => fixture.install(), /snapshot|digest/i);
  assert.deepEqual(await readLibraryState(fixture.libraryRoot), before);
});

test('Collection reuse rejects corrupt exact Retrieval artifacts', async t => {
  const fixture = await setup(t);
  await fixture.install();
  const root = registryPackagePath(fixture.libraryRoot, fixture.packageId);
  const artifactPath = path.join(root, '.dkb', 'builds', 'retrieval', fixture.plan.retrievalProfileDigest.slice(7), fixture.plan.retrievalBuildDigest.slice(7), 'artifacts', 'index.json');
  assert.equal((await fs.stat(artifactPath)).isFile(), true);
  await fs.appendFile(artifactPath, 'tampered');
  const before = await readLibraryState(fixture.libraryRoot);
  await assert.rejects(() => fixture.install('@test/another'), /artifact|hash|digest|index|build/i);
  assert.deepEqual(await readLibraryState(fixture.libraryRoot), before);
});

test('Collection retry is idempotent and synchronization preserves its member Registry origins', async t => {
  const fixture = await setup(t);
  const manifestPath = path.join(fixture.libraryRoot, 'dkb.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  await writeJson(manifestPath, { ...manifest, registry: { url: 'https://different-default.example' } });
  await fixture.install();
  const before = await readLibraryState(fixture.libraryRoot);
  assert.equal(before.entries[fixture.packageId].registryUrl, fixture.client.baseUrl);
  assert.equal(before.entries['@test/bundle'].registryUrl, fixture.client.baseUrl);
  assert.equal((await fixture.install()).status, 'already_installed');
  assert.deepEqual(await readLibraryState(fixture.libraryRoot), before);
  assert.equal(fixture.downloads(), 3);
  await syncLibrary(fixture.libraryRoot);
  assert.deepEqual(await readLibraryState(fixture.libraryRoot), before);
});

test('Collection rolls back a promoted member if a later member layer fails', async t => {
  const { root, libraryRoot } = await createRoot(t);
  const keyPairs = { publisher: generateSigningKeyPair(), registry: generateSigningKeyPair() };
  const alpha = await signedDownloadFixture(t, { packageId: '@test/alpha', keyPairs });
  const beta = await signedDownloadFixture(t, { packageId: '@test/beta', keyPairs });
  await writeJson(path.join(libraryRoot, 'dkb.json'), { type: 'library', name: 'Rollback', roots: {} });
  await syncLibrary(libraryRoot);
  const before = await readLibraryState(libraryRoot);
  const manifestBefore = await fs.readFile(path.join(libraryRoot, 'dkb.json'));
  const revision = collectionSnapshot('@test/bundle', 1, [alpha, beta]);
  const client = collectionClient({ revision, keys: alpha.keys, fixtures: [alpha, beta] });
  const download = client.writeInstallLayer.bind(client);
  let observedPromotedMember = false;
  client.writeInstallLayer = async (artifact, destination) => {
    if (destination.includes(`${path.sep}@test${path.sep}beta${path.sep}`)) {
      observedPromotedMember = (await fs.stat(registryPackagePath(libraryRoot, '@test/alpha'))).isDirectory();
      throw new Error('synthetic second-member download failure');
    }
    return download(artifact, destination);
  };
  await assert.rejects(installRegistryCollection({ libraryRoot, collectionId: revision.collectionId, client }), /second-member download failure/);
  assert.equal(observedPromotedMember, true);
  assert.deepEqual(await readLibraryState(libraryRoot), before);
  assert.deepEqual(await fs.readFile(path.join(libraryRoot, 'dkb.json')), manifestBefore);
  for (const id of ['@test/alpha', '@test/beta', '@test/bundle']) await assert.rejects(fs.stat(registryPackagePath(libraryRoot, id)), { code: 'ENOENT' });
  assert.equal((await fs.stat(root)).isDirectory(), true);
});

test('Collection version updates respect direct ownership and then commit one exact signed replacement', async t => {
  const { libraryRoot } = await createRoot(t);
  const keyPairs = { publisher: generateSigningKeyPair(), registry: generateSigningKeyPair() };
  const original = await signedDownloadFixture(t, { packageId: '@test/member', keyPairs });
  const next = await signedDownloadFixture(t, { packageId: '@test/member', version: '2.0.0', keyPairs });
  await writeJson(path.join(libraryRoot, 'dkb.json'), { type: 'library', name: 'Updates', roots: {} });
  const first = collectionSnapshot('@test/bundle', 1, [original]);
  await installRegistryCollection({ libraryRoot, collectionId: first.collectionId,
    client: collectionClient({ revision: first, keys: original.keys, fixtures: [original] }) });
  await addLibraryRoot(libraryRoot, '@test/member');
  const second = collectionSnapshot('@test/bundle', 2, [next]);
  const update = () => installRegistryCollection({ libraryRoot, collectionId: second.collectionId, update: true,
    client: collectionClient({ revision: second, keys: next.keys, fixtures: [next] }) });
  const protectedState = await readLibraryState(libraryRoot);
  await assert.rejects(update(), /Version conflict/);
  assert.deepEqual(await readLibraryState(libraryRoot), protectedState);
  await removeLibraryRoot(libraryRoot, '@test/member');
  const before = await readLibraryState(libraryRoot);
  assert.equal((await update()).status, 'updated');
  const after = await readLibraryState(libraryRoot);
  assert.equal(after.generation, before.generation + 1);
  assert.equal(after.entries['@test/member'].version, '2.0.0');
  assert.equal(after.entries['@test/member'].digest, next.plan.artifacts[0].receipt.payload.packageTreeHash);
  assert.deepEqual(after.entries['@test/member'].requiredBy, ['collection:@test/bundle']);
  assert.equal(after.entries['@test/bundle'].digest, second.digest);
});
