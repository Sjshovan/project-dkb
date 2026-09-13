import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareRuntimeHttpCredentials, loadRuntimeHttpCredentials, runtimeCredentialsPath } from '../apps/cli/dist/host/runtimeCredentials.js';
import { runtimeClientForUrl } from '../apps/cli/dist/host/runtimeClient.js';
import { registerHostRuntime } from '../apps/cli/dist/host/inventory.js';
import { DkbRuntimeClient } from '@sjshovan/dkb-runtime/runtime/client.js';
import { ConsoleCommandRunner } from '../apps/console/dist/server/commandRunner.js';
import { ConsoleActivityStore } from '../apps/console/dist/server/activity.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-runtime-credentials-'));
  const keys = ['DKB_HOST_INVENTORY', 'DKB_RUNTIME_CREDENTIALS_ROOT', 'DKB_STACK_STATE_ROOT', 'DKB_RUNTIME_ADMIN_TOKEN', 'DKB_RUNTIME_READ_TOKEN'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.DKB_HOST_INVENTORY = path.join(root, 'host.json');
  process.env.DKB_RUNTIME_CREDENTIALS_ROOT = path.join(root, 'credentials');
  process.env.DKB_STACK_STATE_ROOT = path.join(root, 'stacks');
  delete process.env.DKB_RUNTIME_ADMIN_TOKEN;
  delete process.env.DKB_RUNTIME_READ_TOKEN;
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test('local Runtime starters share complete credentials without writing into portable state', async t => {
  const root = await fixture(t);
  const stateRoot = path.join(root, 'runtime');
  const credentials = await Promise.all(Array.from({ length: 16 }, () => prepareRuntimeHttpCredentials(stateRoot)));
  assert.ok(credentials.every(value => JSON.stringify(value) === JSON.stringify(credentials[0])));
  assert.notEqual(credentials[0].adminToken, credentials[0].readToken);
  assert.deepEqual(await loadRuntimeHttpCredentials(stateRoot), credentials[0]);
  assert.notDeepEqual(await prepareRuntimeHttpCredentials(path.join(root, 'other-runtime')), credentials[0]);
  await assert.rejects(fs.access(stateRoot), { code: 'ENOENT' });
  assert.ok((await fs.readdir(process.env.DKB_RUNTIME_CREDENTIALS_ROOT)).every(name => name.endsWith('.json')));
  if (process.platform === 'win32') assert.equal(runtimeCredentialsPath(stateRoot.toUpperCase()), runtimeCredentialsPath(stateRoot));
});

test('credential corruption fails closed without overwriting or exposing secret content', async t => {
  const root = await fixture(t);
  const stateRoot = path.join(root, 'runtime');
  await prepareRuntimeHttpCredentials(stateRoot);
  const target = runtimeCredentialsPath(stateRoot);
  const corrupt = '{"adminToken":"PRIVATE-SENTINEL';
  await fs.writeFile(target, corrupt);
  await assert.rejects(prepareRuntimeHttpCredentials(stateRoot), error => {
    assert.equal(error.code, 'runtime_credentials_invalid');
    assert.ok(!error.message.includes('PRIVATE-SENTINEL'));
    return true;
  });
  assert.equal(await fs.readFile(target, 'utf8'), corrupt);
});

test('explicit Runtime credential environment is not persisted into generated secrets', async t => {
  const root = await fixture(t);
  process.env.DKB_RUNTIME_ADMIN_TOKEN = 'operator-admin-token';
  process.env.DKB_RUNTIME_READ_TOKEN = 'operator-read-token';
  const stateRoot = path.join(root, 'runtime');
  assert.deepEqual(await prepareRuntimeHttpCredentials(stateRoot), { adminToken: 'operator-admin-token', readToken: 'operator-read-token' });
  assert.ok(!(await fs.readFile(runtimeCredentialsPath(stateRoot), 'utf8')).includes('operator-'));
  process.env.DKB_RUNTIME_READ_TOKEN = 'operator-admin-token';
  await assert.rejects(prepareRuntimeHttpCredentials(stateRoot), /different/u);
});

test('Runtime clients use endpoint-scoped local credentials and never elevate a read credential', async t => {
  const root = await fixture(t);
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    response.setHeader('content-type', 'application/json');
    response.end('{"ok":true}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const stateRoot = path.join(root, 'runtime');
  const secrets = await prepareRuntimeHttpCredentials(stateRoot);
  await fs.mkdir(stateRoot);
  await registerHostRuntime('local-proof', baseUrl, { kind: 'process', stateRoot });
  const client = await runtimeClientForUrl(baseUrl);
  await client.status();
  await client.audit();
  await client.health();
  assert.deepEqual(requests.map(value => value.authorization), [`Bearer ${secrets.readToken}`, `Bearer ${secrets.adminToken}`, undefined]);
  assert.ok(!(await fs.readFile(process.env.DKB_HOST_INVENTORY, 'utf8')).includes(secrets.adminToken));
  const other = await runtimeClientForUrl(`http://127.0.0.1:${server.address().port + 1}`);
  assert.equal(other.adminToken, undefined);
  assert.equal(other.readToken, undefined);
  const differentPath = await runtimeClientForUrl(`${baseUrl}/another-runtime`);
  assert.equal(differentPath.adminToken, undefined);
  assert.equal(differentPath.readToken, undefined);
  await new DkbRuntimeClient({ baseUrl, readToken: 'read-only' }).reload();
  assert.equal(requests.at(-1).authorization, undefined, 'read credential cannot authorize management');

  const cli = path.resolve('apps/cli/dist/cli/index.js');
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, '--json', 'runtime', 'show', 'local-proof'], { shell: false, windowsHide: true, env: process.env, signal: AbortSignal.timeout(30_000) });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
  assert.equal(requests.at(-1).authorization, `Bearer ${secrets.readToken}`);

  const activity = new ConsoleActivityStore(path.join(root, 'activity.sqlite'));
  const runner = new ConsoleCommandRunner({ cliEntrypoint: cli, cwd: root, activity });
  try {
    const operation = await runner.run('runtime.show', { runtime: 'local-proof' });
    assert.equal(operation.status, 'succeeded', JSON.stringify(operation));
    assert.equal(requests.at(-1).authorization, `Bearer ${secrets.readToken}`);
    assert.ok(!JSON.stringify(operation).includes(secrets.readToken));
    process.env.DKB_RUNTIME_READ_TOKEN = 'explicit-console-read';
    assert.equal((await runner.run('runtime.show', { runtime: 'local-proof' })).status, 'succeeded');
    assert.equal(requests.at(-1).authorization, 'Bearer explicit-console-read');
  } finally { await runner.close(); activity.close(); }
});

test('Runtime credentials cannot follow redirects or leak in unauthorized error messages', async t => {
  await fixture(t);
  const secret = 'private-test-token';
  let redirected = false;
  const server = http.createServer((request, response) => {
    if (request.url === '/api/runtime') {
      response.writeHead(302, { location: '/redirect' }); response.end();
    } else if (request.url === '/api/library') {
      response.writeHead(401, { 'content-type': 'application/json' }); response.end(JSON.stringify({ message: secret }));
    } else { redirected = true; response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new DkbRuntimeClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, adminToken: secret });
  await assert.rejects(client.status(), /Unable to reach/u);
  assert.equal(redirected, false);
  await assert.rejects(client.library(), error => error.code === 'runtime_unauthorized' && !error.message.includes(secret));
  assert.throws(() => new DkbRuntimeClient({ baseUrl: `https://user:${secret}@example.test` }), error => !error.message.includes(secret));
});
