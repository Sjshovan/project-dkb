import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { humanSummary } from '../apps/cli/dist/cli/presentation.js';
import { summarizeStackStatus } from '../apps/cli/dist/cli/summaries.js';
import { createDkbPackageArchive, extractDkbPackageArchive } from '@sjshovan/dkb-library/archive.js';
import { DkbRegistryClient, writeArchiveFileFromPath } from '@sjshovan/dkb-registry-client/client.js';
import { prepareServeLibrary } from '../apps/cli/dist/cli/serve.js';
import {
  configuredRegistry,
  normalizeRegistryUrl,
  libraryRegistryConfigPath,
  verifyRegistryEndpoint,
  writeConfiguredRegistryUrl,
} from '../apps/cli/dist/cli/registryConfig.js';
import { preflightDkbInstall } from '../services/runtime/dist/runtime/registryInstall.js';
import { applyLibraryLock } from '@sjshovan/dkb-library/state.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repositoryRoot, 'apps', 'cli', 'dist', 'cli', 'index.js');
let cliInvocation = 0;

test('spawned CLI inventories are removed after each invocation', async () => {
  const result = await runCli(['--help']);

  await assert.rejects(fs.access(result.inventoryPath));
});

test('Registry cancel-build presents confirmed and pending cancellation without claiming published builds were cancelled', async () => {
  let status = 'cancelling';
  const server = http.createServer((request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/registry/packages/test/package/versions/1.0.0/build-jobs/7/cancel');
    request.resume();
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ jobId: 7, stage: 'retrieval', target: 'tei-faiss', status, attempts: 1 }));
  });
  await listen(server);
  try {
    const args = ['registry', 'cancel-build', '@test/package', '--version', '1.0.0', '--job', '7', '--url', `http://127.0.0.1:${server.address().port}`];
    const pending = await runCli(['--no-progress', ...args], { DKB_REGISTRY_TOKEN: 'synthetic-test' });
    assert.equal(pending.code, 0, pending.stderr);
    assert.match(pending.stdout, /Cancellation is pending/u);
    assert.match(pending.stdout, /Retry: dkb registry cancel-build/u);
    for (const terminal of ['cancelled', 'published']) {
      status = terminal;
      const result = await runCli(['--json', ...args], { DKB_REGISTRY_TOKEN: 'synthetic-test' });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).status, terminal);
    }
  } finally { await close(server); }
});

test('human summaries render collections as aligned tables', () => {
  assert.deepEqual(humanSummary({
    packages: [
      { packageId: 'alpha', version: '1.0.0', status: 'published' },
      { packageId: 'beta', version: '2.0.0', status: 'published' },
    ],
  }), [
    'PACKAGE ID  VERSION  STATUS',
    'alpha       1.0.0    published',
    'beta        2.0.0    published',
  ]);
});

test('health-check tables describe operational impact instead of raw booleans', () => {
  assert.deepEqual(humanSummary({
    checks: [
      { name: 'public signing keys', ok: true, impact: 'BLOCKING', status: 200 },
      { name: 'package listing API', ok: false, impact: 'BLOCKING', status: 503, message: 'HTTP 503' },
    ],
  }), [
    'NAME                 STATUS  IMPACT    HTTP  MESSAGE',
    'public signing keys  OK      BLOCKING  200   -',
    'package listing API  FAILED  BLOCKING  503   HTTP 503',
  ]);
});

test('stack diagnostics use product names for bundled provider services', () => {
  const summary = summarizeStackStatus({
    name: 'proof',
    checks: [
      { component: 'dkb-tei', status: 'ok', message: 'ready' },
      { component: 'dkb-embedder', status: 'failed', message: 'offline' },
      { component: 'dkb-faiss', status: 'ok', message: 'ready' },
    ],
  }).join('\n');

  assert.match(summary, /TEI\s+OK\s+ready/u);
  assert.match(summary, /FastEmbed\s+FAILED\s+offline/u);
  assert.match(summary, /FAISS\s+OK\s+ready/u);
  assert.doesNotMatch(summary, /Dkb Tei/u);
});

test('pasted Markdown registry links produce an actionable URL error', () => {
  assert.throws(
    () => normalizeRegistryUrl('[http://127.0.0.1:8017](http://127.0.0.1:8017)'),
    /Use the plain URL instead: http:\/\/127\.0\.0\.1:8017/,
  );
});

test('Library folders keep an upstream Registry URL that overrides the user fallback', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-folder-registry-config-'));
  const registryRoot = path.join(tempRoot, 'runtime');
  const nestedRoot = path.join(registryRoot, 'nested', 'folder');
  const userConfigPath = path.join(tempRoot, 'user-config.json');
  const previousCliConfig = process.env.DKB_CLI_CONFIG;
  const previousRegistryUrl = process.env.DKB_REGISTRY_URL;
  const previousHostInventory = process.env.DKB_HOST_INVENTORY;

  try {
    process.env.DKB_CLI_CONFIG = userConfigPath;
    process.env.DKB_HOST_INVENTORY = path.join(tempRoot, 'host.json');
    delete process.env.DKB_REGISTRY_URL;
    await fs.mkdir(nestedRoot, { recursive: true });
    await writeLibraryManifest(registryRoot);
    await writeConfiguredRegistryUrl('https://user-registry.example', { global: true });
    const project = await writeConfiguredRegistryUrl('https://project-registry.example', { root: registryRoot });

    assert.equal(project.source, 'project');
    assert.equal(project.configPath, libraryRegistryConfigPath(registryRoot));
    assert.equal((await configuredRegistry({ cwd: nestedRoot })).url, 'https://project-registry.example');
    assert.equal((await configuredRegistry({ root: registryRoot })).source, 'project');
    assert.equal((await configuredRegistry({ root: path.join(tempRoot, 'unconfigured') })).source, 'user');

    process.env.DKB_REGISTRY_URL = 'https://environment-registry.example';
    assert.equal((await configuredRegistry({ root: registryRoot })).source, 'environment');
    assert.equal((await configuredRegistry({ url: 'https://argument-registry.example', root: registryRoot })).source, 'argument');
  } finally {
    restoreEnvironment('DKB_CLI_CONFIG', previousCliConfig);
    restoreEnvironment('DKB_REGISTRY_URL', previousRegistryUrl);
    restoreEnvironment('DKB_HOST_INVENTORY', previousHostInventory);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('bare init creates an idempotent Library and stores its verified upstream Registry URL', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-bare-init-'));
  const registryRoot = path.join(tempRoot, 'knowledge');
  const userConfigPath = path.join(tempRoot, 'user-config.json');
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('content-type', 'application/json');

    if (request.url === '/.well-known/dkb-registry-keys.json') {
      response.end(JSON.stringify({ keys: [] }));
      return;
    }

    if (request.url === '/api/registry/packages') {
      response.end(JSON.stringify({ data: [] }));
      return;
    }

    if (request.url === '/health') {
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ message: 'Not found' }));
  });

  try {
    await fs.mkdir(registryRoot, { recursive: true });
    await listen(server);
    const address = server.address();
    assert.notEqual(typeof address, 'string');
    const registryUrl = `http://127.0.0.1:${address.port}`;
    const environment = {
      DKB_CLI_CONFIG: userConfigPath,
      DKB_HOST_INVENTORY: path.join(tempRoot, 'host.json'),
      DKB_REGISTRY_URL: '',
      DKB_REGISTRY_VERIFY_TIMEOUT_MS: '20000',
    };
    const initialized = await runCli([
      '--json',
      'init',
      '--registry-url',
      registryUrl,
      '--yes',
    ], environment, registryRoot);

    assert.equal(initialized.code, 0, initialized.stderr);
    assert.deepEqual(JSON.parse(initialized.stdout), {
      status: 'initialized',
      type: 'library',
      root: registryRoot,
      manifest: path.join(registryRoot, 'dkb.json'),
      registry: {
        url: registryUrl,
        source: 'project',
        configPath: libraryRegistryConfigPath(registryRoot),
        root: registryRoot,
      },
      host: {
        library: 'knowledge',
        inventoryPath: path.join(tempRoot, 'host.json'),
      },
      verification: {
        ok: true,
        url: registryUrl,
        checks: [
          { name: 'public signing keys', ok: true, required: true, status: 200 },
          { name: 'package listing API', ok: true, required: true, status: 200 },
          { name: 'health endpoint', ok: true, required: false, status: 200 },
        ],
      },
    });
    assert.equal(JSON.parse(await fs.readFile(path.join(registryRoot, 'dkb.json'), 'utf8')).type, 'library');
    assert.equal(JSON.parse(await fs.readFile(libraryRegistryConfigPath(registryRoot), 'utf8')).registry.url, registryUrl);
    assert.deepEqual([...requests].sort(), [
      '/.well-known/dkb-registry-keys.json',
      '/api/registry/packages',
      '/health',
    ].sort());

    const repeated = await runCli(['--json', 'init', '--yes'], environment, registryRoot);

    assert.equal(repeated.code, 0, repeated.stderr);
    assert.equal(JSON.parse(repeated.stdout).status, 'already initialized');
    assert.deepEqual([...requests].sort(), [
      '/.well-known/dkb-registry-keys.json',
      '/api/registry/packages',
      '/health',
    ].sort());
  } finally {
    await close(server);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('bare init without a URL argument still creates the Library when Registry verification fails', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-unverified-init-'));
  const userConfigPath = path.join(tempRoot, 'user-config.json');
  const server = http.createServer((_request, response) => {
    response.statusCode = 404;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ message: 'Not found' }));
  });

  try {
    await listen(server);
    const address = server.address();
    assert.notEqual(typeof address, 'string');
    const registryUrl = `http://127.0.0.1:${address.port}/unavailable`;
    const result = await runCli(['--no-progress', 'init'], {
      DKB_CLI_CONFIG: userConfigPath,
      DKB_REGISTRY_URL: registryUrl,
    }, tempRoot);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Status: initialized/);
    assert.match(result.stdout, /Warning: Upstream Registry .* could not be verified/);
    assert.match(result.stdout, new RegExp(`Retry: dkb registry use ${escapeRegExp(registryUrl)}`));
    assert.match(result.stderr, /Initializing Library complete/);
    assert.match(result.stdout, /Done\./);
    assert.equal(JSON.parse(await fs.readFile(path.join(tempRoot, 'dkb.json'), 'utf8')).type, 'library');
    assert.equal(JSON.parse(await fs.readFile(libraryRegistryConfigPath(tempRoot), 'utf8')).registry.url, registryUrl);
  } finally {
    await close(server);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('registry use saves an unreachable URL and reports how to retry verification', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-registry-use-offline-'));
  const userConfigPath = path.join(tempRoot, 'user-config.json');
  const server = http.createServer((_request, response) => {
    response.statusCode = 503;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ message: 'Offline' }));
  });

  try {
    await writeLibraryManifest(tempRoot);
    await listen(server);
    const address = server.address();
    assert.notEqual(typeof address, 'string');
    const registryUrl = `http://127.0.0.1:${address.port}`;
    const result = await runCli([
      '--no-progress',
      'registry',
      'use',
      registryUrl,
      '--root',
      tempRoot,
    ], {
      DKB_CLI_CONFIG: userConfigPath,
      DKB_REGISTRY_URL: '',
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Status: configured/);
    assert.match(result.stdout, /Warning: Upstream registry URL was saved/);
    assert.match(result.stdout, new RegExp(`Retry: dkb registry status --url ${escapeRegExp(registryUrl)}`));
    assert.equal(JSON.parse(await fs.readFile(libraryRegistryConfigPath(tempRoot), 'utf8')).registry.url, registryUrl);
  } finally {
    await close(server);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('registry status presents an overall status and conventional check columns', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-registry-status-table-'));
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/.well-known/dkb-registry-keys.json') {
      response.end(JSON.stringify({ keys: [] }));
      return;
    }
    response.statusCode = request.url === '/api/registry/packages' ? 503 : 404;
    response.end(JSON.stringify({ message: 'Unavailable' }));
  });

  try {
    await listen(server);
    const address = server.address();
    assert.notEqual(typeof address, 'string');
    const registryUrl = `http://127.0.0.1:${address.port}`;
    const result = await runCli(['registry', 'status', '--url', registryUrl], {}, tempRoot);
    const output = stripAnsi(result.stdout);

    assert.equal(result.code, 1);
    assert.match(output, new RegExp(`Registry: ${escapeRegExp(registryUrl)}`));
    assert.match(output, /Status: FAILED/);
    assert.match(output, /NAME\s+STATUS\s+IMPACT\s+HTTP\s+MESSAGE/);
    assert.match(output, /public signing keys\s+OK\s+BLOCKING\s+200/);
    assert.match(output, /package listing API\s+FAILED\s+BLOCKING\s+503\s+HTTP 503/);
    assert.match(output, /health endpoint\s+FAILED\s+OPTIONAL\s+404\s+HTTP 404/);
    assert.doesNotMatch(output, /\bREQUIRED\b/);
  } finally {
    await close(server);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('registry verification reports connection refusal instead of a generic fetch failure', async () => {
  const server = http.createServer();
  await listen(server);
  const address = server.address();
  assert.notEqual(typeof address, 'string');
  const registryUrl = `http://127.0.0.1:${address.port}`;
  await close(server);

  const verification = await verifyRegistryEndpoint(registryUrl);

  assert.equal(verification.ok, false);
  assert.ok(verification.checks.every((check) => check.message === 'connection refused'));
});

test('serve initialization uses the same offline-safe registry configuration path', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-serve-init-'));
  const registryUrl = 'http://127.0.0.1:1';
  const previousHostInventory = process.env.DKB_HOST_INVENTORY;

  try {
    process.env.DKB_HOST_INVENTORY = path.join(tempRoot, 'host.json');
    const result = await prepareServeLibrary({
      root: tempRoot,
      yes: true,
      registryUrl,
      verifyRegistry: false,
    });

    assert.equal(result.initialized, true);
    assert.equal(result.compiled, false);
    assert.equal(result.registry.url, registryUrl);
    assert.match(result.warning, /was not verified because verification was skipped/);
    assert.equal(result.retryCommand, `dkb registry use ${registryUrl}`);
    assert.equal(JSON.parse(await fs.readFile(path.join(tempRoot, 'dkb.json'), 'utf8')).type, 'library');
    assert.equal(JSON.parse(await fs.readFile(libraryRegistryConfigPath(tempRoot), 'utf8')).registry.url, registryUrl);
  } finally {
    restoreEnvironment('DKB_HOST_INVENTORY', previousHostInventory);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('--no-progress keeps human output and --json is the explicit machine-output switch', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-cli-output-'));

  try {
    const human = await runCli(['--no-progress', 'init', '@test/human-demo', '--dir', tempRoot, '--yes']);
    assert.equal(human.code, 0);
    assert.match(human.stdout, /Type: dkb/);
    assert.match(human.stdout, /Manifest:/);
    assert.doesNotMatch(human.stdout, /^\s*\{/);
    assert.match(human.stderr, /Initializing DKB complete/);
    assert.match(human.stdout, /Done\./);

    const machine = await runCli(['--json', 'init', '@test/json-demo', '--dir', tempRoot, '--yes']);
    assert.equal(machine.code, 0);
    assert.equal(JSON.parse(machine.stdout).status, 'initialized');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('--json-stream emits ordered operation events and a terminal completion', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-cli-events-'));
  try {
    const result = await runCli(['--json-stream', 'init', '@test/stream-demo', '--dir', tempRoot, '--yes']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    const events = result.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index));
    assert.equal(events[0].event, 'start');
    assert.equal(events.at(-2).event, 'result');
    assert.deepEqual(events.at(-1), {
      format: 'dkb.command-event.v1',
      sequence: events.length - 1,
      timestamp: events.at(-1).timestamp,
      event: 'completion',
      status: 'succeeded',
    });

    const failed = await runCli(['--json-stream', 'definitely-not-a-command']);
    const failureEvents = failed.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    assert.equal(failed.code, 1);
    assert.equal(failed.stderr, '');
    assert.equal(failureEvents.at(-2).event, 'failure');
    assert.equal(failureEvents.at(-1).status, 'failed');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('human terminal output is compact and colored while JSON remains ANSI-free', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-cli-color-'));

  try {
    await writeLibraryManifest(tempRoot);
    const colored = await runCli(['list', '--library', tempRoot], {
      DKB_CLI_CONFIG: path.join(tempRoot, 'user-config.json'),
      DKB_REGISTRY_URL: '',
      FORCE_COLOR: '1',
    });
    assert.equal(colored.code, 0);
    assert.match(colored.stdout, /\u001b\[/u);
    assert.doesNotMatch(stripAnsi(colored.stdout), /^[- ]+$/mu);
    assert.equal(stripAnsi(colored.stdout).split('\n').filter(Boolean).length, 3);

    const machine = await runCli(['--json', 'list', '--library', tempRoot], {
      DKB_CLI_CONFIG: path.join(tempRoot, 'user-config.json'),
      DKB_REGISTRY_URL: '',
      FORCE_COLOR: '1',
    });
    assert.equal(machine.code, 0);
    assert.doesNotMatch(machine.stdout, /\u001b\[/u);
    assert.deepEqual(JSON.parse(machine.stdout).packages, []);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('install detects an identical package before requesting its archive', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-cli-preflight-'));
  const packageRoot = path.join(tempRoot, 'vendor', '@acct-test', 'already-here');
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('content-type', 'application/json');

    if (request.url === '/api/registry/packages/acct-test/already-here') {
      response.end(JSON.stringify({ data: { id: '@acct-test/already-here', latestVersion: '1.0.0' } }));
      return;
    }

    if (request.url === '/api/registry/packages/acct-test/already-here/versions/1.0.0') {
      response.end(JSON.stringify({
        data: {
          packageId: '@acct-test/already-here',
          version: '1.0.0',
          status: 'published',
          archiveHash: `sha256:${'b'.repeat(64)}`,
          packageTreeHash: `sha256:${'a'.repeat(64)}`,
          recordCount: 42,
        },
      }));
      return;
    }

    if (request.url === '/api/registry/packages/acct-test/already-here/versions/1.0.0/install-plan?target=alternate') {
      response.end(JSON.stringify({}));
      return;
    }

    response.statusCode = 500;
    response.end(JSON.stringify({ message: `Unexpected request: ${request.url}` }));
  });

  try {
    await fs.mkdir(packageRoot, { recursive: true });
    await writeLibraryManifest(tempRoot);
    await fs.writeFile(path.join(packageRoot, 'dkb.json'), `${JSON.stringify({
      manifestVersion: 1,
      type: 'dkb',
      name: '@acct-test/already-here',
      displayName: 'Already Here',
      version: '1.0.0',
    }, null, 2)}\n`);
    await applyLibraryLock(tempRoot, {
      library: { name: 'Test Runtime' },
      generation: 1,
      entries: {
        '@acct-test/already-here': {
          identity: '@acct-test/already-here',
          kind: 'dkb',
          source: 'registry',
          version: '1.0.0',
          digest: `sha256:${'a'.repeat(64)}`,
          path: 'vendor/@acct-test/already-here',
          requiredBy: ['root:@acct-test/already-here'],
          installedAt: '2026-08-26T00:00:00.000Z',
        },
      },
      resolvedAt: '2026-08-26T00:00:00.000Z',
    });
    await listen(server);
    const address = server.address();
    assert.notEqual(typeof address, 'string');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await fs.mkdir(path.dirname(libraryRegistryConfigPath(tempRoot)), { recursive: true });
    await fs.writeFile(libraryRegistryConfigPath(tempRoot), `${JSON.stringify({ format: 'dkb.config.v2', registry: { url: baseUrl } }, null, 2)}\n`);
    const result = await runCli([
      '--no-progress',
      'install',
      '@acct-test/already-here',
      '--version',
      '1.0.0',
      '--library',
      tempRoot,
    ], { DKB_REGISTRY_URL: '' });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Status: already installed/);
    assert.match(result.stdout, /Package: @acct-test\/already-here@1\.0\.0/);
    assert.match(result.stderr, /Installing DKB complete/);
    assert.match(result.stdout, /Done\./);
    assert.doesNotMatch(result.stderr, /ExperimentalWarning/);
    assert.deepEqual(requests, [
      '/api/registry/packages/acct-test/already-here',
      '/api/registry/packages/acct-test/already-here/versions/1.0.0',
    ]);

    requests.length = 0;
    const targeted = await runCli([
      '--no-progress',
      'install',
      '@acct-test/already-here',
      '--version',
      '1.0.0',
      '--target',
      'alternate',
      '--library',
      tempRoot,
    ], { DKB_REGISTRY_URL: '' });
    assert.equal(targeted.code, 1);
    assert.deepEqual(requests, [
      '/api/registry/packages/acct-test/already-here',
      '/api/registry/packages/acct-test/already-here/versions/1.0.0',
      '/api/registry/packages/acct-test/already-here/versions/1.0.0/install-plan?target=alternate',
    ]);

    const listed = await runCli(['list', '--library', tempRoot]);
    assert.equal(listed.code, 0);
    assert.match(listed.stdout, /ID\s+VERSION\s+STATUS\s+RECORDS/);
    assert.match(listed.stdout, /@acct-test\/already-here\s+1\.0\.0\s+installed/);
  } finally {
    await close(server);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('package search, show, outdated, and upgrade dry-run form one read-only lifecycle', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-cli-package-lifecycle-'));
  const packageRoot = path.join(tempRoot, 'vendor', '@acct-test', 'knowledge');
  const requests = [];
  let unrelated;
  let upgradeRequest;
  const server = http.createServer(async (request, response) => {
    requests.push(request.url);
    response.setHeader('content-type', 'application/json');

    if (request.method === 'POST' && request.url === '/api/dkbs/install-registry') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      upgradeRequest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response.end(JSON.stringify({
        status: 'installed',
        packageId: '@acct-test/knowledge',
        version: '1.1.0',
        packagePath: packageRoot,
      }));
      return;
    }

    if (request.method === 'POST' && request.url === '/api/registry/packages/acct-test/knowledge/versions/1.1.0/install-grant') {
      response.end(JSON.stringify({
        plan: fakeInstallPlan('@acct-test/knowledge', '1.1.0'),
        installGrant: `dkb_grant_${'g'.repeat(64)}`,
        expiresAt: '2026-08-26T00:05:00.000Z',
      }));
      return;
    }

    if (request.url === '/api/registry/packages?q=knowledge&page=1&perPage=20') {
      response.end(JSON.stringify({
        data: [{
          id: '@acct-test/knowledge',
          namespace: 'acct-test',
          name: 'Knowledge',
          slug: 'knowledge',
          latestVersion: '1.1.0',
          visibility: 'private',
        }],
        meta: { current_page: 1, per_page: 20, last_page: 1, total: 1 },
      }));
      return;
    }

    if (request.url === '/api/registry/collections?q=knowledge&page=1&perPage=20') {
      response.end(JSON.stringify({
        data: [{ id: '@acct-test/knowledge-bundle', namespace: 'acct-test', name: 'Knowledge bundle', slug: 'knowledge-bundle', latestRevision: 2, visibility: 'private' }],
        meta: { current_page: 1, per_page: 20, last_page: 1, total: 1 },
      }));
      return;
    }

    if (request.url === '/api/registry/packages/acct-test/knowledge') {
      response.end(JSON.stringify({
        data: {
          id: '@acct-test/knowledge',
          namespace: 'acct-test',
          name: 'Knowledge',
          slug: 'knowledge',
          latestVersion: '1.1.0',
          visibility: 'private',
          versions: [{ version: '1.1.0', status: 'published', packageTreeHash: `sha256:${'d'.repeat(64)}` }],
        },
      }));
      return;
    }

    if (request.url === '/api/registry/packages/acct-test/knowledge/versions/1.1.0') {
      response.end(JSON.stringify({ data: { packageId: '@acct-test/knowledge', version: '1.1.0', status: 'published', builds: [], sourceReceipt: { sourceInventory: { hash: `sha256:${'e'.repeat(64)}` } } } }));
      return;
    }

    if (request.url === '/api/registry/packages/acct-test/knowledge/versions/1.1.0/contents?path=.&perPage=10') {
      response.end(JSON.stringify({
        data: [{ path: 'README.md', bytes: 42, hash: `sha256:${'f'.repeat(64)}` }],
        meta: { packageId: '@acct-test/knowledge', version: '1.1.0', sourceInventory: { format: 'dkb.source-inventory.v1', mediaType: 'application/vnd.dkb.source-inventory+json', hash: `sha256:${'e'.repeat(64)}`, count: 1, bytes: 222 }, nextCursor: null },
      }));
      return;
    }

    if (request.url === '/api/registry/collections/acct-test/knowledge-bundle') {
      response.end(JSON.stringify({ data: { id: '@acct-test/knowledge-bundle', namespace: 'acct-test', name: 'Knowledge bundle', slug: 'knowledge-bundle', latestRevision: 2, visibility: 'private', revisions: [{ revision: 2, digest: `sha256:${'a'.repeat(64)}` }] } }));
      return;
    }

    if (request.url === '/api/registry/collections/acct-test/knowledge-bundle/revisions/2') {
      response.end(JSON.stringify({ data: { collectionId: '@acct-test/knowledge-bundle', revision: 2, digest: `sha256:${'a'.repeat(64)}`, manifest: { type: 'collection', id: '@acct-test/knowledge-bundle', name: 'Knowledge bundle', revision: 2, digest: `sha256:${'a'.repeat(64)}`, members: [{ id: '@acct-test/knowledge', version: '1.1.0', digest: `sha256:${'d'.repeat(64)}` }] } } }));
      return;
    }

    response.statusCode = 500;
    response.end(JSON.stringify({ message: `Unexpected request: ${request.url}` }));
  });

  try {
    await writeLibraryManifest(tempRoot);
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'dkb.json'), `${JSON.stringify({
      manifestVersion: 1,
      type: 'dkb',
      name: '@acct-test/knowledge',
      displayName: 'Knowledge',
      version: '1.0.0',
      description: '',
    }, null, 2)}\n`);
    await applyLibraryLock(tempRoot, {
      library: { name: 'Test Runtime' },
      generation: 1,
      entries: {
        '@acct-test/knowledge': {
          identity: '@acct-test/knowledge',
          kind: 'dkb',
          source: 'registry',
          version: '1.0.0',
          digest: `sha256:${'c'.repeat(64)}`,
          path: 'vendor/@acct-test/knowledge',
          requiredBy: ['root:@acct-test/knowledge'],
          installedAt: '2026-08-26T00:00:00.000Z',
        },
      },
      resolvedAt: '2026-08-26T00:00:00.000Z',
    });
    await listen(server);
    const address = server.address();
    assert.notEqual(typeof address, 'string');
    const registryUrl = `http://127.0.0.1:${address.port}`;
    await fs.mkdir(path.dirname(libraryRegistryConfigPath(tempRoot)), { recursive: true });
    await fs.writeFile(libraryRegistryConfigPath(tempRoot), `${JSON.stringify({ format: 'dkb.config.v2', registry: { url: registryUrl } }, null, 2)}\n`);

    unrelated = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-cli-registry-browse-'));
    const search = await runCli(['--json', 'search', 'knowledge', '--url', registryUrl, '--type', 'all', '--page', '1', '--per-page', '20'], { DKB_REGISTRY_URL: '' }, unrelated);
    assert.equal(search.code, 0, search.stderr);
    assert.deepEqual(JSON.parse(search.stdout).entries.map((entry) => entry.type), ['dkb', 'collection']);
    const remoteDkb = await runCli(['--json', 'registry', 'show', '@acct-test/knowledge', '--version', '1.1.0', '--url', registryUrl], {}, unrelated);
    assert.equal(remoteDkb.code, 0, remoteDkb.stderr);
    assert.equal(JSON.parse(remoteDkb.stdout).selectedVersion.version, '1.1.0');
    const remoteCollection = await runCli(['--json', 'registry', 'show', '@acct-test/knowledge-bundle', '--revision', '2', '--url', registryUrl], {}, unrelated);
    assert.equal(remoteCollection.code, 0, remoteCollection.stderr);
    assert.equal(JSON.parse(remoteCollection.stdout).selectedRevision.revision, 2);
    const remoteContents = await runCli(['--json', 'registry', 'show', '@acct-test/knowledge', '--version', '1.1.0', '--url', registryUrl, '--contents', '.', '--limit', '10'], {}, unrelated);
    assert.equal(remoteContents.code, 0, remoteContents.stderr);
    assert.equal(JSON.parse(remoteContents.stdout).entries[0].path, 'README.md');
    await fs.rm(unrelated, { recursive: true, force: true });
    unrelated = undefined;

    const shown = await runCli(['--json', 'show', '@acct-test/knowledge', '--library', tempRoot]);
    assert.equal(shown.code, 0, shown.stderr);
    const shownPackage = JSON.parse(shown.stdout);
    assert.equal(shownPackage.format, 'dkb.installed-entry-detail.v2');
    assert.equal(shownPackage.identity, '@acct-test/knowledge');
    assert.equal(shownPackage.kind, 'dkb');
    assert.equal(shownPackage.source, 'registry');
    assert.equal(shownPackage.status, 'installed');
    assert.equal(shownPackage.version, '1.0.0');
    assert.equal(shownPackage.digest, `sha256:${'c'.repeat(64)}`);
    assert.equal(shownPackage.path, packageRoot);
    assert.deepEqual(shownPackage.requiredBy, ['root:@acct-test/knowledge']);
    assert.equal(shownPackage.installedAt, '2026-08-26T00:00:00.000Z');
    assert.equal(shownPackage.manifest.displayName, 'Knowledge');
    assert.equal(shownPackage.provenance.receiptStatus, 'missing');
    assert.equal(shownPackage.provenance.installChainStatus, 'missing');
    assert.equal(shownPackage.activeBuild, undefined);

    const storage = await runCli(['--json', 'library', 'storage', '--library', tempRoot]);
    assert.equal(storage.code, 0, storage.stderr);
    assert.equal(JSON.parse(storage.stdout).packages[0].id, '@acct-test/knowledge');
    assert.ok(JSON.parse(storage.stdout).packages[0].sourceBytes > 0);
    assert.equal(JSON.parse(storage.stdout).packages[0].buildBytes, 0);

    const outdated = await runCli(['--json', 'outdated', '--library', tempRoot], { DKB_REGISTRY_URL: '' });
    assert.equal(outdated.code, 0, outdated.stderr);
    assert.equal(JSON.parse(outdated.stdout).updates, 1);
    assert.equal(JSON.parse(outdated.stdout).packages[0].latest, '1.1.0');

    const upgrade = await runCli([
      '--json',
      'upgrade',
      '@acct-test/knowledge',
      '--dry-run',
      '--library',
      tempRoot,
    ], { DKB_REGISTRY_URL: '' });
    assert.equal(upgrade.code, 0, upgrade.stderr);
    assert.deepEqual(JSON.parse(upgrade.stdout), {
      status: 'update_available',
      packageId: '@acct-test/knowledge',
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
      registryUrl,
      libraryRoot: tempRoot,
      dryRun: true,
    });

    const applied = await runCli([
      '--json',
      'upgrade',
      '@acct-test/knowledge',
      '--library',
      tempRoot,
      '--url',
      registryUrl,
      '--runtime-url',
      registryUrl,
    ], { DKB_REGISTRY_URL: '' });
    assert.equal(applied.code, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).version, '1.1.0');
    assert.deepEqual(upgradeRequest, {
      registryUrl,
      installGrant: `dkb_grant_${'g'.repeat(64)}`,
      plan: fakeInstallPlan('@acct-test/knowledge', '1.1.0'),
      force: true,
    });
    assert.ok(requests.includes('/api/registry/packages?q=knowledge&page=1&perPage=20'));
    assert.ok(requests.includes('/api/registry/collections?q=knowledge&page=1&perPage=20'));
    assert.ok(requests.includes('/api/registry/packages/acct-test/knowledge/versions/1.1.0/contents?path=.&perPage=10'));
    assert.ok(requests.includes('/api/registry/packages/acct-test/knowledge/versions/1.1.0/install-grant'));
    assert.ok(requests.includes('/api/dkbs/install-registry'));
  } finally {
    await close(server);
    if (unrelated) await fs.rm(unrelated, { recursive: true, force: true });
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

function fakeInstallPlan(packageId, version) {
  const digest = (label) => `sha256:${label.repeat(64).slice(0, 64)}`;
  const signature = (role) => ({
    ...(role === 'publisher' ? { accountId: '@acct-test' } : { registryId: 'test-registry' }),
    keyId: `${role}-key`,
    publicKeyFingerprint: digest(role === 'publisher' ? 'a' : 'b'),
    algorithm: 'ed25519',
    value: 'signature',
    signedAt: '2026-08-26T00:00:00.000Z',
  });
  const receipt = (type) => ({
    type,
    version: 1,
    package: { id: packageId, version, sourceHash: digest('c') },
    payloadHash: digest('d'),
    payload: {},
    publisher: signature('publisher'),
    registry: signature('registry'),
  });
  const payload = {
    format: 'dkb.install-plan.v1',
    package: { id: packageId, version, sourceDigest: digest('c') },
    target: 'default',
    evidenceProfileDigest: digest('e'),
    evidenceDigest: digest('f'),
    retrievalProfileDigest: digest('1'),
    compatibilityDigest: digest('2'),
    retrievalBuildDigest: digest('3'),
    artifacts: [
      { kind: 'source', digest: digest('4'), mediaType: 'application/vnd.dkb.source+gzip', bytes: 1, url: '/source', receiptHash: digest('5'), receipt: receipt('dkb.evidence.receipt') },
      { kind: 'evidence', digest: digest('6'), mediaType: 'application/vnd.dkb.evidence+gzip', bytes: 1, url: '/evidence', receiptHash: digest('7'), receipt: receipt('dkb.evidence.receipt') },
      { kind: 'retrieval', digest: digest('8'), mediaType: 'application/vnd.dkb.retrieval-build+gzip', bytes: 1, url: '/retrieval', receiptHash: digest('9'), receipt: receipt('dkb.retrieval.receipt') },
    ],
  };
  return { ...payload, receipt: { ...receipt('dkb.install-plan.receipt'), payload } };
}

test('archive extraction reports a single indeterminate pass with an explicit completion', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-cli-extract-'));
  const sourceRoot = path.join(tempRoot, 'source');
  const outputRoot = path.join(tempRoot, 'output');
  const archivePath = path.join(tempRoot, 'sample.dkbpkg');
  const events = [];

  try {
    await fs.mkdir(sourceRoot, { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'one.txt'), 'one');
    await fs.writeFile(path.join(sourceRoot, 'two.txt'), 'two');
    await createDkbPackageArchive(sourceRoot, archivePath);
    await extractDkbPackageArchive(archivePath, outputRoot, { progress: (event) => events.push(event) });

    assert.equal(events[0].status, 'start');
    assert.equal(events[0].total, 0);
    assert.ok(events.some((event) => event.status === 'update' && event.value > 0));
    assert.equal(events.at(-1).status, 'finish');
    assert.ok(events.at(-1).total >= 2);
    assert.equal(await fs.readFile(path.join(outputRoot, 'one.txt'), 'utf8'), 'one');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('package archives retain immutable builds while excluding operator-controlled state and retired artifacts', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-cli-archive-boundary-'));
  const sourceRoot = path.join(tempRoot, 'source');
  const outputRoot = path.join(tempRoot, 'output');
  const archivePath = path.join(tempRoot, 'sample.dkbpkg');

  try {
    await fs.mkdir(path.join(sourceRoot, '.dkb/plugins/@host/provider'), { recursive: true });
    await fs.mkdir(path.join(sourceRoot, '.dkb/artifacts'), { recursive: true });
    await fs.mkdir(path.join(sourceRoot, '.dkb/builds/evidence/profile/digest'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, '.dkb/config.json'), '{"activeTarget":"host-only"}\n');
    await fs.writeFile(path.join(sourceRoot, '.dkb/plugins/@host/provider/plugin.mjs'), 'throw new Error("must not install")\n');
    await fs.writeFile(path.join(sourceRoot, '.dkb/artifacts/evidence.json'), '{"portable":true}\n');
    await fs.writeFile(path.join(sourceRoot, '.dkb/builds/evidence/profile/digest/evidence.ir.json'), '{"portable":true}\n');
    await fs.writeFile(path.join(sourceRoot, '.dkb/runtime.lock.json'), '{"format":"dkb.runtime.lock.v2"}\n');
    await fs.writeFile(path.join(sourceRoot, '.env'), 'SECRET=must-not-ship\n');
    await fs.writeFile(path.join(sourceRoot, 'private.pem'), 'must-not-ship\n');
    await fs.mkdir(path.join(sourceRoot, 'node_modules', 'unsafe'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'node_modules', 'unsafe', 'index.js'), 'must-not-ship\n');
    await fs.writeFile(path.join(sourceRoot, 'dkb.json'), '{"type":"dkb"}\n');
    await createDkbPackageArchive(sourceRoot, archivePath);
    await extractDkbPackageArchive(archivePath, outputRoot);

    await assert.rejects(fs.access(path.join(outputRoot, '.dkb/config.json')), (error) => error?.code === 'ENOENT');
    await assert.rejects(fs.access(path.join(outputRoot, '.dkb/plugins/@host/provider/plugin.mjs')), (error) => error?.code === 'ENOENT');
    await assert.rejects(fs.access(path.join(outputRoot, '.dkb/artifacts/evidence.json')), (error) => error?.code === 'ENOENT');
    await assert.rejects(fs.access(path.join(outputRoot, '.env')), (error) => error?.code === 'ENOENT');
    await assert.rejects(fs.access(path.join(outputRoot, 'private.pem')), (error) => error?.code === 'ENOENT');
    await assert.rejects(fs.access(path.join(outputRoot, 'node_modules/unsafe/index.js')), (error) => error?.code === 'ENOENT');
    assert.equal(await fs.readFile(path.join(outputRoot, '.dkb/builds/evidence/profile/digest/evidence.ir.json'), 'utf8'), '{"portable":true}\n');
    await assert.rejects(fs.access(path.join(outputRoot, '.dkb/runtime.lock.json')), (error) => error?.code === 'ENOENT');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('install preflight rejects version digest drift and incomplete runtime state', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-cli-preflight-errors-'));
  const packageRoot = path.join(tempRoot, 'vendor', '@acct-test', 'example');

  try {
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'dkb.json'), `${JSON.stringify({
      manifestVersion: 1,
      type: 'dkb',
      name: '@acct-test/example',
      displayName: 'Example',
      version: '1.0.0',
    })}\n`);
    await writeLibraryManifest(tempRoot, {
      '@acct-test/example': { version: '1.0.0' },
    });
    await applyLibraryLock(tempRoot, {
      library: { name: 'Test Runtime' },
      generation: 1,
      entries: {
        '@acct-test/example': {
          identity: '@acct-test/example',
          kind: 'dkb',
          source: 'registry',
          version: '1.0.0',
          digest: `sha256:${'a'.repeat(64)}`,
          path: 'vendor/@acct-test/example',
          requiredBy: ['root:@acct-test/example'],
          installedAt: '2026-08-26T00:00:00.000Z',
        },
      },
      resolvedAt: '2026-08-26T00:00:00.000Z',
    });

    await assert.rejects(
      preflightDkbInstall({
        libraryRoot: tempRoot,
        candidate: { packageId: '@acct-test/example', version: '1.0.0', packageTreeHash: `sha256:${'b'.repeat(64)}` },
      }),
      /Published versions must be immutable/,
    );

    await fs.rm(path.join(tempRoot, 'dkb-lock.json'));
    await fs.rm(path.join(tempRoot, '.dkb', 'state.sqlite'));
    await assert.rejects(
      preflightDkbInstall({
        libraryRoot: tempRoot,
        candidate: { packageId: '@acct-test/example', version: '1.0.0' },
      }),
      /incomplete installation.*Use --force to repair/s,
    );

    const listed = await runCli(['list', '--library', tempRoot]);
    assert.equal(listed.code, 0);
    assert.match(listed.stdout, /@acct-test\/example\s+1\.0\.0\s+untracked/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('registry archives stream directly to a file with byte progress', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-cli-download-'));
  const target = path.join(tempRoot, 'download.dkbpkg');
  const payload = Buffer.alloc(128 * 1024, 7);
  const events = [];
  const server = http.createServer((request, response) => {
    if (request.url !== '/api/registry/packages/test/example/versions/1.2.3/download') {
      response.statusCode = 404;
      response.end();
      return;
    }

    response.setHeader('content-type', 'application/vnd.dkb.package+gzip');
    response.setHeader('content-length', String(payload.length));
    response.end(payload);
  });

  try {
    await listen(server);
    const address = server.address();
    assert.notEqual(typeof address, 'string');
    const client = new DkbRegistryClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    const result = await client.writePackageArchive('@test/example', target, '1.2.3', {
      progress: (event) => events.push(event),
    });

    assert.equal(result.bytes, payload.length);
    assert.deepEqual(await fs.readFile(target), payload);
    assert.equal(events[0].status, 'start');
    assert.equal(events[0].total, payload.length);
    assert.equal(events.at(-1).status, 'finish');
    assert.equal(events.at(-1).total, payload.length);
  } finally {
    await close(server);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('registry archive writes preserve existing output until a forced download completes', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-cli-safe-download-'));
  const target = path.join(tempRoot, 'download.dkbpkg');
  const original = Buffer.from('original archive');
  const replacement = Buffer.from('replacement archive');
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('content-type', 'application/vnd.dkb.package+gzip');

    if (request.url?.includes('/broken/')) {
      response.setHeader('content-length', String(replacement.length + 5));
      response.end(replacement);
      return;
    }

    response.setHeader('content-length', String(replacement.length));
    response.end(replacement);
  });

  try {
    await fs.writeFile(target, original);
    await listen(server);
    const address = server.address();
    assert.notEqual(typeof address, 'string');
    const client = new DkbRegistryClient({ baseUrl: `http://127.0.0.1:${address.port}` });

    await assert.rejects(
      client.writePackageArchive('@test/example', target, '1.0.0'),
      /Output archive already exists.*Use --force/,
    );
    assert.deepEqual(requests, []);
    assert.deepEqual(await fs.readFile(target), original);

    await assert.rejects(
      client.writePackageArchive('@test/broken', target, '1.0.0', { force: true }),
      /terminated|incomplete/,
    );
    assert.deepEqual(await fs.readFile(target), original);

    const completed = await client.writePackageArchive('@test/example', target, '1.0.0', { force: true });
    assert.equal(completed.bytes, replacement.length);
    assert.deepEqual(await fs.readFile(target), replacement);
    assert.deepEqual((await fs.readdir(tempRoot)).sort(), ['download.dkbpkg']);
  } finally {
    await close(server);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('local package archive copies require force and replace atomically', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-cli-safe-copy-'));
  const source = path.join(tempRoot, 'source.dkbpkg');
  const target = path.join(tempRoot, 'target.dkbpkg');

  try {
    await fs.writeFile(source, 'replacement');
    await fs.writeFile(target, 'original');

    await assert.rejects(
      writeArchiveFileFromPath(source, target),
      /Output archive already exists.*Use --force/,
    );
    assert.equal(await fs.readFile(target, 'utf8'), 'original');

    const result = await writeArchiveFileFromPath(source, target, { force: true });
    assert.equal(result.bytes, Buffer.byteLength('replacement'));
    assert.equal(await fs.readFile(target, 'utf8'), 'replacement');
    assert.deepEqual((await fs.readdir(tempRoot)).sort(), ['source.dkbpkg', 'target.dkbpkg']);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('publish reports remote claim failure as a recoverable partial success', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-cli-publish-partial-'));
  const packageRoot = path.join(tempRoot, 'publish-demo');
  const remoteUrl = 'https://runtime.example.test';
  const server = http.createServer((request, response) => {
    request.resume();
    response.setHeader('content-type', 'application/json');

    if (request.method === 'POST' && request.url === '/api/registry/packages') {
      response.statusCode = 201;
      response.end(JSON.stringify({ data: { id: '@test/publish-demo' } }));
      return;
    }

    if (request.method === 'POST' && request.url === '/api/registry/packages/test/publish-demo/versions') {
      response.statusCode = 201;
      response.end(JSON.stringify({
        data: {
          packageId: '@test/publish-demo',
          version: '0.1.0',
          status: 'published',
          recordCount: 1,
        },
      }));
      return;
    }

    if (request.method === 'POST' && request.url === '/api/registry/packages/test/publish-demo/versions/0.1.0/remote-endpoints') {
      response.statusCode = 503;
      response.end(JSON.stringify({ message: 'Runtime endpoint unavailable' }));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ message: 'Not found' }));
  });

  try {
    await writePackageManifest(packageRoot, 'Publish Demo', '0.1.0');
    await fs.writeFile(path.join(packageRoot, 'notes.md'), '# One\n\nEvidence.\n');
    await listen(server);
    const address = server.address();
    assert.notEqual(typeof address, 'string');
    const client = new DkbRegistryClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    const result = await client.publish({ sourcePath: packageRoot, remoteUrl, visibility: 'public' });

    assert.equal(result.status, 'published');
    assert.equal(result.packageId, '@test/publish-demo');
    assert.match(result.warning, /Package published, but remote endpoint registration failed/);
    assert.equal(result.retryCommand, `dkb registry remote claim @test/publish-demo@0.1.0 --url ${remoteUrl}`);
  } finally {
    await close(server);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('publish does not treat an unrelated 422 validation response as package existence', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-cli-publish-validation-'));
  const packageRoot = path.join(tempRoot, 'invalid-demo');
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    response.setHeader('content-type', 'application/json');

    if (request.method === 'POST' && request.url === '/api/registry/packages') {
      response.statusCode = 422;
      response.end(JSON.stringify({ message: 'The visibility field is invalid.' }));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ message: 'Package not found' }));
  });

  try {
    await writePackageManifest(packageRoot, 'Invalid Demo', '0.1.0');
    await listen(server);
    const address = server.address();
    assert.notEqual(typeof address, 'string');
    const client = new DkbRegistryClient({ baseUrl: `http://127.0.0.1:${address.port}` });

    await assert.rejects(
      client.publish({ sourcePath: packageRoot }),
      /The visibility field is invalid/,
    );
    assert.deepEqual(requests, [
      'POST /api/registry/packages',
      'GET /api/registry/packages/test/invalid-demo',
    ]);
  } finally {
    await close(server);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('publish continues after a 422 only when the requested package is confirmed', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-cli-publish-existing-'));
  const packageRoot = path.join(tempRoot, 'existing-demo');
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    response.setHeader('content-type', 'application/json');

    if (request.method === 'POST' && request.url === '/api/registry/packages') {
      response.statusCode = 422;
      response.end(JSON.stringify({ message: 'The package has already been reserved.' }));
      return;
    }

    if (request.method === 'GET' && request.url === '/api/registry/packages/test/existing-demo') {
      response.end(JSON.stringify({ data: { id: '@test/existing-demo' } }));
      return;
    }

    if (request.method === 'POST' && request.url === '/api/registry/packages/test/existing-demo/versions') {
      response.statusCode = 201;
      response.end(JSON.stringify({
        data: {
          packageId: '@test/existing-demo',
          version: '0.1.0',
          status: 'published',
          recordCount: 0,
        },
      }));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ message: 'Not found' }));
  });

  try {
    await writePackageManifest(packageRoot, 'Existing Demo', '0.1.0');
    await listen(server);
    const address = server.address();
    assert.notEqual(typeof address, 'string');
    const client = new DkbRegistryClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    const result = await client.publish({ sourcePath: packageRoot });

    assert.equal(result.status, 'published');
    assert.deepEqual(requests, [
      'POST /api/registry/packages',
      'GET /api/registry/packages/test/existing-demo',
      'POST /api/registry/packages/test/existing-demo/versions',
    ]);
  } finally {
    await close(server);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('publish survives a transient connection failure while polling compilation status', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-cli-publish-poll-retry-'));
  const packageRoot = path.join(tempRoot, 'poll-retry-demo');
  const previousPollInterval = process.env.DKB_REGISTRY_PUBLISH_POLL_INTERVAL_MS;
  const previousTimeout = process.env.DKB_REGISTRY_PUBLISH_TIMEOUT_MS;
  let statusPolls = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    response.setHeader('content-type', 'application/json');

    if (request.method === 'POST' && request.url === '/api/registry/packages') {
      response.statusCode = 201;
      response.end(JSON.stringify({ data: { id: '@test/poll-retry-demo' } }));
      return;
    }

    if (request.method === 'POST' && request.url === '/api/registry/packages/test/poll-retry-demo/versions') {
      response.statusCode = 202;
      response.end(JSON.stringify({
        data: {
          packageId: '@test/poll-retry-demo',
          version: '0.1.0',
          status: 'compiling',
        },
      }));
      return;
    }

    if (request.method === 'GET' && request.url === '/api/registry/packages/test/poll-retry-demo/versions/0.1.0') {
      statusPolls += 1;

      if (statusPolls === 1) {
        request.socket.destroy();
        return;
      }

      response.end(JSON.stringify({
        data: {
          packageId: '@test/poll-retry-demo',
          version: '0.1.0',
          status: 'published',
          recordCount: 1,
        },
      }));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ message: 'Not found' }));
  });

  try {
    process.env.DKB_REGISTRY_PUBLISH_POLL_INTERVAL_MS = '10';
    process.env.DKB_REGISTRY_PUBLISH_TIMEOUT_MS = '2000';
    await writePackageManifest(packageRoot, 'Poll Retry Demo', '0.1.0');
    await listen(server);
    const address = server.address();
    assert.notEqual(typeof address, 'string');
    const client = new DkbRegistryClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    const result = await client.publish({ sourcePath: packageRoot });

    assert.equal(result.status, 'published');
    assert.equal(statusPolls, 2);
  } finally {
    restoreEnvironment('DKB_REGISTRY_PUBLISH_POLL_INTERVAL_MS', previousPollInterval);
    restoreEnvironment('DKB_REGISTRY_PUBLISH_TIMEOUT_MS', previousTimeout);
    await close(server);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('publish honors Retry-After and resumes status polling after Registry rate limiting', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-cli-publish-poll-rate-limit-'));
  const packageRoot = path.join(tempRoot, 'poll-rate-limit-demo');
  const previousPollInterval = process.env.DKB_REGISTRY_PUBLISH_POLL_INTERVAL_MS;
  const previousTimeout = process.env.DKB_REGISTRY_PUBLISH_TIMEOUT_MS;
  let statusPolls = 0;
  let rateLimitedAt = 0;
  let resumedAt = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    response.setHeader('content-type', 'application/json');

    if (request.method === 'POST' && request.url === '/api/registry/packages') {
      response.statusCode = 201;
      response.end(JSON.stringify({ data: { id: '@test/poll-rate-limit-demo' } }));
      return;
    }

    if (request.method === 'POST' && request.url === '/api/registry/packages/test/poll-rate-limit-demo/versions') {
      response.statusCode = 202;
      response.end(JSON.stringify({
        data: {
          packageId: '@test/poll-rate-limit-demo',
          version: '0.1.0',
          status: 'compiling',
        },
      }));
      return;
    }

    if (request.method === 'GET' && request.url === '/api/registry/packages/test/poll-rate-limit-demo/versions/0.1.0') {
      statusPolls += 1;
      if (statusPolls === 1) {
        rateLimitedAt = Date.now();
        response.statusCode = 429;
        response.setHeader('retry-after', '1');
        response.end(JSON.stringify({ message: 'Too Many Attempts.' }));
        return;
      }

      resumedAt = Date.now();
      response.end(JSON.stringify({
        data: {
          packageId: '@test/poll-rate-limit-demo',
          version: '0.1.0',
          status: 'published',
          recordCount: 1,
        },
      }));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ message: 'Not found' }));
  });

  try {
    process.env.DKB_REGISTRY_PUBLISH_POLL_INTERVAL_MS = '10';
    process.env.DKB_REGISTRY_PUBLISH_TIMEOUT_MS = '3000';
    await writePackageManifest(packageRoot, 'Poll Rate Limit Demo', '0.1.0');
    await listen(server);
    const address = server.address();
    assert.notEqual(typeof address, 'string');
    const client = new DkbRegistryClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    const result = await client.publish({ sourcePath: packageRoot });

    assert.equal(result.status, 'published');
    assert.equal(statusPolls, 2);
    assert.ok(resumedAt - rateLimitedAt >= 900, `Retry-After was not honored (${resumedAt - rateLimitedAt} ms)`);
  } finally {
    restoreEnvironment('DKB_REGISTRY_PUBLISH_POLL_INTERVAL_MS', previousPollInterval);
    restoreEnvironment('DKB_REGISTRY_PUBLISH_TIMEOUT_MS', previousTimeout);
    await close(server);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('runtime import removes its staged copy after a successful activation', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-cli-add-staging-'));
  const packageRoot = path.join(tempRoot, 'source');
  const importRoot = path.join(tempRoot, 'imports');
  let requestBody;
  let requestPath;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      requestPath = request.url;
      requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response.end(JSON.stringify({ status: 'installed', id: 'staged-demo' }));
    });
  });

  try {
    await writePackageManifest(packageRoot, 'Staged Demo', '0.1.0');
    await fs.writeFile(path.join(packageRoot, 'notes.md'), 'Staged source.\n');
    await Promise.all([
      fs.mkdir(path.join(packageRoot, '.dkb', 'plugins', '@test', 'evidence'), { recursive: true }),
      fs.mkdir(path.join(packageRoot, '.dkb', 'plugins', '@test', 'embedding'), { recursive: true }),
      fs.mkdir(path.join(packageRoot, '.dkb', 'plugins', '@test', 'index'), { recursive: true }),
      fs.mkdir(path.join(packageRoot, '.dkb', 'plugins', '@test', 'retrieval'), { recursive: true }),
    ]);
    await fs.writeFile(path.join(packageRoot, '.dkb', 'config.json'), JSON.stringify({
      format: 'dkb.config.v2',
      targets: { default: { evidence: '@test/evidence', embedding: '@test/embedding', index: '@test/index', retrieval: '@test/retrieval' } },
    }));
    await fs.writeFile(path.join(packageRoot, '.dkb', 'plugins', '@test', 'evidence', 'plugin.mjs'), `
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
export const apiVersion = 3;
export const id = '@test/evidence';
export const version = '1.0.0';
export const optionsSchema = { '~standard': { version: 1, vendor: 'test', validate(value) { return { value: value ?? {} }; } } };
export function setup(context) {
  context.registerProvider({ kind: 'evidence', async compile({ dkb }) {
    const bytes = await fs.readFile(path.join(dkb.root, 'notes.md'));
    const text = bytes.toString('utf8').trimEnd();
    return { records: [{ id: 'test-record', chunkId: 'test-chunk', text, metadata: {}, provenance: {
      assetId: 'notes.md', storeId: 'files', sourceType: 'filesystem',
      locator: { path: 'notes.md', chunk: 0 }, assetLocator: { path: 'notes.md' }, title: 'notes.md',
      sourceHash: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
      updatedAt: '2026-08-27T00:00:00.000Z', chunkOrdinal: 0, chunkStart: 0, chunkEnd: text.length,
    } }], receipt: { build: { records: 1 } } };
  } });
}
`);
    await fs.writeFile(path.join(packageRoot, '.dkb', 'plugins', '@test', 'embedding', 'plugin.mjs'), `
export const apiVersion = 3;
export const id = '@test/embedding';
export const version = '1.0.0';
export const optionsSchema = { '~standard': { version: 1, vendor: 'test', validate(value) { return { value: value ?? {} }; } } };
export function setup(context) {
  context.registerProvider({
    kind: 'embedding',
    async embedDocuments({ texts }) { return texts.map(() => [1]); },
    async embedQuery() { return [1]; },
    compatibility() { return { embeddingSpace: 'test-space', dimensions: 1, metric: 'cosine', normalized: true }; },
  });
}
`);
    await fs.writeFile(path.join(packageRoot, '.dkb', 'plugins', '@test', 'retrieval', 'plugin.mjs'), `
export const apiVersion = 3;
export const id = '@test/retrieval';
export const version = '1.0.0';
export const optionsSchema = { '~standard': { version: 1, vendor: 'test', validate(value) { return { value: value ?? {} }; } } };
export function setup(context) {
  context.registerProvider({ kind: 'retrieval', protocol: 'dkb.evidence.v1', capabilities: { vectors: 'required' },
    openRuntime() { return { providerId: id, protocol: 'dkb.evidence.v1', async search() { return { hits: [], trace: {} }; }, close() {} }; },
  });
}
`);
    await fs.writeFile(path.join(packageRoot, '.dkb', 'plugins', '@test', 'index', 'plugin.mjs'), `
import fs from 'node:fs/promises';
import path from 'node:path';
export const apiVersion = 3;
export const id = '@test/index';
export const version = '1.0.0';
export const optionsSchema = { '~standard': { version: 1, vendor: 'test', validate(value) { return { value: value ?? {} }; } } };
export function setup(context) {
  context.registerProvider({
    kind: 'index',
    mode: 'packaged',
    format: 'test.index.v1',
    capabilities: { vectors: 'required' },
    async compilePackage({ artifactsRoot, compiled }) {
      const target = path.join(artifactsRoot, 'test-index.json');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify(compiled.records));
      return { build: { recordCount: compiled.records.length } };
    },
    async validatePackage() { return { documentCount: 1 }; },
    async verifyRuntime() { return { indexId: 'test', documentCount: 1, status: 'ready' }; },
    async openRuntime() { return null; },
  });
}
`);
    await listen(server);
    const address = server.address();
    assert.notEqual(typeof address, 'string');
    const result = await runCli([
      '--json',
      'runtime',
      'import',
      packageRoot,
      '--url',
      `http://127.0.0.1:${address.port}`,
      '--host-import-root',
      importRoot,
      '--container-import-root',
      '/imports',
    ]);

    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(requestPath, '/api/dkbs/import-artifact');
    assert.match(requestBody.sourcePath, /^\/imports\/test-staged-demo-/);
    assert.deepEqual(await fs.readdir(importRoot), []);
  } finally {
    await close(server);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('pipeline set accepts lexical-only targets in human and JSON modes', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-cli-lexical-pipeline-'));
  const environment = { DKB_GLOBAL_ROOT: path.join(tempRoot, 'global') };

  try {
    await writePipelineFixturePlugin(tempRoot, '@test/lexical', 'none');

    const argumentsFor = () => [
      'pipeline', 'set', 'default',
      '--root', tempRoot,
      '--evidence', '@test/lexical',
      '--index', '@test/lexical',
      '--retrieval', '@test/lexical',
    ];
    const human = await runCli(argumentsFor(), environment);
    assert.equal(human.code, 0, `${human.stderr}\n${human.stdout}`);
    assert.match(stripAnsi(human.stderr), /Updating pipeline complete/u);
    assert.match(human.stdout, /Target: default/u);
    assert.doesNotMatch(human.stdout, /embedding/u);

    const jsonResult = await runCli(['--json', ...argumentsFor()], environment);
    assert.equal(jsonResult.code, 0, `${jsonResult.stderr}\n${jsonResult.stdout}`);
    assert.equal(jsonResult.stderr, '');
    const json = JSON.parse(jsonResult.stdout);
    assert.equal(json.target, 'default');
    assert.deepEqual(json.providers.map((provider) => provider.kind), ['evidence', 'index', 'retrieval']);

    const saved = JSON.parse(await fs.readFile(path.join(tempRoot, '.dkb', 'config.json'), 'utf8'));
    assert.equal(saved.targets.default.embedding, null);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('pipeline set rejects vector-required targets without an embedder in human and JSON modes', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-cli-vector-pipeline-'));
  const environment = { DKB_GLOBAL_ROOT: path.join(tempRoot, 'global') };

  try {
    await writePipelineFixturePlugin(tempRoot, '@test/vector', 'required');
    const argumentsFor = () => [
      'pipeline', 'set', 'default',
      '--root', tempRoot,
      '--evidence', '@test/vector',
      '--index', '@test/vector',
      '--retrieval', '@test/vector',
    ];
    const humanFailure = await runCli(argumentsFor(), environment);
    assert.equal(humanFailure.code, 1);
    assert.equal(humanFailure.stdout, '');
    assert.match(stripAnsi(humanFailure.stderr), /requires an embedding provider because its index or retrieval provider requires vectors/u);

    const jsonFailure = await runCli(['--json', ...argumentsFor()], environment);
    assert.equal(jsonFailure.code, 1);
    assert.equal(jsonFailure.stderr, '');
    assert.match(
      JSON.parse(jsonFailure.stdout).error.message,
      /requires an embedding provider because its index or retrieval provider requires vectors/u,
    );

    await assert.rejects(fs.access(path.join(tempRoot, '.dkb', 'config.json')));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('diagnostic commands return nonzero when their report is not healthy', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-cli-diagnostics-'));

  try {
    await writeLibraryManifest(tempRoot);
    const health = await runCli(['--json', 'health', tempRoot]);
    assert.equal(health.code, 1);
    assert.equal(JSON.parse(health.stdout).status, 'degraded');

    const doctor = await runCli(['--json', 'compiler', 'doctor'], {
      PATH: '',
      Path: '',
    });
    assert.equal(doctor.code, 1);
    assert.equal(JSON.parse(doctor.stdout).ok, false);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('JSON command failures are a single structured document', async () => {
  const result = await runCli(['--json', 'definitely-not-a-command']);

  assert.equal(result.code, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    error: {
      code: 'commander.unknownCommand',
      message: "unknown command 'definitely-not-a-command'",
    },
  });
});

test('usage failures point to exact subcommand help', async () => {
  const human = await runCli(['install']);
  assert.equal(human.code, 1);
  assert.equal(human.stdout, '');
  assert.match(human.stderr, /^dkb: missing required argument 'package-id'/);
  assert.match(human.stderr, /Run 'dkb install --help' for usage\./);

  const machine = await runCli(['--json', 'install']);
  assert.equal(machine.code, 1);
  assert.equal(machine.stderr, '');
  assert.equal(JSON.parse(machine.stdout).error.code, 'commander.missingArgument');
});

test('root help separates common, management, and advanced commands', async () => {
  const result = await runCli(['--help'], { FORCE_COLOR: '1' });
  const plain = stripAnsi(result.stdout);

  assert.equal(result.code, 0);
  assert.match(plain, /Common Commands:/);
  assert.match(plain, /add \[options\] <path>\s+Compile a local DKB and activate/);
  assert.match(plain, /search \[options\] \[query\]\s+Search the configured Registry/);
  assert.match(plain, /show \[options\] <identity>\s+Inspect one installed DKB/);
  assert.match(plain, /outdated \[options\] \[identity\]\s+Check installed Registry DKBs/);
  assert.match(plain, /upgrade \[options\] <identity>\s+Upgrade one installed Registry DKB/);
  assert.match(plain, /Management Commands:/);
  assert.match(plain, /build \[options\] \[path\]\s+Compile and manage stored Evidence and Retrieval Builds/);
  assert.match(plain, /pipeline\s+Inspect, select, and verify the provider pipeline/);
  assert.match(plain, /plugin\s+Manage trusted filesystem plugins/);
  assert.match(plain, /Advanced Commands:/);
  assert.doesNotMatch(plain, /Other Commands:/);
  assert.match(plain, /compile \[options\] \[path\]\s+Compile a DKB or Library/);
  assert.match(plain, /Run 'dkb <command> --help'/);

  for (const signature of [
    'init [options] [identity]',
    'list [options]',
    'query [options] <query>',
  ]) {
    assert.ok(
      result.stdout.includes(`\u001b[36m${signature}\u001b[39m`),
      `expected the complete command signature to be cyan: ${signature}`,
    );
  }
});

test('registry help exposes the implemented credential lifecycle', async () => {
  const group = await runCli(['registry', '--help']);
  const packages = await runCli(['registry', 'packages', '--help']);
  const login = await runCli(['registry', 'login', '--help']);
  const logout = await runCli(['registry', 'logout', '--help']);

  assert.equal(group.code, 0);
  assert.equal(packages.code, 0);
  assert.equal(login.code, 0);
  assert.equal(logout.code, 0);
  assert.match(group.stdout, /login \[options\]\s+Authenticate this host with a Registry/);
  assert.match(group.stdout, /whoami \[options\]\s+Show the account and team/);
  assert.match(group.stdout, /logout \[options\]\s+Remove the saved Registry credential/);
  assert.doesNotMatch(packages.stdout, /--token <token>/);
  assert.match(login.stdout, /--token-stdin/);
  assert.match(login.stdout, /--device/);
  assert.match(login.stdout, /--scope <scope\.\.\.>/);
  assert.match(logout.stdout, /--revoke/);
});

test('remote help exposes discovery only and no retired query gateway', async () => {
  const result = await runCli(['remote', '--help']);

  assert.equal(result.code, 0);
  for (const command of ['search', 'add', 'list', 'status', 'remove']) {
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`, 'u'));
  }
  for (const retired of ['discover', 'attach', 'sessions', 'detach', 'query']) {
    assert.doesNotMatch(result.stdout, new RegExp(`^\\s+${retired}(?:\\s|$)`, 'mu'));
  }
  assert.match(result.stdout, /Registry-verified remote DKB Runtime endpoints/u);
});

test('retained add and compile command surfaces expose their supported options', async () => {
  const add = await runCli(['add', '--help']);
  const runtimeImport = await runCli(['runtime', 'import', '--help']);
  const compile = await runCli(['compile', '--help']);

  assert.equal(add.code, 0);
  assert.equal(runtimeImport.code, 0);
  assert.equal(compile.code, 0);
  assert.match(add.stdout, /--host-import-root <path>/);
  assert.match(runtimeImport.stdout, /--host-import-root <path>/);
  assert.match(compile.stdout, /--pipeline <name>/);
  assert.match(compile.stdout, /--target <name>/);
});

test('nested help uses the same color system for command groups and leaves', async () => {
  const group = await runCli(['library', '--help'], { FORCE_COLOR: '1' });
  const leaf = await runCli(['library', 'register', '--help'], { FORCE_COLOR: '1' });

  assert.equal(group.code, 0);
  assert.equal(leaf.code, 0);
  assert.ok(group.stdout.includes('\u001b[1m\u001b[36mCommands:\u001b[39m\u001b[22m'));
  assert.ok(group.stdout.includes('\u001b[36madd [options] <identity>\u001b[39m'));
  assert.ok(group.stdout.includes('\u001b[36mregister [options] <path>\u001b[39m'));
  assert.ok(leaf.stdout.includes('\u001b[1m\u001b[36mArguments:\u001b[39m\u001b[22m'));
  assert.ok(leaf.stdout.includes('\u001b[36mpath\u001b[39m'));
  assert.ok(leaf.stdout.includes('\u001b[1m\u001b[36mOptions:\u001b[39m\u001b[22m'));
  assert.ok(leaf.stdout.includes('\u001b[36m--name <name>\u001b[39m'));
});

test('nested help remains plain when color is disabled', async () => {
  const result = await runCli(['library', '--help'], {
    FORCE_COLOR: undefined,
    NO_COLOR: '1',
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Commands:/);
  assert.match(result.stdout, /register \[options\] <path>/);
  assert.doesNotMatch(result.stdout, /\u001b\[/);
});

test('runtime connection failures name the target service', async () => {
  const result = await runCli(['--json', 'runtime', 'status', '--url', 'http://127.0.0.1:1']);

  assert.equal(result.code, 1);
  assert.equal(result.stderr, '');
  assert.match(JSON.parse(result.stdout).error.message, /Unable to reach DKB Runtime http:\/\/127\.0\.0\.1:1/);
});

async function writeLibraryManifest(root, roots = {}) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'dkb.json'), `${JSON.stringify({
    manifestVersion: 1,
    type: 'library',
    name: 'Test Runtime',
    roots,
  }, null, 2)}\n`);
}

async function writePackageManifest(root, name, version) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'dkb.json'), `${JSON.stringify({
    manifestVersion: 1,
    type: 'dkb',
    name: `@test/${slug}`,
    displayName: name,
    version,
    description: '',
  }, null, 2)}\n`);
}

async function writePipelineFixturePlugin(root, id, vectors) {
  const [namespace, name] = id.split('/');
  const pluginRoot = path.join(root, '.dkb', 'plugins', namespace, name);
  await fs.mkdir(pluginRoot, { recursive: true });
  await fs.writeFile(path.join(pluginRoot, 'plugin.mjs'), `
export const apiVersion = 3;
export const id = ${JSON.stringify(id)};
export const version = '1.0.0';
export const optionsSchema = { '~standard': { version: 1, vendor: 'test', validate(value) { return { value: value ?? {} }; } } };
export function setup(context) {
  context.registerProvider({ kind: 'evidence', async compile() { throw new Error('compile is not used by pipeline set'); } });
  context.registerProvider({
    kind: 'index',
    mode: 'packaged',
    format: 'test.index.v1',
    capabilities: { vectors: ${JSON.stringify(vectors)} },
    async compilePackage() { return null; },
    async validatePackage() { return { documentCount: 0 }; },
    async verifyRuntime() { return { indexId: 'test', documentCount: 0, status: 'ready' }; },
    async openRuntime() { return null; },
  });
  context.registerProvider({
    kind: 'retrieval',
    protocol: 'dkb.evidence.v1',
    capabilities: { vectors: 'none' },
    async openRuntime() { return null; },
  });
}
`, 'utf8');
}

function restoreEnvironment(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function runCli(args, extraEnv = {}, cwd = repositoryRoot) {
  cliInvocation += 1;
  const ownsInventory = !Object.hasOwn(extraEnv, 'DKB_HOST_INVENTORY');
  const inventoryPath = ownsInventory
    ? path.join(os.tmpdir(), `dkb-cli-ux-${process.pid}-${cliInvocation}.json`)
    : extraEnv.DKB_HOST_INVENTORY;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: {
        ...process.env,
        DKB_FORCE_TTY: '0',
        DKB_HOST_INVENTORY: inventoryPath,
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr, inventoryPath }));
  }).finally(async () => {
    if (ownsInventory) {
      await fs.rm(inventoryPath, { force: true });
    }
  });
}

function stripAnsi(value) {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function close(server) {
  if (!server.listening) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
