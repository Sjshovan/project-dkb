// Opt-in real CLI/Console -> grant-only worker -> Linux Collection transaction.
// Synthetic signed HTTP Registry; no personal Library, real Registry, or model quality claim.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { generateSigningKeyPair } from '@sjshovan/dkb-library/signing.js';
import { signedDownloadFixture } from './fixtures/signed-download.mjs';
import { collectionSnapshot } from './fixtures/collection-download.mjs';
import { ownerDockerProcess } from '../apps/cli/dist/host/dockerOwnerProcess.js';
import { readDockerLibraryCommand } from '../apps/cli/dist/host/libraryOwnerResult.js';
import { installDockerLibraryPackage } from '../apps/cli/dist/host/libraryInstall.js';
import { LIBRARY_COLLECTION_INSTALL_FORMAT, dockerRegistryTransportUrl } from '../apps/cli/dist/host/libraryInstallContract.js';
import { ConsoleCommandRunner } from '@sjshovan/dkb-console';
import { ConsoleActivityStore } from '../apps/console/dist/server/activity.js';

if (process.argv.length !== 3 || process.argv[2] !== '--run') throw new Error('Run explicitly with --run');
const hooks = [], t = { after: callback => hooks.push(callback) };
const docker = async args => {
  const result = await ownerDockerProcess(args, { timeoutMs: 30_000 });
  assert.equal(result.code, 0, result.stderr); return result.stdout.trim();
};
const context = await docker(['context', 'show']);
const call = args => docker(['--context', context, ...args]);
const image = await call(['image', 'inspect', 'dkb-cli:collection-candidate', '--format', '{{.Id}}']);
const id = randomUUID(), volume = `dkb-collection-owner-proof-${id}`, owner = { context, image, volume };
const checks = [], requests = [];
const record = check => { checks.push(check); console.log(JSON.stringify({ check, status: 'passed' })); };
const secret = `synthetic-${id}`, bearer = `dkb_${id}`;
const redacted = value => assert.equal(JSON.stringify(value).includes(secret) || JSON.stringify(value).includes(bearer), false);
let created = false, mode = 'normal', reachedBeta;
try {
  const keyPairs = { publisher: generateSigningKeyPair(), registry: generateSigningKeyPair() };
  const alpha = await signedDownloadFixture(t, { packageId: '@test/alpha', keyPairs });
  const beta = await signedDownloadFixture(t, { packageId: '@test/beta', keyPairs });
  const alpha2 = await signedDownloadFixture(t, { packageId: '@test/alpha', version: '2.0.0', keyPairs });
  const fixtures = [alpha, beta, alpha2];
  const revisions = [collectionSnapshot('@test/bundle', 1, [alpha, beta]), collectionSnapshot('@test/bundle', 2, [alpha2, beta])];
  const grantFor = fixture => `${secret}-${fixtures.indexOf(fixture)}`;
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization });
    if (req.url === '/.well-known/dkb-registry-keys.json') return res.end(JSON.stringify({ keys: alpha.keys }));
    if (req.url.startsWith('/api/registry/')) {
      if (req.headers.authorization !== `Bearer ${bearer}`) { res.writeHead(401); return res.end(); }
      res.setHeader('content-type', 'application/json');
      const parts = req.url.split('/').map(decodeURIComponent);
      if (parts[3] === 'collections' && parts[4] === 'test' && parts[5] === 'bundle') {
        const data = parts[6] === 'revisions' ? revisions[parts[7] === 'latest' ? 1 : Number(parts[7]) - 1] : { id: '@test/bundle' };
        if (data) return res.end(JSON.stringify({ data }));
      }
      if (parts[3] === 'packages') {
        const fixture = fixtures.find(item => item.packageId === `@${parts[4]}/${parts[5]}` && (!parts[7] || item.version === parts[7]));
        if (fixture && req.method === 'POST' && parts[8] === 'install-grant') return res.end(JSON.stringify({
          plan: fixture.plan, installGrant: grantFor(fixture), expiresAt: new Date(Date.now() + 300_000).toISOString(),
        }));
        if (fixture && req.method === 'GET') return res.end(JSON.stringify({ data: { id: fixture.packageId, latestVersion: fixture.version } }));
      }
      res.writeHead(404); return res.end('{}');
    }
    const fixture = fixtures.find(item => req.headers.authorization === `DKB-Install-Grant ${grantFor(item)}`);
    const layer = fixture?.plan.artifacts.find(item => item.url === req.url);
    if (!layer) { res.writeHead(403); return res.end(); }
    if (fixture === beta && mode === 'fail-beta') { res.writeHead(403); return res.end(`Do not echo ${secret}`); }
    if (fixture === beta && mode === 'pause-beta') { reachedBeta?.(); return; }
    res.setHeader('content-type', layer.mediaType); res.end(fixture.bytes[layer.kind]);
  });
  await new Promise(resolve => server.listen(0, process.platform === 'linux' ? '0.0.0.0' : '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const registryUrl = `http://127.0.0.1:${server.address().port}`;
  const read = (command, input = {}) => readDockerLibraryCommand(owner, command, input, { libraryName: 'collection-proof' });
  await call(['volume', 'create', '--driver', 'local', '--label', `dev.dkb.collection-owner.proof=${id}`, volume]); created = true;
  await read('library.init', { registryUrl, displayName: 'Collection owner proof' });
  const empty = await read('library.packages');
  const host = path.join(alpha.root, 'collection-host'); await fs.mkdir(host);
  const cliPath = fileURLToPath(new URL('../apps/cli/dist/cli/index.js', import.meta.url));
  const environment = { ...process.env, DKB_HOST_INVENTORY: path.join(host, 'host.json'), DKB_CLI_CONFIG: path.join(host, 'config.json'),
    DKB_GLOBAL_ROOT: path.join(host, 'global'), DKB_RUNTIME_CREDENTIALS_ROOT: path.join(host, 'credentials'),
    DKB_REGISTRY_TOKEN: bearer, DKB_REGISTRY_CREDENTIALS: path.join(host, 'registry-credentials.json') };
  delete environment.DKB_LIBRARY_PATH; delete environment.DKB_REGISTRY_URL;
  await fs.writeFile(environment.DKB_REGISTRY_CREDENTIALS, JSON.stringify({ format: 'dkb.credentials.v1',
    registries: { [registryUrl]: { token: bearer, savedAt: new Date().toISOString() } } }), { mode: 0o600 });
  const cli = async (args, expected = 0) => {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, ...args], { cwd: host, env: environment, shell: false, windowsHide: true });
      let stdout = '', stderr = '';
      child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
      const timer = setTimeout(() => child.kill(), 60_000);
      child.once('error', reject); child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    redacted(result); assert.equal(result.code, expected, result.stdout || result.stderr); return result.stdout;
  };
  const scoped = args => [...args, '--library', 'collection-proof'];
  await cli(['--json', 'library', 'register', '--name', 'collection-proof', '--docker-volume', volume, '--docker-context', context, '--owner-image', image]);
  const events = (await cli(['--json-stream', ...scoped(['install', '@test/bundle', '--revision', '1'])])).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(item => item.event === 'result').length, 1);
  assert.equal(events.at(-1).status, 'succeeded');
  assert.equal(events.find(item => item.event === 'result').value.digest, revisions[0].digest);
  assert.ok(events.some(item => item.event === 'progress' && item.phase === 'collection-grants'));
  assert.equal((await read('library.packages')).packages.length, 3);
  const layerCount = () => requests.filter(item => item.path.startsWith('/api/layers/')).length;
  const downloads = layerCount();
  const human = await cli(['--no-progress', ...scoped(['collection', 'install', '@test/bundle', '--revision', '1'])]);
  assert.match(human, /@test\/bundle/u); assert.doesNotMatch(human, /unknown|\u001b\[/u);
  assert.equal(layerCount(), downloads);
  record('public CLI installs exact signed Collection and retries without artifact downloads');

  await read('library.add', { identity: '@test/alpha' });
  const removed = JSON.parse(await cli(['--json', ...scoped(['uninstall', '@test/bundle'])]));
  assert.deepEqual(removed.removedDkbs, ['@test/beta']);
  assert.deepEqual((await read('library.packages')).packages.map(item => item.id), ['@test/alpha']);
  const envKeys = ['DKB_HOST_INVENTORY', 'DKB_CLI_CONFIG', 'DKB_GLOBAL_ROOT', 'DKB_RUNTIME_CREDENTIALS_ROOT', 'DKB_REGISTRY_TOKEN', 'DKB_REGISTRY_CREDENTIALS'];
  const prior = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) process.env[key] = environment[key];
  const activity = new ConsoleActivityStore(path.join(host, 'activity.sqlite'));
  const runner = new ConsoleCommandRunner({ cliEntrypoint: cliPath, cwd: host, activity });
  const beforeReuse = layerCount();
  try {
    const operation = await runner.run('package.install', { identity: '@test/bundle', revision: 1, library: 'collection-proof', registryUrl });
    assert.equal(operation.status, 'succeeded', JSON.stringify(operation.events));
    assert.equal(operation.result.digest, revisions[0].digest);
    assert.equal(operation.events.filter(item => item.event === 'result').length, 1);
    assert.equal(activity.list().activities[0].status, 'succeeded'); redacted(operation); redacted(activity.list());
    await assert.rejects(fs.access(path.join(host, '.dkb/state.sqlite')), { code: 'ENOENT' });
  } finally {
    await runner.close(); activity.close();
    for (const key of envKeys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; }
  }
  assert.equal(layerCount() - beforeReuse, 3, 'only the missing member is downloaded');
  record('Console reuses the direct member, records Activity, and keeps host credentials out of worker downloads');

  const beforeConflict = await read('library.packages');
  await cli(['--json', ...scoped(['collection', 'update', '@test/bundle', '--revision', '2'])], 1);
  assert.deepEqual(await read('library.packages'), beforeConflict);
  await read('library.remove', { identity: '@test/alpha' });
  const updated = JSON.parse(await cli(['--json', ...scoped(['collection', 'update', '@test/bundle', '--revision', '2'])]));
  assert.equal(updated.status, 'updated'); assert.equal(updated.digest, revisions[1].digest);
  assert.equal((await read('library.packages')).packages.find(item => item.id === '@test/alpha').version, '2.0.0');
  record('explicit Collection update protects direct ownership and promotes the exact new member version');
  await cli(['--json', ...scoped(['collection', 'uninstall', '@test/bundle'])]);
  assert.deepEqual(await read('library.packages'), empty);

  mode = 'fail-beta';
  await cli(['--json', ...scoped(['install', '@test/bundle', '--revision', '1'])], 1);
  assert.deepEqual(await read('library.packages'), empty);
  record('expired second-member grant rolls back the already-promoted first member');

  mode = 'pause-beta';
  const reached = new Promise(resolve => { reachedBeta = resolve; });
  const controller = new AbortController();
  const request = { format: LIBRARY_COLLECTION_INSTALL_FORMAT, registryUrl, registryTransportUrl: dockerRegistryTransportUrl(registryUrl),
    collection: revisions[0], members: [alpha, beta].map(item => ({ plan: item.plan, installGrant: grantFor(item) })), update: false };
  const running = installDockerLibraryPackage(owner, request, { libraryName: 'collection-proof', signal: controller.signal });
  running.catch(() => {});
  const timer = new AbortController();
  try { await Promise.race([reached, delay(30_000, undefined, { signal: timer.signal }).then(() => { throw new Error('Second download not reached'); })]); }
  finally { timer.abort(); }
  const ids = (await call(['container', 'ls', '--filter', `volume=${volume}`, '--format', '{{.ID}}'])).split(/\s+/u).filter(Boolean);
  assert.equal(ids.length, 1);
  const [metadata] = JSON.parse(await call(['container', 'inspect', ids[0]]));
  redacted(metadata.Config);
  assert.equal(metadata.Config.Env.some(item => /DKB_REGISTRY_TOKEN|DKB_REGISTRY_CREDENTIAL/iu.test(item)), false);
  const scratch = metadata.Mounts.find(item => item.Destination === '/scratch').Name;
  controller.abort();
  await assert.rejects(running, error => error.code === 'library_owner_cancelled' && /dkb library recover --library "collection-proof"/u.test(error.message));
  assert.equal((await ownerDockerProcess(['--context', context, 'container', 'inspect', ids[0]])).code, 1);
  assert.equal((await ownerDockerProcess(['--context', context, 'volume', 'inspect', scratch])).code, 1);
  await assert.rejects(read('library.packages'), { code: 'library_recovery_required' });
  await cli(['--json', ...scoped(['library', 'recover'])]);
  assert.deepEqual(await read('library.packages'), empty);
  record('cancelled worker is removed with scratch; explicit owner recovery restores the prior Library');
  mode = 'normal';
  const installed = JSON.parse(await cli(['--json', ...scoped(['install', '@test/bundle', '--revision', '1'])]));
  assert.equal(installed.digest, revisions[0].digest); assert.deepEqual(installed.members, revisions[0].manifest.members);
  assert.ok(requests.filter(item => item.path.startsWith('/api/registry/')).every(item => item.authorization === `Bearer ${bearer}`));
  assert.ok(requests.filter(item => item.path.startsWith('/api/layers/')).every(item => item.authorization?.startsWith(`DKB-Install-Grant ${secret}`)));
  record('reinstall preserves exact release identities without compilation; only scoped grants crossed into Linux');
} finally {
  if (created) {
    const ids = (await call(['container', 'ls', '--all', '--filter', `volume=${volume}`, '--format', '{{.ID}}'])).split(/\s+/u).filter(Boolean);
    for (const container of ids) {
      const [metadata] = JSON.parse(await call(['container', 'inspect', container]));
      assert.equal(metadata.Image, image); assert.match(metadata.Config.Labels?.['dev.dkb.owner.operation'] ?? '', /^[a-f0-9-]{36}$/u);
      assert.ok(metadata.Mounts.every(item => item.Type === 'volume' && (item.Name === volume || item.Destination === '/scratch')));
      await call(['container', 'rm', '--force', '--volumes', container]);
    }
    const [metadata] = JSON.parse(await call(['volume', 'inspect', volume]));
    assert.equal(metadata.Labels['dev.dkb.collection-owner.proof'], id); await call(['volume', 'rm', volume]);
  }
  for (const cleanup of hooks.reverse()) await cleanup();
}
console.log(JSON.stringify({ status: 'passed', image, checks, userResourcesChanged: false }));
