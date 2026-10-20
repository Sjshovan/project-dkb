import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { signedDownloadFixture } from './fixtures/signed-download.mjs';
import { collectionSnapshot } from './fixtures/collection-download.mjs';

test('grant-only Docker transport preserves the fixed worker and cleanup boundaries', async t => {
  const fixture = await signedDownloadFixture(t);
  const request = { format: 'dkb.library-install.v2', registryUrl: 'http://127.0.0.1:8000',
    registryTransportUrl: 'http://host.docker.internal:8000', installGrant: 'private-proof-grant', plan: fixture.plan, force: false };
  for (const kind of ['dkb', 'collection']) {
  const selected = kind === 'dkb' ? request : { format: 'dkb.library-collection-install.v1', registryUrl: request.registryUrl,
    registryTransportUrl: request.registryTransportUrl, collection: collectionSnapshot('@test/bundle', 1, [fixture]),
    members: [{ plan: fixture.plan, installGrant: request.installGrant }], update: false };
  for (const scenario of ['success', 'worker-failure', 'invalid-input', 'scratch-type', 'scratch-bind',
    'cancel-create', 'cancel-start', 'cleanup-failure', 'create-reply-lost', 'create-unconfirmed']) {
    await t.test(`${kind}: ${scenario}`, async () => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/install-owner-transport.mjs', import.meta.url))],
        { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
      const timer = setTimeout(() => child.kill(), 15_000);
      try {
        const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
        child.stdin.end(JSON.stringify({ scenario, request: selected }));
        assert.equal(await closed, 0, output);
      } finally { clearTimeout(timer); }
    });
  }
  }
});
