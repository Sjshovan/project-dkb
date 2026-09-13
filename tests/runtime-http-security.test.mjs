import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { serveDkbRuntime } from '@sjshovan/dkb-runtime/runtime/server.js';

const adminToken = 'synthetic-runtime-admin-credential';
const readToken = 'synthetic-runtime-read-credential';
const mcpToken = 'synthetic-runtime-mcp-credential';
const environmentNames = [
  'DKB_RUNTIME_ADMIN_TOKEN', 'DKB_RUNTIME_READ_TOKEN', 'DKB_RUNTIME_READ_ACCESS',
  'DKB_RUNTIME_ALLOWED_HOSTS', 'DKB_RUNTIME_ALLOWED_ORIGINS', 'DKB_PUBLIC_URL',
  'DKB_LIBRARY_PATH', 'DKB_MCP_HTTP_ENABLED', 'DKB_MCP_BEARER_TOKEN',
  'DKB_MCP_ALLOW_INSECURE_NO_AUTH', 'DKB_MCP_PUBLIC_DOCUMENTS',
  'DKB_MCP_HTTP_PATH', 'DKB_MCP_ALLOWED_HOSTS', 'DKB_MCP_ALLOWED_ORIGINS',
];

test('Runtime requires explicit valid credentials and access policy before creating state, including loopback', async (t) => {
  isolateEnvironment(t);
  const root = await temporaryRoot(t);
  const stateRoot = path.join(root, 'must-not-be-created');
  for (const options of [
    {},
    { adminToken: '' },
    { adminToken: '   ' },
    { adminToken: 'unsafe\ncredential' },
    { adminToken: 'unsafe!credential' },
    { adminToken: 'non-ascii-\u2603' },
    { adminToken: 'a'.repeat(4097) },
    { adminToken, readToken: '' },
    { adminToken, readToken: 'token=inside' },
    { adminToken, readToken: adminToken },
    { adminToken, readAccess: 'public' },
    { adminToken, allowedHosts: ['*'] },
    { adminToken, allowedHosts: ['https://runtime.example'] },
    { adminToken, allowedOrigins: ['*'] },
    { adminToken, allowedOrigins: ['null'] },
    { adminToken, allowedOrigins: ['https://runtime.example/path'] },
  ]) {
    await assert.rejects(serveDkbRuntime({ host: '127.0.0.1', port: 0, stateRoot, ...options }),
      (error) => error.code === 'runtime_http_configuration_invalid'
        && !error.message.includes(adminToken) && !error.message.includes(readToken));
  }
  await assert.rejects(fs.access(stateRoot), { code: 'ENOENT' });
});

test('Runtime health is minimal; read and administration credentials remain separate', async (t) => {
  const fixture = await startFixture(t);
  for (const route of ['/health', '/api/health']) {
    const response = await request(fixture.server, route);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true });
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  }
  const readRoutes = [
    ['GET', '/api/runtime'], ['POST', '/api/search'], ['POST', '/api/retrieve'],
    ['POST', '/api/read-targets'], ['POST', '/api/read'],
  ];
  for (const [method, route] of readRoutes) {
    for (const token of [undefined, 'incorrect-credential', mcpToken]) {
      const response = await request(fixture.server, route, { method, token, body: method === 'POST' ? {} : undefined });
      assert.equal(response.status, 401, `${method} ${route}`);
      assert.match(response.headers['www-authenticate'], /Bearer/);
    }
  }
  for (const token of [adminToken, readToken]) {
    const status = await request(fixture.server, '/api/runtime', { token });
    assert.equal(status.status, 200);
    assert.equal(status.body.runtimeId, 'http-security-fixture');
    const search = await request(fixture.server, '/api/search', { method: 'POST', token, body: { query: 'synthetic question' } });
    assert.equal(search.status, 400);
    assert.equal(search.body.error, 'runtime_activation_required', 'authorized query reaches the ordinary admission gate');
  }
  const adminRoutes = [
    ['GET', '/api/library'], ['GET', '/api/runtime/pipelines'], ['GET', '/api/runtime/audit'],
    ['GET', '/api/traces'], ['GET', '/api/traces/latest'], ['GET', '/api/traces/example'],
    ['POST', '/api/runtime/reload'], ['POST', '/api/runtime/pipeline'], ['POST', '/api/runtime/library'],
    ['POST', '/api/dkbs/import-artifact'], ['POST', '/api/dkbs/install-registry'],
    ['DELETE', '/api/dkbs/%40test%2Fpackage'],
  ];
  for (const [method, route] of adminRoutes) {
    for (const token of [undefined, readToken, mcpToken]) {
      const response = await request(fixture.server, route, { method, token, body: method === 'POST' ? {} : undefined });
      assert.equal(response.status, 401, `${method} ${route}`);
    }
  }
  assert.equal((await request(fixture.server, '/api/library', { token: adminToken })).status, 200);
  const audit = await request(fixture.server, '/api/runtime/audit', { token: adminToken });
  assert.equal(audit.status, 200);
  assert.equal(audit.body.events.length, 2, 'only authorized HTTP query attempts produce terminal audit events');
  assert.equal((await request(fixture.server, '/.well-known/dkb.json', { token: adminToken })).status, 404);
  for (const method of ['GET', 'POST', 'DELETE', 'PATCH']) {
    for (const token of [undefined, readToken, adminToken]) {
      const unknown = await request(fixture.server, '/unclassified-operation', { method, token });
      assert.equal(unknown.status, 404, `${method} must reject an unclassified operation`);
      assert.equal(unknown.body.error, 'not_found');
    }
  }
});

test('explicit public-read exposes read discovery but never grants administration', async (t) => {
  const fixture = await startFixture(t, { readAccess: 'public-read' });
  assert.equal((await request(fixture.server, '/api/runtime')).status, 200);
  const discovery = await request(fixture.server, '/.well-known/dkb.json');
  assert.equal(discovery.status, 200);
  assert.equal(discovery.body.endpoints[0].access, 'public-read');
  assert.equal(discovery.body.site, fixture.origin);
  const search = await request(fixture.server, '/api/search', { method: 'POST', body: { query: 'public question' } });
  assert.equal(search.body.error, 'runtime_activation_required');
  assert.equal((await request(fixture.server, '/api/library')).status, 401);
  assert.equal((await request(fixture.server, '/api/runtime/audit')).status, 401);
  assert.equal((await request(fixture.server, '/api/runtime/library', { method: 'POST', body: {} })).status, 401);
  assert.equal((await request(fixture.server, '/api/runtime/library', { method: 'POST', token: readToken, body: {} })).status, 401);
});

test('Runtime rejects untrusted browser origins, Host headers and preflights even with a valid admin token', async (t) => {
  const fixture = await startFixture(t);
  const foreignOrigins = ['https://untrusted.example', 'null', 'http://localhost:1', `${fixture.origin}.untrusted.example`, `${fixture.origin}/path`];
  for (const origin of foreignOrigins) {
    for (const method of ['POST', 'OPTIONS']) {
      const response = await request(fixture.server, '/api/runtime/library', {
        method, token: adminToken, headers: { origin, 'access-control-request-method': 'POST' }, body: method === 'POST' ? {} : undefined,
      });
      assert.equal(response.status, 403, origin);
      assert.equal(response.headers['access-control-allow-origin'], undefined);
    }
  }
  for (const host of ['untrusted.example', 'localhost:1', '127.0.0.1@untrusted.example', `${fixture.authority}.untrusted.example`]) {
    const response = await request(fixture.server, '/health', {
      token: adminToken, headers: { host, 'x-forwarded-host': fixture.authority, 'x-forwarded-proto': 'http' },
    });
    assert.equal(response.status, 421, host);
  }
  const preflight = await request(fixture.server, '/api/runtime/library', {
    method: 'OPTIONS', headers: { origin: fixture.origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,authorization' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], fixture.origin);
  assert.equal(preflight.headers.vary, 'Origin');
  const unauthenticated = await request(fixture.server, '/api/runtime/library', { method: 'POST', headers: { origin: fixture.origin }, body: {} });
  assert.equal(unauthenticated.status, 401, 'approved CORS does not authorize a mutation');
  const approved = await request(fixture.server, '/api/runtime/library', { method: 'POST', token: adminToken, headers: { origin: fixture.origin }, body: {} });
  assert.equal(approved.status, 400);
  assert.match(approved.body.message, /Choose exactly one/);
  const invalidMethod = await request(fixture.server, '/api/runtime/library', { method: 'OPTIONS', headers: { origin: fixture.origin, 'access-control-request-method': 'PUT' } });
  assert.equal(invalidMethod.status, 405);
  const duplicateOrigin = await request(fixture.server, '/health', { headers: { origin: [fixture.origin, fixture.origin] } });
  assert.equal(duplicateOrigin.status, 403);
});

test('explicit proxy Host and browser-origin allowlists preserve exact authorities and credential checks', async (t) => {
  const fixture = await startFixture(t, { allowedHosts: ['knowledge.example:7443'], allowedOrigins: ['https://console.example'] });
  const headers = { host: 'knowledge.example:7443', origin: 'https://console.example' };
  const response = await request(fixture.server, '/api/runtime', { token: readToken, headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers['access-control-allow-origin'], 'https://console.example');
  assert.equal((await request(fixture.server, '/api/runtime', { headers })).status, 401);
  assert.equal((await request(fixture.server, '/health', { headers: { host: 'knowledge.example:7444' } })).status, 421);
  assert.equal((await request(fixture.server, '/health', { headers: { ...headers, origin: 'https://console.example:7443' } })).status, 403);
});

test('Runtime environment policy and operator public URL work without exposing credentials in errors', async (t) => {
  const fixture = await startFixture(t, { adminToken: undefined, readToken: undefined }, {
    DKB_RUNTIME_ADMIN_TOKEN: adminToken, DKB_RUNTIME_READ_TOKEN: readToken,
    DKB_RUNTIME_READ_ACCESS: 'authenticated', DKB_PUBLIC_URL: 'https://knowledge.example',
    DKB_RUNTIME_ALLOWED_HOSTS: 'other.example:7443', DKB_RUNTIME_ALLOWED_ORIGINS: 'https://console.example',
  });
  const response = await request(fixture.server, '/api/runtime', { token: readToken, headers: { host: 'knowledge.example', origin: 'https://knowledge.example' } });
  assert.equal(response.status, 200);
  assert.equal((await request(fixture.server, '/health', { headers: { host: 'other.example:7443', origin: 'https://console.example' } })).status, 200);
  const invalid = await request(fixture.server, '/api/runtime/library', { method: 'POST', token: adminToken, body: { libraryHandle: readToken } });
  assert.equal(invalid.status, 400);
  assert.doesNotMatch(invalid.text, new RegExp(`${adminToken}|${readToken}`));
  const malformed = await request(fixture.server, '/api/search', { method: 'POST', token: readToken, body: `{"secret":"${adminToken}",invalid}` });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error, 'runtime_request_invalid');
  assert.doesNotMatch(malformed.text, new RegExp(`${adminToken}|${readToken}`));
  assert.doesNotMatch((await request(fixture.server, `/unknown/${adminToken}`)).text, new RegExp(adminToken));
});

test('integrated MCP retains its own bearer and exactly two read-only tools', async (t) => {
  const fixture = await startFixture(t, {}, { DKB_MCP_HTTP_ENABLED: 'true', DKB_MCP_BEARER_TOKEN: mcpToken });
  const call = (token) => request(fixture.server, '/mcp', {
    method: 'POST', token, headers: { accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  });
  for (const token of [undefined, adminToken, readToken]) assert.equal((await call(token)).status, 401);
  const result = await call(mcpToken);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.result.tools.map((tool) => tool.name).sort(), ['fetch', 'search']);
  assert.ok(result.body.result.tools.every((tool) => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint));
  assert.equal((await request(fixture.server, '/api/runtime/audit', { token: mcpToken })).status, 401);
});

function isolateEnvironment(t, overrides = {}) {
  const previous = new Map(environmentNames.map((name) => [name, process.env[name]]));
  for (const name of environmentNames) delete process.env[name];
  Object.assign(process.env, overrides);
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

async function temporaryRoot(t, beforeCleanup = async () => {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-runtime-http-security-'));
  t.after(async () => {
    await beforeCleanup();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('dkb-runtime-http-security-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

async function startFixture(t, options = {}, environment = {}) {
  isolateEnvironment(t, environment);
  let server;
  const root = await temporaryRoot(t, async () => {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const libraryPath = path.join(root, 'library');
  await fs.mkdir(libraryPath);
  await fs.writeFile(path.join(libraryPath, 'dkb.json'), JSON.stringify({ manifestVersion: 1, type: 'library', name: 'HTTP security Library', roots: {} }));
  server = await serveDkbRuntime({
    host: '127.0.0.1', port: 0, stateRoot: path.join(root, 'runtime'), libraryPath,
    runtimeId: 'http-security-fixture', adminToken, readToken, ...options,
  });
  const authority = `127.0.0.1:${server.address().port}`;
  return { server, authority, origin: `http://${authority}` };
}

function request(server, route, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    const outgoing = http.request({
      hostname: '127.0.0.1', port: server.address().port, path: route,
      method: options.method ?? 'GET',
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...options.headers,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: response.statusCode, headers: response.headers, body: text ? JSON.parse(text) : null, text }); }
        catch (error) { reject(error); }
      });
    });
    outgoing.setTimeout(5_000, () => outgoing.destroy(new Error('Runtime HTTP security test request timed out.')));
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}
