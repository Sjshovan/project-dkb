import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { compileComposeProject } from '@sjshovan/dkb-compiler/compile.js';
import { addLibraryRoot } from '@sjshovan/dkb-library/resolver.js';
import { hashPortablePackageTree } from '@sjshovan/dkb-library/packageTree.js';
import { readLibraryState } from '@sjshovan/dkb-library/state.js';
import { createDkbLocalMcpServer } from '@sjshovan/dkb-runtime/mcp/local.js';
import { DEFAULT_DKB_RUNTIME_CONTEXT as runtime } from '@sjshovan/dkb-runtime/defaultComposition.js';
import { ensureRuntimeState } from '@sjshovan/dkb-runtime/runtime/state.js';
import { closeRuntimeQuerySnapshot } from '../services/runtime/dist/runtime/querySnapshot.js';
import { refreshRuntimeActivation, switchRuntimePipelineFromRegistry } from '@sjshovan/dkb-runtime/runtime/pipelineSwitch.js';
import { prepareLocalAppend } from '../apps/cli/dist/providers/localAppend.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
const target = 'minisearch-lexical';
const original = '# Existing facts\nThe retained marker is ORIGINAL-ANCHOR-73.\n';
const writable = { permissions: { read: true, write: true }, write: { mode: 'direct', operations: ['append'], confirmationRequired: true } };

async function writeJson(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, JSON.stringify(value, null, 2) + '\n');
}

async function fixture(t, prepare = prepareLocalAppend) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-mcp-append-'));
  const libraryRoot = path.join(root, 'library');
  const packageRoot = path.join(libraryRoot, 'memory');
  const stateRoot = path.join(root, 'runtime');
  const manifestPath = path.join(packageRoot, 'dkb.json');
  await writeJson(path.join(libraryRoot, 'dkb.json'), { type: 'library', name: 'Append fixture', roots: {} });
  const cli = path.join(repo, 'apps/cli/dist/cli/index.js');
  const commandOptions = { cwd: root, windowsHide: true, timeout: 30000,
    env: { ...process.env, DKB_HOST_INVENTORY: path.join(root, 'host.json') } };
  await exec(process.execPath, [cli, '--json', 'plugin', 'link', path.join(repo, 'examples/lexical-pipeline'), '--root', libraryRoot], commandOptions);
  await exec(process.execPath, [cli, '--json', 'pipeline', 'set', target, '--root', libraryRoot,
    '--parser', '@example/minisearch-lexical', '--chunker', '@example/minisearch-lexical',
    '--index', '@example/minisearch-lexical', '--retrieval', '@example/minisearch-lexical', '--no-activate'], commandOptions);
  const manifest = { manifestVersion: 1, type: 'dkb', name: '@test/memory', version: '1.0.0', ...writable };
  await writeJson(manifestPath, manifest);
  await fs.writeFile(path.join(packageRoot, 'existing.md'), original);
  await compileComposeProject(packageRoot, { target, contextRoot: libraryRoot });
  await addLibraryRoot(libraryRoot, manifest.name);
  await ensureRuntimeState(stateRoot, { runtimeId: 'append-fixture', libraryRoot, target });
  await switchRuntimePipelineFromRegistry({ runtime, stateRoot, target });
  const server = createDkbLocalMcpServer({ runtime, stateRoot, prepareAppend: prepare });
  const client = new Client({ name: 'append-proof', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
    await closeRuntimeQuerySnapshot(stateRoot);
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const call = (name, args) => client.callTool({ name, arguments: args });
  const request = { dkbId: manifest.name, requestId: 'fact-01',
    text: 'The new marker is APPENDED-BEACON-82.', evidenceRefs: ['user-provided-reference'], confirmed: true };
  return { root, libraryRoot, packageRoot, stateRoot, manifestPath, manifest, client, call, request };
}

test('local MCP append enforces policy, keeps fact text clean, and immediately serves native provenance', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.client.listTools()).tools.map(tool => tool.name).sort(), ['append', 'fetch', 'search']);
  const before = await f.call('search', { query: 'ORIGINAL-ANCHOR-73' });
  const priorId = before.structuredContent.results[0].evidenceId;
  const saved = await f.call('append', f.request);
  assert.equal(saved.isError, undefined, JSON.stringify(saved));
  assert.equal(saved.structuredContent.status, 'appended');
  assert.equal(saved.structuredContent.committed, true);
  const receipt = saved.structuredContent.receipt;
  assert.equal(receipt.packageVersion, '1.0.0');
  assert.equal(await fs.readFile(path.join(f.packageRoot, receipt.assetLocator.path), 'utf8'), f.request.text);
  assert.equal(await fs.readFile(path.join(f.packageRoot, 'existing.md'), 'utf8'), original);
  assert.deepEqual(JSON.parse(await fs.readFile(f.manifestPath, 'utf8')), f.manifest);
  const searched = await f.call('search', { query: 'APPENDED-BEACON-82', dkbId: f.manifest.name });
  assert.ok(searched.structuredContent.results.some(hit => receipt.evidenceIds.includes(hit.evidenceId)));
  const fetched = await f.call('fetch', { id: receipt.evidenceIds[0] });
  assert.equal(fetched.structuredContent.status, 'complete');
  assert.equal(fetched.structuredContent.citation.sourceHash, receipt.sourceHash);
  assert.equal(fetched.structuredContent.citation.packageVersion, '1.0.0');
  assert.ok(JSON.stringify(fetched.structuredContent).includes(f.request.text));
  assert.ok(!JSON.stringify(fetched.structuredContent).includes('Provenance:'));
  assert.ok(!JSON.stringify(fetched.structuredContent).includes('user-provided-reference'));
  assert.equal((await f.call('fetch', { id: priorId })).structuredContent.status, 'complete');
  const priorSource = await hashPortablePackageTree(f.packageRoot);
  const retry = await f.call('append', f.request);
  assert.equal(retry.structuredContent.status, 'appended', JSON.stringify(retry));
  assert.equal((await hashPortablePackageTree(f.packageRoot)).hash, priorSource.hash);
  const conflicting = await f.call('append', { ...f.request, text: 'A different fact.' });
  assert.equal(conflicting.structuredContent.error.code, 'append_request_conflict');
  const second = await f.call('append', { ...f.request, requestId: 'fact-02', text: 'A second marker is SECOND-ANCHOR-94.' });
  assert.equal(second.structuredContent.status, 'appended', JSON.stringify(second));
  const replayFirst = await f.call('append', f.request);
  assert.equal(replayFirst.structuredContent.status, 'appended', JSON.stringify(replayFirst));
  assert.ok((await f.call('search', { query: 'SECOND-ANCHOR-94' })).structuredContent.results.length);
  await closeRuntimeQuerySnapshot(f.stateRoot);
  await refreshRuntimeActivation({ runtime, stateRoot: f.stateRoot });
  assert.ok((await f.call('search', { query: 'SECOND-ANCHOR-94' })).structuredContent.results.length);
});

test('MCP denied, unconfirmed and unsupported append policies leave sources and state untouched', async t => {
  const f = await fixture(t);
  const policies = [
    [{ permissions: { read: true, write: false }, write: undefined }, f.request, 'append_permission_denied'],
    [{ permissions: { read: true }, write: writable.write }, f.request, 'append_permission_denied'],
    [{ permissions: writable.permissions, write: { ...writable.write, operations: ['update'] } }, f.request, 'append_permission_denied'],
    [writable, { ...f.request, confirmed: false }, 'append_confirmation_required'],
    [writable, { ...f.request, evidenceRefs: [] }, 'append_evidence_required'],
  ];
  for (const [policy, request, code] of policies) {
    await writeJson(f.manifestPath, { ...f.manifest, ...policy });
    const before = await hashPortablePackageTree(f.packageRoot);
    const state = await readLibraryState(f.libraryRoot);
    const denied = await f.call('append', request);
    assert.equal(denied.isError, true);
    assert.equal(denied.structuredContent.error.code, code, JSON.stringify(denied));
    assert.equal(denied.structuredContent.committed, false);
    assert.equal((await hashPortablePackageTree(f.packageRoot)).hash, before.hash);
    assert.equal((await readLibraryState(f.libraryRoot)).generation, state.generation);
  }
});

test('MCP rejects escaping targets, arbitrary paths, colliding assets and oversized input', async t => {
  const f = await fixture(t);
  for (const request of [
    { ...f.request, dkbId: '../outside' },
    { ...f.request, dkbId: '@test/missing' },
    { ...f.request, requestId: '../escape' },
    { ...f.request, requestId: 'C:\\outside' },
    { ...f.request, text: 'x'.repeat(65537) },
    { ...f.request, text: '\0' },
    { ...f.request, file: '../../outside.md' },
    { ...f.request, conversationMessageId: 'invented' },
  ]) {
    const before = await hashPortablePackageTree(f.packageRoot);
    const result = await f.call('append', request);
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.equal((await hashPortablePackageTree(f.packageRoot)).hash, before.hash);
  }
  const colliding = path.join(f.packageRoot, 'append-fact-01.md');
  await fs.writeFile(colliding, 'Existing content must survive.');
  const result = await f.call('append', f.request);
  assert.equal(result.structuredContent.error.code, 'append_request_conflict');
  assert.equal(await fs.readFile(colliding, 'utf8'), 'Existing content must survive.');
});

test('failed append preparation leaves canonical facts and the previous MCP retrieval usable', async t => {
  const f = await fixture(t, async () => { throw new Error('Synthetic compiler unavailable'); });
  const before = await hashPortablePackageTree(f.packageRoot);
  const state = await readLibraryState(f.libraryRoot);
  const result = await f.call('append', f.request);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.committed, false);
  assert.equal((await hashPortablePackageTree(f.packageRoot)).hash, before.hash);
  assert.equal((await readLibraryState(f.libraryRoot)).generation, state.generation);
  assert.ok((await f.call('search', { query: 'ORIGINAL-ANCHOR-73' })).structuredContent.results.length);
});


test('a committed append with a failed refresh retries exactly once after service recovery', async t => {
  let interrupt = true;
  const f = await fixture(t, async input => {
    const selection = await prepareLocalAppend(input);
    if (interrupt) {
      interrupt = false;
      await fs.rename(path.join(input.libraryRoot, '.dkb/config.json'), path.join(input.libraryRoot, '.dkb/config.json.off'));
    }
    return selection;
  });
  const partial = await f.call('append', f.request);
  assert.equal(partial.isError, true);
  assert.equal(partial.structuredContent.status, 'committed_refresh_required', JSON.stringify(partial));
  assert.equal(partial.structuredContent.committed, true);
  assert.equal(await fs.readFile(path.join(f.packageRoot, 'append-fact-01.md'), 'utf8'), f.request.text);
  await fs.rename(path.join(f.libraryRoot, '.dkb/config.json.off'), path.join(f.libraryRoot, '.dkb/config.json'));
  const retried = await f.call('append', f.request);
  assert.equal(retried.structuredContent.status, 'appended', JSON.stringify(retried));
  assert.equal((await fs.readdir(f.packageRoot)).filter(name => name.startsWith('append-')).length, 1);
  assert.ok((await f.call('search', { query: 'APPENDED-BEACON-82' })).structuredContent.results.length);
});

test('MCP append rejects a package symlink without touching its destination', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside-library');
  await fs.rename(f.packageRoot, outside);
  await fs.symlink(outside, f.packageRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const before = await hashPortablePackageTree(outside);
  const rejected = await f.call('append', f.request);
  assert.equal(rejected.isError, true);
  assert.equal((await hashPortablePackageTree(outside)).hash, before.hash);
});
