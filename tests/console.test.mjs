import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startDkbConsoleServer } from '../apps/console/dist/server/server.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(repositoryRoot, 'apps', 'console', 'dist', 'web');

test('Console secures loopback sessions and invokes only typed CLI commands', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-console-test-'));
  const cli = path.join(root, 'fake-cli.mjs');
  const argvLog = path.join(root, 'argv.jsonl');
  const previousStateRoot = process.env.DKB_CONSOLE_STATE_ROOT;
  process.env.DKB_CONSOLE_STATE_ROOT = path.join(root, 'console-state');
  await fs.writeFile(cli, `
    import fs from 'node:fs';
    fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
    const result = process.argv.includes('library') && process.argv.includes('list')
      ? { selected: 'personal', libraries: [{ name: 'personal', selected: true, status: 'ready', path: 'C:/knowledge' }] }
      : { status: 'selected' };
    const base = { format: 'dkb.command-event.v1', timestamp: new Date().toISOString() };
    console.log(JSON.stringify({ ...base, sequence: 0, event: 'start', label: 'Reading DKB state' }));
    console.log(JSON.stringify({ ...base, sequence: 1, event: 'result', value: result }));
    console.log(JSON.stringify({ ...base, sequence: 2, event: 'completion', status: 'succeeded' }));
  `);

  const server = await startDkbConsoleServer({ cliEntrypoint: cli, bootstrapSecret: 'one-time-secret', controlToken: 'control-secret', webRoot });
  try {
    const hostile = await fetch(`${server.url}/healthz`, { headers: { origin: 'https://hostile.example' } });
    assert.equal(hostile.status, 403);
    const missingAsset = await fetch(`${server.url}/assets/missing.js`);
    assert.equal(missingAsset.status, 404);
    assert.equal(missingAsset.headers.get('cache-control'), 'no-store');

    const bootstrap = await fetch(`${server.url}/api/session/bootstrap`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: 'one-time-secret' }),
    });
    assert.equal(bootstrap.status, 200);
    const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0];
    const { csrf } = await bootstrap.json();
    assert.ok(cookie);
    assert.ok(csrf);
    const repeated = await fetch(`${server.url}/api/session/bootstrap`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: 'one-time-secret' }),
    });
    assert.equal(repeated.status, 401);
    const deniedRefresh = await fetch(`${server.url}/control/bootstrap`, { method: 'POST' });
    assert.equal(deniedRefresh.status, 401);
    const refreshed = await fetch(`${server.url}/control/bootstrap`, {
      method: 'POST', headers: { authorization: 'Bearer control-secret' },
    });
    assert.equal(refreshed.status, 200);
    const { secret: refreshedSecret } = await refreshed.json();
    const refreshedBootstrap = await fetch(`${server.url}/api/session/bootstrap`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: refreshedSecret }),
    });
    assert.equal(refreshedBootstrap.status, 200);

    const libraries = await fetch(`${server.url}/api/v1/resources/libraries`, { headers: { cookie } });
    assert.equal(libraries.status, 200);
    assert.equal((await libraries.json()).selected, 'personal');

    const missingCsrf = await fetch(`${server.url}/api/v1/operations`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ commandId: 'library.use', input: { name: 'personal' } }),
    });
    assert.equal(missingCsrf.status, 403);
    const mutation = await fetch(`${server.url}/api/v1/operations`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-dkb-csrf': csrf }, body: JSON.stringify({ commandId: 'library.use', input: { name: 'personal' } }),
    });
    assert.equal(mutation.status, 202);
    const { operationId } = await mutation.json();
    const operation = await waitForOperation(server.url, cookie, operationId);
    assert.equal(operation.status, 'succeeded');

    const registerRegistry = await fetch(`${server.url}/api/v1/operations`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-dkb-csrf': csrf }, body: JSON.stringify({
        commandId: 'registry.register', input: { name: 'proof-registry', url: 'http://127.0.0.1:8018', verify: false },
      }),
    });
    assert.equal(registerRegistry.status, 202);
    await waitForOperation(server.url, cookie, (await registerRegistry.json()).operationId);

    const registryLogin = await fetch(`${server.url}/api/v1/operations`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-dkb-csrf': csrf }, body: JSON.stringify({
        commandId: 'registry.login', input: { url: 'http://127.0.0.1:8018', abilities: ['registry:read'] },
      }),
    });
    assert.equal(registryLogin.status, 202);
    await waitForOperation(server.url, cookie, (await registryLogin.json()).operationId);

    const invalid = await fetch(`${server.url}/api/v1/operations`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-dkb-csrf': csrf }, body: JSON.stringify({ commandId: 'shell.run', input: { command: 'whoami' } }),
    });
    assert.equal(invalid.status, 400);
    const embeddedCredential = await fetch(`${server.url}/api/v1/operations`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-dkb-csrf': csrf }, body: JSON.stringify({
        commandId: 'registry.register', input: { name: 'hostile', url: 'https://user:secret@example.test', verify: true },
      }),
    });
    assert.equal(embeddedCredential.status, 400);
    const missingOperation = await fetch(`${server.url}/api/v1/operations/missing`, { headers: { cookie } });
    assert.equal(missingOperation.status, 404);
    const invocations = (await fs.readFile(argvLog, 'utf8')).trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    assert.deepEqual(invocations[0], ['--json-stream', 'library', 'list']);
    assert.deepEqual(invocations[1], ['--json-stream', 'library', 'use', 'personal']);
    assert.deepEqual(invocations[2], ['--json-stream', 'registry', 'register', 'proof-registry', 'http://127.0.0.1:8018', '--no-verify']);
    assert.deepEqual(invocations[3], ['--json-stream', 'registry', 'login', '--url', 'http://127.0.0.1:8018', '--scope', 'registry:read']);
    assert.equal(invocations.some((argv) => argv.includes('whoami')), false);
  } finally {
    await server.close();
    if (previousStateRoot === undefined) delete process.env.DKB_CONSOLE_STATE_ROOT;
    else process.env.DKB_CONSOLE_STATE_ROOT = previousStateRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function waitForOperation(baseUrl, cookie, id) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/v1/operations/${id}`, { headers: { cookie } });
    const operation = await response.json();
    if (['succeeded', 'failed', 'cancelled'].includes(operation.status)) return operation;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Console operation did not finish.');
}
