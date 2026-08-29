import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const image = 'dkb-index-faiss:0.1.0';
const dockerAvailable = runDocker(['version'], 5_000).status === 0;
const imageAvailable = dockerAvailable && runDocker(['image', 'inspect', image], 5_000).status === 0;

test('FAISS service builds, loads, searches, closes, and contains filesystem access', { skip: !imageAvailable }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-faiss-service-'));
  const container = `dkb-faiss-test-${process.pid}-${Date.now().toString(36)}`;

  try {
    await fs.writeFile(path.join(root, 'vectors.json'), `${JSON.stringify({
      ids: ['1', '2'],
      vectors: [[1, 0], [0, 1]],
    })}\n`, 'utf8');
    const started = runDocker([
      'run', '--detach', '--rm', '--name', container,
      '-p', '127.0.0.1::8092',
      '-e', 'DKB_FAISS_ALLOWED_ROOTS=/state',
      '-v', `${root}:/state`,
      image,
    ], 30_000);
    assert.equal(started.status, 0, started.stderr);
    const portResult = runDocker(['port', container, '8092/tcp'], 10_000);
    assert.equal(portResult.status, 0, portResult.stderr);
    const port = Number(portResult.stdout.trim().match(/:(\d+)$/u)?.[1]);
    assert.equal(Number.isInteger(port) && port > 0, true);
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl);

    const build = await jsonRequest(`${baseUrl}/build`, {
      method: 'POST',
      body: { vectors: '/state/vectors.json', output: '/state/chunks.faiss' },
    });
    assert.equal(build.ok, true);
    assert.equal(build.count, 2);

    const loaded = await jsonRequest(`${baseUrl}/sessions`, {
      method: 'POST',
      body: { dimensions: 2, segments: [{ path: '/state/chunks.faiss' }] },
    });
    assert.equal(typeof loaded.sessionId, 'string');

    const searched = await jsonRequest(`${baseUrl}/sessions/${loaded.sessionId}/search`, {
      method: 'POST',
      body: { vector: [1, 0], limit: 2 },
    });
    assert.equal(searched.hits[0].id, '1');

    const blocked = await fetch(`${baseUrl}/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vectors: '/etc/passwd', output: '/state/blocked.faiss' }),
    });
    assert.equal(blocked.status, 403);

    const closed = await jsonRequest(`${baseUrl}/sessions/${loaded.sessionId}`, { method: 'DELETE' });
    assert.equal(closed.closed, true);
  } finally {
    runDocker(['rm', '--force', container], 15_000);
    await fs.rm(root, { recursive: true, force: true });
  }
});

function runDocker(args, timeout) {
  return spawnSync('docker', args, { encoding: 'utf8', timeout, windowsHide: true });
}

async function jsonRequest(url, options) {
  const response = await fetch(url, {
    method: options.method,
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json();
  assert.equal(response.ok, true, JSON.stringify(body));
  return body;
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Container startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`FAISS service did not become healthy at ${baseUrl}`);
}
