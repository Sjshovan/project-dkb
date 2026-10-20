import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { signedDownloadFixture } from './fixtures/signed-download.mjs';
import { validateLibraryInstallRequest, dockerRegistryTransportUrl, LIBRARY_INSTALL_FORMAT, LIBRARY_INSTALL_INPUT_LIMIT } from '../apps/cli/dist/host/libraryInstallContract.js';
import { installDkbFromLibraryGrant } from '@sjshovan/dkb-runtime/runtime/registryInstall.js';
import { readLibraryState } from '@sjshovan/dkb-library/state.js';
import { listLibraryPackages } from '@sjshovan/dkb-runtime/runtime/state.js';

test('grant owner validates exact private input and permits only a fixed Docker loopback translation', async t => {
  const fixture = await signedDownloadFixture(t);
  const request = { format: LIBRARY_INSTALL_FORMAT, registryUrl: 'http://127.0.0.1:8000',
    registryTransportUrl: 'http://host.docker.internal:8000', installGrant: 'synthetic-private-grant', plan: fixture.plan, force: false };
  assert.deepEqual(validateLibraryInstallRequest(request), request);
  assert.equal(validateLibraryInstallRequest({ ...request, expectedLibraryGeneration: 1 }).expectedLibraryGeneration, 1);
  assert.equal(dockerRegistryTransportUrl('https://registry.example/base/'), 'https://registry.example/base');
  assert.equal(dockerRegistryTransportUrl('http://[::1]:8080/base'), 'http://host.docker.internal:8080/base');
  for (const patch of [
    { token: 'must-not-leak' }, { registryTransportUrl: 'http://attacker.test:8000' },
    { registryTransportUrl: 'http://host.docker.internal:8001' }, { registryTransportUrl: 'http://host.docker.internal:8000/other' },
    { registryUrl: 'https://secret:must-not-leak@registry.example' }, { installGrant: '' }, { installGrant: 'must-not-leak\n' },
    { installGrant: 'x'.repeat(4097) }, { force: 'true' }, { libraryRoot: '/other' }, { format: 'previous' },
    { expectedLibraryGeneration: -1 }, { expectedLibraryGeneration: 1.5 }, { expectedLibraryGeneration: '1' },
    { expectedLibraryGeneration: Number.MAX_SAFE_INTEGER + 1 }, { format: 'dkb.library-install.v1' },
    { environment: { SECRET: 'must-not-leak' } }, { plan: { ...fixture.plan, target: 'x'.repeat(LIBRARY_INSTALL_INPUT_LIMIT) } },
  ]) assert.throws(() => validateLibraryInstallRequest({ ...request, ...patch }), error =>
    error.code === 'invalid_library_install_request' && !error.message.includes('must-not-leak'));
});

test('owner transport fixture contains a complete verifiable downloadable source and build chain', async t => {
  const fixture = await signedDownloadFixture(t);
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization });
    if (req.url === '/.well-known/dkb-registry-keys.json') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ keys: fixture.keys })); }
    const layer = fixture.plan.artifacts.find(item => item.url === req.url);
    if (!layer || req.headers.authorization !== 'DKB-Install-Grant proof') { res.writeHead(403); return res.end(); }
    res.setHeader('content-type', layer.mediaType); res.end(fixture.bytes[layer.kind]);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const libraryRoot = path.join(fixture.root, 'consumer');
  await fs.mkdir(libraryRoot);
  await fs.writeFile(path.join(libraryRoot, 'dkb.json'), JSON.stringify({ type: 'library', name: 'Consumer', roots: {} }));
  const result = await installDkbFromLibraryGrant({ libraryRoot, plan: fixture.plan, installGrant: 'proof', registryUrl: `http://127.0.0.1:${server.address().port}` });
  assert.equal(result.status, 'installed');
  assert.equal(result.verification.ok, true);
  assert.equal(requests.length, 4);
  assert.equal(requests[0].auth, undefined);
  assert.equal(requests.slice(1).every(item => item.auth === 'DKB-Install-Grant proof'), true);
  const state = await readLibraryState(libraryRoot);
  const listing = await listLibraryPackages(libraryRoot);
  assert.equal(listing.generation, state.generation);
  assert.equal(listing.packages[0].source, 'registry');
  assert.equal(listing.packages[0].registryUrl, `http://127.0.0.1:${server.address().port}`);
  const before = requests.length;
  await assert.rejects(installDkbFromLibraryGrant({ libraryRoot, plan: fixture.plan, installGrant: 'proof',
    registryUrl: `http://127.0.0.1:${server.address().port}`, force: true, expectedLibraryGeneration: state.generation - 1 }),
    { code: 'library_upgrade_conflict' });
  assert.equal(requests.length, before, 'stale upgrade is rejected before any remote access');
  assert.deepEqual(await readLibraryState(libraryRoot), state);
  const current = await installDkbFromLibraryGrant({ libraryRoot, plan: fixture.plan, installGrant: 'proof',
    registryUrl: `http://127.0.0.1:${server.address().port}`, expectedLibraryGeneration: state.generation });
  assert.equal(current.status, 'already_installed');
});
