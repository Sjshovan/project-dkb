import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { serveDkbRegistryCompiler } from '@sjshovan/dkb-compiler/server.js';

test('compiler HTTP refuses missing, blank, or malformed service credentials before listening', async (t) => {
  const previous = process.env.DKB_COMPILER_SERVICE_TOKEN;
  t.after(() => restoreEnvironment('DKB_COMPILER_SERVICE_TOKEN', previous));
  for (const value of [undefined, '', ' \t ', 'invalid token', 'invalid\nvalue']) {
    restoreEnvironment('DKB_COMPILER_SERVICE_TOKEN', value);
    await assert.rejects(serveDkbRegistryCompiler({ host: '127.0.0.1', port: 0 }), (error) => {
      assert.equal(error.code, 'compiler_auth_required');
      assert.match(error.message, /DKB_COMPILER_SERVICE_TOKEN/u);
      if (value?.trim()) assert.ok(!error.message.includes(value));
      return true;
    });
  }
});

test('compiler rejects unauthenticated work before reading uploads, loading providers, or changing job state', async (t) => {
  const { url, root, marker, token } = await fixture(t);
  const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) });
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(await health.json()).sort(), ['ok', 'service', 'version']);
  assert.equal(health.headers.get('access-control-allow-origin'), null);

  const credentials = [
    [],
    ['authorization', 'Bearer incorrect'],
    ['authorization', `Basic ${token}`],
    ['authorization', token],
    ['authorization', `Bearer ${token} extra`],
    ['authorization', `Bearer ${token}`, 'Authorization', 'Bearer incorrect'],
  ];
  for (const [method, endpoint] of [['GET', '/capabilities'], ['POST', '/compile'], ['POST', '/compile/cancel']]) {
    for (const headers of credentials) {
      // POST deliberately never sends the declared body: authentication must
      // answer before waiting for an upload or parsing a cancellation request.
      const response = await unfinishedRequest(`${url}${endpoint}?token=${token}`, method, headers);
      assert.equal(response.status, 401, `${method} ${endpoint}`);
      assert.equal(response.headers['www-authenticate'], 'Bearer realm="DKB Compiler"');
      assert.equal(response.headers['access-control-allow-origin'], undefined);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.deepEqual(JSON.parse(response.body), {
        error: 'compiler_unauthorized', message: 'Compiler service authentication is required.',
      });
      assert.ok(!response.body.includes(token));
    }
  }
  const bodyCredential = await fetch(`${url}/compile/cancel`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, authorization: `Bearer ${token}` }), signal: AbortSignal.timeout(2_000),
  });
  assert.equal(bodyCredential.status, 401);
  await bodyCredential.arrayBuffer();
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, '.dkb', 'compiler-cancellations')), { code: 'ENOENT' });
});

test('authenticated compiler requests retain capability, validation, and cancellation behavior', async (t) => {
  const { url, marker, token } = await fixture(t);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  // A running server retains its startup credential; changing the environment
  // cannot silently change its authentication boundary between requests.
  process.env.DKB_COMPILER_SERVICE_TOKEN = randomBytes(32).toString('base64url');
  const changed = await fetch(`${url}/capabilities`, {
    headers: { authorization: `Bearer ${process.env.DKB_COMPILER_SERVICE_TOKEN}` }, signal: AbortSignal.timeout(2_000),
  });
  assert.equal(changed.status, 401);
  await changed.arrayBuffer();
  const capabilities = await fetch(`${url}/capabilities`, {
    headers: { authorization: `bEaReR ${token}` }, signal: AbortSignal.timeout(10_000),
  });
  assert.equal(capabilities.status, 200);
  const catalog = await capabilities.json();
  assert.equal(catalog.service, 'dkb.registry.compiler');
  assert.equal(catalog.allowedTargets[0].name, 'auth-test');
  assert.equal(catalog.allowedTargets[0].available, false);
  assert.equal(await fs.readFile(marker, 'utf8'), 'loaded');

  for (const endpoint of ['/compile', '/compile/cancel']) {
    const response = await fetch(`${url}${endpoint}`, { method: 'POST', headers, body: '{', signal: AbortSignal.timeout(2_000) });
    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /valid JSON/u);
  }
  const control = {
    registryId: 'auth-fixture', jobId: 'cancel-before-start',
    execution: { id: randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString() },
  };
  const cancelled = await fetch(`${url}/compile/cancel`, {
    method: 'POST', headers, body: JSON.stringify(control), signal: AbortSignal.timeout(2_000),
  });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).status, 'cancelled');
  const compiled = await fetch(`${url}/compile`, {
    method: 'POST', headers,
    body: JSON.stringify({ jobId: control.jobId, request: { package: { registryId: control.registryId }, execution: control.execution } }),
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(compiled.status, 409);
  assert.equal((await compiled.json()).error, 'compile_cancelled');
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-compiler-auth-'));
  const marker = path.join(root, 'provider-loaded');
  const token = randomBytes(32).toString('base64url');
  const environment = Object.fromEntries(['DKB_CONTEXT_ROOT', 'DKB_COMPILER_SERVICE_TOKEN', 'DKB_COMPILER_ALLOWED_TARGETS', 'DKB_COMPILER_DEFAULT_TARGET']
    .map((key) => [key, process.env[key]]));
  let server;
  t.after(async () => {
    try {
      if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } finally {
      for (const [key, value] of Object.entries(environment)) restoreEnvironment(key, value);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  Object.assign(process.env, {
    DKB_CONTEXT_ROOT: root, DKB_COMPILER_SERVICE_TOKEN: token,
    DKB_COMPILER_ALLOWED_TARGETS: 'auth-test', DKB_COMPILER_DEFAULT_TARGET: 'auth-test',
  });
  const pluginRoot = path.join(root, '.dkb', 'plugins', '@test', 'compiler-auth');
  await fs.mkdir(pluginRoot, { recursive: true });
  await fs.writeFile(path.join(root, '.dkb', 'config.json'), JSON.stringify({
    format: 'dkb.config.v2', activeTarget: 'auth-test', targets: {
      'auth-test': { evidence: '@test/compiler-auth', index: '@test/compiler-auth', retrieval: '@test/compiler-auth' },
    },
  }));
  await fs.writeFile(path.join(pluginRoot, 'plugin.mjs'), `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'loaded');\nthrow new Error('Intentionally unavailable authentication fixture');\n`);
  server = await serveDkbRegistryCompiler({ host: '127.0.0.1', port: 0 });
  return { root, marker, token, url: `http://127.0.0.1:${server.address().port}` };
}

function unfinishedRequest(url, method, credentials) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method, headers: ['host', new URL(url).host, ...credentials, ...(method === 'POST' ? ['content-length', '1048576'] : [])],
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => {
        clearTimeout(deadline);
        resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') });
        request.destroy();
      });
    });
    const deadline = setTimeout(() => request.destroy(new Error('Compiler waited for an unauthorized request body')), 2_000);
    request.once('error', (error) => { clearTimeout(deadline); reject(error); });
    request.flushHeaders();
  });
}

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
