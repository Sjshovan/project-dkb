// Explicit Windows CLI -> Linux Runtime / Registry-grant proof, not a Laravel or model benchmark.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createRoot, writeJson } from './runtime-query-fixture.mjs';
import { ownerDockerProcess } from '../apps/cli/dist/host/dockerOwnerProcess.js';
import { DkbRuntimeClient } from '@sjshovan/dkb-runtime/runtime/client.js';
import { ConsoleCommandRunner } from '@sjshovan/dkb-console';
import { ConsoleActivityStore } from '../apps/console/dist/server/activity.js';

if (process.argv.length !== 3 || process.argv[2] !== '--run') throw new Error('Run explicitly with --run');
const cleanup = [], t = { after: fn => cleanup.push(fn) };
const id = randomUUID(), label = 'dev.dkb.pipeline.proof', volume = `dkb-pipeline-proof-${id}`, container = volume;
const docker = async args => {
  const result = await ownerDockerProcess(args, { timeoutMs: 120_000 });
  assert.equal(result.code, 0, result.stderr); return result.stdout.trim();
};
const image = await docker(['image', 'inspect', process.env.DKB_PROOF_CLI_IMAGE ?? 'dkb-cli:pipeline-owner-candidate', '--format', '{{.Id}}']);
const requests = [], checks = [];
const record = check => { checks.push(check); console.log(JSON.stringify({ check, status: 'passed' })); };
let createdVolume = false, createdContainer = false, descriptor, mode = 'normal', failure;
const grant = `dkb_grant_${id.replaceAll('-', '')}`, bearer = `dkb_${randomUUID().replaceAll('-', '')}`;
try {
  const host = await createRoot(t);
  const registry = http.createServer(async (req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization });
    if (!descriptor) { res.writeHead(503); return res.end(); }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/.well-known/dkb-registry-keys.json') return res.end(JSON.stringify({ keys: descriptor.keys }));
    if (req.url.startsWith('/api/registry/')) {
      if (req.headers.authorization !== `Bearer ${bearer}`) { res.writeHead(401); return res.end(); }
      if (req.url.endsWith('/install-grant') && req.method === 'POST') {
        let body = ''; for await (const bytes of req) body += bytes;
        assert.equal(JSON.parse(body).retrievalBuildDigest, descriptor.plan.retrievalBuildDigest);
        return res.end(JSON.stringify({ plan: descriptor.plan, installGrant: grant, expiresAt: new Date(Date.now() + 300_000).toISOString() }));
      }
      if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
      return res.end(JSON.stringify({ data: req.url.includes('/versions/')
        ? { packageId: descriptor.packageId, version: '1.0.0', status: 'published', builds: [{ ...descriptor.plan, status: 'published' }] }
        : { id: descriptor.packageId, namespace: 'test', name: 'knowledge', slug: 'knowledge', visibility: 'private', latestVersion: '1.0.0' } }));
    }
    const kind = req.url.split('/').at(-1), encoded = descriptor.layerBytes[kind];
    if (!encoded || req.headers.authorization !== `DKB-Install-Grant ${grant}` || mode === 'expired') { res.writeHead(403); return res.end(`Never echo ${grant}`); }
    const bytes = Buffer.from(encoded, 'base64'); if (mode === 'corrupt') bytes[0] ^= 1;
    res.setHeader('content-type', `application/vnd.dkb.${kind}+gzip`); res.end(bytes);
  });
  await new Promise(resolve => registry.listen(0, process.platform === 'linux' ? '0.0.0.0' : '127.0.0.1', resolve));
  cleanup.push(() => { registry.closeAllConnections(); return new Promise(resolve => registry.close(resolve)); });
  const origin = `http://127.0.0.1:${registry.address().port}`;
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const hostPort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  await docker(['volume', 'create', '--driver', 'local', '--label', `${label}=${id}`, volume]); createdVolume = true;
  const mounts = ['runtime-query-fixture.mjs', 'runtime-trust-fixture.mjs', 'fixtures/pipeline-owner-server.mjs'].flatMap(file =>
    ['--mount', `type=bind,src=${fileURLToPath(new URL(file, import.meta.url))},dst=/workspace/tests/${file},readonly`]);
  await docker(['run', '-d', '--name', container, '--label', `${label}=${id}`, '--pull', 'never', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m',
    '--mount', `type=volume,src=${volume},dst=/proof,volume-nocopy`, ...mounts, '-p', `127.0.0.1:${hostPort}:7331`,
    '--env', 'TMPDIR=/proof', '--env', 'DKB_GLOBAL_ROOT=/tmp/global', '--env', 'DKB_CLI_CONFIG=/tmp/config.json',
    '--env', 'DKB_HOST_INVENTORY=/tmp/host.json', '--env', `DKB_PROOF_REGISTRY_ORIGIN=${origin}`,
    '--env', `DKB_RUNTIME_ALLOWED_HOSTS=127.0.0.1:${hostPort}`,
    '--env', 'DKB_REGISTRY_URL=http://127.0.0.1:1/unrelated-registry', '--entrypoint', 'node', image, 'tests/fixtures/pipeline-owner-server.mjs']);
  createdContainer = true;
  await ready();
  descriptor = JSON.parse(await docker(['exec', container, 'node', '-e', "process.stdout.write(require('fs').readFileSync('/proof/descriptor.json'))"]));
  const address = await docker(['port', container, '7331/tcp']);
  assert.match(address, /^127\.0\.0\.1:\d+$/u);
  const url = `http://${address}`, client = new DkbRuntimeClient({ baseUrl: url, adminToken: 'synthetic-proof-admin' });
  const sentinel = path.join(host.root, 'not-runtime-state'); await fs.writeFile(sentinel, 'host path must stay untouched');
  const environment = { ...process.env, DKB_HOST_INVENTORY: path.join(host.root, 'host.json'), DKB_CLI_CONFIG: path.join(host.root, 'config.json'),
    DKB_GLOBAL_ROOT: path.join(host.root, 'global'), DKB_REGISTRY_CREDENTIALS: path.join(host.root, 'credentials.json'),
    DKB_RUNTIME_CREDENTIALS_ROOT: path.join(host.root, 'runtime-credentials'), DKB_RUNTIME_ADMIN_TOKEN: 'synthetic-proof-admin' };
  for (const key of ['DKB_LIBRARY_PATH', 'DKB_RUNTIME_URL', 'DKB_RUNTIME_STATE_ROOT', 'DKB_REGISTRY_URL', 'DKB_REGISTRY_TOKEN']) delete environment[key];
  const stamp = new Date().toISOString();
  await writeJson(environment.DKB_HOST_INVENTORY, { format: 'dkb.host.v2', defaults: { runtime: 'owner' }, libraries: {}, registries: {}, stacks: {},
    runtimes: { owner: { kind: 'docker', url, stateRoot: sentinel, registeredAt: stamp, updatedAt: stamp } } });
  await writeJson(environment.DKB_REGISTRY_CREDENTIALS, { format: 'dkb.credentials.v1', registries: { [origin]: { token: bearer, savedAt: stamp } } });
  const entry = fileURLToPath(new URL('../apps/cli/dist/cli/index.js', import.meta.url));
  const cli = args => executeCli(entry, host.root, environment, args);
  const original = await activation();
  for (const value of ['corrupt', 'expired']) {
    mode = value;
    const rejected = await cli(['--json', 'pipeline', 'use', 'fixture', '--runtime', 'owner']);
    assert.equal(rejected.code, 1);
    assert.match(JSON.parse(rejected.stdout).error.message, value === 'corrupt' ? /hash mismatch/u : /download was denied/u);
    assert.equal(await activation(), original);
  }
  record('public host CLI preserves Linux activation on corrupt bytes and refused download grants');
  mode = 'normal';
  const before = (await client.pipelines()).targets.find(item => item.name === 'fixture').preparation;
  const result = await cli(['--json-stream', 'pipeline', 'use', 'fixture', '--runtime', 'owner']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.event === 'result').length, 1);
  assert.equal(events.find(event => event.event === 'result').value.packages[0].preparation, 'downloaded');
  assert.ok(events.some(event => event.event === 'progress'));
  assert.equal(events.at(-1).status, 'succeeded');
  assert.ok(requests.filter(item => item.path.startsWith('/api/registry/')).every(item => item.authorization === `Bearer ${bearer}`));
  assert.ok(requests.filter(item => item.path.startsWith('/api/layers/')).every(item => item.authorization === `DKB-Install-Grant ${grant}`));
  assert.equal((await client.search({ query: 'RECOVERY-MARKER' })).results.length, 1);
  record('host CLI streams signed acquisition to Linux Runtime, keeping Registry login exclusively on host');
  const selected = await activation(), count = requests.length;
  await assert.rejects(client.switchPipeline({ target: 'fixture', expected: before, grants: {} }), { code: 'runtime_pipeline_conflict' });
  assert.equal(await activation(), selected); assert.equal(requests.length, count);
  record('owner rejects superseded preparation without Registry access or activation replacement');

  const envKeys = [...new Set([...Object.keys(environment).filter(key => key.startsWith('DKB_')), 'DKB_LIBRARY_PATH', 'DKB_RUNTIME_URL', 'DKB_RUNTIME_STATE_ROOT', 'DKB_REGISTRY_URL', 'DKB_REGISTRY_TOKEN'])];
  const prior = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) { if (environment[key] === undefined) delete process.env[key]; else process.env[key] = environment[key]; }
  const activity = new ConsoleActivityStore(path.join(host.root, 'activity.sqlite'));
  const runner = new ConsoleCommandRunner({ cliEntrypoint: entry, cwd: host.root, activity });
  try {
    const operation = await runner.run('pipeline.use', { runtime: 'owner', target: 'fixture' });
    assert.equal(operation.status, 'succeeded', JSON.stringify(operation.events));
    assert.equal(operation.result.packages[0].preparation, 'retained');
    assert.equal(requests.length, count);
    assert.equal(activity.list().activities[0].status, 'succeeded');
    assert.ok(!JSON.stringify(operation).includes(bearer) && !JSON.stringify(activity.list()).includes(grant));
  } finally {
    await runner.close(); activity.close();
    for (const key of envKeys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; }
  }
  record('real Console runner and Activity switch retained signed Pipeline without host DB access');
  const committed = await activation();
  await docker(['stop', '--time', '3', container]);
  const offline = await cli(['--json', 'pipeline', 'use', 'fixture', '--runtime', 'owner']);
  assert.equal(offline.code, 1); assert.equal(JSON.parse(offline.stdout).error.code, 'runtime_transport_failed');
  await docker(['start', container]); await ready();
  assert.equal(await activation(), committed);
  assert.equal((await client.search({ query: 'RECOVERY-MARKER' })).results.length, 1);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'host path must stay untouched');
  await assert.rejects(fs.access(path.join(host.root, '.dkb/state.sqlite')), { code: 'ENOENT' });
  record('offline owner never falls back to host paths; Linux activation and retrieval survive restart');
} catch (error) { failure = error; }
finally {
  if (createdContainer) {
    const [metadata] = JSON.parse(await docker(['inspect', container]));
    assert.equal(metadata.Config.Labels[label], id); assert.equal(metadata.Image, image);
    await docker(['rm', '--force', container]);
  }
  if (createdVolume) {
    const [metadata] = JSON.parse(await docker(['volume', 'inspect', volume]));
    assert.equal(metadata.Labels[label], id); await docker(['volume', 'rm', volume]);
  }
  for (const dispose of cleanup.reverse()) await dispose();
}
if (failure) throw failure;
console.log(JSON.stringify({ status: 'passed', image, hostPlatform: process.platform, checks, userResourcesChanged: false }));

async function activation() {
  return docker(['exec', container, 'node', '-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(descriptor.runtimeRoot + '/.dkb/runtime-activation.lock.json')}))`]);
}
async function ready() {
  for (let attempt = 0; attempt < 80; attempt++) {
    const [metadata] = JSON.parse(await docker(['inspect', container]));
    if (!metadata.State.Running) throw new Error(await docker(['logs', container]));
    const result = await ownerDockerProcess(['exec', container, 'node', '-e', "fetch('http://127.0.0.1:7331/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], { timeoutMs: 5000 });
    if (result.code === 0) return;
    await delay(250);
  }
  throw new Error('Synthetic Runtime startup exceeded bounded proof wait.');
}
function executeCli(entry, cwd, env, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd, env, windowsHide: true, shell: false });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), 90_000);
    child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      try { assert.ok(![stdout, stderr].some(value => value.includes(grant) || value.includes(bearer))); resolve({ code, stdout, stderr }); }
      catch (error) { reject(error); }
    });
  });
}
