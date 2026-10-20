import assert from 'node:assert/strict';
import test from 'node:test';
import { registryCollectionDigest, validateRegistryCollectionRevision } from '@sjshovan/dkb-protocol/registryCollections.js';
import { DkbRegistryClient } from '@sjshovan/dkb-registry-client/client.js';

const snapshot = name => ({ type: 'collection', id: '@test/bundle', name, revision: 2,
  members: [{ id: '@test/knowledge', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` }] });
function revision(manifest = snapshot('Synthetic Collection')) {
  const digest = registryCollectionDigest(manifest);
  return { collectionId: manifest.id, revision: manifest.revision, digest, manifest: { ...manifest, digest } };
}

test('Collection digest matches Registry PHP ordered JSON, including Unicode and escaping', () => {
  // Independently generated with PHP json_encode(JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR).
  for (const [name, hash] of [
    ['Synthetic Collection', '772cdbc1202d9623aed195ca892a0b5092a285f98d40c3601f833fe20c181f97'],
    ['Café / 東京 🐋\nLine\u2028two\u2029', 'd6e636ba52fbf0ac95afe407c197b14e356e2abff1b24cd4653f8da3ac0ac3e5'],
    ['quotes" / slash \\ tab\t', 'f81dd53f1f2036b4f65d3b689480caad038d247d51ffc2390bf3d71ea93b0527'],
  ]) {
    const value = revision(snapshot(name));
    assert.equal(value.digest, `sha256:${hash}`);
    assert.deepEqual(validateRegistryCollectionRevision(value, { collectionId: value.collectionId, revision: 2 }), value);
  }
});

test('Collection revisions reject wrong selectors, mutable versions, duplicates, unsorted members and digest drift', () => {
  const valid = revision();
  for (const mutate of [
    value => { value.collectionId = '@test/other'; },
    value => { value.revision = 3; },
    value => { value.manifest.revision = 1; },
    value => { value.manifest.name = 'tampered'; },
    value => { value.manifest.digest = `sha256:${'b'.repeat(64)}`; },
    value => { value.manifest.members[0].digest = `sha256:${'b'.repeat(64)}`; },
    value => { value.manifest.members[0].id = '../escape'; },
    value => { value.manifest.members[0].version = 'latest'; },
    value => { value.manifest.members.push({ ...value.manifest.members[0] }); },
    value => { value.manifest.members.push({ ...value.manifest.members[0], id: '@test/earlier' }); },
    value => { value.manifest.members = []; },
    value => { value.manifest.members[0].plugin = 'executable'; },
    value => { value.manifest.extra = true; },
    value => { value.manifest.name = '\ud800'; },
    value => { value.publishedAt = 'not-a-timestamp'; },
  ]) {
    const value = structuredClone(valid);
    mutate(value);
    assert.throws(() => validateRegistryCollectionRevision(value, { collectionId: valid.collectionId, revision: 2 }));
  }
  assert.throws(() => validateRegistryCollectionRevision(valid, { collectionId: valid.collectionId, revision: 1 }), { code: 'invalid_collection_revision' });
  assert.throws(() => validateRegistryCollectionRevision(revision({ ...snapshot('valid'), revision: 0 }), { collectionId: valid.collectionId }));
});

test('Registry client validates both fetched and newly published Collection snapshots', async t => {
  let response = { ...revision(), publishedAt: '2026-10-13T00:00:00.000000Z' };
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: response }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const client = new DkbRegistryClient({ baseUrl: 'https://registry.example', token: '' });
  assert.deepEqual(await client.collectionRevision('@test/bundle', 2), response);
  await assert.rejects(client.collectionRevision('@test/bundle', 1), { code: 'invalid_collection_revision' });
  response = { ...response, digest: `sha256:${'f'.repeat(64)}` };
  await assert.rejects(client.publishCollection({ id: '@test/bundle', name: 'Synthetic Collection', members: [{ id: '@test/knowledge', version: '1.0.0' }] }), { code: 'invalid_collection_revision' });
});
