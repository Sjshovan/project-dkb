// Explicit packaged-CLI/Linux-volume proof. Uses a disposable signed HTTP fixture, not Laravel.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { signedDownloadFixture } from './fixtures/signed-download.mjs';
import { ownerDockerProcess } from '../apps/cli/dist/host/dockerOwnerProcess.js';
import { readDockerLibraryCommand } from '../apps/cli/dist/host/libraryOwnerResult.js';
import { installDockerLibraryPackage } from '../apps/cli/dist/host/libraryInstall.js';
import { LIBRARY_INSTALL_FORMAT, dockerRegistryTransportUrl } from '../apps/cli/dist/host/libraryInstallContract.js';
import { ConsoleCommandRunner } from '@sjshovan/dkb-console';
import { ConsoleActivityStore } from '../apps/console/dist/server/activity.js';
import { generateSigningKeyPair } from '@sjshovan/dkb-library/signing.js';

if (process.argv.length !== 3 || process.argv[2] !== '--run') throw new Error('Run explicitly with --run');
const hooks = [], t = { after: callback => hooks.push(callback) };
const docker = async args => {
  const result = await ownerDockerProcess(args, { timeoutMs: 30_000 });
  assert.equal(result.code, 0, result.stderr); return result.stdout.trim();
};
const context = await docker(['context', 'show']);
const call = args => docker(['--context', context, ...args]);
const image = await call(['image', 'inspect', process.env.DKB_PROOF_CLI_IMAGE ?? 'dkb-cli:upgrade-candidate', '--format', '{{.Id}}']);
const id = randomUUID(), volume = `dkb-install-proof-${id}`, label = `dev.dkb.install.proof=${id}`;
const owner = { context, image, volume };
const checks = [];
const record = check => { checks.push(check); console.log(JSON.stringify({ check, status: 'passed' })); };
let created = false, pendingRequest, failure, mode = 'normal';
const requests = [], scratches = new Set();
try {
  const keyPairs = { publisher: generateSigningKeyPair(), registry: generateSigningKeyPair() };
  const fixture = await signedDownloadFixture(t, { keyPairs });
  const upgradeFixture = await signedDownloadFixture(t, { keyPairs, version: '1.1.0' });
  const grant = `grant-${randomUUID()}`;
  const upgradeGrant = `grant-${randomUUID()}`;
  let latest = '1.0.0';
  const bearer = `dkb_${randomUUID().replaceAll('-', '')}`;
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization });
    if (req.url === '/.well-known/dkb-registry-keys.json') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ keys: fixture.keys })); }
    if (req.url.startsWith('/api/registry/packages/')) {
      if (req.headers.authorization !== `Bearer ${bearer}`) { res.writeHead(401); return res.end(); }
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/install-grant') && req.method === 'POST') {
        const upgrading = req.url.includes('/versions/1.1.0/');
        return res.end(JSON.stringify({ plan: upgrading ? upgradeFixture.plan : fixture.plan,
          installGrant: upgrading ? upgradeGrant : grant, expiresAt: new Date(Date.now() + 300_000).toISOString() }));
      }
      if (req.method === 'GET') return res.end(JSON.stringify({ data: { id: fixture.packageId, latestVersion: latest } }));
    }
    const selected = req.headers.authorization === `DKB-Install-Grant ${upgradeGrant}` ? upgradeFixture : fixture;
    const layer = selected.plan.artifacts.find(item => item.url === req.url);
    if (!layer || ![grant, upgradeGrant].some(value => req.headers.authorization === `DKB-Install-Grant ${value}`)) { res.writeHead(403); return res.end(); }
    if (mode === 'expired') { res.writeHead(403); return res.end(`Do not echo ${grant}`); }
    res.setHeader('content-type', layer.mediaType);
    if (mode === 'pause') { pendingRequest?.(); return; }
    const bytes = Buffer.from(selected.bytes[layer.kind]);
    if (mode === 'corrupt') bytes[0] ^= 1;
    res.end(bytes);
  });
  await new Promise(resolve => server.listen(0, process.platform === 'linux' ? '0.0.0.0' : '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const registryUrl = `http://127.0.0.1:${server.address().port}`;
  const request = { format: LIBRARY_INSTALL_FORMAT, registryUrl, registryTransportUrl: dockerRegistryTransportUrl(registryUrl),
    installGrant: grant, plan: fixture.plan, force: false };
  await call(['volume', 'create', '--label', label, volume]); created = true;
  await readDockerLibraryCommand(owner, 'library.init', { registryUrl, displayName: 'Signed owner proof' });
  const installed = await installDockerLibraryPackage(owner, request, { libraryName: 'proof' });
  assert.equal(installed.status, 'installed'); assert.equal(installed.verification.ok, true);
  assert.equal(requests[0].authorization, undefined);
  assert.equal(requests.slice(1).every(item => item.authorization === `DKB-Install-Grant ${grant}`), true);
  const baseline = await readDockerLibraryCommand(owner, 'library.packages');
  assert.equal(baseline.packages.length, 1);
  record('signed layers install in a Linux Library without Runtime or host database access');
  const before = requests.length;
  assert.equal((await installDockerLibraryPackage(owner, request, { libraryName: 'proof' })).status, 'already_installed');
  assert.deepEqual(requests.slice(before).map(item => item.path), ['/.well-known/dkb-registry-keys.json']);
  record('exact retry verifies retained signed builds without downloading or recompiling');
  for (const value of ['corrupt', 'expired']) {
    mode = value;
    await assert.rejects(installDockerLibraryPackage(owner, { ...request, force: true }, { libraryName: 'proof' }),
      error => !error.message.includes(grant));
    assert.deepEqual(await readDockerLibraryCommand(owner, 'library.packages'), baseline);
  }
  record('corrupt bytes and expired grant preserve installed state and redact remote errors');
  mode = 'pause';
  const reached = new Promise(resolve => { pendingRequest = resolve; });
  const controller = new AbortController();
  const active = installDockerLibraryPackage(owner, { ...request, force: true }, { libraryName: 'proof', signal: controller.signal });
  active.catch(() => {});
  const deadline = new AbortController();
  try {
    await Promise.race([reached, delay(30_000, undefined, { signal: deadline.signal }).then(() => { throw new Error('Download did not reach fixture'); })]);
  } finally { deadline.abort(); }
  const containers = (await call(['container', 'ls', '--filter', 'name=dkb-install-owner-', '--format', '{{.ID}}'])).split(/\s+/u).filter(Boolean);
  const owned = [];
  for (const container of containers) {
    const [metadata] = JSON.parse(await call(['container', 'inspect', container]));
    if (metadata.Mounts.some(item => item.Name === volume)) {
      assert.equal(metadata.Image, image); assert.equal(metadata.HostConfig.NetworkMode, 'bridge');
      assert.equal(metadata.Config.Env.some(item => /DKB_REGISTRY_TOKEN|DKB_REGISTRY_CREDENTIAL/iu.test(item)), false);
      assert.equal(JSON.stringify(metadata.Config).includes(grant), false);
      const scratch = metadata.Mounts.find(item => item.Destination === '/scratch');
      assert.equal(scratch.Type, 'volume'); assert.notEqual(scratch.Name, volume);
      scratches.add(scratch.Name); owned.push(container);
    }
  }
  assert.equal(owned.length, 1);
  controller.abort();
  await assert.rejects(active, { code: 'library_owner_cancelled' });
  for (const container of owned) assert.equal((await ownerDockerProcess(['--context', context, 'container', 'inspect', container])).code, 1);
  for (const scratch of scratches) assert.equal((await ownerDockerProcess(['--context', context, 'volume', 'inspect', scratch])).code, 1);
  assert.deepEqual(await readDockerLibraryCommand(owner, 'library.packages'), baseline);
  record('cancellation confirms container and anonymous scratch removal while retaining the Library');
  mode = 'normal';
  await readDockerLibraryCommand(owner, 'package.uninstall', { identity: fixture.packageId });
  assert.equal((await readDockerLibraryCommand(owner, 'library.packages')).packages.length, 0);
  assert.equal((await installDockerLibraryPackage(owner, request, { libraryName: 'proof' })).status, 'installed');
  assert.deepEqual(await readDockerLibraryCommand(owner, 'library.packages').then(value => value.packages.map(item => item.id)),
    baseline.packages.map(item => item.id));
  record('uninstall and reinstall use the same signed immutable chain without compilation');

  const host = path.join(fixture.root, 'host'); await fs.mkdir(host);
  const cliPath = fileURLToPath(new URL('../apps/cli/dist/cli/index.js', import.meta.url));
  const environment = { ...process.env, DKB_HOST_INVENTORY: path.join(host, 'host.json'), DKB_CLI_CONFIG: path.join(host, 'config.json'),
    DKB_GLOBAL_ROOT: path.join(host, 'global'), DKB_RUNTIME_CREDENTIALS_ROOT: path.join(host, 'credentials'), DKB_REGISTRY_TOKEN: bearer,
    DKB_REGISTRY_CREDENTIALS: path.join(host, 'registry-credentials.json') };
  // Console intentionally does not inherit bearer environment variables. Exercise
  // its real saved-host-login path using only an isolated synthetic credential.
  await fs.writeFile(environment.DKB_REGISTRY_CREDENTIALS, JSON.stringify({ format: 'dkb.credentials.v1',
    registries: { [registryUrl]: { token: bearer, savedAt: new Date().toISOString() } } }), { mode: 0o600 });
  delete environment.DKB_LIBRARY_PATH; delete environment.DKB_REGISTRY_URL;
  const cli = async args => {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, ...args], { cwd: host, env: environment, windowsHide: true, shell: false });
      let stdout = '', stderr = '';
      child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
      const timer = setTimeout(() => child.kill(), 60_000);
      child.once('error', reject); child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${grant}|${upgradeGrant}|${bearer}`, 'u'));
    assert.equal(result.code, 0, result.stdout || result.stderr); return result.stdout;
  };
  await cli(['--json', 'library', 'register', '--name', 'signed-proof', '--docker-volume', volume, '--docker-context', context, '--owner-image', image]);
  await cli(['--json', 'uninstall', fixture.packageId, '--library', 'signed-proof']);
  const publicEvents = (await cli(['--json-stream', 'install', fixture.packageId, '--library', 'signed-proof', '--version', '1.0.0', '--target', 'fixture']))
    .trim().split('\n').map(line => JSON.parse(line));
  assert.equal(publicEvents.filter(item => item.event === 'result').length, 1);
  assert.equal(publicEvents.at(-1).status, 'succeeded');
  assert.equal(publicEvents.find(item => item.event === 'result').value.status, 'installed');
  assert.ok(publicEvents.some(item => item.event === 'progress' && item.phase === 'download-source'));
  const metadata = requests.filter(item => item.path.startsWith('/api/registry/'));
  assert.ok(metadata.length > 0); assert.ok(metadata.every(item => item.authorization === `Bearer ${bearer}`));
  assert.ok(requests.filter(item => item.path.startsWith('/api/layers/')).every(item => item.authorization === `DKB-Install-Grant ${grant}`));
  record('public CLI resolves the Library Registry, keeps login on the host and streams one final result');
  await cli(['--json', 'uninstall', fixture.packageId, '--library', 'signed-proof']);
  const envKeys = ['DKB_HOST_INVENTORY', 'DKB_CLI_CONFIG', 'DKB_GLOBAL_ROOT', 'DKB_RUNTIME_CREDENTIALS_ROOT', 'DKB_REGISTRY_TOKEN', 'DKB_REGISTRY_CREDENTIALS'];
  const prior = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) process.env[key] = environment[key];
  const activity = new ConsoleActivityStore(path.join(host, 'activity.sqlite'));
  const runner = new ConsoleCommandRunner({ cliEntrypoint: cliPath, cwd: host, activity });
  try {
    const operation = await runner.run('package.install', { identity: fixture.packageId, version: '1.0.0', target: 'fixture',
      library: 'signed-proof', registryUrl });
    assert.equal(operation.status, 'succeeded', JSON.stringify(operation.events));
    assert.equal(operation.result.status, 'installed');
    assert.equal(operation.events.filter(event => event.event === 'result').length, 1);
    assert.equal(activity.list().activities[0].status, 'succeeded');
    assert.doesNotMatch(JSON.stringify(operation) + JSON.stringify(activity.list()), new RegExp(`${grant}|${bearer}`, 'u'));
    await assert.rejects(fs.access(path.join(host, '.dkb/state.sqlite')), { code: 'ENOENT' });
    const beforeUpgrade = await readDockerLibraryCommand(owner, 'library.packages');
    latest = '1.1.0';
    // The installed origin wins even when the Library's convenience default is offline.
    await cli(['--json', 'registry', 'use', 'http://127.0.0.1:1', '--root', 'signed-proof', '--no-verify']);
    const beforePlanning = requests.length;
    const outdated = JSON.parse(await cli(['--json', 'outdated', '--library', 'signed-proof']));
    assert.equal(outdated.updates, 1); assert.equal(outdated.packages[0].registry, registryUrl);
    const dryRun = JSON.parse(await cli(['--json', 'upgrade', fixture.packageId, '--library', 'signed-proof', '--dry-run']));
    assert.equal(dryRun.currentVersion, '1.0.0'); assert.equal(dryRun.latestVersion, '1.1.0');
    assert.equal(dryRun.libraryRoot, 'signed-proof'); assert.equal(dryRun.dryRun, true);
    assert.equal(requests.slice(beforePlanning).some(item => /install-grant|layers/u.test(item.path)), false);
    assert.deepEqual((await readDockerLibraryCommand(owner, 'library.packages')).packages, beforeUpgrade.packages);
    record('outdated and dry-run use the installed origin without requesting grants or downloading layers');
    mode = 'corrupt';
    const failed = await runner.run('package.upgrade', { identity: fixture.packageId, library: 'signed-proof' });
    assert.equal(failed.status, 'failed');
    assert.deepEqual((await readDockerLibraryCommand(owner, 'library.packages')).packages, beforeUpgrade.packages);
    mode = 'normal';
    const upgraded = await runner.run('package.upgrade', { identity: fixture.packageId, library: 'signed-proof' });
    assert.equal(upgraded.status, 'succeeded', JSON.stringify(upgraded.events));
    assert.equal(upgraded.result.version, '1.1.0');
    const afterUpgrade = await readDockerLibraryCommand(owner, 'library.packages');
    assert.equal(afterUpgrade.packages[0].version, '1.1.0');
    assert.equal(afterUpgrade.packages[0].registryUrl, registryUrl);
    const noOp = JSON.parse(await cli(['--json', 'upgrade', fixture.packageId, '--library', 'signed-proof']));
    assert.equal(noOp.status, 'up_to_date');
    const beforeStale = requests.length;
    await assert.rejects(installDockerLibraryPackage(owner, { ...request, force: true,
      expectedLibraryGeneration: beforeUpgrade.generation }, { libraryName: 'signed-proof' }), { code: 'library_upgrade_conflict' });
    assert.equal(requests.length, beforeStale, 'stale plan rejected before keys or artifacts');
    assert.deepEqual(await readDockerLibraryCommand(owner, 'library.packages'), afterUpgrade);
    assert.doesNotMatch(JSON.stringify(activity.list()), new RegExp(`${grant}|${upgradeGrant}|${bearer}`, 'u'));
    record('Console upgrade verifies new signed layers, preserves prior release on corruption and rejects stale plans');
  } finally {
    await runner.close(); activity.close();
    for (const key of envKeys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; }
  }
  record('Console uses the same grant-only CLI path with real Activity records and no host Library database');
} catch (error) { failure = error; }
finally {
  if (created) {
    const ids = (await call(['container', 'ls', '--all', '--filter', `volume=${volume}`, '--format', '{{.ID}}'])).split(/\s+/u).filter(Boolean);
    for (const container of ids) {
      const [metadata] = JSON.parse(await call(['container', 'inspect', container]));
      assert.equal(metadata.Image, image);
      assert.match(metadata.Config.Labels?.['dev.dkb.owner.operation'] ?? '', /^[a-f0-9-]{36}$/u);
      assert.ok(metadata.Mounts.every(item => item.Type === 'volume' && (item.Name === volume || item.Destination === '/scratch')));
      await call(['container', 'rm', '--force', '--volumes', container]);
    }
    const [metadata] = JSON.parse(await call(['volume', 'inspect', volume]));
    assert.equal(metadata.Labels['dev.dkb.install.proof'], id);
    await call(['volume', 'rm', volume]);
  }
  for (const cleanup of hooks.reverse()) await cleanup();
}
if (failure) throw failure;
console.log(JSON.stringify({ status: 'passed', image, checks, userResourcesChanged: false }));
