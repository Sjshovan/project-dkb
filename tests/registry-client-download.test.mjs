import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DkbRegistryClient } from '@sjshovan/dkb-registry-client/client.js';

test('install layers stream through native HTTP with byte and digest verification', async (context) => {
  const payload = Buffer.allocUnsafe(12 * 1024 * 1024);
  for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;
  const digest = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
  const server = http.createServer((request, response) => {
    if (request.url !== '/layer' || request.headers.authorization !== 'Bearer proof-token') {
      response.writeHead(401).end('unauthorized');
      return;
    }
    response.writeHead(200, {
      'content-length': String(payload.byteLength),
      'content-type': 'application/vnd.dkb.retrieval-build+gzip',
    });
    let offset = 0;
    const write = () => {
      while (offset < payload.length) {
        const end = Math.min(offset + 64 * 1024, payload.length);
        if (!response.write(payload.subarray(offset, end))) {
          offset = end;
          response.once('drain', write);
          return;
        }
        offset = end;
      }
      response.end();
    };
    write();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-registry-download-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'retrieval.dkbbuild');
  const client = new DkbRegistryClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: 'proof-token' });

  const result = await client.writeInstallLayer({
    kind: 'retrieval',
    digest,
    mediaType: 'application/vnd.dkb.retrieval-build+gzip',
    bytes: payload.byteLength,
    url: '/layer',
    receiptHash: `sha256:${'0'.repeat(64)}`,
    receipt: {},
  }, destination);

  assert.equal(result.bytes, payload.byteLength);
  assert.equal(result.hash, digest);
  assert.equal((await fs.stat(destination)).size, payload.byteLength);
  assert.deepEqual(await fs.readFile(destination), payload);
});

test('install-layer URLs cannot carry Registry credentials across origins', async (context) => {
  let attackerRequests = 0;
  let attackerAuthorization;
  const attacker = http.createServer((request, response) => {
    attackerRequests += 1;
    attackerAuthorization = request.headers.authorization;
    response.end('unexpected');
  });
  await new Promise((resolve) => attacker.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve, reject) => attacker.close((error) => error ? reject(error) : resolve())));
  const address = attacker.address();
  assert.ok(address && typeof address !== 'string');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-registry-cross-origin-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const client = new DkbRegistryClient({ baseUrl: 'http://registry.example.test', installGrant: 'secret-grant' });

  await assert.rejects(
    client.writeInstallLayer({
      kind: 'retrieval',
      digest: `sha256:${'0'.repeat(64)}`,
      mediaType: 'application/vnd.dkb.retrieval-build+gzip',
      bytes: 1,
      url: `//127.0.0.1:${address.port}/steal`,
      receiptHash: `sha256:${'1'.repeat(64)}`,
      receipt: {},
    }, path.join(root, 'retrieval.dkbbuild')),
    /same-origin absolute path/u,
  );
  assert.equal(attackerRequests, 0);
  assert.equal(attackerAuthorization, undefined);
});

test('install-layer streaming aborts as soon as bytes exceed the signed bound', async (context) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/vnd.dkb.evidence+gzip' });
    response.end(Buffer.from('too-many-bytes'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-registry-bounded-layer-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'evidence.dkbevidence');
  const client = new DkbRegistryClient({ baseUrl: `http://127.0.0.1:${address.port}`, installGrant: 'bounded-grant' });

  await assert.rejects(
    client.writeInstallLayer({
      kind: 'evidence',
      digest: `sha256:${'0'.repeat(64)}`,
      mediaType: 'application/vnd.dkb.evidence+gzip',
      bytes: 4,
      url: '/layer',
      receiptHash: `sha256:${'1'.repeat(64)}`,
      receipt: {},
    }, destination),
    /exceeded its signed 4-byte size/u,
  );
  await assert.rejects(fs.access(destination), (error) => error?.code === 'ENOENT');
  assert.deepEqual(await fs.readdir(root), []);
});

test('install-layer streaming enforces a wall-clock deadline against trickle responses', async (context) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/vnd.dkb.evidence+gzip' });
    const interval = setInterval(() => response.write(Buffer.from('x')), 10);
    response.once('close', () => clearInterval(interval));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-registry-deadline-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'evidence.dkbevidence');
  const client = new DkbRegistryClient({ baseUrl: `http://127.0.0.1:${address.port}`, installGrant: 'deadline-grant' });
  const previousTimeout = process.env.DKB_REGISTRY_DOWNLOAD_TIMEOUT_MS;
  process.env.DKB_REGISTRY_DOWNLOAD_TIMEOUT_MS = '60';
  try {
    await assert.rejects(
      client.writeInstallLayer({
        kind: 'evidence',
        digest: `sha256:${'0'.repeat(64)}`,
        mediaType: 'application/vnd.dkb.evidence+gzip',
        bytes: 100,
        url: '/layer',
        receiptHash: `sha256:${'1'.repeat(64)}`,
        receipt: {},
      }, destination),
      /timed out after 60 ms/u,
    );
  } finally {
    if (previousTimeout === undefined) delete process.env.DKB_REGISTRY_DOWNLOAD_TIMEOUT_MS;
    else process.env.DKB_REGISTRY_DOWNLOAD_TIMEOUT_MS = previousTimeout;
  }
  await assert.rejects(fs.access(destination), (error) => error?.code === 'ENOENT');
  assert.deepEqual(await fs.readdir(root), []);
});

test('Registry authentication failures include exact recovery commands', async (context) => {
  const server = http.createServer((request, response) => {
    const status = request.headers.authorization === 'Bearer under-scoped' ? 403 : 401;
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: status === 403 ? 'Forbidden' : 'Unauthenticated' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  await assert.rejects(
    new DkbRegistryClient({ baseUrl, token: 'expired' }).packages(),
    new RegExp(`Registry authentication failed.*dkb registry login --url ${baseUrl}`, 'u'),
  );
  await assert.rejects(
    new DkbRegistryClient({ baseUrl, token: 'under-scoped' }).packages(),
    new RegExp(`lacks permission.*dkb registry login --url ${baseUrl}`, 'u'),
  );
});

test('layer capacity admission rejects before requesting or replacing bytes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-download-capacity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'existing.dkbbuild');
  await fs.writeFile(destination, 'retained');
  let requests = 0;
  const payload = Buffer.from('new-bytes');
  const server = http.createServer((_req, res) => { requests++; res.setHeader('content-type', 'application/vnd.dkb.retrieval-build+gzip'); res.end(payload); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new DkbRegistryClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: '' });
  const layer = { kind: 'retrieval', digest: `sha256:${createHash('sha256').update(payload).digest('hex')}`,
    mediaType: 'application/vnd.dkb.retrieval-build+gzip', bytes: payload.length, url: '/layer', receiptHash: `sha256:${'a'.repeat(64)}`, receipt: {} };
  const capacity = t.mock.method(fs, 'statfs', async () => ({ bsize: 4096n, bavail: 1n }));
  await assert.rejects(client.writeInstallLayer(layer, destination), { code: 'download_capacity_exceeded' });
  capacity.mock.mockImplementation(async () => { throw new Error('unknown storage secret'); });
  await assert.rejects(client.writeInstallLayer(layer, destination), error => error.code === 'download_capacity_unavailable' && !error.message.includes('secret'));
  assert.equal(requests, 0);
  assert.equal(await fs.readFile(destination, 'utf8'), 'retained');
  assert.deepEqual(await fs.readdir(root), ['existing.dkbbuild']);
});
