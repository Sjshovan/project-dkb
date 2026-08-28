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
