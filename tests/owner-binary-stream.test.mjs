import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough, Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import { ownerDockerProcess } from '../apps/cli/dist/host/dockerOwnerProcess.js';

function docker(t, bytes, controller, hang = false) {
  let killed = false, maximumBuffered = 0;
  t.mock.method(cp, 'spawn', (file, args, options) => {
    assert.equal(file, 'docker'); assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough({ highWaterMark: 16384 }); child.stderr = new PassThrough();
    let closed = false;
    const close = code => { if (!closed) { closed = true; child.stderr.end(); child.emit('close', code); } };
    child.kill = () => { killed = true; child.stdout.destroy(); setImmediate(() => close(1)); return true; };
    child.stdin.resume();
    child.stdin.on('finish', () => setImmediate(async () => {
      child.stderr.write('bounded worker diagnostic');
      if (hang) return;
      async function* chunks() {
        for (let offset = 0; offset < bytes; offset += 65536) {
          maximumBuffered = Math.max(maximumBuffered, child.stdout.readableLength);
          yield Buffer.alloc(Math.min(65536, bytes - offset), offset % 251);
          if (controller && offset > 65536) controller.abort();
        }
      }
      try { await pipeline(Readable.from(chunks()), child.stdout); close(0); }
      catch { close(1); }
    }));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { killed: () => killed, buffered: () => maximumBuffered };
}

test('binary Docker output exceeds the JSON limit without buffering, decoding or dropping backpressure', async t => {
  const size = 18 * 1024 * 1024, fixture = docker(t, size), hash = createHash('sha256');
  let received = 0;
  const sink = new Writable({ highWaterMark: 16384, write(bytes, _encoding, done) {
    received += bytes.length; hash.update(bytes); setTimeout(done, 1);
  } });
  const result = await ownerDockerProcess(['fixture'], { stdout: sink, maxStdoutBytes: size, timeoutMs: 10_000 });
  const expected = createHash('sha256');
  for (let offset = 0; offset < size; offset += 65536) expected.update(Buffer.alloc(Math.min(65536, size - offset), offset % 251));
  assert.equal(result.code, 0); assert.equal(result.stdout, ''); assert.equal(received, size);
  assert.equal(hash.digest('hex'), expected.digest('hex')); assert.equal(result.stderr, 'bounded worker diagnostic');
  assert(fixture.buffered() <= 131072); assert.equal(fixture.killed(), false);
});

for (const scenario of ['budget', 'sink', 'cancel', 'timeout']) {
  test(`binary Docker output settles on ${scenario} without leaking destination errors`, async t => {
    const controller = new AbortController();
    const fixture = docker(t, 1024 * 1024, scenario === 'cancel' ? controller : undefined, scenario === 'timeout');
    const sink = new Writable({ write(_bytes, _encoding, done) { done(scenario === 'sink' ? new Error('private-path-and-secret') : undefined); } });
    await assert.rejects(ownerDockerProcess(['fixture'], { stdout: sink, maxStdoutBytes: scenario === 'budget' ? 10 : 2 * 1024 * 1024,
      signal: controller.signal, timeoutMs: scenario === 'timeout' ? 20 : 5000 }), error => {
      assert.equal(error.code, { budget: 'library_owner_output_limit', sink: 'library_owner_output_failed', cancel: 'library_owner_cancelled', timeout: 'library_owner_timeout' }[scenario]);
      assert(!error.message.includes('private-path-and-secret')); return true;
    });
    assert.equal(fixture.killed(), true); assert.equal(sink.destroyed, true);
  });
}

test('binary Docker transport requires a byte budget before starting a process', async t => {
  const spawn = t.mock.method(cp, 'spawn', () => assert.fail('Docker must not start'));
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (const limit of [undefined, 0, -1, Infinity, 0.5]) {
    await assert.rejects(ownerDockerProcess(['fixture'], { stdout: new PassThrough(), maxStdoutBytes: limit }), { code: 'library_owner_output_limit' });
  }
  assert.equal(spawn.mock.callCount(), 0);
});
