import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { compileComposeProject } from '@sjshovan/dkb-compiler/compile.js';
import { readEvidenceBuild, selectStoredPackageBuild } from '@sjshovan/dkb-library/builds.js';
import { addLibraryRoot, removeLibraryRoot } from '@sjshovan/dkb-library/resolver.js';
import { DKB_RUNTIME_ACTIVATION_PATH } from '@sjshovan/dkb-protocol/paths.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { runtimeActivationDigest } from '@sjshovan/dkb-protocol/runtimeActivation.js';
import { DEFAULT_DKB_RUNTIME_CONTEXT } from '@sjshovan/dkb-runtime/defaultComposition.js';
import { ensureRuntimeState } from '@sjshovan/dkb-runtime/runtime/state.js';
import { switchRuntimePipelineFromRegistry } from '@sjshovan/dkb-runtime/runtime/pipelineSwitch.js';
import { closeQueryContext } from '@sjshovan/dkb-runtime/runtime/queryCache.js';
import { listQueryAudit } from '@sjshovan/dkb-runtime/runtime/queryAudit.js';
import { serveDkbRuntime } from '@sjshovan/dkb-runtime/runtime/server.js';

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const cliPath = path.join(repositoryRoot, 'apps', 'cli', 'dist', 'cli', 'index.js');
const exampleRoot = path.join(repositoryRoot, 'examples', 'lexical-pipeline');
const target = 'minisearch-lexical';
const packageId = '@audit/transport-proof';
const runtimeName = 'local-transport-proof';
const marker = 'WHALE-BUBBLE-73';
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

// Local lexical process proof. This deliberately does not certify signed
// Registry variants, bundled providers, containers, or service performance.
test('local lexical process records exact admitted and rejected audit chains through public CLI, HTTP and MCP', { timeout: 90_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-runtime-transport-audit-'));
  const libraryRoot = path.join(root, 'library');
  const packageRoot = path.join(libraryRoot, 'transport-proof');
  const stateRoot = path.join(root, 'runtime');
  const globalRoot = path.join(root, 'global');
  const bearerToken = 'synthetic-transport-mcp-token';
  const adminToken = 'synthetic-transport-admin-token';
  const source = `# Audit proof\n\nThe stable whale marker is ${marker}.\n`;
  const environment = {
    DKB_GLOBAL_ROOT: globalRoot,
    DKB_CLI_CONFIG: path.join(globalRoot, 'config.json'),
    DKB_HOST_INVENTORY: path.join(root, 'host.json'),
    DKB_MCP_HTTP_ENABLED: 'true',
    DKB_MCP_BEARER_TOKEN: bearerToken,
    DKB_MCP_PUBLIC_BASE_URL: '',
    DKB_MCP_PUBLIC_DOCUMENTS: 'false',
    DKB_MCP_ALLOW_INSECURE_NO_AUTH: 'false',
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  let server;
  t.after(async () => {
    try {
      if (server) {
        server.closeIdleConnections();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
      await closeQueryContext(stateRoot);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      assert.match(path.basename(root), /^dkb-runtime-transport-audit-/u);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  await writeJson(environment.DKB_CLI_CONFIG, { format: 'dkb.config.v2' });
  await writeJson(path.join(libraryRoot, 'dkb.json'), { type: 'library', name: 'Local transport audit proof', roots: {} });
  await writeJson(path.join(packageRoot, 'dkb.json'), {
    manifestVersion: 1, type: 'dkb', name: packageId, version: '1.0.0', permissions: { read: true, write: false },
  });
  await fs.writeFile(path.join(packageRoot, 'marine.md'), source);
  const commandOptions = { cwd: root, env: { ...process.env }, windowsHide: true, timeout: 30_000,
    signal: t.signal, maxBuffer: 2 * 1024 * 1024 };
  const command = async (args) => {
    try {
      const result = await execute(process.execPath, [cliPath, '--json', ...args], commandOptions);
      return { exitCode: 0, data: JSON.parse(result.stdout) };
    } catch (error) {
      if (!Number.isInteger(error.code)) throw error;
      return { exitCode: error.code, data: JSON.parse(error.stdout) };
    }
  };
  const successfulCommand = async (args) => {
    const result = await command(args);
    assert.equal(result.exitCode, 0, JSON.stringify(result.data));
    return result.data;
  };
  await successfulCommand(['plugin', 'link', exampleRoot, '--root', libraryRoot]);
  await successfulCommand(['pipeline', 'set', target, '--root', libraryRoot,
    '--parser', '@example/minisearch-lexical', '--chunker', '@example/minisearch-lexical',
    '--index', '@example/minisearch-lexical', '--retrieval', '@example/minisearch-lexical', '--no-activate']);
  await compileComposeProject(packageRoot, { force: true, target, contextRoot: libraryRoot });
  await addLibraryRoot(libraryRoot, packageId);
  await ensureRuntimeState(stateRoot, { runtimeId: runtimeName, libraryRoot, target });
  await switchRuntimePipelineFromRegistry({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot, target });
  const { activation } = await ensureRuntimeState(stateRoot);
  assert.ok(activation);
  const activationBytes = await fs.readFile(path.join(stateRoot, DKB_RUNTIME_ACTIVATION_PATH));
  assert.deepEqual(Object.keys(activation.packages), [packageId]);
  const graph = await selectStoredPackageBuild({ root: packageRoot, target,
    evidenceProfileDigest: activation.evidenceProfileDigest,
    retrievalProfileDigest: activation.retrievalProfileDigest,
    compatibilityDigest: activation.compatibilityDigest });
  assert.deepEqual(graph.selection, activation.packages[packageId]);
  const ir = await readEvidenceBuild(graph.evidencePath);
  assert.equal(ir.evidenceDigest, activation.packages[packageId].evidenceDigest);
  const record = ir.evidence.find((item) => item.text.includes(marker));
  assert.ok(record, 'compiled IR contains the expected source evidence');
  const chunk = ir.chunks.find((item) => item.evidenceId === record.evidenceId);
  assert.ok(chunk, 'canonical chunk refers to the selected Evidence record');
  assert.match(chunk.chunkId, digestPattern);
  assert.deepEqual(record.assetLocator, { path: 'marine.md' });
  const publicLocator = { ref: stableHash({ storeId: record.storeId, type: record.sourceType,
    locator: record.locator, hash: record.sourceHash }).slice(7, 23) };
  assert.equal(graph.profile.profile.embedding, undefined);

  // One real Node Runtime serves authenticated HTTP and authenticated MCP.
  server = await serveDkbRuntime({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot, host: '127.0.0.1', port: 0, adminToken });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const observedRequests = [];
  server.on('request', (request) => observedRequests.push(request.url));
  await successfulCommand(['runtime', 'register', runtimeName, origin, '--kind', 'process', '--state-root', stateRoot, '--no-verify']);
  const post = async (route, body, headers = {}) => {
    const response = await fetch(`${origin}${route}`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dkb-client-id': 'synthetic-http-client',
        ...(route === '/mcp' ? {} : { authorization: `Bearer ${adminToken}` }),
        'x-dkb-session-id': 'synthetic-http-session', ...headers },
      body: JSON.stringify(body), signal: AbortSignal.any([t.signal, AbortSignal.timeout(15_000)]) });
    return { status: response.status, data: await response.json() };
  };
  let sequence = 0;
  const mcp = async (method, params, authorized = true) => post('/mcp', { jsonrpc: '2.0', id: ++sequence, method, params }, {
    accept: 'application/json, text/event-stream', 'x-dkb-client-id': 'synthetic-mcp-client',
    'x-dkb-session-id': 'synthetic-mcp-session', ...(authorized ? { authorization: `Bearer ${bearerToken}` } : {}),
  });
  assert.equal((await mcp('tools/list', {}, false)).status, 401);
  assert.equal((await mcp('initialize', { protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'local-transport-proof', version: '1.0.0' } })).status, 200);
  const tools = (await mcp('tools/list', {})).data.result.tools;
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['fetch', 'search']);
  assert.ok(tools.every((tool) => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint));
  assert.deepEqual(await listQueryAudit(stateRoot, 100), [], 'metadata/authentication requests do not fabricate retrieval events');

  const readRequest = { queries: [{ id: 'transport-proof', target: record.evidenceId, operation: 'fetch' }] };
  const requestFile = path.join(root, 'read-request.json');
  await writeJson(requestFile, readRequest);
  const transports = [
    { channel: 'cli', search: (query) => command(['query', query, '--runtime', runtimeName]),
      read: () => command(['read', requestFile, '--runtime', runtimeName]),
      result: (response) => { assert.equal(response.exitCode, 0, JSON.stringify(response.data)); return response.data; },
      failure: (response) => assert.notEqual(response.exitCode, 0) },
    { channel: 'runtime-http', search: (query) => post('/api/search', { query }), read: () => post('/api/read', readRequest),
      result: (response) => { assert.equal(response.status, 200, JSON.stringify(response.data)); return response.data; },
      failure: (response) => assert.ok(response.status >= 400) },
    { channel: 'mcp', search: (query) => mcp('tools/call', { name: 'search', arguments: { query } }),
      read: () => mcp('tools/call', { name: 'fetch', arguments: { id: record.evidenceId } }),
      result: (response) => {
        assert.equal(response.status, 200, JSON.stringify(response.data));
        assert.notEqual(response.data.result.isError, true, JSON.stringify(response.data));
        return response.data.result.structuredContent;
      },
      failure: (response) => assert.equal(response.data.result.isError, true) },
  ];
  const recorded = [];
  const observe = async (transport, invoke) => {
    const before = new Set((await listQueryAudit(stateRoot, 100)).map((event) => event.eventId));
    const requestCount = observedRequests.length;
    const response = await invoke();
    if (transport.channel === 'cli') assert.equal(observedRequests.length, requestCount, 'local CLI must not call HTTP and relabel its audit channel');
    const added = (await listQueryAudit(stateRoot, 100)).filter((event) => !before.has(event.eventId));
    assert.equal(added.length, 1, 'one terminal audit event is already durable when the public operation returns');
    assert.equal(added[0].channel, transport.channel);
    recorded.push(added[0]);
    return { response, event: added[0] };
  };

  const searchEvents = [];
  for (const transport of transports) {
    const { response, event } = await observe(transport, () => transport.search(marker));
    const result = transport.result(response);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].evidenceId, record.evidenceId);
    assert.deepEqual([result.results[0].chunkOrdinal, result.results[0].chunkStart, result.results[0].chunkEnd],
      [chunk.ordinal, chunk.start, chunk.end]);
    assertAdmitted(event, activation);
    assert.equal(event.query, marker);
    assert.equal(event.intent, 'search');
    assert.equal(event.outcome, 'success');
    assert.equal(event.resultCount, 1);
    assert.deepEqual(event.candidates, [{ packageId, packageVersion: '1.0.0', evidenceDigest: ir.evidenceDigest,
      retrievalBuildDigest: graph.retrieval.retrievalBuildDigest, evidenceId: record.evidenceId,
      score: result.results[0].score, channels: result.results[0].channels }]);
    assert.ok(Number.isFinite(event.candidates[0].score));
    assert.ok(event.candidates[0].channels.length > 0);
    searchEvents.push(event);
  }
  assert.deepEqual(searchEvents[0].candidates, searchEvents[1].candidates);
  assert.deepEqual(searchEvents[1].candidates, searchEvents[2].candidates);
  for (const transport of transports) {
    const { response, event } = await observe(transport, transport.read);
    const result = transport.result(response);
    const evidence = result.queries[0].evidence[0];
    assert.equal(evidence.source.evidenceId, record.evidenceId);
    assert.equal(evidence.source.dkbId, record.packageId);
    assert.equal(evidence.source.packageVersion, record.packageVersion);
    assert.equal(evidence.source.hash, record.sourceHash);
    assert.deepEqual(evidence.source.locator, publicLocator, 'public source exposes the exact opaque locator reference, not its filesystem path');
    assert.deepEqual([result.queries[0].trace.chunkOrdinal, result.queries[0].trace.chunkStart, result.queries[0].trace.chunkEnd],
      [chunk.ordinal, chunk.start, chunk.end]);
    assert.ok(JSON.stringify(evidence).includes(marker));
    assertAdmitted(event, activation);
    assert.equal(event.query, record.evidenceId);
    assert.equal(event.outcome, 'success');
    assert.equal(event.resultCount, 1);
    assert.deepEqual(event.candidates, [{ packageId, packageVersion: '1.0.0', evidenceDigest: ir.evidenceDigest,
      retrievalBuildDigest: graph.retrieval.retrievalBuildDigest, evidenceId: record.evidenceId, score: null, channels: [] }]);
    assert.equal(event.citations.length, 1);
    assert.deepEqual({ evidenceId: event.citations[0].evidenceId, packageId: event.citations[0].packageId,
      packageVersion: event.citations[0].packageVersion, locator: event.citations[0].locator }, {
      evidenceId: record.evidenceId, packageId, packageVersion: '1.0.0', locator: publicLocator,
    });
  }
  for (const transport of transports) {
    const { response, event } = await observe(transport, () => transport.search('qzxxnonexistent'));
    assert.deepEqual(transport.result(response).results, []);
    assertAdmitted(event, activation);
    assert.equal(event.outcome, 'insufficient');
    assert.equal(event.resultCount, 0);
    assert.deepEqual(event.candidates, []);
    assert.deepEqual(event.citations, []);
  }

  // Authoritative removal invalidates every channel; no activation is invented
  // from the old config and no removed evidence may be returned or audited.
  await removeLibraryRoot(libraryRoot, packageId);
  for (const transport of transports) {
    const { response, event } = await observe(transport, () => transport.search(marker));
    transport.failure(response);
    assert.equal(event.admission, 'rejected_before_admission');
    assert.deepEqual(event.runtime, { id: runtimeName, activationDigest: null });
    assert.equal(event.library, null);
    assert.equal(event.pipeline, null);
    assert.deepEqual(event.packages, []);
    assert.deepEqual(event.candidates, []);
    assert.deepEqual(event.citations, []);
    assert.equal(event.resultCount, 0);
    assert.equal(event.outcome, 'failed');
    assert.match(event.error.message, /stale|refresh/iu);
  }
  assert.equal(recorded.length, 12);
  assert.equal(new Set(recorded.map((event) => event.eventId)).size, recorded.length);
  const serialized = JSON.stringify(recorded);
  for (const secret of [bearerToken, adminToken, 'synthetic-http-session', 'synthetic-mcp-session']) assert.equal(serialized.includes(secret), false);
  for (const event of recorded.filter((event) => event.channel !== 'cli')) {
    assert.match(event.client.id, digestPattern);
    assert.match(event.client.sessionId, digestPattern);
  }
  assert.deepEqual(await fs.readFile(path.join(stateRoot, DKB_RUNTIME_ACTIVATION_PATH)), activationBytes);
  assert.equal(await fs.readFile(path.join(packageRoot, 'marine.md'), 'utf8'), source);
});

function assertAdmitted(event, activation) {
  assert.equal(event.type, 'dkb.query_audit.v2');
  assert.equal(event.admission, 'admitted');
  assert.match(event.eventId, digestPattern);
  assert.ok(Number.isFinite(Date.parse(event.recordedAt)));
  assert.ok(event.requestId.length > 0);
  assert.deepEqual(event.runtime, { id: activation.runtimeId, activationDigest: runtimeActivationDigest(activation) });
  assert.deepEqual(event.library, activation.library);
  assert.deepEqual(event.pipeline, { target: activation.target, evidenceProfileDigest: activation.evidenceProfileDigest,
    retrievalProfileDigest: activation.retrievalProfileDigest, compatibilityDigest: activation.compatibilityDigest });
  assert.deepEqual(event.packages, Object.entries(activation.packages).map(([id, build]) => ({ id,
    version: build.version, evidenceDigest: build.evidenceDigest, retrievalBuildDigest: build.retrievalBuildDigest })));
  assert.ok(Number.isFinite(event.timing.elapsedMs) && event.timing.elapsedMs >= 0);
  assert.notEqual(event.timing.operation, null);
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
