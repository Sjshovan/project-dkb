import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { humanSummary } from '../dist/src/cli/presentation.js';
import { createDkbPackageArchive, extractDkbPackageArchive } from '../dist/src/registry/archive.js';
import { DkbRegistryClient, writeArchiveFileFromPath } from '../dist/src/registry/client.js';
import { prepareServeRegistry } from '../dist/src/cli/serve.js';
import {
  configuredRegistry,
  normalizeRegistryUrl,
  registryFolderConfigPath,
  writeConfiguredRegistryUrl,
} from '../dist/src/registry/config.js';
import { preflightDkbInstall } from '../dist/src/registry/packageRegistry.js';
import { sourceAssetsFromChunks } from '../dist/src/indexes/sourceIndex.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repositoryRoot, 'dist', 'src', 'cli', 'index.js');

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

test('pasted Markdown registry links produce an actionable URL error', () => {
  assert.throws(
    () => normalizeRegistryUrl('[http://127.0.0.1:8017](http://127.0.0.1:8017)'),
    /Use the plain URL instead: http:\/\/127\.0\.0\.1:8017/,
  );
});

test('registry folders keep an upstream URL that overrides the user fallback', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-folder-registry-config-'));
  const registryRoot = path.join(tempRoot, 'runtime');
  const nestedRoot = path.join(registryRoot, 'nested', 'folder');
  const userConfigPath = path.join(tempRoot, 'user-config.json');
  const previousCliConfig = process.env.DKB_CLI_CONFIG;
  const previousRegistryUrl = process.env.DKB_REGISTRY_URL;

  try {
    process.env.DKB_CLI_CONFIG = userConfigPath;
    delete process.env.DKB_REGISTRY_URL;
    await fs.mkdir(nestedRoot, { recursive: true });
    await writeRegistryManifest(registryRoot);
    await writeConfiguredRegistryUrl('https://user-registry.example', { global: true });
    const project = await writeConfiguredRegistryUrl('https://project-registry.example', { root: registryRoot });

    assert.equal(project.source, 'project');
    assert.equal(project.configPath, registryFolderConfigPath(registryRoot));
    assert.equal((await configuredRegistry({ cwd: nestedRoot })).url, 'https://project-registry.example');
    assert.equal((await configuredRegistry({ root: registryRoot })).source, 'project');
    assert.equal((await configuredRegistry({ root: path.join(tempRoot, 'unconfigured') })).source, 'user');

    process.env.DKB_REGISTRY_URL = 'https://environment-registry.example';
    assert.equal((await configuredRegistry({ root: registryRoot })).source, 'environment');
    assert.equal((await configuredRegistry({ url: 'https://argument-registry.example', root: registryRoot })).source, 'argument');
  } finally {
    restoreEnvironment('DKB_CLI_CONFIG', previousCliConfig);
    restoreEnvironment('DKB_REGISTRY_URL', previousRegistryUrl);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('bare init creates an idempotent registry and stores its verified upstream URL', async () => {
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
      DKB_REGISTRY_URL: '',
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
      type: 'registry',
      root: registryRoot,
      manifest: path.join(registryRoot, 'dkb.json'),
      registry: {
        url: registryUrl,
        source: 'project',
        configPath: registryFolderConfigPath(registryRoot),
        root: registryRoot,
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
    assert.equal(JSON.parse(await fs.readFile(path.join(registryRoot, 'dkb.json'), 'utf8')).type, 'registry');
    assert.equal(JSON.parse(await fs.readFile(registryFolderConfigPath(registryRoot), 'utf8')).registry.url, registryUrl);
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

test('bare init without a URL argument still creates the registry when verification fails', async () => {
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
    assert.match(result.stdout, /Warning: Upstream registry .* could not be verified/);
    assert.match(result.stdout, new RegExp(`Retry: dkb registry use ${escapeRegExp(registryUrl)}`));
    assert.match(result.stderr, /Initializing registry complete/);
    assert.match(result.stderr, /Done\./);
    assert.equal(JSON.parse(await fs.readFile(path.join(tempRoot, 'dkb.json'), 'utf8')).type, 'registry');
    assert.equal(JSON.parse(await fs.readFile(registryFolderConfigPath(tempRoot), 'utf8')).registry.url, registryUrl);
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
    await writeRegistryManifest(tempRoot);
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
    assert.equal(JSON.parse(await fs.readFile(registryFolderConfigPath(tempRoot), 'utf8')).registry.url, registryUrl);
  } finally {
    await close(server);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('serve initialization uses the same offline-safe registry configuration path', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-serve-init-'));
  const registryUrl = 'http://127.0.0.1:1';

  try {
    const result = await prepareServeRegistry({
      root: tempRoot,
      yes: true,
      registryUrl,
      verifyRegistry: false,
    });

    assert.equal(result.initialized, true);
    assert.equal(result.compiled, true);
    assert.equal(result.registry.url, registryUrl);
    assert.match(result.warning, /was not verified because verification was skipped/);
    assert.equal(result.retryCommand, `dkb registry use ${registryUrl}`);
    assert.equal(JSON.parse(await fs.readFile(path.join(tempRoot, 'dkb.json'), 'utf8')).type, 'registry');
    assert.equal(JSON.parse(await fs.readFile(registryFolderConfigPath(tempRoot), 'utf8')).registry.url, registryUrl);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('source assets are grouped in one pass without mixing identical asset ids across packages', () => {
  const units = [
    sourceUnit({ dkbId: 'beta', assetId: 'shared', chunkOrdinal: 1, hash: 'beta-1', title: 'Beta - Details', heading: 'Details' }),
    sourceUnit({ dkbId: 'alpha', assetId: 'shared', chunkOrdinal: 2, hash: 'alpha-2', title: 'Alpha - Later', heading: 'Later' }),
    sourceUnit({ dkbId: 'alpha', assetId: 'shared', chunkOrdinal: 0, hash: 'alpha-0', title: 'Alpha - Intro', heading: 'Intro' }),
    sourceUnit({ dkbId: 'beta', assetId: 'shared', chunkOrdinal: 0, hash: 'beta-0', title: 'Beta - Intro', heading: 'Intro' }),
  ];

  const assets = sourceAssetsFromChunks(units);

  assert.deepEqual(assets.map((asset) => ({ dkbId: asset.dkbId, id: asset.id, title: asset.title })), [
    { dkbId: 'alpha', id: 'shared', title: 'Alpha' },
    { dkbId: 'beta', id: 'shared', title: 'Beta' },
  ]);
  assert.notEqual(assets[0].hash, assets[1].hash);
});

test('source asset grouping visits a large chunk input linearly', () => {
  const units = Array.from({ length: 32_639 }, (_, index) => sourceUnit({
    dkbId: 'large-package',
    assetId: `asset-${Math.floor(index / 6)}`,
    chunkOrdinal: index % 6,
    hash: `hash-${index}`,
    title: `Asset ${Math.floor(index / 6)}`,
  }));
  let indexedReads = 0;
  const trackedUnits = new Proxy(units, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/u.test(property)) {
        indexedReads += 1;
      }

      return Reflect.get(target, property, receiver);
    },
  });

  const assets = sourceAssetsFromChunks(trackedUnits);

  assert.equal(assets.length, Math.ceil(units.length / 6));
  assert.ok(indexedReads <= units.length * 2, `expected linear input access, observed ${indexedReads} indexed reads`);
});

test('--no-progress keeps human output and --json is the explicit machine-output switch', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-cli-output-'));

  try {
    const human = await runCli(['--no-progress', 'init', 'human-demo', '--dir', tempRoot, '--yes']);
    assert.equal(human.code, 0);
    assert.match(human.stdout, /Type: package/);
    assert.match(human.stdout, /Manifest:/);
    assert.doesNotMatch(human.stdout, /^\s*\{/);
    assert.match(human.stderr, /Initializing package complete/);
    assert.match(human.stderr, /Done\./);

    const machine = await runCli(['--json', 'init', 'json-demo', '--dir', tempRoot, '--yes']);
    assert.equal(machine.code, 0);
    assert.equal(JSON.parse(machine.stdout).status, 'initialized');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('human terminal output is compact and colored while JSON remains ANSI-free', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-cli-color-'));

  try {
    const colored = await runCli(['list', '--runtime-root', tempRoot], {
      DKB_CLI_CONFIG: path.join(tempRoot, 'user-config.json'),
      DKB_REGISTRY_URL: '',
      FORCE_COLOR: '1',
    });
    assert.equal(colored.code, 0);
    assert.match(colored.stdout, /\u001b\[/u);
    assert.doesNotMatch(stripAnsi(colored.stdout), /^[- ]+$/mu);
    assert.equal(stripAnsi(colored.stdout).split('\n').filter(Boolean).length, 3);

    const machine = await runCli(['--json', 'list', '--runtime-root', tempRoot], {
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
  const packageRoot = path.join(tempRoot, 'vendor', 'acct-test', 'already-here');
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('content-type', 'application/json');

    if (request.url === '/api/registry/packages/already-here/versions/1.0.0') {
      response.end(JSON.stringify({
        data: {
          packageId: 'already-here',
          version: '1.0.0',
          status: 'published',
          archiveHash: 'sha256:known-release',
          packageTreeHash: 'sha256:known-tree',
          recordCount: 42,
        },
      }));
      return;
    }

    response.statusCode = 500;
    response.end(JSON.stringify({ message: `Unexpected request: ${request.url}` }));
  });

  try {
    await fs.mkdir(packageRoot, { recursive: true });
    await writeRegistryManifest(tempRoot);
    await fs.writeFile(path.join(packageRoot, 'dkb.json'), `${JSON.stringify({
      manifestVersion: 1,
      type: 'package',
      name: 'Already Here',
      version: '1.0.0',
      publisher: 'acct-test',
      package: '@acct-test/already-here',
    }, null, 2)}\n`);
    await fs.writeFile(path.join(tempRoot, 'dkb-lock.json'), `${JSON.stringify({
      registry: { id: 'test-runtime', name: 'Test Runtime', version: '0.0.0-local' },
      packages: {
        '@acct-test/already-here': {
          id: 'already-here',
          version: '1.0.0',
          archiveHash: 'sha256:known-release',
          packageTreeHash: 'sha256:known-tree',
        },
      },
      artifacts: {
        sourceIndex: { path: '.dkb/artifacts/source.index', hash: null, status: 'missing' },
        sourceGraph: { path: '.dkb/artifacts/source.index.graph', hash: null, status: 'missing' },
        sourceVector: { path: '.dkb/artifacts/source.index.vector.json', hash: null, status: 'missing' },
      },
    }, null, 2)}\n`);
    await listen(server);
    const address = server.address();
    assert.notEqual(typeof address, 'string');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await fs.mkdir(path.dirname(registryFolderConfigPath(tempRoot)), { recursive: true });
    await fs.writeFile(registryFolderConfigPath(tempRoot), `${JSON.stringify({ registry: { url: baseUrl } }, null, 2)}\n`);
    const result = await runCli([
      '--no-progress',
      'install',
      'already-here',
      '--version',
      '1.0.0',
      '--runtime-root',
      tempRoot,
    ], { DKB_REGISTRY_URL: '' });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Status: already installed/);
    assert.match(result.stdout, /Package: already-here@1\.0\.0/);
    assert.match(result.stderr, /Installing package complete/);
    assert.match(result.stderr, /Done\./);
    assert.doesNotMatch(result.stderr, /ExperimentalWarning/);
    assert.deepEqual(requests, ['/api/registry/packages/already-here/versions/1.0.0']);

    const listed = await runCli(['list', '--runtime-root', tempRoot]);
    assert.equal(listed.code, 0);
    assert.match(listed.stdout, /ID\s+VERSION\s+STATUS\s+RECORDS/);
    assert.match(listed.stdout, /already-here\s+1\.0\.0\s+installed/);
  } finally {
    await close(server);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

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

test('install preflight rejects version digest drift and incomplete runtime state', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-cli-preflight-errors-'));
  const packageRoot = path.join(tempRoot, 'vendor', 'acct-test', 'example');

  try {
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'dkb.json'), `${JSON.stringify({
      manifestVersion: 1,
      type: 'package',
      name: 'Example',
      version: '1.0.0',
      publisher: 'acct-test',
      package: '@acct-test/example',
    })}\n`);
    await fs.writeFile(path.join(tempRoot, 'dkb-lock.json'), `${JSON.stringify({
      registry: { id: 'test-runtime', name: 'Test Runtime', version: '0.0.0-local' },
      packages: {
        '@acct-test/example': {
          id: 'example',
          version: '1.0.0',
          archiveHash: 'sha256:old',
          packageTreeHash: 'sha256:tree',
        },
      },
      artifacts: {
        sourceIndex: { path: '.dkb/artifacts/source.index', hash: null, status: 'missing' },
        sourceGraph: { path: '.dkb/artifacts/source.index.graph', hash: null, status: 'missing' },
        sourceVector: { path: '.dkb/artifacts/source.index.vector.json', hash: null, status: 'missing' },
      },
    })}\n`);

    await assert.rejects(
      preflightDkbInstall({
        runtimeRoot: tempRoot,
        candidate: { packageId: 'example', version: '1.0.0', archiveHash: 'sha256:new' },
      }),
      /Published versions must be immutable/,
    );

    await fs.rm(path.join(tempRoot, 'dkb-lock.json'));
    await assert.rejects(
      preflightDkbInstall({
        runtimeRoot: tempRoot,
        candidate: { packageId: 'example', version: '1.0.0' },
      }),
      /incomplete installation.*Use --force to repair/s,
    );

    const listed = await runCli(['list', '--runtime-root', tempRoot]);
    assert.equal(listed.code, 0);
    assert.match(listed.stdout, /example\s+1\.0\.0\s+incomplete/);
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
    if (request.url !== '/api/registry/packages/example/versions/1.2.3/download') {
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
    const result = await client.writePackageArchive('example', target, '1.2.3', {
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
      client.writePackageArchive('example', target, '1.0.0'),
      /Output archive already exists.*Use --force/,
    );
    assert.deepEqual(requests, []);
    assert.deepEqual(await fs.readFile(target), original);

    await assert.rejects(
      client.writePackageArchive('broken', target, '1.0.0', { force: true }),
      /terminated|incomplete/,
    );
    assert.deepEqual(await fs.readFile(target), original);

    const completed = await client.writePackageArchive('example', target, '1.0.0', { force: true });
    assert.equal(completed.bytes, replacement.length);
    assert.deepEqual(await fs.readFile(target), replacement);
    assert.deepEqual((await fs.readdir(tempRoot)).sort(), ['download.dkbpkg']);
  } finally {
    await close(server);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('local registry archive copies require force and replace atomically', async () => {
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
      response.end(JSON.stringify({ data: { id: 'publish-demo' } }));
      return;
    }

    if (request.method === 'POST' && request.url === '/api/registry/packages/publish-demo/versions') {
      response.statusCode = 201;
      response.end(JSON.stringify({
        data: {
          packageId: 'publish-demo',
          version: '0.1.0',
          status: 'published',
          recordCount: 1,
        },
      }));
      return;
    }

    if (request.method === 'POST' && request.url === '/api/registry/packages/publish-demo/versions/0.1.0/remote-endpoints') {
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
    assert.equal(result.packageId, 'publish-demo');
    assert.match(result.warning, /Package published, but remote endpoint registration failed/);
    assert.equal(result.retryCommand, `dkb registry remote claim publish-demo@0.1.0 --url ${remoteUrl}`);
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
      'GET /api/registry/packages/invalid-demo',
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

    if (request.method === 'GET' && request.url === '/api/registry/packages/existing-demo') {
      response.end(JSON.stringify({ data: { id: 'existing-demo' } }));
      return;
    }

    if (request.method === 'POST' && request.url === '/api/registry/packages/existing-demo/versions') {
      response.statusCode = 201;
      response.end(JSON.stringify({
        data: {
          packageId: 'existing-demo',
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
      'GET /api/registry/packages/existing-demo',
      'POST /api/registry/packages/existing-demo/versions',
    ]);
  } finally {
    await close(server);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('runtime add removes its staged copy after a successful import', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-cli-add-staging-'));
  const packageRoot = path.join(tempRoot, 'source');
  const importRoot = path.join(tempRoot, 'imports');
  let requestBody;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'installed', id: 'staged-demo' }));
    });
  });

  try {
    await writePackageManifest(packageRoot, 'Staged Demo', '0.1.0');
    await fs.writeFile(path.join(packageRoot, 'notes.md'), 'Staged source.\n');
    await listen(server);
    const address = server.address();
    assert.notEqual(typeof address, 'string');
    const result = await runCli([
      '--json',
      'add',
      packageRoot,
      '--url',
      `http://127.0.0.1:${address.port}`,
      '--host-import-root',
      importRoot,
      '--container-import-root',
      '/imports',
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(requestBody.sourcePath, /^\/imports\/source-/);
    assert.deepEqual(await fs.readdir(importRoot), []);
  } finally {
    await close(server);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('diagnostic commands return nonzero when their report is not healthy', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-cli-diagnostics-'));

  try {
    await writeRegistryManifest(tempRoot);
    const health = await runCli(['--json', 'health', tempRoot]);
    assert.equal(health.code, 1);
    assert.equal(JSON.parse(health.stdout).status, 'degraded');

    const search = await runCli(['--json', 'search-health', tempRoot], {
      DKB_SEARCH_ENGINE: 'meilisearch',
      MEILI_URL: 'http://127.0.0.1:1',
    });
    assert.equal(search.code, 1);
    assert.equal(JSON.parse(search.stdout).status, 'unavailable');

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
  const result = await runCli(['--help']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Common Commands:/);
  assert.match(result.stdout, /Management Commands:/);
  assert.match(result.stdout, /Advanced Commands:/);
  assert.match(result.stdout, /Run 'dkb <command> --help'/);
});

test('runtime connection failures name the target service', async () => {
  const result = await runCli(['--json', 'runtime', 'status', '--url', 'http://127.0.0.1:1']);

  assert.equal(result.code, 1);
  assert.equal(result.stderr, '');
  assert.match(JSON.parse(result.stdout).error.message, /Unable to reach DKB Runtime http:\/\/127\.0\.0\.1:1/);
});

function sourceUnit(overrides) {
  return {
    id: `${overrides.dkbId}-${overrides.assetId}-${overrides.chunkOrdinal}`,
    assetId: overrides.assetId,
    dkbId: overrides.dkbId,
    storeId: 'root',
    type: 'filesystem',
    locator: { path: `${overrides.assetId}.md`, chunk: overrides.chunkOrdinal },
    assetLocator: { path: `${overrides.assetId}.md` },
    title: overrides.title,
    text: overrides.hash,
    keywords: [],
    capabilities: {
      evidence: 'full',
      records: 'none',
      exactCount: 'none',
      approximateCount: 'partial',
      structuredFilter: 'none',
      operations: ['fetch', 'search'],
    },
    hash: overrides.hash,
    updatedAt: '2026-08-26T00:00:00.000Z',
    chunkOrdinal: overrides.chunkOrdinal,
    chunkStart: 0,
    chunkEnd: 1,
    heading: overrides.heading,
  };
}

async function writeRegistryManifest(root) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'dkb.json'), `${JSON.stringify({
    manifestVersion: 1,
    type: 'registry',
    name: 'Test Runtime',
    version: '0.0.0-local',
    localSources: { enabled: false },
    dependencies: {},
  }, null, 2)}\n`);
}

async function writePackageManifest(root, name, version) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'dkb.json'), `${JSON.stringify({
    name,
    version,
    description: '',
  }, null, 2)}\n`);
}

function restoreEnvironment(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function runCli(args, extraEnv = {}, cwd = repositoryRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: {
        ...process.env,
        DKB_FORCE_TTY: '0',
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
    child.once('close', (code) => resolve({ code, stdout, stderr }));
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
