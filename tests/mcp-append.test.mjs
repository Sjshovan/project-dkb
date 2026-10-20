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
import { createHash } from 'node:crypto';
import { listQueryAudit } from '@sjshovan/dkb-runtime/runtime/queryAudit.js';
import { runtimePaths, maybeReadRuntimeActivation } from '@sjshovan/dkb-runtime/runtime/state.js';
import { addLibraryRoot, removeLibraryRoot } from '@sjshovan/dkb-library/resolver.js';
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

async function fixture(t, prepare = prepareLocalAppend, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-mcp-append-'));
  const libraryRoot = path.join(root, 'library');
  const packageRoot = path.join(libraryRoot, 'memory');
  const stateRoot = path.join(root, 'runtime');
  const manifestPath = path.join(packageRoot, 'dkb.json');
  let client, server;
  t.after(async () => {
    await client?.close();
    await server?.close();
    await closeRuntimeQuerySnapshot(stateRoot);
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^dkb-mcp-append-/u);
    await fs.rm(root, { recursive: true, force: true });
  });
  await writeJson(path.join(libraryRoot, 'dkb.json'), { type: 'library', name: 'Append fixture', roots: {} });
  const cli = path.join(repo, 'apps/cli/dist/cli/index.js');
  const commandOptions = { cwd: root, windowsHide: true, timeout: 30000,
    env: { ...process.env, DKB_HOST_INVENTORY: path.join(root, 'host.json') } };
  await exec(process.execPath, [cli, '--json', 'plugin', 'link', path.join(repo, 'examples/lexical-pipeline'), '--root', libraryRoot], commandOptions);
  await exec(process.execPath, [cli, '--json', 'pipeline', 'set', target, '--root', libraryRoot,
    '--parser', '@example/minisearch-lexical', '--chunker', '@example/minisearch-lexical',
    '--index', '@example/minisearch-lexical', '--retrieval', '@example/minisearch-lexical', '--no-activate'], commandOptions);
  const manifest = { manifestVersion: 1, type: 'dkb', name: '@test/memory', version: '1.0.0', ...(options.policy ?? writable) };
  await writeJson(manifestPath, manifest);
  if (!options.empty) await fs.writeFile(path.join(packageRoot, 'existing.md'), options.initialText ?? original);
  await compileComposeProject(packageRoot, { target, contextRoot: libraryRoot });
  await addLibraryRoot(libraryRoot, manifest.name);
  await ensureRuntimeState(stateRoot, { runtimeId: 'append-fixture', libraryRoot, target });
  await switchRuntimePipelineFromRegistry({ runtime, stateRoot, target });
  server = createDkbLocalMcpServer({ runtime, stateRoot, prepareAppend: prepare });
  client = new Client({ name: 'append-proof', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const call = (name, args) => client.callTool({ name, arguments: args });
  const request = { dkbId: manifest.name, requestId: 'fact-01',
    text: 'The new marker is APPENDED-BEACON-82.', evidenceRefs: ['user-provided-reference'], confirmed: true };
  return { root, libraryRoot, packageRoot, stateRoot, manifestPath, manifest, client, call, request };
}

test('local MCP append enforces policy, keeps fact text clean, and immediately serves native provenance', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.client.listTools()).tools.map(tool => tool.name).sort(), ['append', 'create', 'fetch', 'search', 'write_targets']);
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

const targeted = { permissions: writable.permissions, write: { ...writable.write, operations: ['append','create'],
  paths: { append: ['*.md','*.txt'], create: ['/*.md','/notes/'], exclude: ['/private/','secret.md'] } } };
const sourceHash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const policyFixture = (t, prepare, options = {}) => fixture(t, prepare, {policy:targeted,...options});
const discover = async f => (await f.call('write_targets', {dkbId:f.manifest.name})).structuredContent.packages[0];

test('empty package discovery advertises creation; create never overwrites and path excludes win', async t => {
  const f = await policyFixture(t, undefined, {empty:true});
  const listing = await discover(f);
  assert.deepEqual(listing.existing, []);
  assert.deepEqual(listing.creation.allow, targeted.write.paths.create);
  assert.equal(listing.legacyGeneratedAppend,false);
  assert.equal((await f.call('append',f.request)).structuredContent.error.code,'append_target_required');
  for (const candidate of ['../escape.md','/abs.md','C:/escape.md','private/deny.md','secret.md','.dkb/new.md','AGENTS.md','notes/a.pdf','notes/x.md:secret']) {
    const result = await f.call('create',{...f.request,path:candidate});
    assert.equal(result.isError,true,candidate);
  }
  const request = {...f.request,path:'notes/first.md'};
  const created = await f.call('create',request);
  assert.equal(created.structuredContent.status,'appended',JSON.stringify(created));
  assert.equal(created.structuredContent.receipt.operation,'create');
  assert.equal(await fs.readFile(path.join(f.packageRoot,request.path),'utf8'),request.text);
  const repeated = await f.call('create',request);
  assert.equal(repeated.structuredContent.status,'appended',JSON.stringify(repeated));
  const collision = await f.call('create',{...request,requestId:'collision',text:'Must not replace'});
  assert.equal(collision.structuredContent.error.code,'append_request_conflict');
  const after = await discover(f);
  assert.equal(after.existing[0].path,request.path);
  assert.equal(after.existing[0].sourceHash,sourceHash(request.text));
  assert.equal((await f.call('write_targets',{})).structuredContent.packages.length,1);
});

test('existing append preserves exact UTF-8 prefix and old citations; current search, restart, retry and uninstall are coherent', async t => {
  const initial = '\ufeff# Existing facts\r\nThe marker is ORIGINAL-ANCHOR-73.\r\n';
  const f = await policyFixture(t,undefined,{initialText:initial});
  const initialBytes = Buffer.from(initial);
  const oldSearch = (await f.call('search',{query:'ORIGINAL-ANCHOR-73'})).structuredContent;
  const oldId = oldSearch.results[0].evidenceId;
  const oldSelection = (await maybeReadRuntimeActivation(runtimePaths(f.stateRoot).activationPath)).packages[f.manifest.name];
  const listing = await discover(f);
  const request = {...f.request,path:'existing.md',expectedSourceHash:listing.existing[0].sourceHash,text:'Appended sentence APPENDED-BEACON-82.\r\n'};
  const stale = await f.call('append',{...request,expectedSourceHash:'sha256:'+'0'.repeat(64)});
  assert.equal(stale.structuredContent.error.code,'append_source_stale');
  const result = await f.call('append',request);
  assert.equal(result.structuredContent.status,'appended',JSON.stringify(result));
  assert.deepEqual(await fs.readFile(path.join(f.packageRoot,'existing.md')),Buffer.concat([initialBytes,Buffer.from(request.text)]));
  const receipt = result.structuredContent.receipt;
  assert.equal(receipt.beforeSourceHash,sourceHash(initialBytes));
  const history = JSON.parse(await fs.readFile(path.join(f.packageRoot,'.dkb/source-history.json'),'utf8'));
  assert.deepEqual(await fs.readFile(path.join(f.packageRoot,'.dkb/source-revisions',sourceHash(initialBytes).slice(7)+'.txt')),initialBytes);
  assert.equal(history.revisions[0].selection.evidenceDigest,oldSelection.evidenceDigest);
  const currentSearch = (await f.call('search',{query:'ORIGINAL-ANCHOR-73'})).structuredContent;
  assert.ok(currentSearch.results.length);
  assert.ok(currentSearch.results.every(item=>item.evidenceId!==oldId));
  const fetched = (await f.call('fetch',{id:oldId})).structuredContent;
  assert.equal(fetched.status,'complete');
  assert.equal(fetched.citation.sourceHash,sourceHash(initialBytes));
  assert.equal(fetched.citation.revision.historical,true);
  assert.equal(fetched.citation.revision.evidenceDigest,oldSelection.evidenceDigest);
  assert.ok(!JSON.stringify(fetched.queries[0].evidence).includes('APPENDED-BEACON-82'));
  const audit = (await listQueryAudit(f.stateRoot,1))[0];
  assert.equal(audit.candidates[0].evidenceDigest,oldSelection.evidenceDigest);
  assert.equal(audit.candidates[0].retrievalBuildDigest,oldSelection.retrievalBuildDigest);
  const second = {...request,requestId:'fact-02',expectedSourceHash:receipt.sourceHash,text:'Second append.\n'};
  assert.equal((await f.call('append',second)).structuredContent.status,'appended');
  const beforeRetry = await fs.readFile(path.join(f.packageRoot,'existing.md'));
  assert.equal((await f.call('append',request)).structuredContent.status,'appended');
  assert.deepEqual(await fs.readFile(path.join(f.packageRoot,'existing.md')),beforeRetry);
  await closeRuntimeQuerySnapshot(f.stateRoot);
  await refreshRuntimeActivation({runtime,stateRoot:f.stateRoot});
  assert.equal((await f.call('fetch',{id:oldId})).structuredContent.status,'complete');
  await removeLibraryRoot(f.libraryRoot,f.manifest.name);
  assert.equal((await f.call('fetch',{id:oldId})).isError,true);
  await refreshRuntimeActivation({runtime,stateRoot:f.stateRoot});
  assert.notEqual((await f.call('fetch',{id:oldId})).structuredContent?.status,'complete');
  await addLibraryRoot(f.libraryRoot,f.manifest.name);
  await refreshRuntimeActivation({runtime,stateRoot:f.stateRoot});
  assert.equal((await f.call('fetch',{id:oldId})).structuredContent.status,'complete');
});

test('concurrent targeted append serializes and rejects a stale source precondition', async t => {
  const f=await policyFixture(t);
  const request={...f.request,path:'existing.md',expectedSourceHash:sourceHash(original)};
  const results=await Promise.all([f.call('append',request),f.call('append',{...request,requestId:'other',text:'Other addition.'})]);
  assert.equal(results.filter(r=>r.structuredContent.status==='appended').length,1);
  assert.equal(results.filter(r=>r.structuredContent.error?.code==='append_source_stale').length,1);
  const winner=results[0].structuredContent.status==='appended'?request:{...request,text:'Other addition.'};
  assert.equal(await fs.readFile(path.join(f.packageRoot,'existing.md'),'utf8'),original+winner.text);
});

test('targeted compile failure, source race and unsupported policy never commit', async t => {
  let mutate = false;
  let f;
  f=await policyFixture(t,async input=>{
    if (!mutate) throw new Error('Synthetic unavailable compiler');
    const selection=await prepareLocalAppend(input);
    await fs.writeFile(path.join(f.packageRoot,'existing.md'),original+'External author edit.');
    return selection;
  });
  const request={...f.request,path:'existing.md',expectedSourceHash:sourceHash(original)};
  const before=await readLibraryState(f.libraryRoot);
  assert.equal((await f.call('append',request)).structuredContent.committed,false);
  assert.equal(await fs.readFile(path.join(f.packageRoot,'existing.md'),'utf8'),original);
  mutate=true;
  const raced=await f.call('append',request);
  assert.equal(raced.structuredContent.error.code,'append_source_changed');
  assert.equal(await fs.readFile(path.join(f.packageRoot,'existing.md'),'utf8'),original+'External author edit.');
  assert.equal((await readLibraryState(f.libraryRoot)).generation,before.generation);
  await assert.rejects(fs.access(path.join(f.packageRoot,'.dkb/source-history.json')));
  for (const patch of [{schema:'facts.schema.json'},{dedupe:'required'},{accepts:{lanes:['personal']}}]) {
    await writeJson(f.manifestPath,{...f.manifest,write:{...targeted.write,...patch}});
    assert.equal((await f.call('append',request)).structuredContent.error.code,'write_policy_invalid');
    assert.equal((await f.call('write_targets',{dkbId:f.manifest.name})).structuredContent.error.code,'write_policy_invalid');
  }
});

test('targeted writes reject symlink destinations and hardlinked sources', async t => {
  const f=await policyFixture(t);
  const outside=path.join(f.root,'outside'); await fs.mkdir(outside);
  await fs.symlink(outside,path.join(f.packageRoot,'notes'),process.platform==='win32'?'junction':'dir');
  assert.equal((await f.call('create',{...f.request,path:'notes/escape.md'})).isError,true);
  assert.deepEqual(await fs.readdir(outside),[]);
  await fs.link(path.join(f.packageRoot,'existing.md'),path.join(outside,'linked.md'));
  assert.equal((await f.call('append',{...f.request,path:'existing.md',expectedSourceHash:sourceHash(original)})).structuredContent.error.code,'append_target_invalid');
  assert.equal(await fs.readFile(path.join(outside,'linked.md'),'utf8'),original);
});

test('retained source corruption invalidates both warm and reopened historical fetch', async t => {
  const f=await policyFixture(t);
  const oldId=(await f.call('search',{query:'ORIGINAL-ANCHOR-73'})).structuredContent.results[0].evidenceId;
  const result=await f.call('append',{...f.request,path:'existing.md',expectedSourceHash:sourceHash(original)});
  assert.equal(result.structuredContent.status,'appended',JSON.stringify(result));
  assert.equal((await f.call('fetch',{id:oldId})).structuredContent.status,'complete');
  const archived=path.join(f.packageRoot,'.dkb/source-revisions',sourceHash(original).slice(7)+'.txt');
  await fs.writeFile(archived,'Corrupted historical bytes');
  assert.equal((await f.call('fetch',{id:oldId})).isError,true);
  await closeRuntimeQuerySnapshot(f.stateRoot);
  assert.equal((await f.call('fetch',{id:oldId})).isError,true);
});

test('targeted append recovers a committed refresh failure without duplicate bytes or revisions', async t => {
  let interrupt=true;
  const f=await policyFixture(t,async input=>{
    const selection=await prepareLocalAppend(input);
    if (interrupt) {interrupt=false; await fs.rename(path.join(input.libraryRoot,'.dkb/config.json'),path.join(input.libraryRoot,'.dkb/config.json.off'));}
    return selection;
  });
  const request={...f.request,path:'existing.md',expectedSourceHash:sourceHash(original)};
  const partial=await f.call('append',request);
  assert.equal(partial.structuredContent.status,'committed_refresh_required',JSON.stringify(partial));
  assert.equal(partial.structuredContent.committed,true);
  await fs.rename(path.join(f.libraryRoot,'.dkb/config.json.off'),path.join(f.libraryRoot,'.dkb/config.json'));
  const retry=await f.call('append',request);
  assert.equal(retry.structuredContent.status,'appended',JSON.stringify(retry));
  assert.equal(await fs.readFile(path.join(f.packageRoot,'existing.md'),'utf8'),original+request.text);
  const history=JSON.parse(await fs.readFile(path.join(f.packageRoot,'.dkb/source-history.json'),'utf8'));
  assert.equal(history.revisions.length,1);
});

test('UTF-8 plain text works and invalid encoding or malformed Unicode is rejected', async t => {
  const f=await policyFixture(t);
  const request={...f.request,path:'notes/facts.txt',text:'Plain text marker PLAIN-BEACON-41.'};
  const created=await f.call('create',request);
  assert.equal(created.structuredContent.status,'appended',JSON.stringify(created));
  const appended=await f.call('append',{...request,requestId:'txt-append',expectedSourceHash:sourceHash(request.text),text:'\nSecond line.'});
  assert.equal(appended.structuredContent.status,'appended',JSON.stringify(appended));
  const malformed=await f.call('create',{...f.request,path:'bad.md',requestId:'bad-unicode',text:String.fromCharCode(0xd800)});
  assert.equal(malformed.structuredContent.error.code,'append_text_invalid');
  for (const bytes of [Buffer.from([0xff,0xfe]),Buffer.from([65,0,66])]) {
    await fs.writeFile(path.join(f.packageRoot,'existing.md'),bytes);
    const rejected=await f.call('append',{...f.request,path:'existing.md',requestId:'invalid-text',expectedSourceHash:sourceHash(bytes)});
    assert.equal(rejected.structuredContent.error.code,'append_text_invalid');
  }
});

test('write discovery paginates eligible names without returning content and honors per-operation policy', async t => {
  const f=await policyFixture(t);
  for(let i=0;i<101;i++)await fs.writeFile(path.join(f.packageRoot,'fact-'+String(i).padStart(3,'0')+'.md'),'Synthetic fixture');
  await fs.writeFile(path.join(f.packageRoot,'secret.md'),'Excluded fixture');
  const first=await discover(f);
  assert.equal(first.existing.length,100);
  assert.ok(first.existing.every(item=>item.path!=='secret.md'&&!('text'in item)));
  const second=(await f.call('write_targets',{dkbId:f.manifest.name,after:first.nextCursor})).structuredContent.packages[0];
  assert.equal(second.existing.length,2);
  assert.equal(new Set([...first.existing,...second.existing].map(item=>item.path)).size,102);
  await writeJson(f.manifestPath,{...f.manifest,write:{...targeted.write,operations:['create']}});
  const createOnly=await discover(f);
  assert.deepEqual(createOnly.existing,[]);
  assert.deepEqual(createOnly.creation.allow,targeted.write.paths.create);
  assert.equal((await f.call('append',{...f.request,path:'existing.md',expectedSourceHash:sourceHash(original)})).structuredContent.error.code,'append_permission_denied');
});
