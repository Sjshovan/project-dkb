import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createRoot, createQueryFixture, writeJson } from './runtime-query-fixture.mjs';
import { signedDownloadFixture } from './fixtures/signed-download.mjs';
import { collectionClient, collectionSnapshot } from './fixtures/collection-download.mjs';
import { applyLibraryLock, maybeReadLibraryLock, readLibraryState } from '@sjshovan/dkb-library/state.js';
import { captureLibraryReadFence, recoverLibraryMutation, withLibraryMutation, withLibraryReadSnapshot } from '@sjshovan/dkb-library/mutation.js';
import { generateSigningKeyPair } from '@sjshovan/dkb-library/signing.js';
import { initializeRuntimeBinding, importCompiledDkbArtifactIntoLibraryWithinMutation, closeRuntimeQuerySnapshot, runtimeStatus } from '@sjshovan/dkb-runtime/runtime/state.js';
import { readRuntimeState } from '../services/runtime/dist/runtime/activation.js';
import { attachSignedBuildChainWithinMutation, installDkbPlanIntoLibraryWithinMutation, installDkbPlanIntoLibrary } from '@sjshovan/dkb-runtime/runtime/registryInstall.js';
import { withDkbFileLock } from '@sjshovan/dkb-library/locks.js';
import { installRegistryCollection, uninstallRegistryCollection } from '@sjshovan/dkb-runtime/runtime/collections.js';
import { switchRuntimePipelineFromRegistry, refreshRuntimeActivation } from '@sjshovan/dkb-runtime/runtime/pipelineSwitch.js';
import { runAuditedRuntimeOperation } from '../services/runtime/dist/runtime/queryOperation.js';
import { searchRuntime } from '@sjshovan/dkb-runtime/runtime/queryAccess.js';
import { serveDkbRuntime } from '@sjshovan/dkb-runtime/runtime/server.js';
import { createDkbReadOnlyMcpServer } from '@sjshovan/dkb-runtime/mcp/readOnly.js';
import { listQueryAudit } from '@sjshovan/dkb-runtime/runtime/queryAudit.js';
import { DEFAULT_DKB_RUNTIME_CONTEXT as runtime } from '@sjshovan/dkb-runtime/defaultComposition.js';

const recoveryRequired = (error) => error.code === 'library_recovery_required'
  && /dkb library recover --library/.test(error.message);

test('warm queries read canonical Library state without rediscovering source trees and still reject manifest drift', async (t) => {
  const fixture = await createQueryFixture(t);
  const original = fs.readdir;
  const sourceRoots = new Set([fixture.libraryRoot, fixture.packageRoot].map(value => path.resolve(value)));
  fs.readdir = async (directory, ...args) => {
    assert.equal(sourceRoots.has(path.resolve(String(directory))), false, 'warm retrieval must not rediscover source folders');
    return original(directory, ...args);
  };
  try {
    assert.equal((await search(fixture)).results.length, 1);
    const manifest = path.join(fixture.packageRoot, 'dkb.json');
    await fs.appendFile(manifest, '\n');
    await assert.rejects(search(fixture), { code: 'validated_input_changed' });
    const [audit] = await listQueryAudit(fixture.runtimeRoot, 1);
    assert.equal(audit.outcome, 'failed');
    assert.deepEqual(audit.candidates, []);
  } finally { fs.readdir = original; }
});

test('Runtime WithinMutation imports reject callers without durable Library ownership', async (t) => {
  const fixture = await createRoot(t);
  await assert.rejects(importCompiledDkbArtifactIntoLibraryWithinMutation({ sourcePath: 'not-read' }, fixture.libraryRoot), { code: 'library_mutation_required' });
  await assert.rejects(installDkbPlanIntoLibraryWithinMutation({ libraryRoot: fixture.libraryRoot }), { code: 'library_mutation_required' });
});

test('immutable build attachment requires the Library lease and rejects a pending transaction before verification', async (t) => {
  const fixture = await createCollectionFixture(t);
  const options = { libraryRoot: fixture.libraryRoot, packageRoot: path.join(fixture.libraryRoot, 'vendor', '@test', 'beta') };
  await assert.rejects(attachSignedBuildChainWithinMutation(options), /lock|lease|ownership/i);
  await withDkbFileLock(fixture.libraryRoot, 'library-mutation', async () => {
    await assert.rejects(withLibraryMutation(fixture.libraryRoot, async () => {
      await assert.rejects(attachSignedBuildChainWithinMutation(options), recoveryRequired);
      throw new Error('rollback build attachment test');
    }), /rollback build attachment test/);
  });
});

test('a killed Runtime package replacement restores exact prior package and metadata', async (t) => {
  const fixture = await createQueryFixture(t);
  const before = await metadataBytes(fixture.libraryRoot);
  const source = await fs.readFile(path.join(fixture.packageRoot, 'knowledge.md'));
  const packageIdentity = await fs.stat(fixture.packageRoot);
  const child = await startMutationChild(fixture, 'package-replace');
  assert.notEqual((await fs.stat(fixture.packageRoot)).ino, packageIdentity.ino);
  await assert.rejects(readRuntimeState(fixture.runtimeRoot), recoveryRequired);
  await stopChild(child);
  await recoverLibraryMutation(fixture.libraryRoot);
  assert.deepEqual(await metadataBytes(fixture.libraryRoot), before);
  assert.deepEqual(await fs.readFile(path.join(fixture.packageRoot, 'knowledge.md')), source);
  assert.equal((await fs.stat(fixture.packageRoot)).ino, packageIdentity.ino);
  await recoverLibraryMutation(fixture.libraryRoot);
  // Exact restored bytes preserve the activation identity, but retained warm
  // filesystem observations must be explicitly refreshed after path renames.
  await assert.rejects(search(fixture), { code: 'validated_input_changed' });
  await refreshRuntimeActivation({ stateRoot: fixture.runtimeRoot, runtime });
  assert.equal((await search(fixture)).results.length, 1);
});

test('a killed Collection update restores removed members, exact roots and prior applied state', async (t) => {
  const fixture = await createCollectionFixture(t);
  const before = await metadataBytes(fixture.libraryRoot);
  const collectionPath = path.join(fixture.libraryRoot, 'vendor', '@test', 'collection', 'dkb.json');
  const collectionBefore = await fs.readFile(collectionPath);
  const alphaPath = path.join(fixture.libraryRoot, 'vendor', '@test', 'alpha');
  const alphaBefore = await fs.readFile(path.join(alphaPath, 'knowledge.md'));
  const alphaIdentity = await fs.stat(alphaPath);
  const child = await startMutationChild(fixture, 'collection-update');
  assert.equal(await exists(alphaPath), false, 'old sole-owner member is journaled, not copied');
  assert.equal(JSON.parse(await fs.readFile(collectionPath)).meta.revision, 2);
  await assert.rejects(readLibraryState(fixture.libraryRoot), recoveryRequired);
  await assert.rejects(readRuntimeState(fixture.runtimeRoot), recoveryRequired);
  await stopChild(child);
  await recoverLibraryMutation(fixture.libraryRoot);
  assert.deepEqual(await metadataBytes(fixture.libraryRoot), before);
  assert.deepEqual(await fs.readFile(collectionPath), collectionBefore);
  assert.deepEqual(await fs.readFile(path.join(alphaPath, 'knowledge.md')), alphaBefore);
  assert.equal((await fs.stat(alphaPath)).ino, alphaIdentity.ino);
  const restored = await readLibraryState(fixture.libraryRoot);
  assert.equal(restored.entries['@test/collection'].revision, 1);
  assert.deepEqual(restored.entries['@test/alpha'].requiredBy, ['collection:@test/collection']);
  await recoverLibraryMutation(fixture.libraryRoot);
  assert.deepEqual(await metadataBytes(fixture.libraryRoot), before);
});

test('Collection update commits one generation and uninstall preserves direct member intent', async (t) => {
  const fixture = await createCollectionFixture(t);
  const before = await maybeReadLibraryLock(fixture.libraryRoot);
  const updated = await installRegistryCollection({ libraryRoot: fixture.libraryRoot, collectionId: '@test/collection', update: true, client: fixture.client });
  assert.equal(updated.status, 'updated');
  const current = await readLibraryState(fixture.libraryRoot);
  assert.equal(current.entries['@test/collection'].revision, 2);
  assert.equal(current.entries['@test/alpha'], undefined);
  assert.deepEqual(current.entries['@test/beta'].requiredBy.sort(), ['collection:@test/collection', 'root:@test/beta']);
  assert.equal((await maybeReadLibraryLock(fixture.libraryRoot)).generation, before.generation + 1);
  assert.equal(await exists(path.join(fixture.libraryRoot, 'vendor', '@test', 'alpha')), false);
  await uninstallRegistryCollection({ libraryRoot: fixture.libraryRoot, collectionId: '@test/collection' });
  const remaining = await readLibraryState(fixture.libraryRoot);
  assert.deepEqual(Object.keys(remaining.entries), ['@test/beta']);
  assert.deepEqual(remaining.entries['@test/beta'].requiredBy, ['root:@test/beta']);
  assert.equal(await exists(path.join(fixture.libraryRoot, 'vendor', '@test', 'collection')), false);
  const installed = await installRegistryCollection({ libraryRoot: fixture.libraryRoot, collectionId: '@test/collection', client: fixture.client });
  assert.equal(installed.status, 'installed');
  assert.equal((await readLibraryState(fixture.libraryRoot)).entries['@test/collection'].revision, 2);
});

test('pending Library mutation blocks warm query, status and refresh without implicit recovery', async (t) => {
  const fixture = await createQueryFixture(t);
  const before = await metadataBytes(fixture.libraryRoot);
  const child = await startMutationChild(fixture, 'hold');
  await assert.rejects(search(fixture), recoveryRequired);
  await assert.rejects(runtimeStatus(fixture.runtimeRoot), recoveryRequired);
  await assert.rejects(refreshRuntimeActivation({ stateRoot: fixture.runtimeRoot, runtime }), recoveryRequired);
  await stopChild(child);
  await assert.rejects(search(fixture), recoveryRequired, 'process death does not implicitly recover during a read');
  await recoverLibraryMutation(fixture.libraryRoot);
  assert.deepEqual(await metadataBytes(fixture.libraryRoot), before);
  assert.equal((await search(fixture)).results.length, 1);
});

test('query finalization rejects mutation plus exact rollback even when logical state did not change', async (t) => {
  const fixture = await createQueryFixture(t);
  const before = await metadataBytes(fixture.libraryRoot);
  const requestId = 'library-rollback-aba';
  await assert.rejects(runAuditedRuntimeOperation({
    stateRoot: fixture.runtimeRoot, runtime, channel: 'cli', query: 'RECOVERY-MARKER', intent: 'search', requestId,
    async operation() {
      await assert.rejects(withLibraryMutation(fixture.libraryRoot, async () => { throw new Error('rollback barrier'); }), /rollback barrier/);
      return { value: { evidence: 'must not escape finalization' }, requestId, status: 'ok', outcome: 'success' };
    },
  }), { code: 'library_busy' });
  assert.deepEqual(await metadataBytes(fixture.libraryRoot), before);
  const audit = (await listQueryAudit(fixture.runtimeRoot)).find((event) => event.requestId === requestId);
  assert.equal(audit.outcome, 'failed');
  assert.equal(audit.error.code, 'library_busy');
  assert.deepEqual(audit.candidates, []);
  assert.deepEqual(audit.citations, []);
  assert.equal((await search(fixture)).results.length, 1);
});

for (const phase of ['admission', 'finalization']) test(`the ${phase} snapshot finishes its fresh barrier even inside an outer read scope`, async (t) => {
  const fixture = await createQueryFixture(t);
  const requestId = `snapshot-${phase}-barrier`;
  const resolvedLock = path.join(fixture.libraryRoot, 'dkb-lock.json');
  const readFile = fs.readFile;
  let operationStarted = false;
  let child;
  const intercepted = t.mock.method(fs, 'readFile', async function (target, ...args) {
    const bytes = await Reflect.apply(readFile, fs, [target, ...args]);
    if (!child && String(target) === resolvedLock && operationStarted === (phase === 'finalization')) {
      // The immutable SQLite view has already been captured. Another process
      // begins a real mutation while this phase is validating its file mirror.
      child = await startMutationChild(fixture, 'hold');
    }
    return bytes;
  });
  try {
    await assert.rejects(withLibraryReadSnapshot(async () => {
      await captureLibraryReadFence(fixture.libraryRoot);
      return runAuditedRuntimeOperation({
        stateRoot: fixture.runtimeRoot, runtime, channel: 'cli', query: 'RECOVERY-MARKER', intent: 'search', requestId,
        async operation() {
          operationStarted = true;
          return { value: { evidence: 'must not escape the fresh barrier' }, requestId, status: 'ok', outcome: 'success' };
        },
      });
    }), recoveryRequired);
    assert.ok(child, 'the competing mutation reached the selected phase');
    assert.equal(operationStarted, phase === 'finalization', 'admission must finish its fresh barrier before invoking the operation');
    const audit = (await listQueryAudit(fixture.runtimeRoot)).find((event) => event.requestId === requestId);
    assert.equal(audit.admission, phase === 'admission' ? 'rejected_before_admission' : 'admitted');
    assert.equal(audit.outcome, 'failed');
    assert.deepEqual(audit.candidates, []);
    assert.deepEqual(audit.citations, []);
  } finally {
    intercepted.mock.restore();
    for (const owned of fixture.children) await stopChild(owned);
    await recoverLibraryMutation(fixture.libraryRoot);
  }
  assert.equal((await search(fixture)).results.length, 1);
});

test('query operations do not inherit the completed admission snapshot', async (t) => {
  const fixture = await createQueryFixture(t);
  const requestId = 'snapshot-does-not-escape-admission';
  let child;
  try {
    await assert.rejects(runAuditedRuntimeOperation({
      stateRoot: fixture.runtimeRoot, runtime, channel: 'cli', query: 'RECOVERY-MARKER', intent: 'search', requestId,
      async operation() {
        child = await startMutationChild(fixture, 'hold');
        await assert.rejects(captureLibraryReadFence(fixture.libraryRoot), recoveryRequired,
          'provider work must observe the current ledger, not the expired admission view');
        return { value: null, requestId, status: 'ok', outcome: 'success' };
      },
    }), recoveryRequired);
    const audit = (await listQueryAudit(fixture.runtimeRoot)).find((event) => event.requestId === requestId);
    assert.equal(audit.admission, 'admitted');
    assert.equal(audit.outcome, 'failed');
    assert.deepEqual(audit.candidates, []);
  } finally {
    for (const owned of fixture.children) await stopChild(owned);
    await recoverLibraryMutation(fixture.libraryRoot);
  }
});

test('authenticated HTTP and both read-only MCP tools return no evidence while Library recovery is pending', async (t) => {
  const fixture = await createQueryFixture(t);
  const evidenceId = (await search(fixture)).results[0].evidenceId;
  const server = await serveDkbRuntime({ stateRoot: fixture.runtimeRoot, runtime, host: '127.0.0.1', port: 0, adminToken: 'recovery-http-admin' });
  fixture.disposers.push(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpServer = createDkbReadOnlyMcpServer({ stateRoot: fixture.runtimeRoot, runtime });
  const client = new Client({ name: 'library-recovery-proof', version: '1.0.0' });
  fixture.disposers.push(async () => { await client.close(); await mcpServer.close(); });
  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ['fetch', 'search']);
  const child = await startMutationChild(fixture, 'hold');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/search`, {
    method: 'POST', headers: { authorization: 'Bearer recovery-http-admin', 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'RECOVERY-MARKER' }), signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 409);
  const failure = await response.json();
  assert.equal(failure.error, 'library_recovery_required');
  assert.match(failure.message, /dkb library recover --library/);
  for (const [name, args] of [['search', { query: 'RECOVERY-MARKER' }], ['fetch', { id: evidenceId }]]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /dkb library recover --library/);
  }
  const rejected = (await listQueryAudit(fixture.runtimeRoot)).slice(0, 3);
  assert.deepEqual(new Set(rejected.map((event) => event.channel)), new Set(['runtime-http', 'mcp']));
  assert.ok(rejected.every((event) => event.admission === 'rejected_before_admission' && event.outcome === 'failed' && event.candidates.length === 0));
  await stopChild(child);
  await recoverLibraryMutation(fixture.libraryRoot);
});

if (process.env.DKB_RUNTIME_QUERY_TIMING === '1') test('synthetic lexical warm query timing (current implementation only)', async (t) => {
  const fixture = await createQueryFixture(t);
  for (let index = 0; index < 5; index += 1) await search(fixture);
  const samples = [];
  for (let index = 0; index < 20; index += 1) {
    const start = performance.now();
    assert.equal((await search(fixture)).results.length, 1);
    samples.push(performance.now() - start);
  }
  samples.sort((left, right) => left - right);
  t.diagnostic(JSON.stringify({
    scope: 'one synthetic lexical record; full audited warm Runtime search; current implementation only',
    warmups: 5, samples: samples.length, medianMs: (samples[9] + samples[10]) / 2,
    p95Ms: samples[18], minMs: samples[0], maxMs: samples[19],
    comparison: 'no comparable pre-change baseline; not a whole RAG benchmark or release performance gate',
  }));
});


async function createCollectionFixture(t) {
  const fixture = await createRoot(t);
  const { libraryRoot, runtimeRoot } = fixture;
  const keyPairs = { publisher: generateSigningKeyPair(), registry: generateSigningKeyPair() };
  const alpha = await signedDownloadFixture(t, { packageId: '@test/alpha', keyPairs });
  const beta = await signedDownloadFixture(t, { packageId: '@test/beta', keyPairs });
  await writeJson(path.join(libraryRoot, 'dkb.json'), {
    type: 'library', name: 'Recovery Library', roots: {},
  });
  const first = collectionSnapshot('@test/collection', 1, [alpha]);
  await installRegistryCollection({ libraryRoot, collectionId: first.collectionId,
    client: collectionClient({ revision: first, keys: alpha.keys, fixtures: [alpha] }) });
  const layers = path.join(fixture.root, 'beta-layers');
  await fs.mkdir(layers);
  for (const [kind, extension] of [['source', 'dkbpkg'], ['evidence', 'dkbevidence'], ['retrieval', 'dkbbuild']]) {
    await fs.writeFile(path.join(layers, `${kind}.${extension}`), beta.bytes[kind]);
  }
  await installDkbPlanIntoLibrary({ libraryRoot, plan: beta.plan, trustedKeys: beta.keys, layerRoot: layers, registryUrl: 'https://registry.example.test' });
  const clientInput = { revision: collectionSnapshot('@test/collection', 2, [beta]), keys: beta.keys, fixtures: [{ plan: beta.plan }] };
  await writeJson(path.join(fixture.root, 'collection-client.json'), clientInput);
  fixture.client = collectionClient(clientInput);
  await initializeRuntimeBinding(runtimeRoot, { runtimeId: 'recovery', libraryRoot, target: 'fixture' });
  return fixture;
}


async function startMutationChild(fixture, mode) {
  const source = `
import {withLibraryMutation} from '@sjshovan/dkb-library/mutation.js';
import {importCompiledDkbArtifactIntoLibraryWithinMutation} from '@sjshovan/dkb-runtime/runtime/state.js';
import {installRegistryCollection} from '@sjshovan/dkb-runtime/runtime/collections.js';
import fs from 'node:fs/promises';
import {collectionClient} from './tests/fixtures/collection-download.mjs';
const [libraryRoot,mode]=process.argv.slice(1);
await withLibraryMutation(libraryRoot,async()=>{
 if(mode==='package-replace') await importCompiledDkbArtifactIntoLibraryWithinMutation({sourcePath:libraryRoot+'/knowledge',force:true},libraryRoot);
 if(mode==='collection-update') await installRegistryCollection({libraryRoot,collectionId:'@test/collection',update:true,client:collectionClient(JSON.parse(await fs.readFile(libraryRoot+'/../collection-client.json','utf8')))});
 process.send({phase:'pending'});
 setInterval(()=>{},1000);
 await new Promise(()=>{});
});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, fixture.libraryRoot, mode], {
    cwd: process.cwd(), env: process.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
  });
  fixture.children.push(child);
  child.closed = once(child, 'close');
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Mutation child did not reach barrier: ${stderr}`)), 15_000);
    child.once('message', (message) => { clearTimeout(timer); assert.equal(message.phase, 'pending'); resolve(); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Mutation child exited ${code}: ${stderr}`)); });
  });
  return child;
}

async function stopChild(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await child.closed;
}

function search(fixture) { return searchRuntime({ stateRoot: fixture.runtimeRoot, runtime, query: 'RECOVERY-MARKER' }); }
async function metadataBytes(root) {
  return Promise.all(['dkb.json', 'dkb-lock.json'].map((name) => fs.readFile(path.join(root, name))));
}
async function exists(target) { return fs.stat(target).then(() => true, () => false); }
