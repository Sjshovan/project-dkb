import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CONSOLE_OPERATION_RETENTION,
  CONSOLE_OUTPUT_LINE_BYTES,
  ConsoleCommandRunner,
  ConsoleRunnerBusyError,
  startDkbConsoleServer,
} from '@sjshovan/dkb-console';
import { ConsoleActivityStore } from '../apps/console/dist/server/activity.js';

test('Console bounds terminal count in completion order and keeps Activity summaries', async (t) => {
  const { runner, activity } = await fixture(t, `await emit('result', { value: { status: 'complete' } }); await emit('completion', { status: 'succeeded' });`, { completedLimit: 2 });
  const first = await runner.run('library.list', {});
  const second = await runner.run('library.list', {});
  const third = await runner.run('library.list', {});
  assert.equal(runner.get(first.id), undefined);
  assert.equal(runner.get(second.id), second);
  assert.equal(runner.get(third.id), third);
  assert.equal(activity.list().activities.length, 3);
  assert.ok(activity.list().activities.every((item) => item.status === 'succeeded'));
});

test('Console terminal TTL starts at child closure and expires without additional traffic', async (t) => {
  let now = 100;
  let reads = 0;
  const { runner } = await fixture(t, `await emit('result', { value: [] }); await emit('completion', { status: 'succeeded' });`, { completedTtlMs: 20 }, () => { reads += 1; return now; });
  const operation = await runner.run('library.list', {});
  now = 119;
  assert.equal(runner.get(operation.id), operation);
  now = 120;
  const before = reads;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(reads > before, 'idle sweep reads the clock without get/start');
  assert.equal(runner.get(operation.id), undefined);
});

test('Console eviction follows completion order even when the clock is tied', async (t) => {
  const { runner, root } = await fixture(t, `
    if (process.argv.includes('hold')) {
      await emit('start', { label: 'waiting' });
      while (!(await fs.stat(path.join(root, 'release')).catch(() => null))) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await emit('completion', { status: 'succeeded' });
  `, { completedLimit: 1 }, () => 100);
  const slow = runner.start('library.use', { name: 'hold' });
  const fast = await runner.run('library.list', {});
  assert.equal(runner.get(fast.id), fast);
  const done = completed(runner, slow);
  await fs.writeFile(path.join(root, 'release'), 'ready');
  await done;
  assert.equal(runner.get(fast.id), undefined);
  assert.equal(runner.get(slow.id), slow);
});

test('Console counts full UTF-8 results and replay toward the total terminal byte budget', async (t) => {
  const value = { text: 'é'.repeat(1_000) };
  const { runner } = await fixture(t, `await emit('result', { value: ${JSON.stringify(value)} }); await emit('completion', { status: 'succeeded' });`, { completedBytes: 6_500 });
  const first = await runner.run('library.list', {});
  const second = await runner.run('library.list', {});
  assert.ok(Buffer.byteLength(JSON.stringify(first)) + Buffer.byteLength(JSON.stringify(second)) > 6_500);
  assert.equal(runner.get(first.id), undefined);
  assert.deepEqual(runner.get(second.id).result, value);
  assert.deepEqual(first.result, value, 'eviction does not truncate an already returned result');
});

test('Console preserves empty, null, false, and full result values', async (t) => {
  const values = [null, false, 0, '', [], {}, { text: 'large'.repeat(100_000) }];
  const { runner } = await fixture(t, `
    const values = ${JSON.stringify(values)};
    for (const value of values) await emit('result', { value });
    await emit('completion', { status: 'succeeded' });
  `);
  const live = [];
  const operation = runner.start('library.list', {});
  runner.subscribe(operation.id, (event) => live.push(event));
  await completed(runner, operation);
  assert.deepEqual(live.filter((event) => event.event === 'result').map((event) => event.value), values);
  assert.deepEqual(operation.result, values.at(-1));
  assert.equal(operation.status, 'succeeded');
});

test('Console caps replay count, marks omissions, and preserves original live events and sequence numbers', async (t) => {
  const { runner } = await fixture(t, `
    await emit('result', { value: 'old result' });
    for (let i = 0; i < 600; i += 1) await emit('progress', { phase: 'test', label: 'working', value: i, total: 600, unit: 'steps' });
    await emit('result', { value: { full: 'current result' } });
    await emit('failure', { error: { code: 'ORIGINAL', message: 'Keep this exact failure.' } });
    await emit('completion', { status: 'failed' });
    process.exitCode = 1;
  `);
  const operation = runner.start('library.list', {});
  const live = [];
  runner.subscribe(operation.id, (event) => live.push(event));
  await completed(runner, operation);
  assert.equal(live.length, 604);
  assert.deepEqual(live.map((event) => event.sequence), Array.from({ length: 604 }, (_, index) => index));
  assert.equal(live.some((event) => event.event === 'warning'), false);
  assert.equal(operation.events.length, CONSOLE_OPERATION_RETENTION.replayEvents);
  assert.match(operation.events[0].message, /replay events were discarded/u);
  assertIncreasing(operation.events);
  assert.deepEqual(operation.result, { full: 'current result' });
  for (const type of ['result', 'failure', 'completion']) {
    assert.deepEqual(operation.events.findLast((event) => event.event === type), live.findLast((event) => event.event === type));
  }
});

test('Console caps replay UTF-8 bytes while retaining complete terminal records', async (t) => {
  const { runner } = await fixture(t, `
    const text = 'é'.repeat(600_000);
    for (let i = 0; i < 8; i += 1) await emit('progress', { phase: 'test', label: text, value: i, total: 8, unit: 'steps' });
    await emit('result', { value: { text } });
    await emit('failure', { error: { code: 'ORIGINAL', message: text } });
    await emit('completion', { status: 'failed' });
    process.exitCode = 1;
  `);
  const operation = await runner.run('library.list', {});
  assert.ok(Buffer.byteLength(JSON.stringify(operation.events)) <= CONSOLE_OPERATION_RETENTION.replayBytes);
  assert.match(operation.events[0].message, /replay events were discarded/u);
  assert.equal(operation.result.text, 'é'.repeat(600_000));
  assert.equal(operation.events.find((event) => event.event === 'failure').error.message, 'é'.repeat(600_000));
  assert.equal(operation.events.at(-1).status, 'failed');
  assertIncreasing(operation.events);
});

test('Console retains active and queued mutations beyond TTL and rejects excess admissions before starting them', async (t) => {
  let now = 0;
  const { runner, root, activity } = await fixture(t, `
    await emit('start', { label: 'waiting' });
    while (!(await fs.stat(path.join(root, 'release')).catch(() => null))) await new Promise((resolve) => setTimeout(resolve, 10));
    await emit('completion', { status: 'succeeded' });
  `, { activeLimit: 2, completedLimit: 1, completedTtlMs: 10 }, () => now);
  const first = runner.start('library.use', { name: 'personal' });
  const second = runner.start('library.use', { name: 'personal' });
  await waitFor(() => first.events.length > 0);
  now = 1_000_000;
  assert.equal(runner.get(first.id).status, 'running');
  assert.equal(runner.get(second.id).status, 'queued');
  assert.throws(() => runner.start('library.list', {}), ConsoleRunnerBusyError);
  assert.equal(activity.list().pagination.total, 2);
  const done = Promise.all([completed(runner, first), completed(runner, second)]);
  await fs.writeFile(path.join(root, 'release'), 'ready');
  await done;
  assert.equal(first.status, 'succeeded');
  assert.equal(second.status, 'succeeded');
  assert.equal(runner.get(first.id), undefined);
  assert.equal(runner.get(second.id), second);
});

test('Console close cancels queued work, releases listeners/history, and rejects later starts', async (t) => {
  const { runner, root } = await fixture(t, `
    await fs.appendFile(path.join(root, 'started'), 'started\\n');
    await emit('start', { label: 'waiting' });
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  `);
  const first = runner.start('library.use', { name: 'personal' });
  const queued = runner.start('library.use', { name: 'personal' });
  const events = [];
  runner.subscribe(queued.id, (event) => events.push(event));
  await waitFor(() => first.events.length > 0);
  await runner.close();
  assert.equal(queued.status, 'cancelled');
  assert.deepEqual(events.map((event) => event.event), ['cancellation', 'completion']);
  assert.equal(await fs.readFile(path.join(root, 'started'), 'utf8'), 'started\n');
  assert.equal(runner.get(first.id), undefined);
  assert.equal(runner.get(queued.id), undefined);
  assert.throws(() => runner.start('library.list', {}), ConsoleRunnerBusyError);
  assert.doesNotThrow(runner.subscribe('missing', () => assert.fail('unexpected listener')));
  await runner.close();
});

test('Console reports oversized UTF-8 output before a newline without silently truncating a result', async (t) => {
  const { runner } = await fixture(t, `
    await emit('result', { value: [] });
    process.stdout.write(JSON.stringify({ format: 'dkb.command-event.v1', sequence: sequence++, timestamp: new Date().toISOString(), event: 'result', value: 'é'.repeat(1_100_000) }));
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  `);
  const operation = await runner.run('library.list', {});
  assert.equal(operation.status, 'failed');
  assert.deepEqual(operation.result, [], 'last valid result remains whole');
  const failure = operation.events.findLast((event) => event.event === 'failure');
  assert.equal(failure.error.code, 'CONSOLE_OUTPUT_TOO_LARGE');
  assert.match(failure.error.message, new RegExp(`${CONSOLE_OUTPUT_LINE_BYTES}-byte UTF-8`));
  assert.match(failure.error.message, /not truncated/u);
  assert.equal(operation.events.at(-1).status, 'failed');
  assertIncreasing(operation.events);
});

test('Console waits for child closure and refuses a successful completion followed by failure', async (t) => {
  const { runner, root } = await fixture(t, `
    await emit('result', { value: { status: 'written' } });
    await emit('completion', { status: 'succeeded' });
    await fs.writeFile(path.join(root, 'completion-written'), 'ready');
    while (!(await fs.stat(path.join(root, 'release')).catch(() => null))) await new Promise((resolve) => setTimeout(resolve, 10));
    process.exitCode = 7;
  `);
  const operation = runner.start('library.list', {});
  const events = [];
  runner.subscribe(operation.id, (event) => events.push(event));
  await waitFor(async () => Boolean(await fs.stat(path.join(root, 'completion-written')).catch(() => null)));
  assert.equal(runner.get(operation.id).status, 'running');
  assert.equal(events.some((event) => event.event === 'completion'), false);
  const done = completed(runner, operation);
  await fs.writeFile(path.join(root, 'release'), 'ready');
  await done;
  assert.equal(operation.status, 'failed');
  assert.equal(events.filter((event) => event.event === 'completion').length, 1);
  assert.match(events.find((event) => event.event === 'failure').error.message, /status 7/u);
  assert.deepEqual(operation.result, { status: 'written' });
});

test('Console rejects malformed output and sequences without hiding the terminal failure', async (t) => {
  for (const output of ['not-json', 'null', JSON.stringify({ format: 'dkb.command-event.v1', event: 'failure', sequence: 0, timestamp: 'test', error: null })]) {
    const { runner } = await fixture(t, `process.stdout.write(${JSON.stringify(output + '\n')});`);
    const operation = await runner.run('library.list', {});
    assert.equal(operation.status, 'failed');
    assert.equal(operation.events.find((event) => event.event === 'failure').error.code, 'CONSOLE_INVALID_OUTPUT');
  }
});

test('Console reports invalid output after a buffered completion as failure', async (t) => {
  const { runner } = await fixture(t, `await emit('completion', { status: 'succeeded' }); await emit('result', { value: 'too late' });`);
  const operation = await runner.run('library.list', {});
  assert.equal(operation.status, 'failed');
  assert.equal(operation.events.find((event) => event.event === 'failure').error.code, 'CONSOLE_INVALID_OUTPUT');
  assert.equal(operation.events.filter((event) => event.event === 'completion').length, 1);
  assertIncreasing(operation.events);
});

test('Console detaches a failing listener without hiding the error or interrupting other listeners', async (t) => {
  const warnings = [];
  t.mock.method(process, 'emitWarning', (error) => warnings.push(error.message));
  const { runner } = await fixture(t, `await emit('result', { value: [] }); await emit('completion', { status: 'succeeded' });`);
  const operation = runner.start('library.list', {});
  runner.subscribe(operation.id, () => { throw new Error('Disconnected test listener'); });
  await completed(runner, operation);
  assert.equal(operation.status, 'succeeded');
  assert.deepEqual(warnings, ['Disconnected test listener']);
});

test('Console reports Activity persistence failure instead of advertising success', async (t) => {
  const { runner, activity } = await fixture(t, `await emit('result', { value: [] }); await emit('completion', { status: 'succeeded' });`);
  t.mock.method(activity, 'finish', () => { throw new Error('test storage failure'); });
  const operation = await runner.run('library.list', {});
  assert.equal(operation.status, 'failed');
  assert.equal(operation.events.find((event) => event.event === 'failure').error.code, 'CONSOLE_ACTIVITY_FAILED');
  assert.deepEqual(operation.result, []);
  assertIncreasing(operation.events);
});

test('Console binds its real server atomically and secures the OS-assigned fallback port', async t => {
  const listen = net.Server.prototype.listen;
  const ports = [];
  t.mock.method(net.Server.prototype, 'listen', function (...args) {
    const port = typeof args[0] === 'object' ? args[0].port : args[0];
    ports.push(port);
    if (port === 7338) {
      queueMicrotask(() => this.emit('error', Object.assign(new Error('Synthetic occupied preferred port'), { code: 'EADDRINUSE' })));
      return this;
    }
    return listen.apply(this, args);
  });
  const { server } = await serverFixture(t, '', { port: undefined });
  assert.deepEqual(ports, [7338, 0], 'bind directly, without probing and releasing another socket');
  assert.ok(Number(new URL(server.url).port) > 0);
  assert.equal((await fetch(`${server.url}/healthz`)).status, 200);
  assert.equal((await server.app.inject({ url: '/healthz', headers: { host: '127.0.0.1:0' } })).statusCode, 421);
  assert.equal((await fetch(`${server.url}/healthz`, { headers: { origin: 'http://127.0.0.1:0' } })).status, 403);
});

test('Console explicit port conflicts fail and preserve the running Console process state', async t => {
  const { server, root, cliEntrypoint } = await serverFixture(t, '');
  const statePath = path.join(root, 'server-state', 'process.json');
  const before = await fs.readFile(statePath);
  await assert.rejects(startDkbConsoleServer({ cliEntrypoint, cwd: root, webRoot: path.join(root, 'web'),
    bootstrapSecret: 'failed-startup-secret', port: Number(new URL(server.url).port) }), { code: 'EADDRINUSE' });
  assert.deepEqual(await fs.readFile(statePath), before);
  assert.equal((await fetch(`${server.url}/healthz`)).status, 200);
});

test('Console HTTP returns expiry guidance, streams original events, and replays a bounded ordered history', async (t) => {
  const { server, headers, root } = await serverFixture(t, `
    await emit('start', { label: 'waiting' });
    while (!(await fs.stat(path.join(root, 'release')).catch(() => null))) await new Promise((resolve) => setTimeout(resolve, 10));
    for (let i = 0; i < 600; i += 1) await emit('progress', { phase: 'test', label: 'working', value: i, total: 600, unit: 'steps' });
    await emit('result', { value: { full: 'original' } });
    await emit('completion', { status: 'succeeded' });
  `);
  for (const suffix of ['', '/events']) {
    const missing = await fetch(`${server.url}/api/v1/operations/expired${suffix}`, { headers });
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /Result expired.*check Activity\/current resource before retrying/u);
  }
  const response = await postOperation(server, headers);
  assert.equal(response.status, 202);
  const { operationId } = await response.json();
  const liveResponse = await fetch(`${server.url}/api/v1/operations/${operationId}/events`, { headers });
  const liveBody = liveResponse.text();
  await fs.writeFile(path.join(root, 'release'), 'ready');
  const live = sseEvents(await liveBody);
  assert.equal(live.length, 603);
  assert.equal(live.some((event) => event.event === 'warning'), false);
  assertIncreasing(live);
  const replayResponse = await fetch(`${server.url}/api/v1/operations/${operationId}/events`, { headers });
  const replay = sseEvents(await replayResponse.text());
  assert.equal(replay.length, CONSOLE_OPERATION_RETENTION.replayEvents);
  assert.match(replay[0].message, /replay events were discarded/u);
  assertIncreasing(replay);
  assert.deepEqual(replay.at(-2).value, { full: 'original' });
  assert.deepEqual(replay.at(-1), live.at(-1));
});

test('Console HTTP rejects excess queued commands with 503 and starts no rejected mutation', async (t) => {
  const { server, headers, root } = await serverFixture(t, `
    await fs.appendFile(path.join(root, 'started'), 'started\\n');
    await emit('start', { label: 'waiting' });
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  `);
  for (let index = 0; index < CONSOLE_OPERATION_RETENTION.activeLimit; index += 1) {
    const response = await postOperation(server, headers);
    assert.equal(response.status, 202);
    await response.json();
  }
  const rejected = await postOperation(server, headers);
  assert.equal(rejected.status, 503);
  assert.match((await rejected.json()).error, /No command was started/u);
  const activity = await (await fetch(`${server.url}/api/v1/activity`, { headers })).json();
  assert.equal(activity.pagination.total, CONSOLE_OPERATION_RETENTION.activeLimit);
  await waitFor(async () => Boolean(await fs.stat(path.join(root, 'started')).catch(() => null)));
  await server.close();
  assert.equal(await fs.readFile(path.join(root, 'started'), 'utf8'), 'started\n');
});

test('Console disconnects a stalled SSE reader without cancelling or retrying its mutation', { timeout: 30_000 }, async (t) => {
  const { server, headers, root } = await serverFixture(t, `
    await fs.appendFile(path.join(root, 'started'), 'started\\n');
    await emit('start', { label: 'waiting' });
    while (!(await fs.stat(path.join(root, 'release')).catch(() => null))) await new Promise((resolve) => setTimeout(resolve, 10));
    const text = 'x'.repeat(400_000);
    for (let i = 0; i < 64; i += 1) await emit('progress', { phase: 'test', label: text, value: i, total: 64, unit: 'steps' });
    await emit('result', { value: { mutation: 'complete' } });
    await emit('completion', { status: 'succeeded' });
  `);
  const response = await postOperation(server, headers);
  const { operationId } = await response.json();
  const stalled = await fetch(`${server.url}/api/v1/operations/${operationId}/events`, { headers });
  const healthy = await fetch(`${server.url}/api/v1/operations/${operationId}/events`, { headers });
  const healthyBody = healthy.text();
  await fs.writeFile(path.join(root, 'release'), 'ready');
  const events = sseEvents(await healthyBody);
  assert.equal(events.length, 67);
  assert.equal(events.at(-1).status, 'succeeded');
  assert.deepEqual(events.at(-2).value, { mutation: 'complete' });
  await assert.rejects(stalled.text(), /terminated|abort|socket/u);
  const operation = await (await fetch(`${server.url}/api/v1/operations/${operationId}`, { headers })).json();
  assert.equal(operation.status, 'succeeded');
  assert.equal(await fs.readFile(path.join(root, 'started'), 'utf8'), 'started\n');
});

test('Console cancellation cooperates with an IPC-ready CLI and waits for cleanup before completion', async t => {
  const { runner, root } = await fixture(t, `
    process.send({ format: 'dkb.cli-control.v1', event: 'ready' });
    process.on('message', async value => {
      if (value?.event !== 'cancel') return;
      await new Promise(resolve => setTimeout(resolve, 100));
      await fs.writeFile(path.join(root, 'cleanup-confirmed'), 'done');
      await emit('cancellation', { reason: 'Owner cleanup complete.' });
      await emit('completion', { status: 'cancelled' });
      process.disconnect();
    });
    await fs.writeFile(path.join(root, 'ready'), 'ready');
    await emit('start', { label: 'Waiting for cancellation' });
  `);
  const operation = runner.start('library.list', {});
  await waitFor(() => operation.events.some(event => event.event === 'start'));
  assert.equal(runner.cancel(operation.id), true);
  await completed(runner, operation);
  assert.equal(operation.status, 'cancelled');
  assert.equal(await fs.readFile(path.join(root, 'cleanup-confirmed'), 'utf8'), 'done');
});

async function fixture(t, body, retention, now) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-console-retention-'));
  const beforeCleanup = [];
  let runner;
  let activity;
  t.after(async () => {
    for (const cleanup of beforeCleanup) await cleanup();
    await runner?.close();
    activity?.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const cliEntrypoint = path.join(root, 'fake-cli.mjs');
  await fs.writeFile(cliEntrypoint, `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import { once } from 'node:events';
    const root = ${JSON.stringify(root)};
    let sequence = 0;
    async function emit(event, fields) {
      const line = JSON.stringify({ format: 'dkb.command-event.v1', sequence: sequence++, timestamp: new Date().toISOString(), event, ...fields }) + '\\n';
      if (!process.stdout.write(line)) await once(process.stdout, 'drain');
    }
    ${body}
  `);
  activity = new ConsoleActivityStore(path.join(root, 'activity.sqlite'));
  runner = new ConsoleCommandRunner({ cliEntrypoint, cwd: root, activity, retention, now });
  return { runner, activity, root, cliEntrypoint, beforeCleanup };
}

async function serverFixture(t, body, options = {}) {
  const fixtureData = await fixture(t, body);
  const previousStateRoot = process.env.DKB_CONSOLE_STATE_ROOT;
  process.env.DKB_CONSOLE_STATE_ROOT = path.join(fixtureData.root, 'server-state');
  let server;
  fixtureData.beforeCleanup.push(async () => {
    await server?.close();
    if (previousStateRoot === undefined) delete process.env.DKB_CONSOLE_STATE_ROOT;
    else process.env.DKB_CONSOLE_STATE_ROOT = previousStateRoot;
  });
  const webRoot = path.join(fixtureData.root, 'web');
  await fs.mkdir(webRoot);
  await fs.writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>Console test</title>');
  server = await startDkbConsoleServer({ cliEntrypoint: fixtureData.cliEntrypoint, cwd: fixtureData.root, webRoot, bootstrapSecret: 'test-only-bootstrap', port: 0, ...options });
  const bootstrap = await fetch(`${server.url}/api/session/bootstrap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: 'test-only-bootstrap' }) });
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const { csrf } = await bootstrap.json();
  return { ...fixtureData, server, headers: { cookie, 'content-type': 'application/json', 'x-dkb-csrf': csrf } };
}

function postOperation(server, headers) {
  return fetch(`${server.url}/api/v1/operations`, { method: 'POST', headers, body: JSON.stringify({ commandId: 'library.use', input: { name: 'personal' } }) });
}

function sseEvents(body) {
  return body.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
}

function completed(runner, operation) {
  if (['succeeded', 'failed', 'cancelled'].includes(operation.status)) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = runner.subscribe(operation.id, (event) => {
      if (event.event === 'completion') { unsubscribe(); resolve(); }
    });
  });
}

async function waitFor(predicate) {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, 'timed out waiting for fixture');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function assertIncreasing(events) {
  for (let index = 1; index < events.length; index += 1) assert.ok(events[index].sequence > events[index - 1].sequence);
}
