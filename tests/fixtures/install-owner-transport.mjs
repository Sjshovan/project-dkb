// Child-process Docker double: never contacts a real daemon or opens Library state.
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';

let input = '';
for await (const bytes of process.stdin) input += bytes;
const { scenario, request } = JSON.parse(input);
const image = `sha256:${'a'.repeat(64)}`, container = 'b'.repeat(64), scratch = 'c'.repeat(64);
const controller = new AbortController(), calls = [];
let created = false, removed = false, started = false;
cp.spawn = (file, args, options) => {
  assert.equal(file, 'docker'); assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
  for (const grant of request.members ?? [request]) assert.equal(JSON.stringify({ args, options }).includes(grant.installGrant), false);
  const command = args.slice(2); calls.push(command);
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let stdin = '', closed = false;
  child.stdin.on('data', bytes => stdin += bytes);
  const finish = (output = '', code = 0) => {
    if (closed) return;
    closed = true; child.stdout.write(output); child.emit('close', code);
  };
  child.kill = () => { queueMicrotask(() => finish('', 1)); return true; };
  child.stdin.on('finish', () => setImmediate(() => {
    if (command[0] === 'context') return finish(JSON.stringify([{ Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }]));
    if (command[0] === 'image') return finish(JSON.stringify([{ Id: image, Os: 'linux', Config: { Labels: {
      'dev.dkb.library-install.protocol': 'dkb.library-install.v2', 'org.opencontainers.image.version': '0.2.0',
      'dev.dkb.library-collection-install.protocol': 'dkb.library-collection-install.v1',
    } } }]));
    if (command[0] === 'volume') {
      assert.equal(command[1], 'inspect');
      return finish(JSON.stringify([{ Name: command[2], Driver: 'local', Scope: 'local',
        Options: scenario === 'scratch-bind' && command[2] === scratch ? { type: 'none', o: 'bind', device: '/host' } : null,
        Mountpoint: `/var/lib/docker/volumes/${command[2]}/_data` }]));
    }
    if (command[0] === 'create') {
      assert.equal(command[command.indexOf('--network') + 1], 'bridge');
      assert.ok(command.includes('--rm')); assert.ok(command.includes('--read-only'));
      assert.equal(command[command.indexOf('--pull') + 1], 'never');
      const mounts = command.flatMap((value, index) => value === '--mount' ? [command[index + 1]] : []);
      assert.deepEqual(mounts, ['type=volume,dst=/scratch,volume-driver=local,volume-nocopy',
        'type=volume,src=proof-library,dst=/library,volume-nocopy']);
      assert.equal(command.at(-2), image);
      assert.equal(command.at(-1), '/workspace/apps/cli/dist/host/libraryInstallWorker.js');
      assert.equal(command.includes('--env'), false);
      if (scenario === 'create-unconfirmed') return finish('', 1);
      created = true;
      if (scenario === 'cancel-create') controller.abort();
      if (scenario === 'create-reply-lost') return finish('', 1);
      return finish(container);
    }
    if (command[0] === 'container' && command[1] === 'inspect') return finish(JSON.stringify([{ Mounts: [{
      Type: scenario === 'scratch-type' ? 'bind' : 'volume', Name: scratch, Destination: '/scratch',
    }] }]));
    if (command[0] === 'start') {
      started = true; assert.deepEqual(JSON.parse(stdin), request);
      if (scenario === 'cancel-start' || scenario === 'cleanup-failure') return controller.abort();
      created = false; // Docker --rm also removes this container's anonymous volume.
      return finish('verified', scenario === 'worker-failure' ? 1 : 0);
    }
    if (command[0] === 'container' && command[1] === 'ls') return finish(created ? container : '');
    if (command[0] === 'container' && command[1] === 'rm') {
      assert.deepEqual(command, ['container', 'rm', '--force', '--volumes', container]);
      if (scenario === 'cleanup-failure') return finish('', 1);
      created = false; removed = true; return finish(container);
    }
    throw new Error(`Unexpected owner operation: ${command[0]}`);
  }));
  return child;
};
syncBuiltinESMExports();
const { runDockerOwnerWorker } = await import('../../apps/cli/dist/host/dockerOwnerWorker.js');
const running = runDockerOwnerWorker('install', { context: 'desktop-linux', volume: 'proof-library', image },
  scenario === 'invalid-input' ? { ...request, token: 'forbidden' } : request, { signal: controller.signal });
const code = {
  'invalid-input': 'invalid_library_install_request', 'scratch-type': 'library_owner_preflight_failed',
  'scratch-bind': 'unsupported_library_owner_volume', 'cancel-start': 'library_owner_cancelled',
  'cleanup-failure': 'library_owner_cleanup_failed', 'create-unconfirmed': 'library_owner_cleanup_unconfirmed',
  'create-reply-lost': 'library_owner_create_failed',
}[scenario];
if (scenario === 'cancel-create') await assert.rejects(running, error => error === controller.signal.reason);
else if (code) await assert.rejects(running, { code });
else assert.deepEqual(await running, { code: scenario === 'worker-failure' ? 1 : 0, stdout: 'verified', stderr: '' });
if (scenario === 'invalid-input') assert.equal(calls.length, 0);
if (['scratch-type', 'scratch-bind', 'cancel-create', 'create-reply-lost'].includes(scenario)) {
  assert.equal(removed, true); assert.equal(started, false);
}
if (scenario === 'cancel-start') assert.equal(removed, true);
if (scenario === 'cleanup-failure') assert.equal(created, true);
if (scenario === 'create-unconfirmed') { assert.equal(removed, false); assert.equal(started, false); }
assert.equal(calls.some(command => command[0] === 'volume' && command[1] !== 'inspect'), false);
