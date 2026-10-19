import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { signedDownloadFixture } from './fixtures/signed-download.mjs';
import { collectionSnapshot } from './fixtures/collection-download.mjs';
import { generateSigningKeyPair } from '@sjshovan/dkb-library/signing.js';
import { readLibraryState } from '@sjshovan/dkb-library/state.js';
import { syncLibrary } from '@sjshovan/dkb-library/resolver.js';
import { createRoot, writeJson } from './runtime-query-fixture.mjs';
import { validateLibraryInstallRequest } from '../apps/cli/dist/host/libraryInstallContract.js';
import { installCollectionFromLibraryGrants } from '@sjshovan/dkb-runtime/runtime/collectionGrant.js';

async function fixture(t) {
  const { libraryRoot } = await createRoot(t);
  const keyPairs = { publisher: generateSigningKeyPair(), registry: generateSigningKeyPair() };
  const members = await Promise.all(['@test/alpha', '@test/beta'].map(packageId => signedDownloadFixture(t, { packageId, keyPairs })));
  const collection = collectionSnapshot('@test/bundle', 1, members);
  const grants = members.map((item, index) => ({ plan: item.plan, installGrant: `private-proof-${index}` }));
  const requests = [];
  let failBeta = false;
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    if (req.url === '/.well-known/dkb-registry-keys.json') return res.end(JSON.stringify({ keys: members[0].keys }));
    const index = grants.findIndex(grant => req.headers.authorization === `DKB-Install-Grant ${grant.installGrant}`);
    const item = members[index];
    const artifact = item?.plan.artifacts.find(layer => layer.url === req.url);
    if (!artifact || (failBeta && index === 1)) { res.writeHead(403); return res.end('synthetic expired grant'); }
    res.setHeader('content-type', artifact.mediaType); res.end(item.bytes[artifact.kind]);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const registryUrl = `http://127.0.0.1:${server.address().port}`;
  await writeJson(path.join(libraryRoot, 'dkb.json'), { type: 'library', name: 'Grant consumer', roots: {} });
  await syncLibrary(libraryRoot);
  return { libraryRoot, members, grants, collection, requests, registryUrl,
    failSecondMember() { failBeta = true; },
    install: () => installCollectionFromLibraryGrants({ libraryRoot, registryUrl, collection, members: grants, update: false }) };
}

test('Collection owner rejects extra, missing, duplicate and cross-release grants before delegation', async t => {
  const f = await fixture(t);
  const input = { format: 'dkb.library-collection-install.v1', registryUrl: f.registryUrl,
    registryTransportUrl: f.registryUrl.replace('127.0.0.1', 'host.docker.internal'),
    collection: f.collection, members: f.grants, update: false };
  assert.deepEqual(validateLibraryInstallRequest(input), input);
  for (const patch of [{ token: 'forbidden-secret' }, { force: true }, { libraryRoot: '/host' },
    { members: f.grants.slice(0, 1) }, { members: [f.grants[0], f.grants[0]] },
    { members: [...f.grants, f.grants[0]] }, { update: 'true' },
    { members: [{ ...f.grants[0], installGrant: 'forbidden-secret\n' }, f.grants[1]] },
    { members: [{ ...f.grants[0], token: 'forbidden-secret' }, f.grants[1]] },
    { registryTransportUrl: 'https://attacker.example' },
    { collection: { ...f.collection, digest: `sha256:${'a'.repeat(64)}` } },
  ]) assert.throws(() => validateLibraryInstallRequest({ ...input, ...patch }), error =>
    error.code === 'invalid_library_install_request' && !error.message.includes('forbidden-secret'));
});

test('Collection grant transport installs and reuses exact signed members without a bearer or compiler', async t => {
  const f = await fixture(t);
  const before = await readLibraryState(f.libraryRoot);
  assert.equal((await f.install()).status, 'installed');
  const installed = await readLibraryState(f.libraryRoot);
  assert.equal(installed.generation, before.generation + 1);
  assert.deepEqual(Object.keys(installed.entries).sort(), ['@test/alpha', '@test/beta', '@test/bundle']);
  assert.equal(f.requests.length, 7);
  assert.equal(f.requests[0].authorization, undefined);
  assert.ok(f.requests.slice(1).every(item => item.authorization?.startsWith('DKB-Install-Grant private-proof-')));
  assert.equal((await f.install()).status, 'already_installed');
  assert.deepEqual(await readLibraryState(f.libraryRoot), installed);
  assert.equal(f.requests.length, 8, 'retry fetches public keys only');
});

test('Collection member grant failure rolls back earlier promotion in the same transaction', async t => {
  const f = await fixture(t);
  const before = await readLibraryState(f.libraryRoot);
  f.failSecondMember();
  await assert.rejects(f.install(), /403|expired|grant|download/i);
  assert.deepEqual(await readLibraryState(f.libraryRoot), before);
  assert.equal(f.requests.filter(item => item.authorization === 'DKB-Install-Grant private-proof-0').length, 3);
  for (const name of ['alpha', 'beta', 'bundle']) await assert.rejects(fs.stat(path.join(f.libraryRoot, 'vendor', '@test', name)), { code: 'ENOENT' });
});
