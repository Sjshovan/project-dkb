import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DkbRegistryClient } from '@sjshovan/dkb-registry-client/client.js';
import { DKB_PIPELINE_RESOLUTION_MESSAGE } from '@sjshovan/dkb-protocol/compilerCapabilities.js';

const digest = (character) => `sha256:${character.repeat(64)}`;
const compiler = { kind: 'observed-installed', packageName: '@sjshovan/dkb-compiler', packageVersion: '0.2.0', filesDigest: digest('6'), dependencyDigest: digest('7'), buildDigest: digest('8') };
const pipeline = {
  name: 'tei-faiss',
  default: true,
  available: true,
  providers: [{ id: '@dkb/embedding-tei', version: '0.1.0', kind: 'embedding', source: 'bundled', sourceDigest: digest('c'), integrityDigest: digest('1'), integrity: {
    apiVersion: 3, id: '@dkb/embedding-tei', version: '0.1.0', filesDigest: digest('9'), dependencyDigest: digest('a'), externalDigests: { image: digest('b') }, protocols: ['dkb.embedding.v1'], artifactFormats: [],
  } }],
  processors: [],
  buildDigest: digest('2'),
  evidenceProfileDigest: digest('3'),
  retrievalProfileDigest: digest('4'),
  compatibilityDigest: digest('5'),
  requiredServices: ['embedding-tei'],
  health: [{ id: '@dkb/embedding-tei', kind: 'embedding', ok: true }],
  compilerBuildDigest: compiler.buildDigest,
  chains: { evidence: ['@test/evidence'], embedding: '@dkb/embedding-tei', index: '@test/index', retrieval: '@test/retrieval', processors: { document: [], chunk: [], record: [] } },
  serviceRequirements: [{ id: 'embedding-tei', kind: 'docker', providerId: '@dkb/embedding-tei', providerKind: 'embedding', source: 'bundled' }],
};

test('Registry cancellation targets the exact job and cancelled build polling terminates immediately', async () => {
  const client = new DkbRegistryClient({ baseUrl: 'http://127.0.0.1:1', token: 'test' });
  const job = { jobId: 7, stage: 'retrieval', target: 'tei-faiss', status: 'cancelled', attempts: 1 };
  client.post = async (route, body) => {
    assert.equal(route, '/api/registry/packages/test/example/versions/1.0.0/build-jobs/7/cancel');
    assert.deepEqual(body, {});
    return job;
  };
  assert.deepEqual(await client.cancelBuild('@test/example', '1.0.0', 7), job);
  client.get = async () => job;
  await assert.rejects(client.waitForBuild('@test/example', '1.0.0', 7, { timeoutMs: 100, pollIntervalMs: 10 }), { code: 'registry_build_cancelled' });
  for (const invalid of [{ ...job, jobId: 8 }, { ...job, attempts: NaN }, { ...job, status: 'invented' }]) {
    client.post = async () => invalid;
    await assert.rejects(client.cancelBuild('@test/example', '1.0.0', 7), /invalid build-job status/u);
  }
  await assert.rejects(client.cancelBuild('@test/example', '1.0.0', -1), /positive integer/u);
});

test('Registry client validates advertised Pipelines and binds build requests to their exact digests', async () => {
  let buildBody;
  const server = http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/registry/pipelines') {
      response.end(JSON.stringify({ default: 'tei-faiss', compiler, pipelines: [pipeline] }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/registry/packages/test/example/versions/1.0.0/builds') {
      buildBody = JSON.parse(await bodyText(request));
      response.statusCode = 202;
      response.end(JSON.stringify({ status: 'queued', jobId: 7, target: 'tei-faiss' }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: 'not found' }));
  });
  await listen(server);
  try {
    const address = server.address();
    assert.equal(typeof address, 'object');
    const client = new DkbRegistryClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: 'test' });
    const catalog = await client.pipelines();
    assert.equal(catalog.default, 'tei-faiss');
    assert.deepEqual(catalog.compiler, compiler);
    assert.deepEqual(catalog.pipelines[0], pipeline);
    const result = await client.requestBuild('@test/example', '1.0.0', pipeline.name, {
      retrievalProfileDigest: pipeline.retrievalProfileDigest,
      compatibilityDigest: pipeline.compatibilityDigest,
    });
    assert.equal(result.jobId, 7);
    assert.deepEqual(buildBody, {
      target: 'tei-faiss',
      retrievalProfileDigest: pipeline.retrievalProfileDigest,
      compatibilityDigest: pipeline.compatibilityDigest,
    });
  } finally {
    await close(server);
  }
});

test('Registry catalogs reject missing or malformed current compiler and provider metadata', async () => {
  const client = new DkbRegistryClient({ baseUrl: 'http://127.0.0.1:1', token: 'test' });
  const catalog = { default: pipeline.name, compiler, pipelines: [pipeline] };
  for (const change of [
    (value) => { delete value.compiler; },
    (value) => { delete value.pipelines[0].providers[0].integrity; },
    (value) => { delete value.pipelines[0].chains; },
    (value) => { delete value.pipelines[0].serviceRequirements; },
    (value) => { value.pipelines[0].compilerBuildDigest = digest('e'); },
    (value) => { value.pipelines[0].providers[0].integrity.id = '@wrong/provider'; },
    (value) => { value.pipelines[0].providers[0].integrity.externalDigests.image = 'mutable-tag'; },
  ]) {
    const value = structuredClone(catalog); change(value); client.get = async () => value;
    await assert.rejects(client.pipelines(), /metadata|identity|requirements/i);
  }
  const extra = structuredClone(catalog);
  extra.compiler.token = 'must-not-leak'; extra.pipelines[0].providers[0].integrity.secret = 'must-not-leak';
  client.get = async () => extra;
  assert.doesNotMatch(JSON.stringify(await client.pipelines()), /must-not-leak/);
});

test('Registry client preserves unavailable unresolved recipes but rejects fabricated partial identities', async () => {
  const client = new DkbRegistryClient({ baseUrl: 'http://127.0.0.1:1', token: 'test' });
  const unresolved = {
    name: 'optional', default: false, available: false, providers: [], processors: [], chains: null,
    buildDigest: null, evidenceProfileDigest: null, retrievalProfileDigest: null, compatibilityDigest: null,
    requiredServices: [], serviceRequirements: [], compilerBuildDigest: compiler.buildDigest,
    health: [{ id: 'optional', kind: 'pipeline', ok: false, detail: DKB_PIPELINE_RESOLUTION_MESSAGE }],
    resolutionError: { code: 'pipeline_resolution_failed', message: DKB_PIPELINE_RESOLUTION_MESSAGE },
  };
  const catalog = { default: pipeline.name, compiler, pipelines: [pipeline, unresolved] };
  client.get = async () => catalog;
  assert.deepEqual((await client.pipelines()).pipelines, [pipeline, unresolved]);
  for (const change of [
    (entry) => { entry.available = true; },
    (entry) => { entry.buildDigest = digest('a'); },
    (entry) => { delete entry.evidenceProfileDigest; },
    (entry) => { entry.providers = pipeline.providers; },
    (entry) => { entry.chains = pipeline.chains; },
    (entry) => { entry.requiredServices = ['invented-service']; },
    (entry) => { entry.serviceRequirements = pipeline.serviceRequirements; },
    (entry) => { entry.health[0].ok = true; },
    (entry) => { entry.health[0].detail = 'sensitive-provider-message'; },
    (entry) => { entry.resolutionError.message = 'sensitive-provider-message'; },
    (entry) => { entry.resolutionError = null; },
  ]) {
    const entry = structuredClone(unresolved); change(entry);
    client.get = async () => ({ ...catalog, pipelines: [pipeline, entry] });
    await assert.rejects(client.pipelines(), /unresolved metadata|invalid Pipeline/);
  }
});

test('Registry client carries the exact ready Retrieval Build into its install grant', async () => {
  const retrievalBuildDigest = digest('a');
  let grantBody;
  const server = http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST' && request.url === '/api/registry/packages/test/example/versions/1.0.0/builds') {
      request.resume();
      response.end(JSON.stringify({
        status: 'ready',
        target: pipeline.name,
        build: { evidenceDigest: digest('9'), retrievalBuildDigest },
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/registry/packages/test/example/versions/1.0.0/install-grant') {
      grantBody = JSON.parse(await bodyText(request));
      response.end(JSON.stringify({
        plan: fakeInstallPlan('@test/example', '1.0.0', pipeline.name, retrievalBuildDigest),
        installGrant: `dkb_grant_${'g'.repeat(64)}`,
        expiresAt: '2026-09-02T00:05:00.000Z',
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: 'not found' }));
  });
  await listen(server);
  try {
    const address = server.address();
    assert.equal(typeof address, 'object');
    const client = new DkbRegistryClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: 'test' });
    const build = await client.requestBuild('@test/example', '1.0.0', pipeline.name, {
      retrievalProfileDigest: pipeline.retrievalProfileDigest,
      compatibilityDigest: pipeline.compatibilityDigest,
    });
    assert.equal(build.retrievalBuildDigest, retrievalBuildDigest);
    const grant = await client.createInstallGrant(
      '@test/example',
      '1.0.0',
      pipeline.name,
      build.retrievalBuildDigest,
    );
    assert.equal(grant.plan.retrievalBuildDigest, retrievalBuildDigest);
    assert.deepEqual(grantBody, { target: pipeline.name, retrievalBuildDigest });
  } finally {
    await close(server);
  }
});

test('Registry client accepts immutable original build labels only for an exact catalog recipe alias', async () => {
  const client = new DkbRegistryClient({ baseUrl: 'http://127.0.0.1:1' });
  const plan = fakeInstallPlan('@test/example', '1.0.0', 'original-label');
  plan.evidenceProfileDigest = pipeline.evidenceProfileDigest;
  plan.retrievalProfileDigest = pipeline.retrievalProfileDigest;
  plan.compatibilityDigest = pipeline.compatibilityDigest;
  plan.artifacts.find((artifact) => artifact.kind === 'retrieval').receipt.payload.profileLock = {
    profile: { providerBuildDigest: pipeline.buildDigest },
  };
  client.get = async (route) => {
    if (route === '/api/registry/pipelines') return { default: pipeline.name, compiler, pipelines: [pipeline] };
    assert.equal(route, '/api/registry/packages/test/example/versions/1.0.0/install-plan?target=tei-faiss');
    return plan;
  };
  client.post = async (_route, body) => {
    assert.equal(body.target, pipeline.name);
    return { plan, installGrant: 'dkb_grant_test', expiresAt: '2026-09-03T00:05:00.000Z' };
  };
  const accepted = await client.installPlan('@test/example', '1.0.0', pipeline.name);
  assert.equal(accepted.target, 'original-label');
  assert.equal((await client.createInstallGrant('@test/example', '1.0.0', pipeline.name, plan.retrievalBuildDigest)).plan.retrievalBuildDigest, plan.retrievalBuildDigest);
  await assert.rejects(client.createInstallGrant('@test/example', '1.0.0', pipeline.name, digest('e')), /identity, target, or build mismatch/);
  for (const field of ['evidenceProfileDigest', 'retrievalProfileDigest', 'compatibilityDigest']) {
    const previous = plan[field]; plan[field] = digest('e');
    await assert.rejects(client.installPlan('@test/example', '1.0.0', pipeline.name), /identity or target mismatch/);
    plan[field] = previous;
  }
  plan.artifacts.find((artifact) => artifact.kind === 'retrieval').receipt.payload.profileLock.profile.providerBuildDigest = digest('e');
  await assert.rejects(client.createInstallGrant('@test/example', '1.0.0', pipeline.name, plan.retrievalBuildDigest), /identity, target, or build mismatch/);
});

test('Registry client rejects an install grant whose signed plan substitutes another Pipeline target', async () => {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST' && request.url === '/api/registry/packages/test/example/versions/1.0.0/install-grant') {
      request.resume();
      response.end(JSON.stringify({
        plan: fakeInstallPlan('@test/example', '1.0.0', 'substituted-target'),
        installGrant: `dkb_grant_${'g'.repeat(64)}`,
        expiresAt: '2026-09-02T00:05:00.000Z',
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: 'not found' }));
  });
  await listen(server);
  try {
    const address = server.address();
    assert.equal(typeof address, 'object');
    const client = new DkbRegistryClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: 'test' });
    await assert.rejects(
      client.createInstallGrant('@test/example', '1.0.0', 'tei-faiss'),
      /install grant identity, target, or build mismatch/u,
    );
  } finally {
    await close(server);
  }
});

test('Registry client rejects an install plan whose target differs from the requested Pipeline', async () => {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET'
      && request.url === '/api/registry/packages/test/example/versions/1.0.0/install-plan?target=tei-faiss') {
      response.end(JSON.stringify(fakeInstallPlan('@test/example', '1.0.0', 'substituted-target')));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: 'not found' }));
  });
  await listen(server);
  try {
    const address = server.address();
    assert.equal(typeof address, 'object');
    const client = new DkbRegistryClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: 'test' });
    await assert.rejects(
      client.installPlan('@test/example', '1.0.0', 'tei-faiss'),
      /install plan identity or target mismatch/u,
    );
  } finally {
    await close(server);
  }
});

test('Registry build polling honors Retry-After and resumes after rate limiting', async () => {
  let statusPolls = 0;
  let rateLimitedAt = 0;
  let resumedAt = 0;
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/registry/packages/test/example/versions/1.0.0/build-jobs/9') {
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
        jobId: 9,
        stage: 'variant',
        target: 'tei-faiss',
        status: 'published',
        attempts: 1,
        retrievalBuildDigest: digest('6'),
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: 'not found' }));
  });
  await listen(server);
  try {
    const address = server.address();
    assert.equal(typeof address, 'object');
    const client = new DkbRegistryClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: 'test' });
    const job = await client.waitForBuild('@test/example', '1.0.0', 9, {
      timeoutMs: 3_000,
      pollIntervalMs: 10,
    });

    assert.equal(job.status, 'published');
    assert.equal(statusPolls, 2);
    assert.ok(resumedAt - rateLimitedAt >= 900, `Retry-After was not honored (${resumedAt - rateLimitedAt} ms)`);
  } finally {
    await close(server);
  }
});

test('Registry build polling bounds Retry-After by the operation timeout', async () => {
  let statusPolls = 0;
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/registry/packages/test/example/versions/1.0.0/build-jobs/10') {
      statusPolls += 1;
      response.statusCode = 429;
      response.setHeader('retry-after', '60');
      response.end(JSON.stringify({ message: 'Too Many Attempts.' }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: 'not found' }));
  });
  await listen(server);
  try {
    const address = server.address();
    assert.equal(typeof address, 'object');
    const client = new DkbRegistryClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: 'test' });
    const startedAt = Date.now();

    await assert.rejects(
      client.waitForBuild('@test/example', '1.0.0', 10, { timeoutMs: 150, pollIntervalMs: 10 }),
      /Timed out waiting for Registry build 10.*Last transient error: Too Many Attempts/u,
    );
    assert.ok(Date.now() - startedAt < 1_000, 'Retry-After exceeded the operation timeout');
    assert.equal(statusPolls, 1);
  } finally {
    await close(server);
  }
});

test('Registry polling does not retry before its deadline when a timer wakes early', async (t) => {
  let now = 0;
  const requestedAt = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    now += delay > 1 ? delay - 1 : delay;
    queueMicrotask(callback);
  });
  const client = new DkbRegistryClient({ baseUrl: 'http://127.0.0.1:1', token: 'test' });
  t.mock.method(globalThis, 'fetch', async () => {
    requestedAt.push(now);
    return new Response(JSON.stringify({ message: 'Too Many Attempts.' }), {
      status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60' },
    });
  });
  await assert.rejects(
    client.waitForBuild('@test/example', '1.0.0', 10, { timeoutMs: 150, pollIntervalMs: 10 }),
    /Timed out waiting for Registry build 10.*Last transient error: Too Many Attempts/u,
  );
  assert.deepEqual(requestedAt, [10], 'early timer wakeups must not bypass either poll interval or Retry-After');
  assert.equal(now, 150, 'the operation still ends at its original timeout');
});

test('Registry publication sends the selected trusted Pipeline with the immutable source upload', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-publish-pipeline-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'dkb.json'), `${JSON.stringify({
    manifestVersion: 1,
    type: 'dkb',
    name: '@test/pipeline-source',
    displayName: 'Pipeline Source',
    version: '1.0.0',
    description: '',
  }, null, 2)}\n`);
  await fs.writeFile(path.join(root, 'knowledge.md'), 'Trusted source content.\n');
  let versionBody = '';
  const server = http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST' && request.url === '/api/registry/packages') {
      request.resume();
      response.statusCode = 201;
      response.end(JSON.stringify({ data: { id: '@test/pipeline-source' } }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/registry/packages/test/pipeline-source/versions') {
      versionBody = await bodyText(request);
      response.statusCode = 201;
      response.end(JSON.stringify({ data: { packageId: '@test/pipeline-source', version: '1.0.0', status: 'published', recordCount: 1 } }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: 'not found' }));
  });
  await listen(server);
  try {
    const address = server.address();
    assert.equal(typeof address, 'object');
    const client = new DkbRegistryClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: 'test' });
    await client.publish({ sourcePath: root, pipeline: 'tei-faiss' });
    assert.match(versionBody, /name="pipeline"\r\n\r\ntei-faiss\r\n/u);
  } finally {
    await close(server);
  }
});

function bodyText(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.once('error', reject);
  });
}

function fakeInstallPlan(packageId, version, target, retrievalBuildDigest = digest('7')) {
  const sourceDigest = digest('a');
  const layerReceipt = (type, payload, parentReceiptHash) => ({
    type,
    version: 1,
    package: { id: packageId, version, sourceHash: sourceDigest },
    ...(parentReceiptHash ? { parentReceiptHash } : {}),
    payloadHash: digest('b'),
    payload,
    publisher: {
      accountId: '@test', keyId: 'publisher-key', publicKeyFingerprint: digest('c'),
      algorithm: 'ed25519', value: 'signature', signedAt: '2026-09-02T00:00:00.000Z',
    },
    registry: {
      registryId: 'test-registry', keyId: 'registry-key', publicKeyFingerprint: digest('d'),
      algorithm: 'ed25519', value: 'signature', signedAt: '2026-09-02T00:00:00.000Z',
    },
  });
  const evidenceReceiptHash = digest('e');
  const retrievalReceiptHash = digest('f');
  const payload = {
    format: 'dkb.install-plan.v1',
    package: { id: packageId, version, sourceDigest },
    target,
    evidenceProfileDigest: digest('3'),
    evidenceDigest: digest('4'),
    retrievalProfileDigest: digest('5'),
    compatibilityDigest: digest('6'),
    retrievalBuildDigest,
    artifacts: [
      {
        kind: 'source', digest: sourceDigest, mediaType: 'application/vnd.dkb.source+gzip', bytes: 1,
        url: '/source', receiptHash: digest('8'), receipt: {},
      },
      {
        kind: 'evidence', digest: digest('9'), mediaType: 'application/vnd.dkb.evidence+gzip', bytes: 1,
        url: '/evidence', receiptHash: evidenceReceiptHash,
        receipt: layerReceipt('dkb.evidence.receipt', {}, digest('8')),
      },
      {
        kind: 'retrieval', digest: digest('0'), mediaType: 'application/vnd.dkb.retrieval-build+gzip', bytes: 1,
        url: '/retrieval', receiptHash: retrievalReceiptHash,
        receipt: layerReceipt('dkb.retrieval.receipt', {}, evidenceReceiptHash),
      },
    ],
  };
  return { ...payload, receipt: layerReceipt('dkb.install-plan.receipt', payload) };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
