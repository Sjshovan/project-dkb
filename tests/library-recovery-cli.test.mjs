import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyLibraryLock, readLibraryState } from '@sjshovan/dkb-library/state.js';
import { removeLibraryPath, withLibraryMutation, writeLibraryMutationFile } from '@sjshovan/dkb-library/mutation.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repositoryRoot, 'apps/cli/dist/cli/index.js');

for (const displaced of [false, true]) {
  test(`CLI writes queue before context inspection (${displaced ? 'temporarily displaced' : 'present'} manifest); reads stay closed`, async t => {
    const fixture = await createFixture(t);
    const library = await createLibrary(fixture, 'Queued writers');
    const manifest = await fs.readFile(path.join(library, 'dkb.json'));
    let child, completed, stdout = '', stderr = '', closed = false;
    t.after(async () => { if (child && !closed) child.kill('SIGKILL'); await completed; });
    await withLibraryMutation(library, async () => {
      if (displaced) await removeLibraryPath(library, path.join(library, 'dkb.json'));
      child = spawn(process.execPath, [cliPath, '--json-stream', 'collection', 'create', '@proof/queued'], {
        cwd: library, env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      completed = once(child, 'close').then(([code]) => { closed = true; return code; });
      let started;
      const start = new Promise(resolve => { started = resolve; });
      child.stdout.on('data', bytes => { stdout += bytes.toString(); if (stdout.includes('"event":"start"')) started(); });
      child.stderr.on('data', bytes => { stderr += bytes.toString(); });
      let timer;
      try {
        await Promise.race([start, completed.then(() => { throw new Error(`Write stopped before queuing: ${stdout} ${stderr}`); }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Write did not start')), 10_000); })]);
      } finally { clearTimeout(timer); }
      const read = await runCli(fixture, ['--json', 'library', 'status', '--library', library]);
      assert.equal(read.code, 1);
      assert.equal(JSON.parse(read.stdout).error.code, 'library_recovery_required');
      assert.equal(closed, false, `Write should wait for the owner instead of reporting recovery: ${stdout}`);
      if (displaced) await writeLibraryMutationFile(library, path.join(library, 'dkb.json'), manifest);
    });
    let timer;
    try {
      const code = await Promise.race([completed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Queued write did not settle')), 15_000); })]);
      assert.equal(code, 0, stdout + stderr);
    } finally { clearTimeout(timer); }
    const events = stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.at(-1).status, 'succeeded');
    assert.ok(Object.hasOwn((await readLibraryState(library)).entries, '@proof/queued'));
  });
}

test('Library recovery is visible in group and leaf help with explicit root support', async (t) => {
  const fixture = await createFixture(t);
  const group = await runCli(fixture, ['library', '--help']);
  assert.equal(group.code, 0, group.stderr);
  assert.match(group.stdout, /recover\s+\[options\]/u);
  const leaf = await runCli(fixture, ['library', 'recover', '--help']);
  assert.equal(leaf.code, 0, leaf.stderr);
  assert.match(leaf.stdout, /Usage: dkb library recover/u);
  assert.match(leaf.stdout, /--library <library>/u);
  assert.match(leaf.stdout, /manifest\s+is unavailable/u);
  assert.doesNotMatch(leaf.stdout, /\u001b\[/u);
});

test('unchanged Library recovery has concise human and single-document JSON output without refresh', async (t) => {
  const fixture = await createFixture(t);
  const library = await createLibrary(fixture, 'Unchanged');
  let requests = 0;
  const url = await serve(t, (_request, response) => {
    requests += 1;
    response.end('{}');
  });
  await writeInventory(fixture, { target: library }, 'target', {
    local: { kind: 'process', url, library: 'target' },
  });
  const before = await fs.readFile(path.join(library, 'dkb.json'));
  const human = await runCli(fixture, ['--no-progress', 'library', 'recover', '--library', library]);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /Status: unchanged/u);
  assert.ok(human.stdout.includes(`Path: ${library}`));
  assert.match(human.stdout, /Done\./u);
  assert.doesNotMatch(human.stdout + human.stderr, /\u001b\[/u);
  const json = await runCli(fixture, ['--json', 'library', 'recover', '--library', library]);
  assert.equal(json.code, 0, json.stderr);
  assert.equal(json.stderr, '');
  assert.deepEqual(JSON.parse(json.stdout), { status: 'unchanged', libraryPath: library });
  assert.deepEqual(await fs.readFile(path.join(library, 'dkb.json')), before);
  assert.equal(requests, 0);
});

test('Library recovery preserves explicit, environment, nearest, and selected context precedence', async (t) => {
  const fixture = await createFixture(t);
  const selected = await createLibrary(fixture, 'Selected');
  const nearest = await createLibrary(fixture, 'Nearest');
  const environment = await createLibrary(fixture, 'Environment');
  const explicit = await createLibrary(fixture, 'Explicit');
  const child = path.join(nearest, 'nested');
  await fs.mkdir(child);
  await writeInventory(fixture, { selected, named: explicit }, 'selected');
  const cases = [
    { args: ['--library', 'named'], env: { DKB_LIBRARY_PATH: environment }, cwd: child, expected: explicit },
    { args: ['--library', path.relative(child, explicit)], env: { DKB_LIBRARY_PATH: environment }, cwd: child, expected: explicit },
    { args: [], env: { DKB_LIBRARY_PATH: environment }, cwd: child, expected: environment },
    { args: [], cwd: child, expected: nearest },
    { args: [], cwd: fixture.root, expected: selected },
  ];
  for (const example of cases) {
    const result = await runCli(fixture, ['--json', 'library', 'recover', ...example.args], example.env, example.cwd);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).libraryPath, example.expected);
  }
});

for (const mode of ['missing', 'corrupt']) {
  test(`explicit Library recovery restores a ${mode} manifest after real process death; status does not recover`, async (t) => {
    const fixture = await createFixture(t);
    const library = await createLibrary(fixture, `${mode} manifest`);
    const beforeManifest = await fs.readFile(path.join(library, 'dkb.json'));
    const beforeState = await readLibraryState(library);
    await interruptMutation(t, fixture, library, mode);
    const status = await runCli(fixture, ['--json', 'library', 'status', '--library', library]);
    assert.equal(status.code, 1);
    assert.equal(status.stderr, '');
    const failure = JSON.parse(status.stdout);
    assert.equal(failure.ok, false);
    assert.equal(failure.error.code, 'library_recovery_required');
    assert.ok(failure.error.message.includes(`dkb library recover --library "${library}"`));
    const humanFailure = await runCli(fixture, ['library', 'status', '--library', library]);
    assert.equal(humanFailure.code, 1);
    assert.equal(humanFailure.stdout, '');
    assert.match(humanFailure.stderr, /Error:/u);
    assert.ok(humanFailure.stderr.includes(`dkb library recover --library "${library}"`));
    const write = await runCli(fixture, ['--json', 'collection', 'create', '@proof/must-not-write', '--library', library]);
    assert.equal(write.code, 1, write.stdout + write.stderr);
    assert.equal(JSON.parse(write.stdout).error.code, 'library_recovery_required');
    await assert.rejects(fs.access(path.join(library, 'must-not-write')), { code: 'ENOENT' });
    if (mode === 'missing') await assert.rejects(fs.access(path.join(library, 'dkb.json')), { code: 'ENOENT' });
    else assert.equal(await fs.readFile(path.join(library, 'dkb.json'), 'utf8'), '{interrupted');

    const recovery = await runCli(fixture, ['--json', 'library', 'recover', '--library', library]);
    assert.equal(recovery.code, 0, recovery.stderr || recovery.stdout);
    const result = JSON.parse(recovery.stdout);
    assert.equal(result.status, 'rolled_back');
    assert.equal(result.libraryPath, library);
    assert.equal(typeof result.transactionId, 'string');
    assert.deepEqual(result.runtimeRefreshes, []);
    assert.deepEqual(await fs.readFile(path.join(library, 'dkb.json')), beforeManifest);
    assert.deepEqual(await readLibraryState(library), beforeState);
    const repeated = await runCli(fixture, ['--json', 'library', 'recover', '--library', library]);
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.deepEqual(JSON.parse(repeated.stdout), { status: 'unchanged', libraryPath: library });
  });
}

test('registered-name and selected recovery work with displaced manifests', async (t) => {
  const fixture = await createFixture(t);
  const library = await createLibrary(fixture, 'Registered');
  await writeInventory(fixture, { target: library }, 'target');
  for (const args of [['--library', 'target'], []]) {
    await interruptMutation(t, fixture, library, 'missing');
    const status = await runCli(fixture, ['--json', 'library', 'status', ...args]);
    assert.equal(status.code, 1);
    assert.equal(JSON.parse(status.stdout).error.code, 'library_recovery_required');
    const recovery = await runCli(fixture, ['--json', 'library', 'recover', ...args]);
    assert.equal(recovery.code, 0, recovery.stderr || recovery.stdout);
    assert.equal(JSON.parse(recovery.stdout).status, 'rolled_back');
    assert.equal(JSON.parse(recovery.stdout).libraryPath, library);
  }
});

test('actual recovery refreshes only serving local Runtimes and retains stale warnings in human and JSON output', async (t) => {
  const fixture = await createFixture(t);
  fixture.diagnoseTransport = true;
  const library = await createLibrary(fixture, 'Serving');
  const requests = [];
  const transport = {};
  const url = await serve(t, (request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    request.resume();
    response.setHeader('content-type', 'application/json');
    response.statusCode = request.url.startsWith('/offline/') ? 503 : 200;
    response.end(JSON.stringify(response.statusCode === 200 ? { status: 'ready' } : { error: 'Synthetic Runtime unavailable' }));
  }, transport);
  await writeInventory(fixture, { target: library }, 'target', {
    online: { kind: 'process', url: `${url}/online`, library: 'target' },
    offline: { kind: 'docker', url: `${url}/offline`, library: 'target' },
    remote: { kind: 'remote', url: `${url}/remote`, library: 'target' },
  });
  // Exercise the cold-start refresh in JSON first so failures retain the actual
  // per-Runtime stale messages instead of only the human warning summary.
  for (const output of ['--json', '--no-progress']) {
    await interruptMutation(t, fixture, library, 'changed');
    const requestStart = requests.length;
    const result = await runCli(fixture, [output, 'library', 'recover', '--library', library]);
    const iterationRequests = requests.slice(requestStart);
    const diagnostic = JSON.stringify({ output, ...result,
      requests: iterationRequests.map(({ method, url }) => ({ method, url })),
      transport,
    });
    assert.equal(result.code, 0, diagnostic);
    if (output === '--json') {
      assert.equal(result.stderr, '', diagnostic);
      const recovery = JSON.parse(result.stdout);
      assert.equal(recovery.status, 'rolled_back', diagnostic);
      assert.deepEqual(recovery.runtimeRefreshes.map(({ name, status }) => ({ name, status })), [
        { name: 'online', status: 'refreshed' }, { name: 'offline', status: 'stale' },
      ], diagnostic);
      assert.match(recovery.runtimeRefreshes[1].message, /POST \/api\/runtime\/reload failed with HTTP 503/u, diagnostic);
      assert.match(recovery.warning, /dkb runtime refresh offline/u, diagnostic);
    } else {
      assert.match(result.stdout, /Status: rolled back/u, diagnostic);
      assert.match(result.stdout, /Warning: Library update succeeded, but 1 Runtime remains stale:/u, diagnostic);
      assert.match(result.stdout, /dkb runtime refresh offline/u, diagnostic);
      assert.doesNotMatch(result.stdout, /dkb runtime refresh online/u, diagnostic);
    }
    assert.equal(iterationRequests.length, 2, diagnostic);
    assert.deepEqual(iterationRequests.map(({ method, url }) => ({ method, url })).sort((left, right) => left.url.localeCompare(right.url)), [
      { method: 'POST', url: '/offline/api/runtime/reload' },
      { method: 'POST', url: '/online/api/runtime/reload' },
    ], diagnostic);
    assert.ok(iterationRequests.every((request) => request.authorization === 'Bearer synthetic-recovery-admin'), diagnostic);
  }
  assert.equal(requests.length, 4);
  assert.ok(requests.every((request) => request.method === 'POST' && request.url.endsWith('/api/runtime/reload')));
  assert.ok(requests.every((request) => request.authorization === 'Bearer synthetic-recovery-admin'));
  assert.ok(requests.every((request) => !request.url.startsWith('/remote/')));
});

test('offline Library and Collection mutations preserve Runtime recovery guidance in every output mode', async (t) => {
  const fixture = await createFixture(t);
  const library = await createLibrary(fixture, 'Mutation warnings');
  const url = await serve(t, (request, response) => {
    request.resume();
    response.statusCode = 503;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ error: 'Synthetic Runtime unavailable' }));
  });
  await writeInventory(fixture, { target: library }, 'target', {
    offline: { kind: 'process', url, library: 'target' },
  });
  for (const [index, output] of ['--json', '--json-stream', '--no-progress'].entries()) {
    const identity = `@proof/warning-${index}`;
    for (const args of [['collection', 'create', identity], ['library', 'remove', identity], ['library', 'add', identity],
      ['registry', 'use', `https://registry-${index}.example`, '--root', 'target', '--no-verify']]) {
      const result = await runCli(fixture, [output, ...args]);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, /\u001b\[/u);
      if (output === '--no-progress') {
        assert.match(result.stdout, /Library update succeeded, but 1 Runtime remains stale:/u);
        assert.match(result.stdout, /dkb runtime refresh offline/u);
        assert.match(result.stdout, /Done\./u);
      } else {
        const events = output === '--json-stream' ? result.stdout.trim().split('\n').map(JSON.parse) : [];
        const value = events.length ? events.find(event => event.event === 'result').value : JSON.parse(result.stdout);
        assert.match(value.warning, /dkb runtime refresh offline/u);
        assert.equal(value.runtimeRefreshes[0].status, 'stale');
        if (events.length) {
          assert.equal(events.filter(event => event.event === 'result').length, 1);
          assert.ok(events.some(event => event.event === 'warning' && event.message.includes('dkb runtime refresh offline')));
          assert.equal(events.at(-1).status, 'succeeded');
        }
      }
    }
  }
});

test('CLI recovery retains a committed generation after process death during cleanup and refreshes once', async (t) => {
  const fixture = await createFixture(t);
  const library = await createLibrary(fixture, 'Committed');
  let requests = 0;
  const url = await serve(t, (request, response) => {
    requests += 1;
    request.resume();
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ status: 'ready' }));
  });
  await writeInventory(fixture, { target: library }, 'target', {
    local: { kind: 'process', url, library: 'target' },
  });
  await interruptMutation(t, fixture, library, 'committed');
  const recovery = await runCli(fixture, ['--json', 'library', 'recover', '--library', library]);
  assert.equal(recovery.code, 0, recovery.stderr || recovery.stdout);
  const result = JSON.parse(recovery.stdout);
  assert.equal(result.status, 'committed');
  assert.equal(result.libraryPath, library);
  assert.equal(result.runtimeRefreshes[0].status, 'refreshed');
  assert.equal((await readLibraryState(library)).generation, 2);
  assert.equal(JSON.parse(await fs.readFile(path.join(library, 'dkb.json'), 'utf8')).displayName, 'Interrupted edit');
  const repeated = await runCli(fixture, ['--json', 'library', 'recover', '--library', library]);
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).status, 'unchanged');
  assert.equal(requests, 1);
});

async function createFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-library-recovery-cli-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('dkb-library-recovery-cli-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ format: 'dkb.config.v2' }));
  const stackRoot = path.join(root, 'stacks');
  await fs.mkdir(stackRoot);
  return { root, env: {
    ...process.env,
    DKB_GLOBAL_ROOT: path.join(root, 'global'),
    DKB_CLI_CONFIG: configPath,
    DKB_HOST_INVENTORY: path.join(root, 'host.json'),
    DKB_RUNTIME_CREDENTIALS_ROOT: path.join(root, 'credentials'),
    DKB_STACK_STATE_ROOT: stackRoot,
    DKB_LIBRARY_PATH: '',
    DKB_RUNTIME_URL: '',
    DKB_RUNTIME_ADMIN_TOKEN: 'synthetic-recovery-admin',
    DKB_RUNTIME_READ_TOKEN: '',
    DKB_FORCE_TTY: '0',
    FORCE_COLOR: undefined,
    NO_COLOR: '1',
  } };
}

async function createLibrary(fixture, name) {
  const root = path.join(fixture.root, name);
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'dkb.json'), `${JSON.stringify({ type: 'library', name, roots: {} })}\n`);
  await applyLibraryLock(root, { library: { name }, generation: 1, entries: {}, resolvedAt: '2026-09-14T00:00:00.000Z' });
  return root;
}

async function writeInventory(fixture, libraries, selected, runtimes = {}) {
  const timestamps = { registeredAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z' };
  await fs.writeFile(fixture.env.DKB_HOST_INVENTORY, JSON.stringify({
    format: 'dkb.host.v2', defaults: { library: selected },
    libraries: Object.fromEntries(Object.entries(libraries).map(([name, libraryPath]) => [name, { path: libraryPath, displayName: name, ...timestamps }])),
    runtimes: Object.fromEntries(Object.entries(runtimes).map(([name, runtime]) => [name, { ...runtime, ...timestamps }])),
    registries: {}, stacks: {},
  }));
}

async function runCli(fixture, args, extraEnv = {}, cwd = fixture.root) {
  const diagnosticsPath = path.join(fixture.root, 'transport-diagnostics.json');
  const preload = fixture.diagnoseTransport
    ? ['--import', new URL('./fixtures/loopback-transport-diagnostics.mjs', import.meta.url).href] : [];
  const child = spawn(process.execPath, [...preload, cliPath, ...args], {
    cwd, env: { ...fixture.env, ...extraEnv,
      ...(fixture.diagnoseTransport ? { DKB_TEST_TRANSPORT_DIAGNOSTICS: diagnosticsPath } : {}),
    }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 30_000);
  try {
    const [code] = await once(child, 'close');
    assert.equal(timedOut, false, `CLI timed out: ${stderr}`);
    return { code, stdout, stderr,
      ...(fixture.diagnoseTransport ? { clientTransport: JSON.parse(await fs.readFile(diagnosticsPath, 'utf8')) } : {}),
    };
  } finally { clearTimeout(timer); }
}

async function interruptMutation(t, fixture, library, mode) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import { withLibraryMutation, removeLibraryPath, writeLibraryMutationFile } from '@sjshovan/dkb-library/mutation.js';
    import { applyLibraryLock } from '@sjshovan/dkb-library/state.js';
    process.on('message', () => {});
    const root = process.env.DKB_TEST_RECOVERY_ROOT;
    const target = path.join(root, 'dkb.json');
    const committed = process.env.DKB_TEST_RECOVERY_MODE === 'committed';
    if (committed) {
      const remove = fs.rm;
      const transactions = path.join(root, '.dkb', 'transactions') + path.sep;
      fs.rm = async (candidate, options) => {
        if (String(candidate).startsWith(transactions) && String(candidate).endsWith('.backup')) {
          process.send('prepared');
          await new Promise(() => {});
        }
        return remove(candidate, options);
      };
    }
    await withLibraryMutation(root, async () => {
      if (process.env.DKB_TEST_RECOVERY_MODE === 'missing') await removeLibraryPath(root, target);
      else {
        const manifest = JSON.parse(await fs.readFile(target, 'utf8'));
        const bytes = process.env.DKB_TEST_RECOVERY_MODE === 'corrupt' ? '{interrupted' : JSON.stringify({ ...manifest, displayName: 'Interrupted edit' });
        await writeLibraryMutationFile(root, target, Buffer.from(bytes));
      }
      if (committed) {
        const lock = JSON.parse(await fs.readFile(path.join(root, 'dkb-lock.json'), 'utf8'));
        await applyLibraryLock(root, { ...lock, generation: lock.generation + 1 });
      } else {
        process.send('prepared');
        await new Promise(() => {});
      }
    });
  `], {
    cwd: repositoryRoot,
    env: { ...fixture.env, DKB_TEST_RECOVERY_ROOT: library, DKB_TEST_RECOVERY_MODE: mode },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = once(child, 'close');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
  let timer;
  try {
    await Promise.race([
      once(child, 'message').then(([message]) => assert.equal(message, 'prepared')),
      closed.then(() => { throw new Error(`Mutation child stopped before preparation: ${stderr}`); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Mutation child timed out: ${stderr}`)), 15_000); }),
    ]);
    child.kill('SIGKILL');
    await closed;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; }
  }
}

async function serve(t, listener, diagnostics) {
  const server = http.createServer(listener);
  if (diagnostics) {
    // Failure evidence only: never warm the connection, retry, or extend a deadline.
    const lag = monitorEventLoopDelay({ resolution: 20 });
    lag.enable();
    diagnostics.acceptedConnections = 0;
    server.on('connection', () => diagnostics.acceptedConnections++);
    Object.defineProperties(diagnostics, {
      listening: { enumerable: true, get: () => server.listening },
      maxEventLoopDelayMs: { enumerable: true, get: () => Math.round(lag.max / 1e6) },
    });
    t.after(() => lag.disable());
  }
  t.after(() => new Promise((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
