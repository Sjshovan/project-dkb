import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { once } from 'node:events';
import { embedWithFastEmbed } from '@sjshovan/dkb-embedding-fastembed/plugin.js';
import { embedWithTei, teiCompatibility, TEI_DEFAULT_MODEL_REVISION } from '@sjshovan/dkb-embedding-tei/tei.js';

const fastembedTestPin = { modelRepository: 'test/onnx', modelRevision: 'a'.repeat(40) };

test('FastEmbed provider bounds document batches and preserves result order', async (t) => {
  const requests = [];
  let acceptedConnections = 0;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      model: 'test-model',
      ...fastembedTestPin,
      vectors: body.texts.map((text) => [text.length, requests.length]),
    }));
  });
  server.on('connection', () => acceptedConnections++);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  }));
  const address = server.address();
  const vectors = await embedWithFastEmbed(
    ['one', 'two', 'three', 'four', 'five'],
    'document',
    { url: `http://127.0.0.1:${address.port}/embed`, model: 'test-model', ...fastembedTestPin, dimensions: 2, batchSize: 2 },
  ).catch(error => {
    // Diagnostic only: preserve the failure and its socket cause, not request text.
    assert.fail(JSON.stringify({ message: error.message, cause: error.cause && {
      name: error.cause.name, code: error.cause.code, syscall: error.cause.syscall,
    }, listening: server.listening, acceptedConnections, receivedBatches: requests.length }));
  });

  assert.deepEqual(requests.map((request) => request.texts), [['one', 'two'], ['three', 'four'], ['five']]);
  assert.deepEqual(vectors, [[3, 1], [3, 1], [5, 2], [4, 2], [4, 3]]);
});

test('FastEmbed provider rejects non-finite vectors', async (t) => {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end('{"model":"test-model","vectors":[[1,1e999]]}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();

  await assert.rejects(
    embedWithFastEmbed(['bad'], 'document', { url: `http://127.0.0.1:${address.port}/embed`, model: 'test-model', ...fastembedTestPin, dimensions: 2 }),
    /request failed/i,
  );
});

test('FastEmbed refuses mutable custom models and a service using another model revision', async (t) => {
  await assert.rejects(embedWithFastEmbed(['text'], 'query', { url: 'http://127.0.0.1:1/embed', model: 'test-model', dimensions: 2 }), /exact 40-character modelRevision/);
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ model: 'test-model', ...fastembedTestPin, modelRevision: 'b'.repeat(40), vectors: [[1, 2]] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  await assert.rejects(embedWithFastEmbed(['text'], 'query', { url: `http://127.0.0.1:${server.address().port}/embed`, model: 'test-model', ...fastembedTestPin, dimensions: 2 }), /model identity mismatch/);
});

test('TEI provider batches requests, applies mode transforms, and validates finite dimensions', async (t) => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    if (request.url === '/health') {
      response.writeHead(200).end();
      return;
    }
    if (request.url === '/info') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ model_id: 'BAAI/bge-small-en-v1.5', model_sha: TEI_DEFAULT_MODEL_REVISION, version: '1.9.3' }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(body.inputs.map((text) => Array.from({ length: 3 }, (_, index) => text.length + index))));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  const options = {
    url,
    model: 'BAAI/bge-small-en-v1.5',
    modelRevision: TEI_DEFAULT_MODEL_REVISION,
    dimensions: 3,
    batchSize: 2,
    queryPrefix: 'query: ',
    documentPrefix: 'passage: ',
  };

  const documents = await embedWithTei(['one', 'two', 'three'], 'document', options);
  const query = await embedWithTei(['find it'], 'query', options);

  assert.equal(documents.length, 3);
  assert.equal(query.length, 1);
  assert.deepEqual(requests.map((request) => request.inputs), [
    ['passage: one', 'passage: two'],
    ['passage: three'],
    ['query: find it'],
  ]);
  assert.ok(requests.every((request) => request.normalize === true && request.truncate === true && request.dimensions === 3));
});

test('TEI compatibility binds model revision and query/document transforms', () => {
  const left = teiCompatibility({ dimensions: 384, queryPrefix: 'query: ' });
  const right = teiCompatibility({ dimensions: 384, queryPrefix: 'search: ' });

  assert.equal(left.modelRevision, TEI_DEFAULT_MODEL_REVISION);
  assert.notEqual(left.queryTransformDigest, right.queryTransformDigest);
  assert.equal(left.documentTransformDigest, right.documentTransformDigest);
  assert.throws(() => teiCompatibility({ modelRevision: 'main' }), /exact 40-character model commit/);
  assert.throws(() => teiCompatibility({ model: 'test/custom' }), /exact 40-character model commit/);
});

test('TEI provider rejects malformed vectors and honors cancellation', async (t) => {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/info') {
      response.end(JSON.stringify({ model_id: 'BAAI/bge-small-en-v1.5', model_sha: TEI_DEFAULT_MODEL_REVISION, version: '1.9.3' }));
      return;
    }
    response.end(JSON.stringify([[1, Number.NaN]]));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();
  const options = { url: `http://127.0.0.1:${address.port}`, dimensions: 2 };

  await assert.rejects(embedWithTei(['bad'], 'document', options), /dimension or numeric validation failed/i);
  const controller = new AbortController();
  controller.abort(new Error('cancelled by test'));
  await assert.rejects(embedWithTei(['cancel'], 'query', options, controller.signal), /cancelled by test/i);
});

test('TEI refuses a wrong pinned model before embedding and a model replaced during embedding', async (t) => {
  let revision = 'b'.repeat(40);
  let serviceVersion = '1.9.3';
  let replaceDuringEmbed = false;
  let embedded = 0;
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/info') {
      response.end(JSON.stringify({ model_id: 'BAAI/bge-small-en-v1.5', model_sha: revision, version: serviceVersion }));
      return;
    }
    embedded++;
    if (replaceDuringEmbed) revision = 'c'.repeat(40);
    response.end(JSON.stringify([[1, 2]]));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const options = { url: `http://127.0.0.1:${server.address().port}`, dimensions: 2 };
  await assert.rejects(embedWithTei(['text'], 'query', options), /model identity mismatch/);
  assert.equal(embedded, 0);
  revision = TEI_DEFAULT_MODEL_REVISION;
  serviceVersion = 'unexpected-version';
  await assert.rejects(embedWithTei(['text'], 'query', options), /model identity mismatch/);
  assert.equal(embedded, 0);
  serviceVersion = '1.9.3';
  replaceDuringEmbed = true;
  await assert.rejects(embedWithTei(['text'], 'document', options), /model identity mismatch/);
  assert.equal(embedded, 1);
});

test('TEI cancellation interrupts pinned identity verification', async (t) => {
  const controller = new AbortController();
  const server = http.createServer((_request, response) => {
    controller.abort(new Error('cancelled during identity check'));
    response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  await assert.rejects(embedWithTei(['text'], 'query', { url: `http://127.0.0.1:${server.address().port}`, dimensions: 2 }, controller.signal), /cancelled during identity check/);
});
