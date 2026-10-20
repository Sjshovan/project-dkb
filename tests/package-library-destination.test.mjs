import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { generateSigningKeyPair } from '@sjshovan/dkb-library/signing.js';
import { readLibraryState, applyLibraryLock } from '@sjshovan/dkb-library/state.js';
import { installDkbFromRegistry } from '@sjshovan/dkb-runtime/runtime/registryInstall.js';
import { signedDownloadFixture } from './fixtures/signed-download.mjs';
import { writeJson } from './runtime-query-fixture.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../apps/cli/dist/cli/index.js', import.meta.url));

test('native install keeps its explicit Library destination and refreshes only after verified commit', async t => {
  const fixture = await destinationFixture(t);
  fixture.cleanupPending = true;
  const result = await fixture.run(['install', fixture.id, '--version', '1.0.0']);
  assert.equal(result.status, 'installed');
  assert.equal(result.libraryRoot, fixture.consumer);
  assert.equal(result.verification.ok, true);
  assert.equal((await readLibraryState(fixture.consumer)).entries[fixture.id].version, '1.0.0');
  assert.equal(result.runtimeRefreshes[0].status, 'refreshed');
  assert.match(result.warning, /managed-index cleanup needs attention/);
  assert.match(result.runtimeRefreshes[0].recovery, /dkb runtime refresh --url <runtime-url>/);
  assert.deepEqual(fixture.runtimeRequests, [{ method: 'POST', path: '/api/runtime/reload', installedVersion: '1.0.0' }]);
  await fixture.assertUntouched();
});

test('native upgrade with a Runtime URL retains signed rollback, generation checks and refresh warnings', async t => {
  const fixture = await destinationFixture(t);
  await installDkbFromRegistry({ registryUrl: fixture.registryUrl, packageId: fixture.id, version: '1.0.0', libraryRoot: fixture.consumer });
  const before = await readLibraryState(fixture.consumer);
  const firstRequest = fixture.requests.length;
  const dryRun = await fixture.run(['upgrade', fixture.id, '--dry-run']);
  assert.equal(dryRun.latestVersion, '1.1.0');
  assert.equal(dryRun.libraryRoot, fixture.consumer);
  assert.deepEqual(await readLibraryState(fixture.consumer), before);
  assert.equal(fixture.requests.slice(firstRequest).some(item => item.method !== 'GET' || /layers|install-plan/u.test(item.path)), false);
  assert.deepEqual(fixture.runtimeRequests, []);

  fixture.mode = 'corrupt';
  const corrupt = await fixture.run(['upgrade', fixture.id], 1);
  assert.match(corrupt.error.message, /hash|digest|bytes|size/iu);
  assert.deepEqual(await readLibraryState(fixture.consumer), before);
  assert.deepEqual(fixture.runtimeRequests, []);

  fixture.mode = 'drift';
  const beforeDrift = fixture.requests.length;
  const drift = await fixture.run(['upgrade', fixture.id], 1);
  assert.equal(drift.error.code, 'library_upgrade_conflict');
  assert.equal(fixture.requests.length - beforeDrift, 1, 'generation conflict fails before release or artifact acquisition');
  assert.equal((await readLibraryState(fixture.consumer)).entries[fixture.id].version, '1.0.0');
  assert.deepEqual(fixture.runtimeRequests, []);

  fixture.mode = 'normal';
  fixture.reloadFails = true;
  const upgraded = await fixture.run(['upgrade', fixture.id]);
  assert.equal(upgraded.version, '1.1.0');
  assert.equal(upgraded.libraryRoot, fixture.consumer);
  assert.equal(upgraded.verification.ok, true);
  assert.equal((await readLibraryState(fixture.consumer)).entries[fixture.id].version, '1.1.0');
  assert.equal(upgraded.runtimeRefreshes[0].status, 'stale');
  assert.match(upgraded.warning, /Library update succeeded.*stale/u);
  assert.match(upgraded.runtimeRefreshes[0].recovery, /dkb runtime refresh/u);
  assert.deepEqual(fixture.runtimeRequests, [{ method: 'POST', path: '/api/runtime/reload', installedVersion: '1.1.0' }]);
  const firstNoOp = fixture.requests.length;
  assert.equal((await fixture.run(['upgrade', fixture.id])).status, 'up_to_date');
  assert.equal(fixture.requests.length - firstNoOp, 1);
  assert.equal(fixture.runtimeRequests.length, 1);
  await fixture.assertUntouched();
});

async function destinationFixture(t) {
  const keyPairs = { publisher: generateSigningKeyPair(), registry: generateSigningKeyPair() };
  const first = await signedDownloadFixture(t, { keyPairs });
  const second = await signedDownloadFixture(t, { keyPairs, version: '1.1.0' });
  const consumer = path.join(first.root, 'consumer');
  await writeJson(path.join(consumer, 'dkb.json'), { type: 'library', name: 'Install destination', roots: {} });
  const unrelatedBefore = await readLibraryState(second.libraryRoot);
  const fixture = { id: first.packageId, consumer, requests: [], runtimeRequests: [], mode: 'normal', reloadFails: false };
  let selected = first;
  const registry = http.createServer(async (request, response) => {
    try {
      fixture.requests.push({ method: request.method, path: request.url });
      response.setHeader('content-type', 'application/json');
      if (request.url === '/.well-known/dkb-registry-keys.json') return response.end(JSON.stringify({ keys: first.keys }));
      if (request.url === '/api/registry/packages/test/knowledge') {
        if (fixture.mode === 'drift') {
          const lock = JSON.parse(await fs.readFile(path.join(consumer, 'dkb-lock.json'), 'utf8'));
          await applyLibraryLock(consumer, { ...lock, generation: lock.generation + 1 });
        }
        return response.end(JSON.stringify({ data: { id: fixture.id, namespace: 'test', name: 'Knowledge', slug: 'knowledge',
          latestVersion: '1.1.0', versions: [{ version: '1.1.0', status: 'published' }] } }));
      }
      const version = request.url.match(/^\/api\/registry\/packages\/test\/knowledge\/versions\/(1\.[01]\.0)(.*)$/u);
      if (version) {
        selected = version[1] === '1.0.0' ? first : second;
        if (!version[2]) return response.end(JSON.stringify({ data: { packageId: fixture.id, version: selected.version, status: 'published' } }));
        if (version[2] === '/install-plan') return response.end(JSON.stringify(selected.plan));
        // Exercise the old redirect as an actual successful remote response before
        // asserting the destination. New code must never request this grant.
        if (version[2] === '/install-grant') return response.end(JSON.stringify({ plan: selected.plan,
          installGrant: 'synthetic-grant', expiresAt: new Date(Date.now() + 60_000).toISOString() }));
      }
      const layer = selected.plan.artifacts.find(item => item.url === request.url);
      if (layer) {
        response.setHeader('content-type', layer.mediaType);
        const bytes = Buffer.from(selected.bytes[layer.kind]);
        if (fixture.mode === 'corrupt') bytes[0] ^= 255;
        return response.end(bytes);
      }
      response.writeHead(404); response.end(JSON.stringify({ error: 'Unexpected Registry request' }));
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
  });
  const runtime = http.createServer(async (request, response) => {
    try {
      const installedVersion = (await readLibraryState(consumer)).entries[fixture.id]?.version;
      fixture.runtimeRequests.push({ method: request.method, path: request.url, installedVersion });
      assert.equal(request.headers.authorization, 'Bearer synthetic-admin');
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/dkbs/install-registry') {
        for await (const _ of request) { /* drain the old path's request */ }
        return response.end(JSON.stringify({ status: 'installed', packageId: fixture.id, version: selected.version,
          libraryRoot: second.libraryRoot }));
      }
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/api/runtime/reload');
      if (fixture.reloadFails) { response.writeHead(503); return response.end(JSON.stringify({ error: 'synthetic-private-reload-detail' })); }
      response.end(JSON.stringify({ status: 'reloaded', ...(fixture.cleanupPending
        ? { indexCleanup: { pending: 1 }, warning: 'synthetic-private-reload-detail' } : {}) }));
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
  });
  for (const server of [registry, runtime]) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    first.disposers.push(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  }
  fixture.registryUrl = `http://127.0.0.1:${registry.address().port}`;
  const runtimeUrl = `http://127.0.0.1:${runtime.address().port}`;
  const environment = { ...process.env, DKB_HOST_INVENTORY: path.join(first.root, 'host.json'),
    DKB_CLI_CONFIG: path.join(first.root, 'cli.json'), DKB_GLOBAL_ROOT: path.join(first.root, 'global'),
    DKB_RUNTIME_CREDENTIALS_ROOT: path.join(first.root, 'credentials'), DKB_RUNTIME_ADMIN_TOKEN: 'synthetic-admin',
    DKB_REGISTRY_CREDENTIALS: path.join(first.root, 'registry-credentials.json'), DKB_REGISTRY_TOKEN: '', DKB_FORCE_TTY: '0' };
  delete environment.DKB_LIBRARY_PATH; delete environment.DKB_REGISTRY_URL;
  fixture.run = async (args, expectedCode = 0) => {
    let result;
    try { result = { code: 0, ...await execute(process.execPath, [cli, '--json', ...args, '--library', consumer,
      '--url', fixture.registryUrl, '--runtime-url', runtimeUrl], { cwd: first.root, env: environment, windowsHide: true, timeout: 45_000 }) }; }
    catch (error) { assert.equal(error.killed, false, error.message); result = error; }
    assert.equal(result.code, expectedCode, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-admin|synthetic-grant|synthetic-private-reload-detail|\u001b\[/u);
    return JSON.parse(result.stdout);
  };
  fixture.assertUntouched = async () => {
    assert.deepEqual(await readLibraryState(second.libraryRoot), unrelatedBefore);
    assert.equal(fixture.requests.some(item => item.method !== 'GET'), false);
  };
  return fixture;
}
