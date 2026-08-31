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
    const args = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + '\\n');
    const result = args.includes('search')
      ? { registryUrl: 'http://127.0.0.1:8018', entries: [{ type: 'dkb', id: '@proof/alpha', namespace: 'proof', name: 'Alpha', slug: 'alpha', visibility: 'public', latestVersion: '1.0.0' }, { type: 'collection', id: '@proof/bundle', namespace: 'proof', name: 'Proof bundle', slug: 'bundle', visibility: 'public', latestRevision: 1 }], pages: { dkbs: { currentPage: 1, perPage: 20, lastPage: 1, total: 1 }, collections: { currentPage: 1, perPage: 20, lastPage: 1, total: 1 } } }
      : args.includes('registry') && args.includes('show') && args.includes('--contents')
        ? { packageId: '@proof/alpha', version: '1.0.0', sourceInventory: { format: 'dkb.source-inventory.v1', mediaType: 'application/vnd.dkb.source-inventory+json', hash: 'sha256:test', count: 1, bytes: 6 }, entries: [{ path: 'readme.md', bytes: 6, hash: 'sha256:file' }], nextCursor: null }
        : args.includes('registry') && args.includes('show') && args.includes('@proof/bundle')
          ? { type: 'collection', entry: { type: 'collection', id: '@proof/bundle', namespace: 'proof', name: 'Proof bundle', slug: 'bundle', visibility: 'public', latestRevision: 1, revisions: [{ revision: 1, digest: 'sha256:' + 'b'.repeat(64) }] }, selectedRevision: { collectionId: '@proof/bundle', revision: 1, digest: 'sha256:' + 'b'.repeat(64), manifest: { members: [] } } }
          : args.includes('registry') && args.includes('show')
            ? { type: 'dkb', entry: { type: 'dkb', id: '@proof/alpha', namespace: 'proof', name: 'Alpha', slug: 'alpha', visibility: 'public', latestVersion: '1.0.0' }, versions: [{ version: '1.0.0', status: 'published' }], selectedVersion: { packageId: '@proof/alpha', version: '1.0.0', status: 'published', builds: [] } }
            : args.includes('show') && args.includes('--verify')
      ? { format: 'dkb.package-verification.v1', identity: '@proof/alpha', status: 'passed', checkedAt: '2026-08-30T12:00:00.000Z', checks: [], recovery: [] }
      : args.includes('show') && args.includes('--preview')
        ? { format: 'dkb.package-preview.v1', identity: '@proof/alpha', path: 'readme.md', bytes: 6, sha256: 'sha256:test', mediaType: 'text/markdown', previewable: true, truncated: false, bytesRead: 6, content: '# Test', evidenceRecords: 1 }
        : args.includes('show') && args.includes('--contents')
          ? { format: 'dkb.package-contents.v1', identity: '@proof/alpha', directory: '.', entries: [{ name: 'readme.md', path: 'readme.md', kind: 'file', bytes: 6, contentKind: 'text', previewable: true, searchable: true, evidenceRecords: 1 }] }
          : args.includes('show')
            ? { format: 'dkb.installed-entry-detail.v1', identity: '@proof/alpha', kind: 'dkb', status: 'installed' }
            : process.argv.includes('library') && process.argv.includes('list')
      ? { selected: 'personal', libraries: [{ name: 'personal', selected: true, status: 'ready', path: 'C:/knowledge', registry: 'proof-registry' }, { name: 'other', status: 'ready', path: 'C:/other', registry: 'other-registry' }] }
      : process.argv.includes('registry') && process.argv.includes('list')
        ? { selected: 'proof-registry', registries: [{ name: 'proof-registry', selected: true, status: 'online', url: 'http://127.0.0.1:8018' }, { name: 'other-registry', status: 'online', url: 'http://127.0.0.1:8999' }] }
      : process.argv.includes('runtime') && process.argv.includes('list')
        ? { selected: 'proof-runtime', runtimes: [{ name: 'proof-runtime', selected: true, status: 'online', url: 'http://127.0.0.1:7331', library: 'personal' }] }
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

    const checkedLibraries = await fetch(`${server.url}/api/v1/resources/libraries?check=1`, { headers: { cookie } });
    assert.equal(checkedLibraries.status, 200);
    const checkedRuntimes = await fetch(`${server.url}/api/v1/resources/runtimes?check=1`, { headers: { cookie } });
    assert.equal(checkedRuntimes.status, 200);

    const packageDetail = await fetch(`${server.url}/api/v1/libraries/personal/entries/proof/alpha`, { headers: { cookie } });
    assert.equal(packageDetail.status, 200);
    assert.equal((await packageDetail.json()).identity, '@proof/alpha');
    const packageContents = await fetch(`${server.url}/api/v1/libraries/personal/entries/proof/alpha/contents?path=.`, { headers: { cookie } });
    assert.equal(packageContents.status, 200);
    assert.equal((await packageContents.json()).entries[0].path, 'readme.md');
    const packagePreview = await fetch(`${server.url}/api/v1/libraries/personal/entries/proof/alpha/preview?path=readme.md`, { headers: { cookie } });
    assert.equal(packagePreview.status, 200);
    assert.equal((await packagePreview.json()).content, '# Test');
    const escapedPreview = await fetch(`${server.url}/api/v1/libraries/personal/entries/proof/alpha/preview?path=../secret.txt`, { headers: { cookie } });
    assert.equal(escapedPreview.status, 400);

    const registryContext = await fetch(`${server.url}/api/v1/registries/proof-registry`, { headers: { cookie } });
    assert.equal(registryContext.status, 200);
    assert.deepEqual((await registryContext.json()).libraries.map((item) => item.name), ['personal']);
    const registryCatalog = await fetch(`${server.url}/api/v1/registries/proof-registry/catalog?q=proof&type=all&page=1&perPage=20`, { headers: { cookie } });
    assert.equal(registryCatalog.status, 200);
    assert.equal((await registryCatalog.json()).entries.length, 2);
    const registryDkb = await fetch(`${server.url}/api/v1/registries/proof-registry/dkbs/proof/alpha?version=1.0.0`, { headers: { cookie } });
    assert.equal(registryDkb.status, 200);
    assert.equal((await registryDkb.json()).selectedVersion.version, '1.0.0');
    const registryCollection = await fetch(`${server.url}/api/v1/registries/proof-registry/collections/proof/bundle?revision=1`, { headers: { cookie } });
    assert.equal(registryCollection.status, 200);
    assert.equal((await registryCollection.json()).selectedRevision.revision, 1);
    const registryContents = await fetch(`${server.url}/api/v1/registries/proof-registry/dkbs/proof/alpha/contents?version=1.0.0&path=.`, { headers: { cookie } });
    assert.equal(registryContents.status, 200);
    assert.equal((await registryContents.json()).entries[0].path, 'readme.md');

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

    const verification = await fetch(`${server.url}/api/v1/operations`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-dkb-csrf': csrf }, body: JSON.stringify({ commandId: 'package.verify', input: { library: 'personal', identity: '@proof/alpha' } }),
    });
    assert.equal(verification.status, 202);
    const verified = await waitForOperation(server.url, cookie, (await verification.json()).operationId);
    assert.equal(verified.result.status, 'passed');

    const exactInstall = await fetch(`${server.url}/api/v1/operations`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-dkb-csrf': csrf }, body: JSON.stringify({ commandId: 'package.install', input: { library: 'personal', identity: '@proof/alpha', version: '1.0.0', target: 'default', registryUrl: 'http://127.0.0.1:8018' } }),
    });
    assert.equal(exactInstall.status, 202);
    await waitForOperation(server.url, cookie, (await exactInstall.json()).operationId);
    const mismatchedInstall = await fetch(`${server.url}/api/v1/operations`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-dkb-csrf': csrf }, body: JSON.stringify({ commandId: 'package.install', input: { library: 'other', identity: '@proof/alpha', version: '1.0.0', target: 'default', registryUrl: 'http://127.0.0.1:8018' } }),
    });
    assert.equal(mismatchedInstall.status, 400);
    assert.match((await mismatchedInstall.json()).error, /Connect Library/u);

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
    const includesInvocation = (expected) => invocations.some((actual) => JSON.stringify(actual) === JSON.stringify(expected));
    assert.equal(includesInvocation(['--json-stream', 'library', 'list']), true);
    assert.equal(includesInvocation(['--json-stream', 'runtime', 'list', '--check']), true);
    assert.equal(includesInvocation(['--json-stream', 'show', '@proof/alpha', '--library', 'personal']), true);
    assert.equal(includesInvocation(['--json-stream', 'search', 'proof', '--url', 'http://127.0.0.1:8018', '--type', 'all', '--page', '1', '--per-page', '20']), true);
    assert.equal(includesInvocation(['--json-stream', 'registry', 'show', '@proof/alpha', '--url', 'http://127.0.0.1:8018', '--version', '1.0.0']), true);
    assert.equal(includesInvocation(['--json-stream', 'registry', 'show', '@proof/bundle', '--url', 'http://127.0.0.1:8018', '--revision', '1']), true);
    assert.equal(includesInvocation(['--json-stream', 'registry', 'show', '@proof/alpha', '--url', 'http://127.0.0.1:8018', '--version', '1.0.0', '--contents', '.', '--limit', '100']), true);
    assert.equal(includesInvocation(['--json-stream', 'install', '@proof/alpha', '--library', 'personal', '--version', '1.0.0', '--target', 'default', '--url', 'http://127.0.0.1:8018', '--runtime-url', 'http://127.0.0.1:7331']), true);
    assert.equal(includesInvocation(['--json-stream', 'registry', 'register', 'proof-registry', 'http://127.0.0.1:8018', '--no-verify']), true);
    assert.equal(includesInvocation(['--json-stream', 'registry', 'login', '--url', 'http://127.0.0.1:8018', '--scope', 'registry:read']), true);
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
