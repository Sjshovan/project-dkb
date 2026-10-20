import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { createRoot, writeJson } from './runtime-query-fixture.mjs';

const execute = promisify(execFile);
const cli = new URL('../apps/cli/dist/cli/index.js', import.meta.url).href;

// This is a routing test, not an HTTP or provider proof. Substitute only fetch
// in the child: inventory, command registration, credentials and CLI output are real.
for (const kind of ['docker', 'remote']) {
  test(`${kind} query and Pipeline inspection never use a saved host Runtime path`, async t => {
    const fixture = await setup(t, kind);
    for (const [args, route, token] of [
      [['query', 'owner marker'], '/api/search', 'read'],
      [['read-targets', 'owner marker'], '/api/read-targets', 'read'],
      [['read', fixture.request], '/api/read', 'read'],
      [['pipeline', 'list'], '/api/runtime/pipelines', 'admin'],
      [['pipeline', 'show', 'fixture'], '/api/runtime/pipelines', 'admin'],
      [['pipeline', 'verify', 'fixture'], '/api/runtime/pipelines', 'admin'],
    ]) {
      const result = await run(fixture, args);
      assert.equal(result.code, 0, JSON.stringify({ args, ...result }));
      assert.equal(result.calls.length, 1, JSON.stringify({ args, ...result }));
      assert.equal(result.calls[0].route, route);
      assert.equal(result.calls[0].authorization, `Bearer synthetic-owner-${token}`);
      assert.equal(await fs.readFile(fixture.hostState, 'utf8'), 'not a Runtime directory');
    }
  });

  test(`${kind} failed Pipeline request does not fall back to host files`, async t => {
    const fixture = await setup(t, kind);
    for (const args of [['pipeline', 'list'], ['pipeline', 'show', 'fixture'], ['pipeline', 'verify', 'fixture'], ['pipeline', 'use', 'fixture'], ['query', 'marker']]) {
      const result = await run(fixture, args, true);
      assert.equal(result.code, 1);
      assert.equal(JSON.parse(result.stdout).error.code, 'runtime_transport_failed', JSON.stringify({ args, ...result }));
      assert.equal(result.calls.length, 1);
      assert.equal(await fs.readFile(fixture.hostState, 'utf8'), 'not a Runtime directory');
    }
  });

  test(`${kind} retained Pipeline activation uses the owner receipt without accessing a saved host path`, async t => {
    const fixture = await setup(t, kind);
    const result = await run(fixture, ['pipeline', 'use', 'fixture']);
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(JSON.parse(result.stdout).status, 'pipeline_switched');
    assert.deepEqual(result.calls.map(call => call.route), ['/api/runtime/pipelines', '/api/runtime/pipeline']);
    assert.ok(result.calls.every(call => call.authorization === 'Bearer synthetic-owner-admin'));
    assert.deepEqual(result.calls[1].body, { target: 'fixture', expected: catalog().targets[0].preparation, grants: {} });
    assert.equal(await fs.readFile(fixture.hostState, 'utf8'), 'not a Runtime directory');
  });

  test(`${kind} missing editable builds fail without opening host files or submitting activation`, async t => {
    const fixture = await setup(t, kind);
    const result = await run(fixture, ['pipeline', 'use', 'fixture'], false, 'missing-local');
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'unsupported_capability', JSON.stringify(result));
    assert.deepEqual(result.calls.map(call => call.route), ['/api/runtime/pipelines']);
    assert.equal(await fs.readFile(fixture.hostState, 'utf8'), 'not a Runtime directory');
  });

  test(`${kind} malformed owner preparation cannot reach activation`, async t => {
    const fixture = await setup(t, kind);
    const result = await run(fixture, ['pipeline', 'use', 'fixture'], false, 'malformed');
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'runtime_pipeline_preparation_invalid', JSON.stringify(result));
    assert.deepEqual(result.calls.map(call => call.route), ['/api/runtime/pipelines']);
    assert.equal(await fs.readFile(fixture.hostState, 'utf8'), 'not a Runtime directory');
  });
}

function catalog(scenario = 'ready') {
  const digest = character => 'sha256:' + character.repeat(64);
  const identities = { configDigest: digest('a'), evidenceProfileDigest: digest('b'),
    retrievalProfileDigest: digest('c'), compatibilityDigest: digest('d') };
  const ready = scenario !== 'missing-local';
  return { targets: [{ name: 'fixture', health: 'ready', healthDetails: [], ...identities,
    preparation: scenario === 'malformed' ? null : { format: 'dkb.runtime-pipeline-preparation.v1',
      runtimeId: 'owner', target: 'fixture', selectionDigest: digest('e'), libraryDigest: digest('f'), ...identities },
    coverage: { total: 1, ready: ready ? 1 : 0, packages: [{ id: '@test/knowledge', version: '1.0.0',
      source: 'local', ready, status: ready ? 'ready' : 'missing' }] },
  }], results: [] };
}

async function setup(t, kind) {
  const fixture = await createRoot(t);
  const hostState = path.join(fixture.root, 'host-state');
  await fs.writeFile(hostState, 'not a Runtime directory');
  const inventory = path.join(fixture.root, 'host.json'), request = path.join(fixture.root, 'read.json');
  await writeJson(inventory, { format: 'dkb.host.v2', defaults: { runtime: 'owner' }, libraries: {}, registries: {}, stacks: {},
    runtimes: { owner: { kind, stateRoot: hostState, url: 'http://127.0.0.1:1/owner',
      registeredAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z' } } });
  await writeJson(request, { queries: [{ id: 'proof', operation: 'fetch', target: 'sha256:' + 'a'.repeat(64) }] });
  return { ...fixture, hostState, request, env: { ...process.env,
    DKB_HOST_INVENTORY: inventory, DKB_STACK_STATE_ROOT: path.join(fixture.root, 'stacks'),
    DKB_RUNTIME_CREDENTIALS_ROOT: path.join(fixture.root, 'credentials'),
    DKB_RUNTIME_ADMIN_TOKEN: 'synthetic-owner-admin', DKB_RUNTIME_READ_TOKEN: 'synthetic-owner-read',
    DKB_FORCE_TTY: '0', NO_COLOR: '1', FORCE_COLOR: undefined,
  } };
}

async function run(fixture, args, offline = false, scenario = 'ready') {
  const script = `
    const calls=[];
    globalThis.fetch=async (url, options) => {
      const route=new URL(url).pathname.replace('/owner','');
      calls.push({route, authorization:options.headers.authorization,
        ...(route === '/api/runtime/pipeline' ? {body:JSON.parse(options.body)} : {})});
      if (${offline}) throw new TypeError('synthetic offline');
      return new Response(JSON.stringify(route === '/api/runtime/pipeline'
        ? {status:'pipeline_switched',target:'fixture'} : ${JSON.stringify(catalog(scenario))}));
    };
    process.on('exit',()=>process.stderr.write('ROUTING:'+JSON.stringify(calls)+'\\n'));
    process.argv=[process.execPath,'--json',...${JSON.stringify(args)},'--runtime','owner'];
    await import(${JSON.stringify(cli)});
  `;
  let result;
  try { result = { code: 0, ...await execute(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fixture.root, env: fixture.env, timeout: 30_000, windowsHide: true,
  }) }; } catch (error) {
    assert.equal(error.killed, false, error.message);
    result = { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
  assert.match(result.stderr, /^ROUTING:[^\r\n]+\r?\n$/u,
    `Routing must not load service code before the CLI installs its output contract: ${result.stderr}`);
  return { ...result, calls: JSON.parse(result.stderr.match(/ROUTING:(.*)/u)?.[1] ?? 'null') };
}
