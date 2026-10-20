import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { createQueryFixture } from './runtime-query-fixture.mjs';
import { signRuntimeFixture } from './runtime-trust-fixture.mjs';
import { useRuntimePipeline } from '../apps/cli/dist/providers/runtimePipeline.js';
import { DkbRuntimeClient } from '@sjshovan/dkb-runtime/runtime/client.js';
import { serveDkbRuntime } from '@sjshovan/dkb-runtime/runtime/server.js';
import { applyLibraryLock } from '@sjshovan/dkb-library/state.js';
import { saveRegistryCredential } from '@sjshovan/dkb-registry-client/credentials.js';

const runtime = { distribution: { id: '@test/handoff', version: '1.0.0', defaults: { format: 'dkb.config.v2' }, plugins: [], services: [] } };
const environmentOwners = new WeakSet();
const activation = fixture => fs.readFile(path.join(fixture.runtimeRoot, '.dkb/runtime-activation.lock.json'));
const select = (fixture, overrides = {}) => useRuntimePipeline({ client: fixture.client, name: 'owner', target: 'fixture', kind: 'remote', ...overrides });

test('host prepares an exact grant and the authenticated owner acquires signed builds without a Registry bearer', async t => {
  const fixture = await setup(t);
  const progress = [];
  const result = await select(fixture, { progress: event => progress.push(event) });
  assert.equal(result.status, 'pipeline_switched');
  assert.equal(result.packages[0].preparation, 'downloaded');
  assert.equal(result.packages[0].retrievalBuildDigest, fixture.plan.retrievalBuildDigest);
  const layers = fixture.requests.filter(item => item.path.startsWith('/api/layers/'));
  assert.deepEqual(layers.map(item => item.path), ['/api/layers/evidence', '/api/layers/retrieval']);
  assert.ok(layers.every(item => item.authorization === `DKB-Install-Grant ${fixture.grant}`));
  const hostRequests = fixture.requests.filter(item => item.path.startsWith('/api/registry/'));
  assert.equal(hostRequests.length, 3, 'published build needs two catalog reads and one grant, never a compilation request');
  assert.ok(hostRequests.every(item => item.authorization === `Bearer ${fixture.bearer}`));
  assert.equal(fixture.requests.some(item => item.authorization?.includes('unscoped-token')), false);
  assert.doesNotMatch(JSON.stringify({ result, progress }), /synthetic-registry-secret|synthetic-plan-grant|unscoped-token/u);
  const count = fixture.requests.length;
  assert.equal((await select(fixture)).packages[0].preparation, 'retained');
  assert.equal(fixture.requests.length, count, 'retained signed builds switch without Registry access');
  assert.equal((await fixture.client.search({ query: 'RECOVERY-MARKER' })).results.length, 1);
});

test('owner HTTP rejects a stale preparation before downloading any signed layers', async t => {
  const fixture = await setup(t);
  const previous = await activation(fixture);
  const client = {
    pipelines: () => fixture.client.pipelines(),
    async switchPipeline(input) {
      const lock = JSON.parse(await fs.readFile(path.join(fixture.libraryRoot, 'dkb-lock.json'), 'utf8'));
      lock.generation++;
      await applyLibraryLock(fixture.libraryRoot, lock);
      return fixture.client.switchPipeline(input);
    },
  };
  await assert.rejects(select(fixture, { client }), { code: 'runtime_pipeline_conflict' });
  assert.deepEqual(await activation(fixture), previous);
  assert.equal(fixture.requests.some(item => item.path.startsWith('/api/layers/')), false);
});

test('corrupt bytes and refused grants preserve owner activation, and a retry succeeds', async t => {
  const fixture = await setup(t);
  const previous = await activation(fixture);
  for (const mode of ['corrupt', 'expired']) {
    fixture.mode = mode;
    await assert.rejects(select(fixture), error => !/synthetic-plan-grant|synthetic-registry-secret/u.test(error.message));
    assert.deepEqual(await activation(fixture), previous);
    await assert.rejects(fs.access(fixture.graph.retrievalPath), { code: 'ENOENT' });
  }
  fixture.mode = 'normal';
  assert.equal((await select(fixture)).status, 'pipeline_switched');
});

test('host rejects invalid coverage, local compilation and origin changes before requesting grants', async t => {
  const fixture = await setup(t);
  const catalog = await fixture.client.pipelines();
  const target = catalog.targets.find(item => item.name === 'fixture');
  const previous = await activation(fixture);
  for (const mutate of [
    value => { value.coverage.packages[0].status = 'invalid'; },
    value => { value.coverage.packages[0].source = 'local'; },
    value => { value.coverage.packages.push(value.coverage.packages[0]); value.coverage.total++; },
    value => { value.coverage.packages[0].registryUrl = 'https://secret:password@other.invalid'; },
    value => { value.preparation.compatibilityDigest = 'sha256:' + 'a'.repeat(64); },
    value => { value.coverage.packages[0].ready = true; },
  ]) {
    const changed = structuredClone(target); mutate(changed);
    await assert.rejects(select(fixture, { client: { pipelines: async () => ({ targets: [changed] }), switchPipeline: () => assert.fail('invalid plan cannot activate') } }));
  }
  await assert.rejects(select(fixture, { registryUrl: 'https://other.invalid' }), { code: 'registry_origin_conflict' });
  assert.equal(fixture.requests.length, 0);
  assert.deepEqual(await activation(fixture), previous);
});

test('per-package grants retain separate Registry origins and scope environment credentials', async t => {
  const first = await setup(t);
  const second = await setup(t, '@test/second');
  const left = (await first.client.pipelines()).targets.find(item => item.name === 'fixture');
  const right = (await second.client.pipelines()).targets.find(item => item.name === 'fixture');
  assert.equal(left.retrievalProfileDigest, right.retrievalProfileDigest);
  left.coverage.packages.push(right.coverage.packages[0]); left.coverage.total++;
  // Save both origins into the current isolated credential document.
  await saveRegistryCredential(first.origin, { token: first.bearer, savedAt: new Date().toISOString() });
  process.env.DKB_REGISTRY_URL = first.origin;
  process.env.DKB_REGISTRY_TOKEN = first.bearer;
  let submitted;
  const result = await useRuntimePipeline({ name: 'owner', target: 'fixture', kind: 'docker', client: {
    pipelines: async () => ({ targets: [left] }),
    async switchPipeline(input) { submitted = input; return { status: 'pipeline_switched' }; },
  } });
  assert.equal(result.status, 'pipeline_switched');
  for (const fixture of [first, second]) {
    assert.equal(submitted.grants[fixture.packageId].installGrant, fixture.grant);
    assert.equal(new URL(submitted.grants[fixture.packageId].registryTransportUrl).hostname, 'host.docker.internal');
    assert.equal(new URL(submitted.grants[fixture.packageId].registryTransportUrl).port, new URL(fixture.origin).port);
    assert.ok(fixture.requests.every(item => item.authorization === `Bearer ${fixture.bearer}`));
  }
});

async function setup(t, packageId = '@test/knowledge') {
  const base = await createQueryFixture(t, { packageId });
  if (!environmentOwners.has(t)) {
    environmentOwners.add(t);
    const saved = Object.fromEntries(['DKB_REGISTRY_CREDENTIALS', 'DKB_REGISTRY_URL', 'DKB_REGISTRY_TOKEN'].map(key => [key, process.env[key]]));
    t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  }
  const requests = [];
  let fixture;
  const registry = http.createServer(async (req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/.well-known/dkb-registry-keys.json') return res.end(JSON.stringify({ keys: fixture.keys }));
    if (req.url.startsWith('/api/registry/')) {
      if (req.headers.authorization !== `Bearer ${fixture.bearer}`) { res.writeHead(401); return res.end('{}'); }
      if (req.url.endsWith('/install-grant')) {
        let body = ''; for await (const chunk of req) body += chunk;
        assert.equal(JSON.parse(body).retrievalBuildDigest, fixture.plan.retrievalBuildDigest);
        return res.end(JSON.stringify({ plan: fixture.plan, installGrant: fixture.grant, expiresAt: new Date(Date.now() + 300_000).toISOString() }));
      }
      if (req.method !== 'GET') { res.writeHead(405); return res.end('{}'); }
      const value = req.url.includes('/versions/')
        ? { packageId, version: '1.0.0', status: 'published', builds: [{ ...fixture.plan, status: 'published' }] }
        : { id: packageId, namespace: 'test', name: packageId.split('/')[1], slug: packageId.split('/')[1], visibility: 'private', latestVersion: '1.0.0' };
      return res.end(JSON.stringify({ data: value }));
    }
    const kind = req.url.split('/').at(-1), bytes = fixture.layerBytes.get(kind);
    if (!bytes || req.headers.authorization !== `DKB-Install-Grant ${fixture.grant}` || fixture.mode === 'expired') {
      res.writeHead(403); return res.end(`Do not expose ${fixture.grant}`);
    }
    const sent = Buffer.from(bytes);
    if (fixture.mode === 'corrupt') sent[0] ^= 1;
    res.setHeader('content-type', `application/vnd.dkb.${kind}+gzip`); res.end(sent);
  });
  await new Promise(resolve => registry.listen(0, '127.0.0.1', resolve));
  base.disposers.push(() => close(registry));
  const origin = `http://127.0.0.1:${registry.address().port}`;
  fixture = { ...await signRuntimeFixture(base, { downloadable: true, origin }), requests, mode: 'normal',
    bearer: `dkb_synthetic-registry-secret-${packageId.replace(/[^a-z0-9]/gu, '-')}`, grant: `synthetic-plan-grant-${packageId}` };
  process.env.DKB_REGISTRY_CREDENTIALS = path.join(fixture.root, 'credentials.json');
  process.env.DKB_REGISTRY_URL = 'http://127.0.0.1:1/unrelated-stack-registry';
  process.env.DKB_REGISTRY_TOKEN = 'dkb_unscoped-token';
  await saveRegistryCredential(origin, { token: fixture.bearer, savedAt: new Date().toISOString() });
  // Remove only this isolated fixture's compiled Retrieval Build to exercise acquisition.
  assert.ok(path.resolve(fixture.graph.retrievalPath).startsWith(path.resolve(fixture.root) + path.sep));
  await fs.rm(fixture.graph.retrievalPath, { recursive: true });
  const server = await serveDkbRuntime({ runtime, stateRoot: fixture.runtimeRoot, host: '127.0.0.1', port: 0, adminToken: 'synthetic-owner-admin' });
  base.disposers.push(() => close(server));
  fixture.client = new DkbRuntimeClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, adminToken: 'synthetic-owner-admin' });
  return fixture;
}

function close(server) { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); }
