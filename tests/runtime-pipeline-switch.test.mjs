import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AsyncResource } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { compileComposeProject, ensurePackageBuildForTarget } from '@sjshovan/dkb-compiler/compile.js';
import { listPackageBuilds } from '@sjshovan/dkb-library/builds.js';
import { applyLibraryLock } from '@sjshovan/dkb-library/state.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DKB_RUNTIME_ACTIVATION_PATH, DKB_RUNTIME_BINDING_PATH } from '@sjshovan/dkb-protocol/paths.js';
import { ensureRuntimeState } from '../services/runtime/dist/runtime/state.js';
import { runtimePublicStatus, runtimeStatus } from '../services/runtime/dist/runtime/libraryState.js';
import { switchRuntimePipelineFromRegistry } from '../services/runtime/dist/runtime/pipelineSwitch.js';
import { getOrOpenRuntimeQueryContext, closeRuntimeQuerySnapshot } from '../services/runtime/dist/runtime/querySnapshot.js';
import { retrieveFromRuntime } from '../services/runtime/dist/runtime/retrieval.js';
import { describeRuntimeTargets, readRuntime, searchRuntime } from '../services/runtime/dist/runtime/queryAccess.js';
import { runAuditedRuntimeOperation } from '../services/runtime/dist/runtime/queryOperation.js';
import { createDkbReadOnlyMcpServer } from '../services/runtime/dist/mcp/readOnly.js';
import { listQueryAudit, queryAuditDatabasePath } from '../services/runtime/dist/runtime/queryAudit.js';
import { serveDkbRuntime } from '../services/runtime/dist/runtime/server.js';
import { DEFAULT_DKB_RUNTIME_CONTEXT } from '../services/runtime/dist/defaultComposition.js';
import { DKB_RUNTIME_SELECTION_TRANSACTION, promoteRuntimeSelection } from '../services/runtime/dist/runtime/activation.js';
import { withRuntimeMutation } from '../services/runtime/dist/runtime/mutation.js';
import { DkbProviderHost } from '@sjshovan/dkb-pipeline/host.js';
import { generateSigningKeyPair } from '@sjshovan/dkb-library/signing.js';
import { pinRegistryTrustedKeys, readPinnedRegistryKeys } from '../services/runtime/dist/runtime/registryTrust.js';
import { verifyRetainedRegistryBuild } from '@sjshovan/dkb-runtime/runtime/registryInstall.js';
import { signRuntimeFixture } from './runtime-trust-fixture.mjs';
import { verifyRuntimeIndex } from '../services/runtime/dist/providers/runtimeIndex.js';
import { refreshRuntimeActivation } from '../services/runtime/dist/runtime/pipelineSwitch.js';
import { removeDkbFromLibrary } from '../services/runtime/dist/runtime/packageLifecycle.js';
import { withDkbFileLock } from '@sjshovan/dkb-library/locks.js';
import { runtimePipelineCatalog } from '../services/runtime/dist/runtime/pipelineCatalog.js';
import { verifyInstalledBuildTrust } from '../services/runtime/dist/runtime/buildTrust.js';
import { createDkbPackageArchive } from '@sjshovan/dkb-library/archive.js';
import { DkbRegistryClient } from '@sjshovan/dkb-registry-client/client.js';
import * as tar from 'tar';

const LOCAL_TEST_DISTRIBUTION = {
  id: '@test/runtime-fixture', version: '1.0.0',
  defaults: { format: 'dkb.config.v2' }, plugins: [], services: [],
};

test('publishing a compiled editable DKB uploads source only while install archives retain builds', async (t) => {
  const fixture = await createWarmRuntimeFixture(t);
  await fs.writeFile(path.join(fixture.packageRoot, '.env'), 'PASSWORD=must-not-upload');
  await fs.writeFile(path.join(fixture.packageRoot, '.dkb-package.json'), JSON.stringify({ receipt: 'local-receipt' }));
  await fs.writeFile(path.join(fixture.packageRoot, 'dkb-lock.json'), '{}');
  await fs.mkdir(path.join(fixture.packageRoot, 'node_modules', 'private'), { recursive: true });
  await fs.writeFile(path.join(fixture.packageRoot, 'node_modules', 'private', 'index.js'), 'private dependency');
  await fs.mkdir(path.join(fixture.packageRoot, 'notes', '.DKB'), { recursive: true });
  await fs.writeFile(path.join(fixture.packageRoot, 'notes', '.DKB', 'private.json'), '{}');
  const archivePath = path.join(fixture.root, 'published-source.dkbpkg');
  const client = new DkbRegistryClient({ baseUrl: 'http://127.0.0.1:1', token: 'test' });
  client.ensurePackage = async () => {};
  client.request = async (method, route, form) => {
    assert.equal(method, 'POST'); assert.match(route, /\/versions$/);
    await fs.writeFile(archivePath, Buffer.from(await form.get('source').arrayBuffer()));
    return { data: { packageId: fixture.packageId, version: '1.0.0', status: 'published' } };
  };
  const sourceBefore = await fs.readFile(path.join(fixture.packageRoot, 'knowledge.md'));
  await client.publish({ sourcePath: fixture.packageRoot, pipeline: 'fast' });
  const names = [];
  await tar.t({ file: archivePath, onentry: (entry) => names.push(entry.path.replace(/^\.\//, '')) });
  assert.ok(names.includes('dkb.json')); assert.ok(names.includes('knowledge.md'));
  assert.equal(names.some((name) => /(?:^|\/)(?:\.dkb|node_modules|\.env|\.dkb-package\.json|dkb-lock\.json)(?:\/|$)/iu.test(name)), false, names.join('\n'));
  const installPath = path.join(fixture.root, 'install.dkbpkg');
  await createDkbPackageArchive(fixture.packageRoot, installPath);
  const installed = [];
  await tar.t({ file: installPath, onentry: (entry) => installed.push(entry.path.replace(/^\.\//, '')) });
  assert.ok(installed.some((name) => name.startsWith('.dkb/builds/evidence/')));
  assert.ok(installed.some((name) => name.startsWith('.dkb/builds/retrieval/')));
  assert.equal(installed.some((name) => name.startsWith('.dkb/plugins/') || name === '.dkb/config.json'), false);
  assert.deepEqual(await fs.readFile(path.join(fixture.packageRoot, 'knowledge.md')), sourceBefore);
});

test('per-build verification distinguishes exact local bytes from a Registry-signed chain', async (t) => {
  const fixture = await createWarmRuntimeFixture(t);
  const builds = await listPackageBuilds(fixture.packageRoot);
  const verify = (buildDigest) => verifyInstalledBuildTrust({ libraryRoot: fixture.libraryRoot, identity: fixture.packageId, buildDigest });
  assert.equal((await verify(builds.retrieval[0].buildDigest)).status, 'local-verified');
  assert.equal((await verify(builds.evidence[0].evidenceDigest)).status, 'local-verified');
  await assert.rejects(verify('sha256:../../outside'), /exact sha256/);
  await assert.rejects(verify(`sha256:${'f'.repeat(64)}`), /exact build/);
  const signed = await signRuntimeFixture(fixture);
  for (const digest of [builds.retrieval[0].buildDigest, builds.evidence[0].evidenceDigest]) assert.equal((await verify(digest)).status, 'registry-verified');
  await fs.rm(signed.trustPath);
  const missingKeys = await verify(builds.retrieval[0].buildDigest);
  assert.equal(missingKeys.status, 'failed');
  assert.match(missingKeys.message, /trust|key|receipt/i);
});

test('per-build verification does not certify a corrupt stored artifact', async (t) => {
  const fixture = await createWarmRuntimeFixture(t);
  const builds = await listPackageBuilds(fixture.packageRoot);
  const selected = builds.retrieval[0];
  await fs.appendFile(path.join(selected.path, 'artifacts', 'test-index.json'), '\nchanged');
  const result = await verifyInstalledBuildTrust({ libraryRoot: fixture.libraryRoot, identity: fixture.packageId, buildDigest: selected.buildDigest });
  assert.equal(result.status, 'failed');
  assert.match(result.message, /artifact|mismatch/i);
});

test('Pipeline catalog distinguishes compatible local artifacts from missing Registry trust', async (t) => {
  const fixture = await createWarmRuntimeFixture(t);
  const inspect = async () => (await runtimePipelineCatalog({
    distribution: LOCAL_TEST_DISTRIBUTION, root: fixture.runtimeRoot,
    libraryRoot: fixture.libraryRoot, activeTarget: 'fast',
  })).targets.find((target) => target.name === 'fast');
  const local = await inspect();
  assert.equal(local.coverage.compatible, 1);
  assert.equal(local.coverage.ready, 1);
  assert.equal(local.coverage.packages[0].trust, 'local');
  const lock = libraryLock(fixture.packageId, 2);
  lock.entries[fixture.packageId].source = 'registry';
  lock.entries[fixture.packageId].registryUrl = 'https://untrusted-registry.example.test';
  await applyLibraryLock(fixture.libraryRoot, lock);
  const untrusted = await inspect();
  assert.equal(untrusted.coverage.compatible, 1);
  assert.equal(untrusted.coverage.ready, 0);
  assert.equal(untrusted.buildsReady, false);
  assert.equal(untrusted.coverage.packages[0].trust, 'unverified');
  assert.match(untrusted.coverage.packages[0].detail, /trust|receipt|key/i);
});

test('Pipeline catalog verifies retained Registry signatures offline and rejects tampered receipts', async (t) => {
  const fixture = await signRuntimeFixture(await createWarmRuntimeFixture(t));
  const inspect = async () => (await runtimePipelineCatalog({
    distribution: LOCAL_TEST_DISTRIBUTION, root: fixture.runtimeRoot,
    libraryRoot: fixture.libraryRoot, activeTarget: 'fast',
  })).targets.find((target) => target.name === 'fast');
  const signed = await inspect();
  assert.equal(signed.coverage.compatible, 1);
  assert.equal(signed.coverage.ready, 1);
  assert.equal(signed.coverage.packages[0].trust, 'registry-signed');
  const receipt = JSON.parse(await fs.readFile(fixture.sourcePath, 'utf8'));
  receipt.registry.signature = 'tampered';
  receipt.payload.packageTreeHash = `sha256:${'0'.repeat(64)}`;
  await fs.writeFile(fixture.sourcePath, JSON.stringify(receipt));
  const tampered = await inspect();
  assert.equal(tampered.coverage.compatible, 1);
  assert.equal(tampered.coverage.ready, 0);
  assert.equal(tampered.buildsReady, false);
  assert.equal(tampered.coverage.packages[0].trust, 'unverified');
  assert.match(tampered.coverage.packages[0].detail, /trust|signature|receipt|digest/i);
});

test('two Runtimes share one Library while keeping independent Pipeline activation and rollback', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-shared-library-runtimes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const libraryRoot = path.join(root, 'library');
  const packageRoot = path.join(libraryRoot, 'knowledge');
  const fastRuntimeRoot = path.join(root, 'runtime-fast');
  const teiRuntimeRoot = path.join(root, 'runtime-tei');
  const packageId = '@test/runtime-switch';

  await writeJson(path.join(libraryRoot, 'dkb.json'), {
    type: 'library', name: 'Shared Runtime Library', roots: { [packageId]: { path: 'knowledge' } },
  });
  await writeJson(path.join(packageRoot, 'dkb.json'), {
    manifestVersion: 1, type: 'dkb', name: packageId, version: '1.0.0', permissions: { read: true, write: false },
  });
  await fs.writeFile(path.join(packageRoot, 'knowledge.md'), 'The retained build marker is PIPELINE-SWITCH-42.\n', 'utf8');
  await writePipelinePlugins(libraryRoot);

  await compileComposeProject(packageRoot, { force: true, target: 'fast', contextRoot: libraryRoot });
  const teiPreparation = await ensurePackageBuildForTarget(packageRoot, { target: 'tei', contextRoot: libraryRoot });
  assert.equal(teiPreparation.preparation, 'retrieval_compiled');
  await applyLibraryLock(libraryRoot, libraryLock(packageId, 1));
  await Promise.all([
    ensureRuntimeState(fastRuntimeRoot, { runtimeId: 'fast-runtime', libraryRoot, target: 'fast' }),
    ensureRuntimeState(teiRuntimeRoot, { runtimeId: 'tei-runtime', libraryRoot, target: 'tei' }),
  ]);

  const fast = await switchRuntimePipelineFromRegistry({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: fastRuntimeRoot, target: 'fast' });
  const tei = await switchRuntimePipelineFromRegistry({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: teiRuntimeRoot, target: 'tei' });
  const fastState = await ensureRuntimeState(fastRuntimeRoot);
  const teiState = await ensureRuntimeState(teiRuntimeRoot);

  assert.equal(fast.target, 'fast');
  assert.equal(tei.target, 'tei');
  assert.equal(fastState.libraryRoot, teiState.libraryRoot);
  assert.equal(fast.evidenceProfileDigest, tei.evidenceProfileDigest);
  assert.equal(fastState.activation.packages[packageId].evidenceDigest, teiState.activation.packages[packageId].evidenceDigest);
  assert.notEqual(fast.compatibilityDigest, tei.compatibilityDigest);
  assert.notEqual(fastState.activation.packages[packageId].retrievalBuildDigest, teiState.activation.packages[packageId].retrievalBuildDigest);
  assert.equal(JSON.stringify(fastState.activation).includes(libraryRoot), false);
  await assert.rejects(fs.access(path.join(libraryRoot, ...DKB_RUNTIME_ACTIVATION_PATH.split('/'))));

  const cliSearch = await searchRuntime({
    stateRoot: fastRuntimeRoot,
    runtime: DEFAULT_DKB_RUNTIME_CONTEXT,
    query: 'PIPELINE-SWITCH-42',
    limit: 2,
    channel: 'cli',
  });
  const evidenceId = cliSearch.results[0].evidenceId;
  assert.ok(evidenceId);
  assert.equal(cliSearch.results[0].evidenceId, evidenceId);
  const cliTargets = await describeRuntimeTargets({
    stateRoot: fastRuntimeRoot,
    runtime: DEFAULT_DKB_RUNTIME_CONTEXT,
    query: 'PIPELINE-SWITCH-42',
    limit: 2,
    channel: 'cli',
  });
  assert.equal(cliTargets.targets[0].sourceId, evidenceId);
  const cliRead = await readRuntime({
    stateRoot: fastRuntimeRoot,
    runtime: DEFAULT_DKB_RUNTIME_CONTEXT,
    request: { queries: [{ id: 'cli-fetch', target: evidenceId, operation: 'fetch' }] },
    channel: 'cli',
  });
  assert.equal(cliRead.queries[0].evidence[0].source.evidenceId, evidenceId);

  const httpServer = await serveDkbRuntime({
    host: '127.0.0.1',
    port: 0,
    adminToken: 'pipeline-http-admin',
    stateRoot: fastRuntimeRoot,
    runtime: DEFAULT_DKB_RUNTIME_CONTEXT,
  });
  const address = httpServer.address();
  assert.equal(typeof address, 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  let httpSearch;
  let httpTargets;
  let httpRetrieved;
  let httpRead;
  try {
    httpSearch = await postRuntimeJson(origin, '/api/search', { query: 'PIPELINE-SWITCH-42', limit: 2 });
    httpTargets = await postRuntimeJson(origin, '/api/read-targets', { query: 'PIPELINE-SWITCH-42', limit: 2 });
    httpRetrieved = await postRuntimeJson(origin, '/api/retrieve', { need: 'PIPELINE-SWITCH-42', intent: 'evidence', limit: 2 });
    httpRead = await postRuntimeJson(origin, '/api/read', { queries: [{ id: 'http-fetch', target: evidenceId, operation: 'fetch' }] });
  } finally {
    await closeServer(httpServer);
  }
  assert.equal(httpSearch.results[0].evidenceId, evidenceId);
  assert.equal(httpTargets.targets[0].sourceId, evidenceId);
  assert.equal(httpRetrieved.evidence[0].source.evidenceId, evidenceId);
  assert.equal(httpRead.queries[0].evidence[0].source.evidenceId, evidenceId);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpServer = createDkbReadOnlyMcpServer({
    runtime: DEFAULT_DKB_RUNTIME_CONTEXT,
    stateRoot: fastRuntimeRoot,
    publicBaseUrl: 'https://knowledge.example',
  });
  const mcpClient = new Client({ name: 'runtime-audit-proof', version: '1.0.0' });
  await mcpServer.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  let mcpSearch;
  let mcpFetch;
  try {
    mcpSearch = await mcpClient.callTool({ name: 'search', arguments: { query: 'PIPELINE-SWITCH-42', limit: 2 } });
    mcpFetch = await mcpClient.callTool({ name: 'fetch', arguments: { id: evidenceId } });
  } finally {
    await mcpClient.close();
    await mcpServer.close();
  }
  assert.equal(mcpSearch.structuredContent.results[0].evidenceId, evidenceId);
  assert.equal(mcpFetch.structuredContent.citation.id, evidenceId);

  const audit = await listQueryAudit(fastRuntimeRoot, 20);
  assert.equal(audit.length, 9);
  for (const event of audit) {
    assert.equal(event.runtime.id, 'fast-runtime');
    assert.equal(event.library.id, fastState.activation.library.id);
    assert.equal(event.library.stateDigest, fastState.activation.library.stateDigest);
    assert.equal(event.pipeline.target, 'fast');
    assert.equal(event.pipeline.evidenceProfileDigest, fastState.activation.evidenceProfileDigest);
    assert.equal(event.pipeline.retrievalProfileDigest, fastState.activation.retrievalProfileDigest);
    assert.equal(event.pipeline.compatibilityDigest, fastState.activation.compatibilityDigest);
    assert.deepEqual(event.packages, [{
      id: packageId,
      version: '1.0.0',
      evidenceDigest: fastState.activation.packages[packageId].evidenceDigest,
      retrievalBuildDigest: fastState.activation.packages[packageId].retrievalBuildDigest,
    }]);
    assert.equal(event.outcome, 'success');
  }
  const searchEvents = audit.filter((event) => event.intent === 'search');
  assert.deepEqual(searchEvents.map((event) => event.channel).sort(), ['cli', 'mcp', 'runtime-http']);
  assert.equal(searchEvents.length, 3);
  assert.deepEqual(searchEvents.map(auditChain), [auditChain(searchEvents[0]), auditChain(searchEvents[0]), auditChain(searchEvents[0])]);
  assert.deepEqual(searchEvents[0].candidates, [{
    packageId,
    packageVersion: '1.0.0',
    evidenceDigest: fastState.activation.packages[packageId].evidenceDigest,
    retrievalBuildDigest: fastState.activation.packages[packageId].retrievalBuildDigest,
    evidenceId,
    score: 0.99,
    channels: ['lexical'],
  }]);

  const navigationEvents = audit.filter((event) => event.intent === 'read-targets');
  assert.deepEqual(navigationEvents.map((event) => event.channel).sort(), ['cli', 'runtime-http']);
  assert.deepEqual(navigationEvents.map((event) => event.candidates), [searchEvents[0].candidates, searchEvents[0].candidates]);
  const retrieveEvent = audit.find((event) => event.channel === 'runtime-http' && event.intent === 'evidence');
  assert.deepEqual(retrieveEvent.candidates, searchEvents[0].candidates);

  const directReadEvents = audit.filter((event) => event.intent === 'read' || event.intent === 'fetch');
  assert.equal(directReadEvents.length, 3);
  for (const event of directReadEvents) {
    assert.equal(event.candidates.length, 1);
    assert.equal(event.candidates[0].score, null);
    assert.deepEqual(event.candidates[0].channels, []);
  }
  assert.equal(audit.filter((event) => event.channel === 'runtime-http').every((event) => Boolean(event.client.id)), true);
  const observerEvents = JSON.parse(await fs.readFile(path.join(fastRuntimeRoot, '.dkb', 'observer-events.json'), 'utf8'));
  assert.equal(observerEvents.length, 9);
  assert.equal(observerEvents.every((event) => event.frozen && event.auditPersisted && event.mutationBlocked), true);
  const observerHealth = (await runtimeStatus(fastRuntimeRoot)).observerHealth;
  assert.equal(observerHealth.status, 'available');
  assert.deepEqual(observerHealth.entries.map((entry) => ({
    id: entry.id,
    status: entry.status,
    successCount: entry.successCount,
    failureCount: entry.failureCount,
  })), [
    { id: '@test/core', status: 'healthy', successCount: 9, failureCount: 0 },
    { id: '@test/failing-observer', status: 'degraded', successCount: 0, failureCount: 9 },
  ]);
  const publicObserverHealth = (await runtimePublicStatus(fastRuntimeRoot)).observerHealth;
  assert.equal(publicObserverHealth.entries.some((entry) => Object.hasOwn(entry, 'detail')), false);

  await assert.rejects(
    runAuditedRuntimeOperation({
      stateRoot: fastRuntimeRoot,
      runtime: DEFAULT_DKB_RUNTIME_CONTEXT,
      channel: 'cli',
      query: 'invalid candidate',
      intent: 'search',
      requestId: 'invalid-candidate',
      async operation() {
        return {
          value: null,
          requestId: 'invalid-candidate',
          status: 'ready',
          outcome: 'success',
          candidates: [{
            packageId: '@test/not-activated',
            packageVersion: '1.0.0',
            evidenceId: 'invalid',
            score: null,
            channels: [],
          }],
        };
      },
    }),
    /outside its validated activation/i,
  );
  const invalidAudit = (await listQueryAudit(fastRuntimeRoot, 1))[0];
  assert.equal(invalidAudit.outcome, 'failed');
  assert.equal(invalidAudit.error.code, 'runtime_candidate_invalid');

  const teiActivationBefore = await activationBytes(teiRuntimeRoot);
  await switchRuntimePipelineFromRegistry({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: fastRuntimeRoot, target: 'tei' });
  assert.deepEqual(await activationBytes(teiRuntimeRoot), teiActivationBefore);
  assert.equal((await runtimeStatus(teiRuntimeRoot)).target, 'tei');

  const builds = await listPackageBuilds(packageRoot);
  assert.equal(builds.evidence.length, 1);
  assert.equal(builds.retrieval.length, 2);
  const teiBuild = builds.retrieval.find((item) => item.profileDigest === teiPreparation.retrievalProfileDigest);
  assert.ok(teiBuild);
  await fs.appendFile(path.join(teiBuild.path, 'artifacts', 'test-index.json'), '\ncorrupt\n', 'utf8');
  await switchRuntimePipelineFromRegistry({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: fastRuntimeRoot, target: 'fast' });
  const fastActivationBefore = await activationBytes(fastRuntimeRoot);
  await assert.rejects(
    switchRuntimePipelineFromRegistry({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: fastRuntimeRoot, target: 'tei' }),
    /artifact tree mismatch/i,
  );
  assert.deepEqual(await activationBytes(fastRuntimeRoot), fastActivationBefore);

  await applyLibraryLock(libraryRoot, libraryLock(packageId, 2));
  assert.equal((await runtimeStatus(fastRuntimeRoot)).stale, true);
  assert.equal((await runtimeStatus(teiRuntimeRoot)).stale, true);
  await assert.rejects(
    getOrOpenRuntimeQueryContext(await ensureRuntimeState(fastRuntimeRoot), 'Shared Runtime Library', DEFAULT_DKB_RUNTIME_CONTEXT),
    /Runtime fast-runtime is stale/i,
  );
  await assert.rejects(
    retrieveFromRuntime({ need: 'PIPELINE-SWITCH-42' }, fastRuntimeRoot, DEFAULT_DKB_RUNTIME_CONTEXT),
    /Runtime fast-runtime is stale/i,
  );
  const failedAudit = (await listQueryAudit(fastRuntimeRoot, 10))[0];
  assert.equal(failedAudit.outcome, 'failed');
  assert.equal(failedAudit.error.code, 'runtime_refresh_required');
});

test('Runtime rejects a retrieval provider hit outside the requested DKB scope', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-runtime-retrieval-scope-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const libraryRoot = path.join(root, 'library');
  const runtimeRoot = path.join(root, 'runtime');
  const packageA = '@test/scope-a';
  const packageB = '@test/scope-b';
  const packages = [
    { id: packageA, relativePath: 'scope-a', marker: 'SCOPE-A-ONLY' },
    { id: packageB, relativePath: 'scope-b', marker: 'SCOPE-B-ONLY' },
  ];

  await writeJson(path.join(libraryRoot, 'dkb.json'), {
    type: 'library',
    name: 'Retrieval Scope Library',
    roots: Object.fromEntries(packages.map((item) => [item.id, { path: item.relativePath }])),
  });
  for (const item of packages) {
    const packageRoot = path.join(libraryRoot, item.relativePath);
    await writeJson(path.join(packageRoot, 'dkb.json'), {
      manifestVersion: 1,
      type: 'dkb',
      name: item.id,
      version: '1.0.0',
      permissions: { read: true, write: false },
    });
    await fs.writeFile(path.join(packageRoot, 'knowledge.md'), `${item.marker}\n`, 'utf8');
  }
  await writeScopeLeakPipelinePlugins(libraryRoot);
  for (const item of packages) {
    await compileComposeProject(path.join(libraryRoot, item.relativePath), {
      force: true,
      target: 'scoped',
      contextRoot: libraryRoot,
    });
  }
  await applyLibraryLock(libraryRoot, {
    library: { name: 'Retrieval Scope Library' },
    generation: 1,
    entries: Object.fromEntries(packages.map((item) => [item.id, {
      identity: item.id,
      kind: 'dkb',
      source: 'local',
      version: '1.0.0',
      digest: stableHash({ package: item.id, version: '1.0.0' }),
      path: item.relativePath,
      requiredBy: [`root:${item.id}`],
      installedAt: '2026-08-28T00:00:00.000Z',
    }])),
    resolvedAt: '2026-08-28T00:00:00.000Z',
  });
  await ensureRuntimeState(runtimeRoot, {
    runtimeId: 'retrieval-scope-runtime',
    libraryRoot,
    target: 'scoped',
  });
  await switchRuntimePipelineFromRegistry({
    runtime: DEFAULT_DKB_RUNTIME_CONTEXT,
    stateRoot: runtimeRoot,
    target: 'scoped',
  });

  await assert.rejects(
    searchRuntime({
      stateRoot: runtimeRoot,
      runtime: DEFAULT_DKB_RUNTIME_CONTEXT,
      query: 'SCOPE-A-ONLY',
      limit: 5,
      scope: { dkbId: packageA },
      channel: 'cli',
    }),
    /outside the requested Evidence scope/u,
  );
});

test('warm Runtime queries reject changed provider configuration, plugin code, and build bytes', async (t) => {
  const changes = {
    async configuration({ libraryRoot }) {
      const filename = path.join(libraryRoot, '.dkb', 'config.json');
      const config = JSON.parse(await fs.readFile(filename, 'utf8'));
      config.targets.fast.embedding = '@test/tei';
      await writeJson(filename, config);
    },
    async plugin({ libraryRoot }) {
      await fs.appendFile(path.join(libraryRoot, '.dkb', 'plugins', '@test', 'fast', 'plugin.mjs'), '\n// changed loaded implementation\n');
    },
    async retrieval({ packageRoot }) {
      const builds = await listPackageBuilds(packageRoot);
      await fs.appendFile(path.join(builds.retrieval[0].path, 'artifacts', 'test-index.json'), '\n ');
    },
    async evidence({ packageRoot }) {
      const builds = await listPackageBuilds(packageRoot);
      const filename = path.join(builds.evidence[0].path, 'evidence.ir.json');
      const source = await fs.readFile(filename, 'utf8');
      assert.ok(source.includes('PIPELINE-SWITCH-42'));
      await fs.writeFile(filename, source.replaceAll('PIPELINE-SWITCH-42', 'PIPELINE-BROKEN-00'), 'utf8');
    },
    async catalog({ packageRoot }) {
      await alterEvidenceCatalog(packageRoot);
    },
  };

  for (const [kind, change] of Object.entries(changes)) {
    await t.test(kind, async (subtest) => {
      const fixture = await createWarmRuntimeFixture(subtest);
      const before = await activationBytes(fixture.runtimeRoot);
      await change(fixture);
      await assert.rejects(searchRuntime({
        stateRoot: fixture.runtimeRoot,
        runtime: DEFAULT_DKB_RUNTIME_CONTEXT,
        query: 'PIPELINE-SWITCH-42',
      }), /changed|drift|mismatch|invalid|refresh|integrity/i);
      assert.deepEqual(await activationBytes(fixture.runtimeRoot), before);
      const audit = await listQueryAudit(fixture.runtimeRoot, 2);
      assert.equal(audit[0].outcome, 'failed');
      assert.equal(audit[0].candidates.length, 0);
    });
  }
});

test('cold Runtime queries reject catalog text not present in canonical Evidence IR', async (t) => {
  const fixture = await createWarmRuntimeFixture(t);
  await closeRuntimeQuerySnapshot(fixture.runtimeRoot);
  await alterEvidenceCatalog(fixture.packageRoot);
  await assert.rejects(searchRuntime({
    stateRoot: fixture.runtimeRoot, runtime: DEFAULT_DKB_RUNTIME_CONTEXT, query: 'PIPELINE-SWITCH-42',
  }), /catalog|canonical|mismatch/i);
  assert.equal((await listQueryAudit(fixture.runtimeRoot, 1))[0].outcome, 'failed');
});

test('Runtime discards a response when another Runtime changes Library state during retrieval', async (t) => {
  const fixture = await createWarmRuntimeFixture(t);
  await assert.rejects(runAuditedRuntimeOperation({
    stateRoot: fixture.runtimeRoot, runtime: DEFAULT_DKB_RUNTIME_CONTEXT, channel: 'cli',
    query: 'PIPELINE-SWITCH-42', intent: 'concurrent-state-regression', requestId: 'state-drift',
    async operation() {
      await applyLibraryLock(fixture.libraryRoot, libraryLock('@test/runtime-switch', 2));
      return { value: 'must not escape', requestId: 'state-drift', status: 'ok', outcome: 'success' };
    },
  }), /stale|changed/i);
  const event = (await listQueryAudit(fixture.runtimeRoot, 1))[0];
  assert.equal(event.outcome, 'failed');
  assert.equal(event.candidates.length, 0);
});

test('queued Runtime queries read activation after the pending mutation completes', async (t) => {
  const fixture = await createWarmRuntimeFixture(t);
  let release;
  const ready = Promise.withResolvers();
  const wait = new Promise((resolve) => { release = resolve; });
  const writer = withRuntimeMutation(fixture.runtimeRoot, async () => {
    ready.resolve();
    await wait;
    const instance = await ensureRuntimeState(fixture.runtimeRoot);
    await promoteRuntimeSelection(fixture.runtimeRoot, instance.binding, { ...instance.activation, generation: 2 });
  });
  await ready.promise;
  const query = searchRuntime({ stateRoot: fixture.runtimeRoot, runtime: DEFAULT_DKB_RUNTIME_CONTEXT, query: 'PIPELINE-SWITCH-42' });
  try { await assertStillPending(query); } finally { release(); }
  await writer;
  const result = await query;
  assert.ok(result.results.length);
  const instance = await ensureRuntimeState(fixture.runtimeRoot);
  const event = (await listQueryAudit(fixture.runtimeRoot, 1))[0];
  assert.equal(event.runtime.activationDigest, stableHash(instance.activation));
});

test('post-commit observer drift cannot rewrite the one finalized response or historical audit chain', async (t) => {
  const fixture = await createWarmRuntimeFixture(t);
  const before = await ensureRuntimeState(fixture.runtimeRoot);
  const response = { marker: 'finalized', nested: { value: 1 } };
  const received = await runAuditedRuntimeOperation({
    stateRoot: fixture.runtimeRoot, runtime: DEFAULT_DKB_RUNTIME_CONTEXT, channel: 'cli',
    query: 'PIPELINE-SWITCH-42', intent: 'observer-state-regression', requestId: 'observer-drift',
    async operation({ context }) {
      const observe = context.providerHost.observeQuery.bind(context.providerHost);
      context.providerHost.observeQuery = async (...args) => {
        context.providerHost.observeQuery = observe;
        const persisted = (await listQueryAudit(fixture.runtimeRoot, 1))[0];
        assert.equal(persisted.requestId, 'observer-drift');
        assert.equal(persisted.outcome, 'success');
        assert.ok(Object.isFrozen(args[0]) && Object.isFrozen(args[0].data));
        assert.throws(() => { args[0].data.query = 'changed'; }, TypeError);
        response.nested.value = 9;
        await applyLibraryLock(fixture.libraryRoot, libraryLock(fixture.packageId, 2));
        return observe(...args);
      };
      return { value: response, requestId: 'observer-drift', status: 'ok', outcome: 'success' };
    },
  });
  assert.deepEqual(received, { marker: 'finalized', nested: { value: 1 } });
  assert.ok(Object.isFrozen(received.nested));
  const events = (await listQueryAudit(fixture.runtimeRoot, 10)).filter((event) => event.requestId === 'observer-drift');
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, 'success');
  assert.equal(events[0].admission, 'admitted');
  assert.deepEqual(events[0].library, before.activation.library);
  await assert.rejects(() => searchRuntime({ stateRoot: fixture.runtimeRoot, runtime: DEFAULT_DKB_RUNTIME_CONTEXT, query: 'after-observer-drift' }), /stale|changed/i);
  const rejected = (await listQueryAudit(fixture.runtimeRoot, 1))[0];
  assert.equal(rejected.admission, 'rejected_before_admission');
  assert.equal(rejected.library, null);
});

test('every query channel audits missing, malformed, and busy pre-admission state without inventing a build graph', async (t) => {
  const fixture = await createWarmRuntimeFixture(t);
  await closeRuntimeQuerySnapshot(fixture.runtimeRoot);
  const bindingPath = path.join(fixture.runtimeRoot, DKB_RUNTIME_BINDING_PATH);
  const activationPath = path.join(fixture.runtimeRoot, DKB_RUNTIME_ACTIVATION_PATH);
  const journalPath = path.join(fixture.runtimeRoot, DKB_RUNTIME_SELECTION_TRANSACTION);
  const binding = await fs.readFile(bindingPath);
  const activation = await fs.readFile(activationPath);
  for (const [name, tamper, knownId] of [
    ['missing-binding', () => fs.rm(bindingPath), null],
    ['malformed-binding', () => fs.writeFile(bindingPath, '{bad'), null],
    ['missing-activation', () => fs.rm(activationPath), 'warm-drift'],
    ['malformed-activation', () => fs.writeFile(activationPath, '{bad'), 'warm-drift'],
    ['busy-selection', () => fs.writeFile(journalPath, 'in-progress'), 'warm-drift'],
  ]) {
    await tamper();
    for (const channel of ['cli', 'runtime-http', 'mcp']) {
      const requestId = `${name}:${channel}`;
      let ran = false;
      await assert.rejects(() => runAuditedRuntimeOperation({
        stateRoot: fixture.runtimeRoot, runtime: DEFAULT_DKB_RUNTIME_CONTEXT, channel,
        query: requestId, intent: 'search', requestId,
        async operation() { ran = true; throw new Error('Unadmitted operation must not run'); },
      }));
      assert.equal(ran, false);
      const matches = (await listQueryAudit(fixture.runtimeRoot, 100)).filter((event) => event.requestId === requestId);
      assert.equal(matches.length, 1);
      const event = matches[0];
      assert.equal(event.admission, 'rejected_before_admission');
      assert.deepEqual(event.runtime, { id: knownId, activationDigest: null });
      assert.equal(event.library, null);
      assert.equal(event.pipeline, null);
      assert.deepEqual(event.packages, []);
      assert.deepEqual(event.candidates, []);
      assert.deepEqual(event.citations, []);
      assert.equal(event.resultCount, 0);
      assert.equal(event.outcome, 'failed');
    }
    await fs.writeFile(bindingPath, binding);
    await fs.writeFile(activationPath, activation);
    await fs.rm(journalPath, { force: true });
  }
});

test('callback cancellation records one terminal event and mandatory audit failure releases no success or observer event', async (t) => {
  const fixture = await createWarmRuntimeFixture(t);
  const options = { stateRoot: fixture.runtimeRoot, runtime: DEFAULT_DKB_RUNTIME_CONTEXT, channel: 'cli', query: 'cancelled', intent: 'search', requestId: 'audit-cancelled' };
  await assert.rejects(() => runAuditedRuntimeOperation({ ...options,
    client: { id: 'safe-client', authorization: 'Bearer never-record-this', token: 'never-record-this' },
    async operation() { throw new DOMException('Request cancelled', 'AbortError'); },
  }), /cancelled/i);
  const cancelled = (await listQueryAudit(fixture.runtimeRoot, 1))[0];
  assert.equal(cancelled.outcome, 'cancelled');
  assert.equal(cancelled.admission, 'admitted');
  assert.deepEqual(cancelled.client, { id: 'safe-client' });
  const observersPath = path.join(fixture.runtimeRoot, '.dkb', 'observer-events.json');
  const observers = await fs.readFile(observersPath);
  const database = new DatabaseSync(path.toNamespacedPath(queryAuditDatabasePath(fixture.runtimeRoot)));
  try { database.exec("create trigger fail_audit before insert on query_audit begin select raise(abort, 'fixture audit unavailable'); end;"); } finally { database.close(); }
  await assert.rejects(() => runAuditedRuntimeOperation({ ...options, requestId: 'audit-unwritable',
    async operation() { return { value: 'must not be released', requestId: 'audit-unwritable', outcome: 'success', status: 'ready' }; },
  }), (error) => error.code === 'runtime_audit_failed' && /no response was released/u.test(error.message));
  assert.equal((await listQueryAudit(fixture.runtimeRoot, 100)).some((event) => event.requestId === 'audit-unwritable'), false);
  assert.deepEqual(await fs.readFile(observersPath), observers);
});

test('public CLI, HTTP, and MCP search paths each persist one honest pre-admission rejection', async (t) => {
  const fixture = await createWarmRuntimeFixture(t);
  const httpServer = await serveDkbRuntime({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: fixture.runtimeRoot, host: '127.0.0.1', port: 0, adminToken: 'pipeline-http-admin' });
  t.after(() => closeServer(httpServer));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpServer = createDkbReadOnlyMcpServer({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: fixture.runtimeRoot });
  const mcpClient = new Client({ name: 'rejected-audit-proof', version: '1.0.0' });
  await mcpServer.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  t.after(async () => { await mcpClient.close(); await mcpServer.close(); });
  await fs.rm(path.join(fixture.runtimeRoot, DKB_RUNTIME_ACTIVATION_PATH));
  const query = 'missing activation';
  await assert.rejects(() => searchRuntime({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: fixture.runtimeRoot, query }), /no validated activation/u);
  const response = await fetch(`http://127.0.0.1:${httpServer.address().port}/api/search`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer pipeline-http-admin' }, body: JSON.stringify({ query }) });
  assert.ok(response.status >= 400);
  await response.text();
  const mcp = await mcpClient.callTool({ name: 'search', arguments: { query } });
  assert.equal(mcp.isError, true);
  const events = (await listQueryAudit(fixture.runtimeRoot, 10)).filter((event) => event.query === query);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((event) => event.channel).sort(), ['cli', 'mcp', 'runtime-http']);
  for (const event of events) {
    assert.equal(event.admission, 'rejected_before_admission');
    assert.deepEqual(event.runtime, { id: 'warm-drift', activationDigest: null });
    assert.equal(event.library, null);
    assert.equal(event.pipeline, null);
    assert.equal(event.outcome, 'failed');
  }
});

test('state changes while opening the mandatory audit store produce one failed outcome, never success', async (t) => {
  const fixture = await createWarmRuntimeFixture(t);
  const mkdir = fs.mkdir.bind(fs);
  let mutate = false;
  t.mock.method(fs, 'mkdir', async (directory, ...args) => {
    if (mutate && path.resolve(String(directory)) === path.join(fixture.runtimeRoot, '.dkb')) {
      mutate = false;
      await applyLibraryLock(fixture.libraryRoot, libraryLock(fixture.packageId, 2));
    }
    return mkdir(directory, ...args);
  });
  await assert.rejects(() => runAuditedRuntimeOperation({
    stateRoot: fixture.runtimeRoot, runtime: DEFAULT_DKB_RUNTIME_CONTEXT, channel: 'cli',
    query: 'audit-open-drift', intent: 'search', requestId: 'audit-open-drift',
    async operation() { mutate = true; return { value: 'must not escape', requestId: 'audit-open-drift', outcome: 'success', status: 'ready' }; },
  }), /stale|changed/i);
  const events = (await listQueryAudit(fixture.runtimeRoot, 100)).filter((event) => event.requestId === 'audit-open-drift');
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, 'failed');
  assert.equal(events[0].admission, 'admitted');
});

test('status reads do not recover an in-progress Runtime selection', async (t) => {
  const fixture = await createWarmRuntimeFixture(t);
  const journal = path.join(fixture.runtimeRoot, DKB_RUNTIME_SELECTION_TRANSACTION);
  const staged = Promise.withResolvers();
  const release = Promise.withResolvers();
  const writer = withRuntimeMutation(fixture.runtimeRoot, async () => {
    await fs.writeFile(journal, 'live-promotion-marker');
    staged.resolve();
    await release.promise;
    assert.equal(await fs.readFile(journal, 'utf8'), 'live-promotion-marker');
    await fs.unlink(journal);
  });
  await staged.promise;
  const status = runtimeStatus(fixture.runtimeRoot);
  try { await assertStillPending(status); } finally { release.resolve(); }
  await writer;
  assert.equal((await status).stale, false);
});

test('a stalled query observer degrades health without blocking later validated Runtime responses', async (t) => {
  const fixture = await createWarmRuntimeFixture(t, { stalledObserver: true });
  const before = await listQueryAudit(fixture.runtimeRoot, 1);
  assert.equal(before[0].outcome, 'success');
  const result = await searchRuntime({ stateRoot: fixture.runtimeRoot, runtime: DEFAULT_DKB_RUNTIME_CONTEXT, query: 'PIPELINE-SWITCH-42' });
  assert.equal(result.results.length, 1);
  const events = await listQueryAudit(fixture.runtimeRoot, 2);
  assert.deepEqual(events.map(({ outcome }) => outcome), ['success', 'success']);
  const health = (await runtimeStatus(fixture.runtimeRoot)).observerHealth.entries.find(({ id }) => id === '@test/failing-observer');
  assert.equal(health.status, 'degraded');
  assert.equal(health.failureCount, 2);
  assert.match(health.detail, /unfinished delivery/u);
  await closeRuntimeQuerySnapshot(fixture.runtimeRoot);
});

async function assertStillPending(operation) {
  const result = await Promise.race([
    operation.then(() => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 30)),
  ]);
  assert.equal(result, 'pending');
}

async function alterEvidenceCatalog(packageRoot) {
  const builds = await listPackageBuilds(packageRoot);
  const database = new DatabaseSync(path.toNamespacedPath(path.join(builds.evidence[0].path, 'evidence.catalog.sqlite')));
  try {
    database.prepare('UPDATE evidence_records SET evidence_text = ?').run('Forged knowledge not present in the signed Evidence IR.');
  } finally {
    database.close();
  }
}

test('Runtime startup rolls back every interrupted pre-commit binding and activation promotion state', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-runtime-selection-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const libraryRoot = path.join(root, 'library');
  await writeJson(path.join(libraryRoot, 'dkb.json'), { type: 'library', name: 'Recovery Library', roots: {} });
  const digest = (value) => stableHash({ value });
  const scenarios = [
    { name: 'after staging', mutations: [] },
    { name: 'after backing up binding', mutations: ['backup-binding'] },
    { name: 'after backing up both files', mutations: ['backup-binding', 'backup-activation'] },
    { name: 'after promoting binding', mutations: ['backup-binding', 'backup-activation', 'promote-binding'] },
    { name: 'after promoting both files', mutations: ['backup-binding', 'backup-activation', 'promote-binding', 'promote-activation'] },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    await t.test(scenario.name, async () => {
      const runtimeRoot = path.join(root, `runtime-${index}`);
      await ensureRuntimeState(runtimeRoot, { runtimeId: `recovery-runtime-${index}`, libraryRoot, target: 'stable' });
      const bindingPath = path.join(runtimeRoot, ...DKB_RUNTIME_BINDING_PATH.split('/'));
      const activationPath = path.join(runtimeRoot, ...DKB_RUNTIME_ACTIVATION_PATH.split('/'));
      const stableActivation = {
        format: 'dkb.runtime-activation.v1', runtimeId: `recovery-runtime-${index}`, library: { id: 'Recovery Library', generation: 0, stateDigest: digest('state') }, target: 'stable',
        evidenceProfileDigest: digest('evidence'), retrievalProfileDigest: digest('retrieval'), compatibilityDigest: digest('compatibility'), packages: {}, generation: 1, generatedAt: new Date(0).toISOString(),
      };
      await writeJson(activationPath, stableActivation);
      const stableBinding = JSON.parse(await fs.readFile(bindingPath, 'utf8'));
      const stamp = `${process.pid}-recovery${index}-${randomUUID()}`;
      const stagedBinding = { ...stableBinding, target: 'candidate', updatedAt: new Date().toISOString() };
      const stagedActivation = { ...stableActivation, target: 'candidate', generation: 2, generatedAt: new Date().toISOString() };
      await writeJson(`${bindingPath}.stage-${stamp}`, stagedBinding);
      await writeJson(`${activationPath}.stage-${stamp}`, stagedActivation);
      await writeJson(path.join(runtimeRoot, ...DKB_RUNTIME_SELECTION_TRANSACTION.split('/')), {
        format: 'dkb.runtime-selection.transaction.v1', stamp, phase: 'staged', existed: { binding: true, activation: true },
      });
      for (const mutation of scenario.mutations) {
        if (mutation === 'backup-binding') await fs.rename(bindingPath, `${bindingPath}.replace-${stamp}`);
        if (mutation === 'backup-activation') await fs.rename(activationPath, `${activationPath}.replace-${stamp}`);
        if (mutation === 'promote-binding') await fs.rename(`${bindingPath}.stage-${stamp}`, bindingPath);
        if (mutation === 'promote-activation') await fs.rename(`${activationPath}.stage-${stamp}`, activationPath);
      }

      const recovered = await ensureRuntimeState(runtimeRoot);

      assert.deepEqual(recovered.binding, stableBinding);
      assert.deepEqual(recovered.activation, stableActivation);
      await assert.rejects(fs.access(path.join(runtimeRoot, ...DKB_RUNTIME_SELECTION_TRANSACTION.split('/'))), (error) => error?.code === 'ENOENT');
      await assert.rejects(fs.access(`${bindingPath}.replace-${stamp}`), (error) => error?.code === 'ENOENT');
      await assert.rejects(fs.access(`${activationPath}.replace-${stamp}`), (error) => error?.code === 'ENOENT');
    });
  }
});

test('Runtime startup restores a displaced transaction journal before rolling back', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-runtime-journal-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const libraryRoot = path.join(root, 'library');
  const runtimeRoot = path.join(root, 'runtime');
  await writeJson(path.join(libraryRoot, 'dkb.json'), { type: 'library', name: 'Journal Recovery Library', roots: {} });
  await ensureRuntimeState(runtimeRoot, { runtimeId: 'journal-recovery-runtime', libraryRoot, target: 'stable' });
  const bindingPath = path.join(runtimeRoot, ...DKB_RUNTIME_BINDING_PATH.split('/'));
  const activationPath = path.join(runtimeRoot, ...DKB_RUNTIME_ACTIVATION_PATH.split('/'));
  const digest = (value) => stableHash({ value });
  const stableActivation = {
    format: 'dkb.runtime-activation.v1', runtimeId: 'journal-recovery-runtime', library: { id: 'Journal Recovery Library', generation: 0, stateDigest: digest('state') }, target: 'stable',
    evidenceProfileDigest: digest('evidence'), retrievalProfileDigest: digest('retrieval'), compatibilityDigest: digest('compatibility'), packages: {}, generation: 1, generatedAt: new Date(0).toISOString(),
  };
  await writeJson(activationPath, stableActivation);
  const stableBinding = JSON.parse(await fs.readFile(bindingPath, 'utf8'));
  const stamp = `${process.pid}-journal-${randomUUID()}`;
  const journalPath = path.join(runtimeRoot, ...DKB_RUNTIME_SELECTION_TRANSACTION.split('/'));
  const journalBackupPath = `${journalPath}.replace-${process.pid}-crash`;
  await fs.rename(bindingPath, `${bindingPath}.replace-${stamp}`);
  await fs.rename(activationPath, `${activationPath}.replace-${stamp}`);
  await writeJson(`${bindingPath}.stage-${stamp}`, { ...stableBinding, target: 'candidate' });
  await writeJson(`${activationPath}.stage-${stamp}`, { ...stableActivation, target: 'candidate', generation: 2 });
  await writeJson(journalBackupPath, {
    format: 'dkb.runtime-selection.transaction.v1', stamp, phase: 'staged', existed: { binding: true, activation: true },
  });

  const recovered = await ensureRuntimeState(runtimeRoot);

  assert.deepEqual(recovered.binding, stableBinding);
  assert.deepEqual(recovered.activation, stableActivation);
  await assert.rejects(fs.access(journalPath), (error) => error?.code === 'ENOENT');
  await assert.rejects(fs.access(journalBackupPath), (error) => error?.code === 'ENOENT');
  await assert.rejects(fs.access(`${bindingPath}.replace-${stamp}`), (error) => error?.code === 'ENOENT');
  await assert.rejects(fs.access(`${activationPath}.replace-${stamp}`), (error) => error?.code === 'ENOENT');
});

test('Runtime startup finalizes a fully promoted selection only after its commit marker exists', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-runtime-committed-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const libraryRoot = path.join(root, 'library');
  const runtimeRoot = path.join(root, 'runtime');
  await writeJson(path.join(libraryRoot, 'dkb.json'), { type: 'library', name: 'Committed Recovery Library', roots: {} });
  await ensureRuntimeState(runtimeRoot, { runtimeId: 'committed-recovery-runtime', libraryRoot, target: 'stable' });
  const bindingPath = path.join(runtimeRoot, ...DKB_RUNTIME_BINDING_PATH.split('/'));
  const activationPath = path.join(runtimeRoot, ...DKB_RUNTIME_ACTIVATION_PATH.split('/'));
  const digest = (value) => stableHash({ value });
  const stableActivation = {
    format: 'dkb.runtime-activation.v1', runtimeId: 'committed-recovery-runtime', library: { id: 'Committed Recovery Library', generation: 0, stateDigest: digest('state') }, target: 'stable',
    evidenceProfileDigest: digest('evidence'), retrievalProfileDigest: digest('retrieval'), compatibilityDigest: digest('compatibility'), packages: {}, generation: 1, generatedAt: new Date(0).toISOString(),
  };
  await writeJson(activationPath, stableActivation);
  const stableBinding = JSON.parse(await fs.readFile(bindingPath, 'utf8'));
  const stamp = `${process.pid}-committed-${randomUUID()}`;
  const candidateBinding = { ...stableBinding, target: 'candidate', updatedAt: new Date().toISOString() };
  const candidateActivation = { ...stableActivation, target: 'candidate', generation: 2, generatedAt: new Date().toISOString() };
  const journalPath = path.join(runtimeRoot, ...DKB_RUNTIME_SELECTION_TRANSACTION.split('/'));
  const commitPath = `${journalPath}.commit-${stamp}`;
  await writeJson(`${bindingPath}.stage-${stamp}`, candidateBinding);
  await writeJson(`${activationPath}.stage-${stamp}`, candidateActivation);
  await writeJson(journalPath, {
    format: 'dkb.runtime-selection.transaction.v1', stamp, phase: 'staged', existed: { binding: true, activation: true },
  });
  await fs.rename(bindingPath, `${bindingPath}.replace-${stamp}`);
  await fs.rename(activationPath, `${activationPath}.replace-${stamp}`);
  await fs.rename(`${bindingPath}.stage-${stamp}`, bindingPath);
  await fs.rename(`${activationPath}.stage-${stamp}`, activationPath);
  await fs.writeFile(commitPath, '');

  const recovered = await ensureRuntimeState(runtimeRoot);

  assert.deepEqual(recovered.binding, candidateBinding);
  assert.deepEqual(recovered.activation, candidateActivation);
  await assert.rejects(fs.access(journalPath), (error) => error?.code === 'ENOENT');
  await assert.rejects(fs.access(commitPath), (error) => error?.code === 'ENOENT');
  await assert.rejects(fs.access(`${bindingPath}.replace-${stamp}`), (error) => error?.code === 'ENOENT');
  await assert.rejects(fs.access(`${activationPath}.replace-${stamp}`), (error) => error?.code === 'ENOENT');
});

test('cold Runtime admission verifies retained Registry receipts offline, including local target aliases', async (t) => {
  const fixture = await signRuntimeFixture(await createWarmRuntimeFixture(t));
  const configPath = path.join(fixture.libraryRoot, '.dkb', 'config.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  config.targets['local-alias'] = config.targets.fast;
  await writeJson(configPath, config);
  const originalPlan = await fs.readFile(fixture.planPath);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Offline admission must not fetch'); });
  const switched = await switchRuntimePipelineFromRegistry({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: fixture.runtimeRoot, target: 'local-alias' });
  assert.equal(switched.packages[0].preparation, 'retained');
  assert.deepEqual(await fs.readFile(fixture.planPath), originalPlan, 'signed target is never rewritten');
  await closeRuntimeQuerySnapshot(fixture.runtimeRoot);
  const result = await searchRuntime({ stateRoot: fixture.runtimeRoot, runtime: DEFAULT_DKB_RUNTIME_CONTEXT, query: 'PIPELINE-SWITCH-42' });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].dkbId, fixture.packageId);
  const chain = await verifyRetainedRegistryBuild({ libraryRoot: fixture.libraryRoot, registryUrl: fixture.origin, packageRoot: fixture.packageRoot, graph: fixture.graph, target: 'local-alias' });
  assert.equal(chain.retrieval.retrievalBuildDigest, fixture.graph.retrieval.retrievalBuildDigest);
});

test('cold and warm Runtime admission reject missing, corrupt, and revoked retained Registry trust', async (t) => {
  const fixture = await signRuntimeFixture(await createWarmRuntimeFixture(t));
  await switchRuntimePipelineFromRegistry({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: fixture.runtimeRoot, target: 'fast' });
  const previous = await activationBytes(fixture.runtimeRoot);
  const pristine = new Map(await Promise.all([fixture.sourcePath, fixture.planPath, fixture.trustPath].map(async (file) => [file, await fs.readFile(file)])));
  const query = () => searchRuntime({ stateRoot: fixture.runtimeRoot, runtime: DEFAULT_DKB_RUNTIME_CONTEXT, query: 'PIPELINE-SWITCH-42' });
  const cases = [
    ['source receipt missing', () => fs.rm(fixture.sourcePath)],
    ['install receipt missing', () => fs.rm(fixture.planPath)],
    ['source signature corrupt', async () => { const value = JSON.parse(pristine.get(fixture.sourcePath)); value.publisher.value = Buffer.alloc(64).toString('base64'); await writeJson(fixture.sourcePath, value); }],
    ['parent reference corrupt', async () => { const value = JSON.parse(pristine.get(fixture.planPath)); value.artifacts[2].receipt.parentReceiptHash = stableHash({ wrong: 'parent' }); await writeJson(fixture.planPath, value); }],
    ['trust missing', () => fs.rm(fixture.trustPath)],
    ['trust malformed', () => fs.writeFile(fixture.trustPath, '{broken')],
    ['key fingerprint mismatch', async () => { const value = JSON.parse(pristine.get(fixture.trustPath)); value.keys[0].publicKeyFingerprint = stableHash({wrong:'key'}); await writeJson(fixture.trustPath, value); }],
    ['Registry key revoked', async () => { const value = JSON.parse(pristine.get(fixture.trustPath)); value.keys.find((key) => key.subjectType === 'registry').status = 'revoked'; await writeJson(fixture.trustPath, value); }],
  ];
  for (const [label, tamper] of cases) {
    await closeRuntimeQuerySnapshot(fixture.runtimeRoot);
    await tamper();
    await assert.rejects(query, (error) => {
      assert.match(error.code, /^registry_/u, label);
      assert.match(error.message, /Recover with: dkb install @test\/warm-drift --version 1\.0\.0/u, label);
      if (label === 'trust malformed' || label === 'key fingerprint mismatch') assert.match(error.message, /Back up and move .* aside for inspection/u);
      return true;
    }, label);
    await assert.rejects(() => verifyRetainedRegistryBuild({ libraryRoot: fixture.libraryRoot, registryUrl: fixture.origin, packageRoot: fixture.packageRoot, graph: fixture.graph, target: 'fast' }), /Cannot trust retained|pinned Registry trust|signed Registry|fingerprint/i, label);
    await assert.rejects(() => switchRuntimePipelineFromRegistry({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: fixture.runtimeRoot, target: 'fast' }), undefined, label);
    assert.deepEqual(await activationBytes(fixture.runtimeRoot), previous, label);
    for (const [file, bytes] of pristine) await fs.writeFile(file, bytes);
  }
  assert.equal((await query()).results.length, 1);
  await fs.rm(fixture.trustPath);
  await assert.rejects(query, /changed|drift|trust|input|cannot open/i, 'warm contexts cannot keep serving after trust removal');
});

test('a local target alias downloads and activates the exact signed original-target chain', async (t) => {
  const fixture = await signRuntimeFixture(await createWarmRuntimeFixture(t), { downloadable: true });
  const configPath = path.join(fixture.libraryRoot, '.dkb', 'config.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  config.targets['download-alias'] = config.targets.fast;
  await writeJson(configPath, config);
  const originalPlan = await fs.readFile(fixture.planPath);
  await fs.rm(fixture.graph.retrievalPath, { recursive: true });
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    if (request.url === '/.well-known/dkb-registry-keys.json') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: fixture.keys }));
      return;
    }
    const kind = request.url.split('/').at(-1);
    const bytes = fixture.layerBytes.get(kind);
    if (bytes) {
      response.setHeader('content-type', `application/vnd.dkb.${kind}+gzip`);
      response.end(bytes);
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => closeServer(server));
  const transport = `http://127.0.0.1:${server.address().port}`;
  const grant = { plan: fixture.plan, installGrant: `dkb_grant_${'g'.repeat(64)}` };
  const previous = await activationBytes(fixture.runtimeRoot);
  await assert.rejects(() => switchRuntimePipelineFromRegistry({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: fixture.runtimeRoot, target: 'tei', grants: { [fixture.packageId]: grant } }), /does not match the Runtime's resolved provider identities/u);
  assert.equal(requests.length, 0, 'different profile is rejected before download');
  assert.deepEqual(await activationBytes(fixture.runtimeRoot), previous);
  const switched = await switchRuntimePipelineFromRegistry({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: fixture.runtimeRoot, registryTransportUrl: transport, target: 'download-alias', grants: { [fixture.packageId]: grant } });
  assert.equal(switched.packages[0].preparation, 'downloaded');
  assert.equal(switched.target, 'download-alias');
  assert.equal(switched.packages[0].retrievalBuildDigest, fixture.graph.retrieval.retrievalBuildDigest);
  assert.deepEqual(requests.map((request) => request.path), ['/.well-known/dkb-registry-keys.json', '/api/layers/evidence', '/api/layers/retrieval']);
  assert.ok(requests.slice(1).every((request) => request.authorization === `DKB-Install-Grant ${grant.installGrant}`));
  assert.deepEqual(await fs.readFile(fixture.planPath), originalPlan);
  const profile = JSON.parse(await fs.readFile(path.join(fixture.graph.retrievalPath, 'dkb-profile.lock.json'), 'utf8'));
  assert.equal(profile.profile.target, 'fast', 'stored signed build label is not rewritten');
  await closeRuntimeQuerySnapshot(fixture.runtimeRoot);
  assert.equal((await searchRuntime({ stateRoot: fixture.runtimeRoot, runtime: DEFAULT_DKB_RUNTIME_CONTEXT, query: 'PIPELINE-SWITCH-42' })).results.length, 1);
});

test('Registry trust pins immutable key fingerprints, retains rotation history, and rejects malformed cache', async (t) => {
  const fixture = await signRuntimeFixture(await createWarmRuntimeFixture(t));
  const before = await fs.readFile(fixture.trustPath);
  const replacement = generateSigningKeyPair();
  const substituted = fixture.keys.map((key) => key.subjectType === 'registry' ? { ...key, publicKeyPem: replacement.publicKeyPem, publicKeyFingerprint: replacement.publicKeyFingerprint } : key);
  await assert.rejects(() => pinRegistryTrustedKeys({ libraryRoot: fixture.libraryRoot, registryUrl: fixture.origin, keys: substituted }), /replace pinned signing key/);
  assert.deepEqual(await fs.readFile(fixture.trustPath), before);
  await pinRegistryTrustedKeys({ libraryRoot: fixture.libraryRoot, registryUrl: fixture.origin, keys: fixture.keys.filter((key) => key.subjectType === 'registry') });
  assert.equal((await readPinnedRegistryKeys(fixture.libraryRoot, fixture.origin)).length, 2, 'historical publisher keys are retained');
  await pinRegistryTrustedKeys({ libraryRoot: fixture.libraryRoot, registryUrl: fixture.origin, keys: fixture.keys.map((key) => ({ ...key, status: 'revoked' })) });
  await assert.rejects(() => pinRegistryTrustedKeys({ libraryRoot: fixture.libraryRoot, registryUrl: fixture.origin, keys: fixture.keys }), /reactivate revoked/);
  await fs.writeFile(fixture.trustPath, '{broken');
  await assert.rejects(() => pinRegistryTrustedKeys({ libraryRoot: fixture.libraryRoot, registryUrl: fixture.origin, keys: fixture.keys }), /Unreadable pinned Registry trust.*Back up and move .* aside for inspection/);
  assert.equal(await fs.readFile(fixture.trustPath, 'utf8'), '{broken');
});

test('activation rejects malformed package validation and changes during final index preparation', async (t) => {
  const fixture = await createWarmRuntimeFixture(t);
  const previous = await activationBytes(fixture.runtimeRoot);
  const configPath = path.join(fixture.libraryRoot, '.dkb', 'config.json');
  const configBytes = await fs.readFile(configPath);
  const createHost = DkbProviderHost.create.bind(DkbProviderHost);
  let behavior = 'bad-count';
  t.mock.method(DkbProviderHost, 'create', async (...args) => {
    const host = await createHost(...args);
    const index = host.provider('index');
    const validate = index.validatePackage.bind(index);
    index.validatePackage = async (input) => {
      const result = await validate(input);
      if (behavior === 'bad-count') return { documentCount: -1 };
      if (behavior === 'config-drift') { const changed = JSON.parse(configBytes); changed.targets.fast.options = { '@test/core': { semanticChange: true } }; await writeJson(configPath, changed); }
      if (behavior === 'artifact-drift') await fs.appendFile(path.join(input.artifactsRoot, 'test-index.json'), ' ');
      return result;
    };
    return host;
  });
  for (behavior of ['bad-count', 'config-drift', 'artifact-drift']) {
    await assert.rejects(() => switchRuntimePipelineFromRegistry({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: fixture.runtimeRoot, target: 'fast' }), /count|changed|drift|mismatch/i, behavior);
    assert.deepEqual(await activationBytes(fixture.runtimeRoot), previous, behavior);
    await fs.writeFile(configPath, configBytes);
  }
});

test('Runtime validates managed index install, verify, and uninstall results before accepting them', async (t) => {
  const fixture = await createWarmRuntimeFixture(t, { managed: true });
  const previous = await activationBytes(fixture.runtimeRoot);
  const instance = await ensureRuntimeState(fixture.runtimeRoot);
  const createHost = DkbProviderHost.create.bind(DkbProviderHost);
  let operation = 'install';
  let malformed = { indexId: 'test', documentCount: 1, status: 'removed', created: true };
  t.mock.method(DkbProviderHost, 'create', async (...args) => {
    const host = await createHost(...args);
    const index = host.provider('index');
    if (operation === 'install') index.installPackage = async () => malformed;
    if (operation === 'verify') index.verifyRuntime = async () => malformed;
    if (operation === 'uninstall') index.uninstallPackage = async () => malformed;
    return host;
  });
  for (malformed of [undefined, { indexId: 'test', documentCount: NaN, status: 'ready' }, { indexId: 'test', documentCount: 2, status: 'ready' }, { indexId: 'test', documentCount: 1, status: 'removed' }]) {
    await assert.rejects(() => switchRuntimePipelineFromRegistry({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: fixture.runtimeRoot, target: 'fast' }), /invalid|inconsistent/i);
    assert.deepEqual(await activationBytes(fixture.runtimeRoot), previous);
  }
  const common = { runtime: DEFAULT_DKB_RUNTIME_CONTEXT, runtimeStateRoot: fixture.runtimeRoot, libraryRoot: fixture.libraryRoot, libraryId: instance.activation.library.id, target: 'fast', packageId: fixture.packageId, packageVersion: '1.0.0' };
  operation = 'verify';
  malformed = { indexId: 'test', documentCount: 1, status: 'removed' };
  await assert.rejects(() => verifyRuntimeIndex({ ...common, activation: instance.activation }), /inconsistent/);
  operation = 'uninstall';
  await removeDkbFromLibrary(fixture.packageId, fixture.libraryRoot);
  malformed = { indexId: 'test', documentCount: 1, status: 'orphaned' };
  const incomplete = await refreshRuntimeActivation({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: fixture.runtimeRoot });
  assert.equal(incomplete.indexCleanup.pending, 1);
  assert.match(incomplete.warning, /cleanup.*needs attention/);
  malformed = { indexId: 'test', documentCount: 0, status: 'orphaned', warning: 'Delete the unused test index after restoring its service.' };
  assert.equal((await refreshRuntimeActivation({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: fixture.runtimeRoot })).indexCleanup.pending, 1);
  malformed = { indexId: 'test', documentCount: 0, status: 'removed' };
  assert.equal((await refreshRuntimeActivation({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: fixture.runtimeRoot })).indexCleanup.removed, 1);
  assert.deepEqual((await ensureRuntimeState(fixture.runtimeRoot)).activation.packages, {});
});

test('managed retention preserves concurrent spaces, then cleans only removed Library versions under ownership', async (t) => {
  const fixture = await createWarmRuntimeFixture(t, { managed: true });
  await ensurePackageBuildForTarget(fixture.packageRoot, { target: 'tei', contextRoot: fixture.libraryRoot });
  const second = path.join(fixture.root, 'second-runtime');
  await ensureRuntimeState(second, { runtimeId: 'second', libraryRoot: fixture.libraryRoot, target: 'fast' });
  const createHost = DkbProviderHost.create.bind(DkbProviderHost);
  const removed = [];
  let queuedMutation;
  let writerEntered = false;
  const independent = new AsyncResource('independent-index-reinstall');
  t.after(() => independent.emitDestroy());
  t.mock.method(DkbProviderHost, 'create', async (...args) => {
    const host = await createHost(...args);
    host.provider('index').uninstallPackage = async (input) => {
      removed.push([input.libraryRoot, input.packageId, input.packageVersion]);
      // A concurrent process cannot reinstall between the absent-version check and deletion.
      if (!queuedMutation) {
        queuedMutation = independent.runInAsyncScope(() => withDkbFileLock(fixture.libraryRoot, 'library-mutation', async () => { writerEntered = true; }));
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(writerEntered, false, 'the Library lease covers the external delete');
      }
      assert.equal(input.packageId, fixture.packageId);
      assert.equal(input.packageVersion, '1.0.0');
      return { indexId: 'all-retired-package-spaces', documentCount: 0, status: 'removed' };
    };
    return host;
  });
  const refresh = stateRoot => refreshRuntimeActivation({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot });
  await switchRuntimePipelineFromRegistry({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: second, target: 'fast' });
  const otherBefore = await activationBytes(second);
  const changed = await switchRuntimePipelineFromRegistry({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: fixture.runtimeRoot, target: 'tei' });
  assert.equal(changed.indexCleanup.retained, 2, 'inactive and active spaces are both retained');
  assert.equal(removed.length, 0);
  assert.deepEqual(await activationBytes(second), otherBefore);
  await removeDkbFromLibrary(fixture.packageId, fixture.libraryRoot);
  await assert.rejects(() => searchRuntime({ stateRoot: second, runtime: DEFAULT_DKB_RUNTIME_CONTEXT, query: 'PIPELINE-SWITCH-42' }), /changed|stale|refresh/i);
  const result = await refresh(fixture.runtimeRoot);
  assert.equal(result.indexCleanup.removed, 2);
  assert.equal(result.indexCleanup.pending, 0);
  assert.deepEqual(await activationBytes(second), otherBefore, 'cleanup never writes another Runtime activation');
  await queuedMutation;
  assert.equal(writerEntered, true);
  assert.equal((await refresh(fixture.runtimeRoot)).indexCleanup.removed, 0, 'successful cleanup receipts are consumed');
  assert.equal((await refresh(second)).indexCleanup.removed, 1, 'another Runtime may idempotently reconcile the same retired version');
  assert.equal(removed.every(([root]) => root === fixture.libraryRoot), true);
});

test('managed cleanup persists retry authority, rejects recipe drift and malformed receipts, and never rolls back activation', async (t) => {
  const fixture = await createWarmRuntimeFixture(t, { managed: true });
  const createHost = DkbProviderHost.create.bind(DkbProviderHost);
  let behavior = 'throws';
  let calls = 0;
  t.mock.method(DkbProviderHost, 'create', async (...args) => {
    const host = await createHost(...args);
    if (behavior === 'storage-drift') host.provider('index').storageIdentity = () => `sha256:${'b'.repeat(64)}`;
    host.provider('index').uninstallPackage = async () => {
      calls++;
      if (behavior === 'throws') throw new Error('secret fixture provider credential must not escape');
      return { indexId: 'test', documentCount: 0, status: 'removed' };
    };
    return host;
  });
  const directory = path.join(fixture.runtimeRoot, '.dkb', 'managed-index-retention');
  const [filename] = await fs.readdir(directory);
  const receipt = path.join(directory, filename);
  const bytes = await fs.readFile(receipt);
  await removeDkbFromLibrary(fixture.packageId, fixture.libraryRoot);
  const refresh = () => refreshRuntimeActivation({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: fixture.runtimeRoot });
  const failed = await refresh();
  assert.equal(failed.indexCleanup.pending, 1);
  assert.match(failed.warning, /dkb runtime refresh warm-drift/);
  assert.doesNotMatch(JSON.stringify(failed), /secret fixture/);
  assert.deepEqual((await ensureRuntimeState(fixture.runtimeRoot)).activation.packages, {});
  assert.deepEqual(await fs.readFile(receipt), bytes);
  const configPath = path.join(fixture.libraryRoot, '.dkb', 'config.json');
  const configBytes = await fs.readFile(configPath);
  const changed = JSON.parse(configBytes);
  changed.targets.fast.options = { '@test/core': { service: 'a-different-service' } };
  await writeJson(configPath, changed);
  behavior = 'removed';
  assert.equal((await refresh()).indexCleanup.pending, 1);
  assert.equal(calls, 1, 'changed provider options cannot authorize cleanup');
  await fs.writeFile(configPath, configBytes);
  behavior = 'storage-drift';
  assert.equal((await refresh()).indexCleanup.pending, 1);
  assert.equal(calls, 1, 'an environment-resolved store change cannot authorize cleanup');
  behavior = 'removed';
  await fs.writeFile(receipt, '{broken');
  assert.equal((await refresh()).indexCleanup.pending, 1);
  assert.equal(calls, 1, 'invalid receipt grants no deletion authority');
  await fs.writeFile(receipt, bytes);
  const invalid = Array.from({ length: 23 }, (_, index) => path.join(directory, `invalid-${index}.json`));
  for (const file of invalid) await fs.writeFile(file, '{broken');
  const bounded = await refresh();
  assert.equal(bounded.indexCleanup.pending, 23);
  assert.equal(bounded.indexCleanup.warnings.length, 21, 'twenty details plus a bounded summary');
  assert.match(bounded.indexCleanup.warnings.at(-1), /3 additional cleanup scopes/);
  for (const file of invalid) await fs.unlink(file);
  assert.equal(bounded.indexCleanup.removed, 1, 'the valid receipt reconciles independently');
  const recovered = await refresh();
  assert.equal(recovered.indexCleanup.removed, 0);
  assert.equal(recovered.warning, undefined);
  assert.equal((await fs.readdir(directory)).length, 0);
});

test('managed cleanup of an upgraded version preserves the installed release and records before provider import', async (t) => {
  const fixture = await createWarmRuntimeFixture(t, { managed: true });
  const manifest = path.join(fixture.packageRoot, 'dkb.json');
  await writeJson(manifest, { ...JSON.parse(await fs.readFile(manifest, 'utf8')), version: '1.1.0' });
  // Model replacement by another package release, not mutation of the old build graph.
  await fs.rm(path.join(fixture.packageRoot, '.dkb', 'builds'), { recursive: true });
  await compileComposeProject(fixture.packageRoot, { force: true, target: 'fast', contextRoot: fixture.libraryRoot });
  const lock = libraryLock(fixture.packageId, 2);
  lock.entries[fixture.packageId].version = '1.1.0';
  await applyLibraryLock(fixture.libraryRoot, lock);
  const createHost = DkbProviderHost.create.bind(DkbProviderHost);
  const removals = [];
  t.mock.method(DkbProviderHost, 'create', async (...args) => {
    const host = await createHost(...args);
    const index = host.provider('index');
    const install = index.installPackage.bind(index);
    index.installPackage = async input => {
      const dir = path.join(fixture.runtimeRoot, '.dkb', 'managed-index-retention');
      const records = await Promise.all((await fs.readdir(dir)).map(async name => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'))));
      assert.equal(records.some(record => record.packageVersion === '1.1.0'), true, 'receipt precedes remote side effects');
      return install(input);
    };
    index.uninstallPackage = async input => {
      removals.push(input.packageVersion);
      return { indexId: 'old-version-only', documentCount: 0, status: 'removed' };
    };
    return host;
  });
  const result = await refreshRuntimeActivation({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: fixture.runtimeRoot });
  assert.deepEqual(removals, ['1.0.0']);
  assert.equal(result.indexCleanup.retained, 1);
  assert.equal(result.packages[0].version, '1.1.0');
});

test('real Meilisearch refresh reclaims retired spaces without touching another Library and reimports retained builds', {
  skip: process.env.DKB_RUN_MANAGED_INDEX_PROOF !== '1', timeout: 120_000,
}, async t => {
  const execute = promisify(execFile);
  const container = `dkb-managed-retention-${randomUUID()}`;
  const image = process.env.DKB_MANAGED_INDEX_PROOF_IMAGE;
  assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/u, 'select an already installed immutable Meilisearch image');
  const key = `synthetic-${randomUUID()}`;
  const docker = (...args) => execute('docker', args, { windowsHide: true, timeout: 30_000, env: { ...process.env, MEILI_MASTER_KEY: key } });
  await docker('run', '-d', '--rm', '--name', container, '--label', 'dev.dkb.managed-retention-proof=true',
    '--memory', '512m', '--cpus', '1', '--tmpfs', '/meili_data', '-p', '127.0.0.1::7700',
    '-e', 'MEILI_MASTER_KEY', '-e', 'MEILI_NO_ANALYTICS=true', image);
  t.after(() => docker('rm', '-f', container));
  const port = (await docker('port', container, '7700/tcp')).stdout.trim().split(':').at(-1);
  const origin = `http://127.0.0.1:${port}`;
  const request = async endpoint => {
    const response = await fetch(origin + endpoint, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) });
    assert.equal(response.ok, true, await response.clone().text());
    return response.json();
  };
  const deadline = Date.now() + 30_000;
  while (true) {
    try { await request('/health'); break; }
    catch (error) { if (Date.now() > deadline) throw error; await new Promise(resolve => setTimeout(resolve, 150)); }
  }
  const previousUrl = process.env.DKB_TEST_RETENTION_MEILI_URL;
  const previousKey = process.env.DKB_TEST_RETENTION_MEILI_KEY;
  process.env.DKB_TEST_RETENTION_MEILI_URL = origin;
  process.env.DKB_TEST_RETENTION_MEILI_KEY = key;
  t.after(() => {
    for (const [name, value] of [['DKB_TEST_RETENTION_MEILI_URL', previousUrl], ['DKB_TEST_RETENTION_MEILI_KEY', previousKey]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const first = await createWarmRuntimeFixture(t, { managedService: true });
  const other = await createWarmRuntimeFixture(t, { managedService: true });
  const indexes = async () => (await request('/indexes?limit=100')).results.map(entry => entry.uid).sort();
  const otherIndexes = await indexes();
  assert.equal(otherIndexes.length, 2);
  await ensurePackageBuildForTarget(first.packageRoot, { target: 'tei', contextRoot: first.libraryRoot });
  await switchRuntimePipelineFromRegistry({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: first.runtimeRoot, target: 'tei' });
  assert.equal((await indexes()).length, 3, 'inactive space remains installed');
  const stored = await listPackageBuilds(first.packageRoot);
  await removeDkbFromLibrary(first.packageId, first.libraryRoot);
  const refresh = await refreshRuntimeActivation({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: first.runtimeRoot });
  assert.equal(refresh.indexCleanup.pending, 0, refresh.warning);
  assert.equal((await indexes()).length, 1, 'only the other Library survives');
  assert.equal((await searchRuntime({ stateRoot: other.runtimeRoot, runtime: DEFAULT_DKB_RUNTIME_CONTEXT, query: 'PIPELINE-SWITCH-42' })).results.length, 1);
  await writeJson(path.join(first.libraryRoot, 'dkb.json'), { type: 'library', name: 'Warm Runtime Library', roots: { [first.packageId]: { path: 'knowledge' } } });
  await applyLibraryLock(first.libraryRoot, libraryLock(first.packageId, 3));
  await refreshRuntimeActivation({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: first.runtimeRoot });
  assert.deepEqual(await listPackageBuilds(first.packageRoot), stored, 'no compilation on reactivation');
  assert.equal((await indexes()).length, 2);
  assert.equal((await searchRuntime({ stateRoot: first.runtimeRoot, runtime: DEFAULT_DKB_RUNTIME_CONTEXT, query: 'PIPELINE-SWITCH-42' })).results.length, 1);
});

test('managed preparation never guesses ownership from malformed install results', async (t) => {
  const fixture = await createWarmRuntimeFixture(t, { managed: true });
  const previous = await activationBytes(fixture.runtimeRoot);
  const createHost = DkbProviderHost.create.bind(DkbProviderHost);
  let removed = 0;
  let ownership;
  t.mock.method(DkbProviderHost, 'create', async (...args) => {
    const host = await createHost(...args);
    const index = host.provider('index');
    index.installPackage = async () => ({ indexId: 'possibly-preexisting', documentCount: 1, status: 'ready', ...(ownership === undefined ? {} : { created: ownership }) });
    index.uninstallPackage = async () => { removed += 1; return { indexId: 'possibly-preexisting', documentCount: 0, status: 'removed' }; };
    index.discardPackage = async () => { removed += 1; return { indexId: 'possibly-preexisting', documentCount: 0, status: 'removed' }; };
    return host;
  });
  for (ownership of [undefined, 'yes', 1]) {
    await assert.rejects(
      () => switchRuntimePipelineFromRegistry({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: fixture.runtimeRoot, target: 'fast' }),
      (error) => ['provider_output_invalid', 'invalid_provider_output'].includes(error.code)
        && /Automatic deletion is unsafe/.test(error.message)
        && /dkb pipeline verify fast --runtime warm-drift/.test(error.message),
    );
    assert.equal(removed, 0);
    assert.deepEqual(await activationBytes(fixture.runtimeRoot), previous);
  }
});

test('failed activation discards only newly created exact indexes and surfaces orphan cleanup failures', async (t) => {
  const fixture = await createWarmRuntimeFixture(t, { managed: true });
  const previous = await activationBytes(fixture.runtimeRoot);
  const build = (await listPackageBuilds(fixture.packageRoot)).retrieval[0];
  const artifactPath = path.join(build.path, 'artifacts', 'test-index.json');
  const artifact = await fs.readFile(artifactPath);
  const configPath = path.join(fixture.libraryRoot, '.dkb', 'config.json');
  const config = await fs.readFile(configPath);
  const createHost = DkbProviderHost.create.bind(DkbProviderHost);
  const retainedIndex = 'active-other-space';
  const preparedIndex = 'new-space-index';
  let behavior;
  let discarded = [];
  let indexes = new Set();
  let broadDeletes = 0;
  t.mock.method(DkbProviderHost, 'create', async (...args) => {
    const host = await createHost(...args);
    const index = host.provider('index');
    index.installPackage = async () => {
      indexes.add(preparedIndex);
      if (behavior === 'provider-drift') {
        const changed = JSON.parse(config);
        changed.targets.fast.options = { '@test/core': { differentService: true } };
        await writeJson(configPath, changed);
      } else await fs.appendFile(artifactPath, ' ');
      return { indexId: preparedIndex, documentCount: 1, status: 'ready', created: behavior !== 'retained' };
    };
    index.uninstallPackage = async () => {
      broadDeletes += 1;
      indexes.clear();
      return { indexId: 'all-spaces', documentCount: 0, status: 'removed' };
    };
    index.discardPackage = async (input) => {
      discarded.push(input.indexId);
      assert.equal(input.dkb.manifest.id, fixture.packageId);
      assert.equal(input.artifactsRoot, path.dirname(artifactPath));
      assert.equal(input.indexId, preparedIndex);
      if (behavior === 'throws') throw new Error('fixture index service refused cleanup');
      if (behavior === 'orphaned') return { indexId: preparedIndex, documentCount: 1, status: 'orphaned', warning: 'fixture index service is offline' };
      if (behavior === 'wrong-index') return { indexId: retainedIndex, documentCount: 0, status: 'removed' };
      indexes.delete(input.indexId);
      return { indexId: input.indexId, documentCount: 0, status: 'removed' };
    };
    if (behavior === 'unsupported') index.discardPackage = undefined;
    return host;
  });
  for (behavior of ['removed', 'retained', 'throws', 'orphaned', 'wrong-index', 'unsupported', 'provider-drift']) {
    discarded = [];
    indexes = new Set([retainedIndex]);
    const needsRecovery = !['removed', 'retained'].includes(behavior);
    await assert.rejects(
      () => switchRuntimePipelineFromRegistry({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: fixture.runtimeRoot, target: 'fast' }),
      (error) => {
        assert.match(error.message, /changed|drift|mismatch/i);
        if (needsRecovery) {
          assert.equal(error.code, 'runtime_index_cleanup_required');
          assert.match(error.message, /new-space-index/);
          assert.match(error.message, /only confirmed orphans/);
          assert.match(error.message, /dkb pipeline verify fast --runtime warm-drift/);
        }
        return true;
      },
      behavior,
    );
    assert.equal(broadDeletes, 0, behavior);
    assert.equal(indexes.has(retainedIndex), true, behavior);
    assert.equal(indexes.has(preparedIndex), behavior !== 'removed', behavior);
    assert.deepEqual(discarded, ['retained', 'unsupported', 'provider-drift'].includes(behavior) ? [] : [preparedIndex], behavior);
    assert.deepEqual(await activationBytes(fixture.runtimeRoot), previous, behavior);
    await fs.writeFile(artifactPath, artifact);
    await fs.writeFile(configPath, config);
  }
});

function libraryLock(packageId, generation) {
  return {
    library: { name: 'Shared Runtime Library' }, generation,
    entries: { [packageId]: {
      identity: packageId, kind: 'dkb', source: 'local', version: '1.0.0',
      digest: stableHash({ package: packageId, version: '1.0.0' }), path: 'knowledge',
      requiredBy: [`root:${packageId}`], installedAt: '2026-08-28T00:00:00.000Z',
    } },
    resolvedAt: '2026-08-28T00:00:00.000Z',
  };
}

async function createWarmRuntimeFixture(t, { stalledObserver = false, managed = false, managedService = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-runtime-warm-drift-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const libraryRoot = path.join(root, 'library');
  const packageRoot = path.join(libraryRoot, 'knowledge');
  const runtimeRoot = path.join(root, 'runtime');
  const packageId = '@test/warm-drift';
  await writeJson(path.join(libraryRoot, 'dkb.json'), {
    type: 'library', name: 'Warm Runtime Library', roots: { [packageId]: { path: 'knowledge' } },
  });
  await writeJson(path.join(packageRoot, 'dkb.json'), {
    manifestVersion: 1, type: 'dkb', name: packageId, version: '1.0.0', permissions: { read: true, write: false },
  });
  await fs.writeFile(path.join(packageRoot, 'knowledge.md'), 'The retained build marker is PIPELINE-SWITCH-42.\n', 'utf8');
  await writePipelinePlugins(libraryRoot, { managed, managedService });
  if (stalledObserver) {
    await writePlugin(libraryRoot, '@test', 'failing-observer', `
export const apiVersion=3; export const id='@test/failing-observer'; export const version='1.0.0'; export const optionsSchema={'~standard':{version:1,vendor:'test',validate(value){return {value:value??{}};}}};
export function setup(context){context.registerQueryObserver({id,version,observe(){return new Promise(()=>{});}});}
`);
  }
  await compileComposeProject(packageRoot, { force: true, target: 'fast', contextRoot: libraryRoot });
  await applyLibraryLock(libraryRoot, libraryLock(packageId, 1));
  await ensureRuntimeState(runtimeRoot, { runtimeId: 'warm-drift', libraryRoot, target: 'fast' });
  await switchRuntimePipelineFromRegistry({ runtime: DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot: runtimeRoot, target: 'fast' });
  const result = await searchRuntime({ stateRoot: runtimeRoot, runtime: DEFAULT_DKB_RUNTIME_CONTEXT, query: 'PIPELINE-SWITCH-42' });
  assert.equal(result.results.length, 1);
  return { root, libraryRoot, packageRoot, runtimeRoot, packageId };
}

async function activationBytes(runtimeRoot) {
  return fs.readFile(path.join(runtimeRoot, ...DKB_RUNTIME_ACTIVATION_PATH.split('/')));
}

async function writePipelinePlugins(root, { managed = false, managedService = false } = {}) {
  const index = managedService ? '@dkb/index-meilisearch' : '@test/core';
  const retrieval = managedService ? '@dkb/retrieval-hybrid' : '@test/core';
  const options = managedService ? { '@dkb/index-meilisearch': {
    urlEnv: 'DKB_TEST_RETENTION_MEILI_URL', apiKeyEnv: 'DKB_TEST_RETENTION_MEILI_KEY', timeoutMs: 10_000,
    imageDigest: process.env.DKB_MANAGED_INDEX_PROOF_IMAGE,
  } } : {};
  await writeJson(path.join(root, '.dkb', 'config.json'), {
    format: 'dkb.config.v2', activeTarget: 'fast',
    targets: {
      fast: { evidence: '@test/core', embedding: '@test/fast', index, options, retrieval, observers: ['@test/core', '@test/failing-observer'] },
      tei: { evidence: '@test/core', embedding: '@test/tei', index, options, retrieval, observers: ['@test/core', '@test/failing-observer'] },
    },
  });
  await writePlugin(root, '@test', 'core', `
import fs from 'node:fs/promises'; import path from 'node:path';
  export const apiVersion=3; export const id='@test/core'; export const version='1.0.0'; export const optionsSchema={'~standard':{version:1,vendor:'test',validate(value){return {value:value??{}};}}};
export function setup(context) {
  context.registerProvider({kind:'evidence',async compile({dkb}){const text=await fs.readFile(path.join(dkb.root,'knowledge.md'),'utf8');return {records:[{id:'record-1',chunkId:'record-1',text,provenance:{assetId:'knowledge.md',storeId:'filesystem',sourceType:'filesystem',locator:{path:'knowledge.md',chunk:0},assetLocator:{path:'knowledge.md'},title:'knowledge.md',sourceHash:'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',updatedAt:'2026-08-28T00:00:00.000Z',chunkOrdinal:0,chunkStart:0,chunkEnd:text.length},metadata:{dkb_path:'knowledge.md',dkb_source_hash:'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}}],receipt:{build:{}}};}});
  if (${!managedService}) context.registerProvider({kind:'index',mode:'${managed ? 'managed' : 'packaged'}',format:'test.index.v1',capabilities:{vectors:'required'},async compilePackage({artifactsRoot,compiled}){const target=path.join(artifactsRoot,'test-index.json');await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,JSON.stringify(compiled.records));return {build:{recordCount:compiled.records.length}};},async validatePackage({artifactsRoot}){const records=JSON.parse(await fs.readFile(path.join(artifactsRoot,'test-index.json'),'utf8'));return {documentCount:records.length};},${managed ? "storageIdentity(){return 'sha256:'+'a'.repeat(64);},async installPackage(){return {indexId:'test',documentCount:1,status:'ready',created:false};},async discardPackage({indexId}){return {indexId,documentCount:0,status:'removed'};},async uninstallPackage(){return {indexId:'test',documentCount:0,status:'removed'};}," : ''}async verifyRuntime(){return {indexId:'test',documentCount:1,status:'ready'};},async openRuntime(){return null;}});
  if (${!managedService}) context.registerProvider({kind:'retrieval',protocol:'dkb.evidence.v1',capabilities:{vectors:'optional'},openRuntime({evidence}){const evidenceId=evidence.records[0]?.evidenceId;return {providerId:id,protocol:'dkb.evidence.v1',async search({query}){const matchedTokens=query.toLowerCase().includes('pipeline-switch-42')?['pipeline-switch-42','pipeline','switch','42']:[];return {hits:evidenceId&&matchedTokens.length?[{evidenceId,score:0.99,channels:['lexical'],matchedTokens}]:[],trace:{mode:'fixture'}};},async close(){}};}});
  context.registerQueryObserver({id:'@test/core',version:'1.0.0',async observe(event,{root}){const auditPath=path.join(root,'.dkb','query-audit.sqlite');const auditPersisted=await fs.access(auditPath).then(()=>true,()=>false);const frozen=Object.isFrozen(event)&&Object.isFrozen(event.data);try{event.data.query='tampered';}catch{}const mutationBlocked=event.data.query!=='tampered';const output=path.join(root,'.dkb','observer-events.json');const previous=await fs.readFile(output,'utf8').then(JSON.parse,()=>[]);previous.push({eventId:event.eventId,auditPersisted,frozen,mutationBlocked});await fs.writeFile(output,JSON.stringify(previous));}});
}`);
  await writePlugin(root, '@test', 'failing-observer', `
export const apiVersion=3; export const id='@test/failing-observer'; export const version='1.0.0'; export const optionsSchema={'~standard':{version:1,vendor:'test',validate(value){return {value:value??{}};}}};
export function setup(context){context.registerQueryObserver({id,version,async observe(){throw new Error('fixture observer export failed');}});}
`);
  await writePlugin(root, '@test', 'fast', embeddingPlugin('@test/fast', 'fast-space', 0.25));
  await writePlugin(root, '@test', 'tei', embeddingPlugin('@test/tei', 'tei-space', 0.75));
}

async function writeScopeLeakPipelinePlugins(root) {
  await writeJson(path.join(root, '.dkb', 'config.json'), {
    format: 'dkb.config.v2',
    activeTarget: 'scoped',
    targets: {
      scoped: {
        evidence: '@test/scope-core',
        index: '@test/scope-core',
        retrieval: '@test/scope-core',
      },
    },
  });
  await writePlugin(root, '@test', 'scope-core', `
import fs from 'node:fs/promises'; import path from 'node:path';
export const apiVersion=3; export const id='@test/scope-core'; export const version='1.0.0'; export const optionsSchema={'~standard':{version:1,vendor:'test',validate(value){return {value:value??{}};}}};
export function setup(context) {
  context.registerProvider({kind:'evidence',async compile({dkb}){const text=await fs.readFile(path.join(dkb.root,'knowledge.md'),'utf8');return {records:[{id:'record-1',chunkId:'record-1',text,provenance:{assetId:'knowledge.md',storeId:'filesystem',sourceType:'filesystem',locator:{path:'knowledge.md',chunk:0},assetLocator:{path:'knowledge.md'},title:'knowledge.md',sourceHash:'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',updatedAt:'2026-08-28T00:00:00.000Z',chunkOrdinal:0,chunkStart:0,chunkEnd:text.length},metadata:{dkb_path:'knowledge.md',dkb_source_hash:'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}}],receipt:{build:{}}};}});
  context.registerProvider({kind:'index',mode:'packaged',format:'test.scope-index.v1',capabilities:{vectors:'none'},async compilePackage({artifactsRoot,compiled}){await fs.mkdir(artifactsRoot,{recursive:true});await fs.writeFile(path.join(artifactsRoot,'scope-index.json'),JSON.stringify(compiled.records));return {build:{recordCount:compiled.records.length}};},async validatePackage({artifactsRoot}){const records=JSON.parse(await fs.readFile(path.join(artifactsRoot,'scope-index.json'),'utf8'));return {documentCount:records.length};},async verifyRuntime(){return {indexId:'scope',documentCount:1,status:'ready'};},async openRuntime(){return null;}});
  context.registerProvider({kind:'retrieval',protocol:'dkb.evidence.v1',capabilities:{vectors:'none'},openRuntime({evidence}){return {providerId:id,protocol:'dkb.evidence.v1',async search({scope}){const leaked=evidence.records.find((record)=>record.packageId!==scope?.dkbId);return {hits:leaked?[{evidenceId:leaked.evidenceId,score:1,channels:['vector']}]:[],trace:{mode:'intentional-scope-leak'}};},async close(){}};}});
}`);
}

function embeddingPlugin(id, space, value) {
  return `export const apiVersion=3;export const id='${id}';export const version='1.0.0';export const optionsSchema={'~standard':{version:1,vendor:'test',validate(value){return {value:value??{}};}}};export function setup(context){context.registerProvider({kind:'embedding',async embedDocuments({texts}){return texts.map(()=>[${value}]);},async embedQuery(){return [${value}];},compatibility(){return {embeddingSpace:'${space}',dimensions:1,metric:'cosine',normalized:true};},health(){return {ok:true};}});}`;
}

async function writePlugin(root, namespace, name, source) {
  const target = path.join(root, '.dkb', 'plugins', namespace, name, 'plugin.mjs');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, source, 'utf8');
}

async function postRuntimeJson(origin, pathName, body) {
  const response = await fetch(`${origin}${pathName}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer pipeline-http-admin',
      'content-type': 'application/json',
      'x-dkb-client-id': 'runtime-audit-http-proof',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function auditChain(event) {
  return {
    runtime: event.runtime,
    library: event.library,
    pipeline: event.pipeline,
    packages: event.packages,
    requestId: event.requestId,
    query: event.query,
    intent: event.intent,
    status: event.status,
    outcome: event.outcome,
    candidates: event.candidates,
    citations: event.citations,
    operation: event.timing.operation,
  };
}

async function writeJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
