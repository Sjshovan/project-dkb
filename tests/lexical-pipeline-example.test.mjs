import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { compileComposeProject, ensurePackageBuildForTarget } from '@sjshovan/dkb-compiler/compile.js';
import { listPackageBuilds } from '@sjshovan/dkb-library/builds.js';
import { addLibraryRoot, removeLibraryRoot } from '@sjshovan/dkb-library/resolver.js';
import { DKB_RUNTIME_ACTIVATION_PATH } from '@sjshovan/dkb-protocol/paths.js';
import { DEFAULT_DKB_RUNTIME_CONTEXT } from '@sjshovan/dkb-runtime/defaultComposition.js';
import { ensureRuntimeState } from '@sjshovan/dkb-runtime/runtime/state.js';
import { switchRuntimePipelineFromRegistry } from '@sjshovan/dkb-runtime/runtime/pipelineSwitch.js';
import { searchRuntime, readRuntime } from '@sjshovan/dkb-runtime/runtime/queryAccess.js';
import { closeQueryContext } from '@sjshovan/dkb-runtime/runtime/queryCache.js';
import { listQueryAudit } from '@sjshovan/dkb-runtime/runtime/queryAudit.js';
import { serveDkbRuntime } from '@sjshovan/dkb-runtime/runtime/server.js';
import { serveDkbMcpHttp } from '@sjshovan/dkb-runtime/mcp/http.js';
import '../examples/lexical-pipeline/plugin.test.mjs';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const exampleRoot = path.join(repositoryRoot, 'examples', 'lexical-pipeline');
const pipeline = 'minisearch-lexical';

test('real lexical example compiles, serves, scopes, deactivates and reuses immutable builds without embedding', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-lexical-example-'));
  const libraryRoot = path.join(root, 'library');
  const runtimeRoots = [path.join(root, 'runtime-a'), path.join(root, 'runtime-b')];
  t.after(async () => {
    for (const stateRoot of runtimeRoots) await closeQueryContext(stateRoot);
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  await writeJson(path.join(libraryRoot, 'dkb.json'), { type: 'library', name: 'Lexical example', roots: {} });
  await fs.mkdir(path.join(libraryRoot, '.dkb'), { recursive: true });
  const cli = path.join(repositoryRoot, 'apps', 'cli', 'dist', 'cli', 'index.js');
  const commandOptions = { cwd: root, timeout: 30_000, env: { ...process.env, DKB_HOST_INVENTORY: path.join(root, 'host.json') } };
  const linked = await execFileAsync(process.execPath, [cli, '--json', 'plugin', 'link', exampleRoot, '--root', libraryRoot], {
    ...commandOptions,
  });
  assert.equal(JSON.parse(linked.stdout).id, '@example/minisearch-lexical');
  const configured = await execFileAsync(process.execPath, [cli, '--json', 'pipeline', 'set', pipeline, '--root', libraryRoot,
    '--parser', '@example/minisearch-lexical', '--chunker', '@example/minisearch-lexical',
    '--index', '@example/minisearch-lexical', '--retrieval', '@example/minisearch-lexical', '--no-activate'], commandOptions);
  assert.ok(JSON.parse(configured.stdout));

  const sources = [
    { name: 'marine', filename: 'marine.md', text: '# Marine\nWhale communication signal: WHALE-BUBBLE-73.\n\n## Safety\nThe trusted marker is SAFE-SOURCE-91.\n' },
    { name: 'systems', filename: 'systems.txt', text: 'Runtime deployment signal: RUNTIME-MOUNT-28.\n' },
  ];
  for (const source of sources) {
    source.id = `@example/${source.name}`;
    source.root = path.join(libraryRoot, source.name);
    await writeJson(path.join(source.root, 'dkb.json'), {
      manifestVersion: 1, type: 'dkb', name: source.id, version: '1.0.0', permissions: { read: true, write: false },
    });
    await fs.writeFile(path.join(source.root, source.filename), source.text);
    await compileComposeProject(source.root, { force: true, target: pipeline, contextRoot: libraryRoot });
    await addLibraryRoot(libraryRoot, source.id);
    source.builds = await listPackageBuilds(source.root);
    assert.equal(source.builds.evidence.length, 1);
    assert.equal(source.builds.retrieval.length, 1);
    const ir = JSON.parse(await fs.readFile(path.join(source.builds.evidence[0].path, 'evidence.ir.json'), 'utf8'));
    assert.ok(ir.evidence.length > 0);
    for (const record of ir.evidence) {
      assert.equal(record.sourceHash, hash(source.text));
      assert.deepEqual(record.assetLocator, { path: source.filename });
      assert.equal(record.packageId, source.id);
    }
    const artifact = path.join(source.builds.retrieval[0].path, 'artifacts', 'lexical.json');
    source.artifact = artifact;
    source.artifactBytes = await fs.readFile(artifact);
    assert.deepEqual((await fs.readdir(path.dirname(artifact))).sort(), ['lexical.json']);
  }

  const activate = (stateRoot) => switchRuntimePipelineFromRegistry({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot, target: pipeline });
  const search = (stateRoot, query, scope) => searchRuntime({ stateRoot, runtime: DEFAULT_DKB_RUNTIME_CONTEXT, query, scope, limit: 10 });
  for (const [ordinal, stateRoot] of runtimeRoots.entries()) {
    await ensureRuntimeState(stateRoot, { runtimeId: `lexical-${ordinal}`, libraryRoot, target: pipeline });
    await activate(stateRoot);
  }
  const first = await ensureRuntimeState(runtimeRoots[0]);
  const second = await ensureRuntimeState(runtimeRoots[1]);
  assert.deepEqual(first.activation.packages, second.activation.packages);
  const profile = JSON.parse(await fs.readFile(path.join(sources[0].builds.retrieval[0].path, 'dkb-profile.lock.json'), 'utf8'));
  assert.equal(profile.profile.embedding, undefined);
  assert.equal(profile.compatibility.dimensions, undefined);
  assert.equal(profile.compatibility.indexFormat, 'example.minisearch.v1');
  const originalActivation = await fs.readFile(path.join(runtimeRoots[0], DKB_RUNTIME_ACTIVATION_PATH));

  await proveAuditedTransports({ stateRoot: runtimeRoots[0], root, cli, commandOptions });

  for (const marker of ['WHALE-BUBBLE-73', 'SAFE-SOURCE-91', 'RUNTIME-MOUNT-28']) {
    const result = await search(runtimeRoots[0], marker);
    assert.ok(result.results.length > 0, marker);
    const evidenceId = result.results[0].evidenceId;
    const fetched = await readRuntime({ stateRoot: runtimeRoots[0], runtime: DEFAULT_DKB_RUNTIME_CONTEXT,
      request: { queries: [{ id: 'evidence', target: evidenceId, operation: 'fetch' }] } });
    assert.equal(fetched.queries[0].evidence[0].source.evidenceId, evidenceId);
    assert.ok(JSON.stringify(fetched).includes(marker));
  }
  assert.equal((await search(runtimeRoots[0], 'qzxxnonexistent')).results.length, 0);
  assert.equal((await search(runtimeRoots[0], 'RUNTIME-MOUNT-28', { dkbId: '@example/marine' })).results.length, 0);
  assert.equal((await search(runtimeRoots[0], 'WHALE-BUBBLE-73', { dkbId: '@example/marine' })).results.length, 1);

  // A corrupt destination build cannot replace an already valid activation.
  await fs.appendFile(sources[0].artifact, '\ninvalid');
  await assert.rejects(activate(runtimeRoots[0]), /artifact|digest|hash|JSON|unexpected/i);
  assert.deepEqual(await fs.readFile(path.join(runtimeRoots[0], DKB_RUNTIME_ACTIVATION_PATH)), originalActivation);
  await fs.writeFile(sources[0].artifact, sources[0].artifactBytes);
  await activate(runtimeRoots[0]);

  // Editable removal preserves source/builds, but authoritative Library state
  // invalidates both Runtimes immediately; refreshing one never refreshes the other.
  await removeLibraryRoot(libraryRoot, '@example/marine');
  for (const stateRoot of runtimeRoots) await assert.rejects(search(stateRoot, 'WHALE-BUBBLE-73'), /stale|refresh/i);
  await activate(runtimeRoots[0]);
  assert.equal((await search(runtimeRoots[0], 'WHALE-BUBBLE-73')).results.length, 0);
  assert.equal((await search(runtimeRoots[0], 'RUNTIME-MOUNT-28')).results.length, 1);
  await assert.rejects(search(runtimeRoots[1], 'RUNTIME-MOUNT-28'), /stale|refresh/i);
  await addLibraryRoot(libraryRoot, '@example/marine');
  await activate(runtimeRoots[0]);
  assert.equal((await search(runtimeRoots[0], 'WHALE-BUBBLE-73')).results.length, 1);
  for (const source of sources) {
    const retained = await ensurePackageBuildForTarget(source.root, { target: pipeline, contextRoot: libraryRoot });
    assert.equal(retained.preparation, 'retained');
    assert.deepEqual(await listPackageBuilds(source.root), source.builds);
    assert.deepEqual(await fs.readFile(source.artifact), source.artifactBytes);
    assert.equal(await fs.readFile(path.join(source.root, source.filename), 'utf8'), source.text);
  }
  const audit = await listQueryAudit(runtimeRoots[0], 50);
  assert.ok(audit.some((event) => event.admission === 'rejected_before_admission'));
  assert.ok(audit.some((event) => event.outcome === 'insufficient'));
  assert.ok(audit.filter((event) => event.admission === 'admitted').every((event) => event.pipeline && event.library));
});

test('lexical example is checked against the exported SDK types', async () => {
  await execFileAsync(process.execPath, [path.join(repositoryRoot, 'node_modules/typescript/bin/tsc'), '-p', path.join(exampleRoot, 'tsconfig.json')], { timeout: 30_000 });
});

test('shared pipeline proof compiles the real lexical plugin locally and over HTTP, then uses audited Runtime APIs', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-lexical-http-proof-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const globalRoot = path.join(root, 'global');
  const pluginPath = path.join(globalRoot, 'plugins', '@example', 'minisearch-lexical');
  await fs.mkdir(path.dirname(pluginPath), { recursive: true });
  await fs.symlink(exampleRoot, pluginPath, process.platform === 'win32' ? 'junction' : 'dir');
  await fs.copyFile(path.join(exampleRoot, 'pipeline.json'), path.join(globalRoot, 'config.json'));
  const result = await execFileAsync(process.execPath, [path.join(repositoryRoot, 'scripts', 'prove-provider-pipeline.mjs')], {
    cwd: repositoryRoot,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    env: {
      ...process.env,
      DKB_GLOBAL_ROOT: globalRoot,
      DKB_HOST_INVENTORY: path.join(root, 'host.json'),
      DKB_PROOF_TARGET: pipeline,
      DKB_PROOF_COMPILER_URL: '',
      DKB_COMPILER_ALLOWED_TARGETS: pipeline,
      DKB_COMPILER_DEFAULT_TARGET: pipeline,
      DKB_COMPILER_WORK_ROOT: path.join(root, 'jobs'),
      DKB_KEEP_PROOF_ROOT: '0',
    },
  });
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.ok, true);
  assert.equal(proof.target, pipeline);
  assert.equal(proof.embedding, null);
  assert.ok(proof.evidenceCount > 0);
  assert.equal(proof.local.buildDigest, proof.remote.buildDigest);
  assert.deepEqual(Object.keys(proof.searches).sort(), ['RUNTIME-MOUNT-28', 'SAFE-SOURCE-91', 'WHALE-BUBBLE-73']);
  await assert.rejects(fs.access(proof.proofRoot), { code: 'ENOENT' });
});

async function writeJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
}

async function proveAuditedTransports({ stateRoot, root, cli, commandOptions }) {
  const runtime = DEFAULT_DKB_RUNTIME_CONTEXT;
  const bearerToken = 'synthetic-lexical-mcp-token';
  const http = await serveDkbRuntime({ runtime, stateRoot, host: '127.0.0.1', port: 0 });
  let mcp;
  try {
    mcp = await serveDkbMcpHttp({ runtime, stateRoot, host: '127.0.0.1', port: 0,
      bearerToken, allowInsecureNoAuth: false, publicDocuments: false });
    const httpOrigin = `http://127.0.0.1:${http.address().port}`;
    const endpoint = `http://127.0.0.1:${mcp.address().port}/mcp`;
    const cliRun = async (args) => JSON.parse((await execFileAsync(process.execPath,
      [cli, '--json', ...args], { ...commandOptions, windowsHide: true })).stdout);
    await cliRun(['runtime', 'register', 'lexical-audit-proof', httpOrigin,
      '--kind', 'process', '--state-root', stateRoot, '--no-verify']);
    const httpPost = async (route, body) => {
      const response = await fetch(`${httpOrigin}${route}`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dkb-client-id': 'lexical-http-proof' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    let sequence = 0;
    const mcpCall = async (method, params, authorized = true) => {
      const response = await fetch(endpoint, { method: 'POST', headers: {
        accept: 'application/json, text/event-stream', 'content-type': 'application/json',
        'x-dkb-client-id': 'lexical-mcp-proof',
        ...(authorized ? { authorization: `Bearer ${bearerToken}` } : {}),
      }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }),
      signal: AbortSignal.timeout(15_000) });
      assert.equal(response.status, authorized ? 200 : 401, await response.clone().text());
      return response.json();
    };
    await mcpCall('tools/list', {}, false);
    await mcpCall('initialize', { protocolVersion: '2025-11-25', capabilities: {},
      clientInfo: { name: 'lexical-proof', version: '1.0.0' } });
    const tools = (await mcpCall('tools/list', {})).result.tools;
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['fetch', 'search']);
    assert.ok(tools.every((tool) => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint));

    const query = 'WHALE-BUBBLE-73';
    const cliSearch = await cliRun(['query', query, '--runtime', 'lexical-audit-proof']);
    const httpSearch = await httpPost('/api/search', { query });
    const mcpSearchResult = (await mcpCall('tools/call', { name: 'search', arguments: { query } })).result;
    assert.equal(mcpSearchResult.isError, undefined, JSON.stringify(mcpSearchResult));
    const mcpSearch = mcpSearchResult.structuredContent;
    const evidenceId = cliSearch.results[0].evidenceId;
    assert.ok(evidenceId);
    assert.equal(httpSearch.results[0].evidenceId, evidenceId);
    assert.equal(mcpSearch.results[0].evidenceId, evidenceId);

    const request = { queries: [{ id: 'proof', target: evidenceId, operation: 'fetch' }] };
    const requestFile = path.join(root, 'read-request.json');
    await writeJson(requestFile, request);
    const cliRead = await cliRun(['read', requestFile, '--runtime', 'lexical-audit-proof']);
    const httpRead = await httpPost('/api/read', request);
    const mcpReadResult = (await mcpCall('tools/call', { name: 'fetch', arguments: { id: evidenceId } })).result;
    assert.equal(mcpReadResult.isError, undefined, JSON.stringify(mcpReadResult));
    const mcpRead = mcpReadResult.structuredContent;
    for (const result of [cliRead, httpRead, mcpRead]) {
      assert.equal(result.queries[0].evidence[0].source.evidenceId, evidenceId);
      assert.ok(JSON.stringify(result).includes(query));
    }
    const events = await listQueryAudit(stateRoot, 50);
    const searches = events.filter((event) => event.intent === 'search' && event.query === query);
    assert.deepEqual(searches.map((event) => event.channel).sort(), ['cli', 'mcp', 'runtime-http']);
    const canonical = searches.find((event) => event.channel === 'cli');
    assert.equal(canonical.admission, 'admitted');
    for (const event of searches) {
      for (const field of ['runtime', 'library', 'pipeline', 'packages', 'candidates']) {
        assert.deepEqual(event[field], canonical[field], `${event.channel} ${field}`);
      }
      assert.equal(event.outcome, 'success');
      assert.ok(event.candidates.every((item) => item.evidenceDigest && item.retrievalBuildDigest));
      if (event.channel !== 'cli') assert.match(event.client.id, /^sha256:[a-f0-9]{64}$/);
    }
    const reads = events.filter((event) => ['read', 'fetch'].includes(event.intent));
    assert.deepEqual(reads.map((event) => event.channel).sort(), ['cli', 'mcp', 'runtime-http']);
    assert.ok(reads.every((event) => event.citations.some((citation) => citation.evidenceId === evidenceId)));
    assert.equal(JSON.stringify(events).includes(bearerToken), false);
    const insufficient = (await mcpCall('tools/call', {
      name: 'search', arguments: { query: 'qzxxnonexistent' },
    })).result.structuredContent;
    assert.equal(insufficient.status, 'empty');
    assert.equal(insufficient.sufficiency.matchedNeed, false);
    assert.deepEqual(insufficient.results, []);
    assert.equal((await listQueryAudit(stateRoot, 1))[0].outcome, 'insufficient');
  } finally {
    for (const server of [mcp, http].filter(Boolean)) {
      server.closeIdleConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
}

function hash(text) { return `sha256:${createHash('sha256').update(text).digest('hex')}`; }
