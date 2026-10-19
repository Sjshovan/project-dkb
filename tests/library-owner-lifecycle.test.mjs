import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

// Replace Docker only in a child process. Exercise the actual owner transport,
// including cancellation while the daemon is still creating its container.
for (const scenario of ['success', 'unix-context', 'command-failure', 'cancel-create', 'cancel-start', 'cleanup-failure', 'cleanup-absent', 'cleanup-observation-failure', 'create-reply-lost', 'create-reply-malformed', 'create-dispatch-unconfirmed', 'remote-context', 'remote-npipe', 'wrong-image', 'bind-volume']) {
  test(`Library owner transport: ${scenario}`, async () => {
    const script = `
      import assert from 'node:assert/strict';
      import cp from 'node:child_process';
      import { EventEmitter } from 'node:events';
      import { PassThrough } from 'node:stream';
      import { syncBuiltinESMExports } from 'node:module';
      const scenario = ${JSON.stringify(scenario)};
      const image = 'sha256:' + 'a'.repeat(64), container = 'b'.repeat(64);
      const controller = new AbortController(), calls = [];
      let created = false, removed = false, removalAttempted = false, request, operationLabel;
      cp.spawn = (file, args, options) => {
        assert.equal(file, 'docker');
        assert.equal(options.shell, false);
        assert.equal(options.windowsHide, true);
        assert.deepEqual(args.slice(0, 2), ['--context', 'desktop-linux']);
        const command = args.slice(2);
        calls.push(command);
        const child = new EventEmitter();
        child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        let input = '', closed = false;
        child.stdin.on('data', bytes => input += bytes.toString());
        const finish = (output = '', code = 0) => {
          if (closed) return;
          closed = true;
          if (output) child.stdout.write(output);
          child.emit('close', code);
        };
        child.kill = () => { queueMicrotask(() => finish('', 1)); return true; };
        child.stdin.on('finish', () => setImmediate(() => {
          if (command[0] === 'context') return finish(JSON.stringify([{ Endpoints: { docker: { Host: {
            'remote-context': 'ssh://elsewhere', 'remote-npipe': 'npipe:////another-host/pipe/docker_engine',
            'unix-context': 'unix:///var/run/docker.sock',
          }[scenario] ?? 'npipe:////./pipe/dockerDesktopLinuxEngine' } } }]));
          if (command[0] === 'image') return finish(JSON.stringify([{ Id: image, Os: 'linux', Config: { Labels: {
            'dev.dkb.library-owner.protocol': 'dkb.library-owner.v1',
            'org.opencontainers.image.version': scenario === 'wrong-image' ? '0.0.0' : '0.2.0',
          } } }]));
          if (command[0] === 'volume') return finish(JSON.stringify([{ Name: 'proof-library', Driver: 'local', Scope: 'local',
            Options: scenario === 'bind-volume' ? { type: 'none', o: 'bind', device: '/host' } : null,
            Mountpoint: '/var/lib/docker/volumes/proof-library/_data' }]));
          if (command[0] === 'create') {
            operationLabel = command[command.indexOf('--label') + 1];
            assert.ok(command.includes('--read-only'));
            assert.equal(command[command.indexOf('--network') + 1], 'none');
            assert.equal(command[command.indexOf('--pull') + 1], 'never');
            assert.equal(command[command.indexOf('--mount') + 1], 'type=volume,src=proof-library,dst=/library,volume-nocopy');
            assert.equal(command.filter(value => value === '--mount').length, 1);
            assert.equal(command.at(-2), image);
            assert.equal(command.at(-1), '/workspace/apps/cli/dist/host/libraryOwnerWorker.js');
            if (scenario === 'cancel-create') controller.abort();
            if (scenario === 'create-dispatch-unconfirmed') return finish('', 1);
            created = true;
            if (scenario === 'create-reply-lost') return finish('', 1);
            if (scenario === 'create-reply-malformed') return finish('not-a-container-id');
            return finish(container + '\\n');
          }
          if (command[0] === 'start') {
            assert.equal(created, true);
            request = JSON.parse(input);
            assert.equal(request.command, 'library.status');
            if (scenario === 'cancel-start' || scenario.startsWith('cleanup-')) return controller.abort();
            created = false;
            return finish(JSON.stringify({ ok: scenario !== 'command-failure' }), scenario === 'command-failure' ? 1 : 0);
          }
          if (command[0] === 'container' && command[1] === 'ls') {
            assert.match(command[command.indexOf('--filter') + 1], /^label=dev\\.dkb\\.owner\\.operation=[a-f0-9-]{36}$/u);
            assert.equal(command[command.indexOf('--filter') + 1], 'label=' + operationLabel);
            if (removalAttempted && scenario === 'cleanup-observation-failure') {
              child.stderr.write('fixture observation unavailable'); return finish('', 1);
            }
            return finish(created ? container : '');
          }
          if (command[0] === 'container' && command[1] === 'rm') {
            assert.deepEqual(command, ['container', 'rm', '--force', container]);
            removalAttempted = true;
            if (scenario.startsWith('cleanup-')) {
              if (scenario === 'cleanup-absent') created = false;
              child.stderr.write('fixture removal denied'); return finish('', 17);
            }
            removed = true; created = false; return finish(container);
          }
          if (command[0] === 'container' && command[1] === 'inspect') {
            assert.deepEqual(command, ['container', 'inspect', '--format', '{{json .State}}', container]);
            if (scenario === 'cleanup-absent' || scenario === 'cleanup-observation-failure') {
              child.stderr.write('fixture state unavailable'); return finish('', 1);
            }
            return finish(JSON.stringify({ Status: 'running', Running: true }));
          }
          throw new Error('Unexpected Docker operation: ' + command[0]);
        }));
        return child;
      };
      syncBuiltinESMExports();
      const { runDockerLibraryOwner } = await import('./apps/cli/dist/host/libraryOwner.js');
      const running = runDockerLibraryOwner({ context: 'desktop-linux', volume: 'proof-library', image },
        { format: 'dkb.library-owner.v1', command: 'library.status', input: {}, output: 'json' }, { signal: controller.signal });
      if (scenario === 'cancel-create') {
        await assert.rejects(running, error => error === controller.signal.reason);
        assert.equal(calls.some(args => args[0] === 'start'), false);
        assert.equal(removed, true);
      } else if (scenario === 'cancel-start') {
        await assert.rejects(running, { code: 'library_owner_cancelled' }); assert.equal(removed, true);
      } else if (scenario.startsWith('cleanup-')) {
        await assert.rejects(running, error => {
          assert.equal(error.code, 'library_owner_cleanup_failed');
          const diagnostics = JSON.parse(error.message.split('Docker cleanup diagnostics: ')[1]);
          assert.equal(diagnostics.context, 'desktop-linux');
          assert.equal('dev.dkb.owner.operation=' + diagnostics.operation, operationLabel);
          assert.equal(diagnostics.container, container);
          assert.deepEqual(diagnostics.removal, { code: 17, stderr: 'fixture removal denied' });
          assert.deepEqual(diagnostics.remaining, scenario === 'cleanup-observation-failure'
            ? { code: 1, stdout: '', stderr: 'fixture observation unavailable' }
            : { code: 0, stdout: scenario === 'cleanup-absent' ? '' : container, stderr: '' });
          assert.deepEqual(diagnostics.state, scenario === 'cleanup-failure'
            ? { code: 0, stdout: JSON.stringify({ Status: 'running', Running: true }), stderr: '' }
            : { code: 1, stdout: '', stderr: 'fixture state unavailable' });
          return true;
        });
        assert.equal(created, scenario !== 'cleanup-absent');
      } else if (scenario === 'create-dispatch-unconfirmed') {
        await assert.rejects(running, error => error.code === 'library_owner_cleanup_unconfirmed'
          && /dkb-library-owner-[a-f0-9-]{36}/u.test(error.message) && /delayed/iu.test(error.message));
        assert.equal(calls.some(args => args[0] === 'start'), false);
        assert.equal(removed, false);
      } else if (scenario === 'create-reply-lost' || scenario === 'create-reply-malformed') {
        await assert.rejects(running, { code: 'library_owner_create_failed' });
        assert.equal(calls.some(args => args[0] === 'start'), false);
        assert.equal(removed, true);
      } else if (['remote-context', 'remote-npipe', 'wrong-image', 'bind-volume'].includes(scenario)) {
        await assert.rejects(running, { code: { 'remote-context': 'unsupported_library_owner_context', 'remote-npipe': 'unsupported_library_owner_context', 'wrong-image': 'library_owner_image_mismatch', 'bind-volume': 'unsupported_library_owner_volume' }[scenario] });
        assert.equal(calls.some(args => args[0] === 'create'), false);
      } else {
        const result = await running;
        assert.equal(result.code, scenario === 'command-failure' ? 1 : 0);
        assert.deepEqual(JSON.parse(result.stdout), { ok: scenario !== 'command-failure' });
      }
      assert.equal(calls.some(args => args[0] === 'volume' && args[1] !== 'inspect'), false);
    `;
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(), timeout: 15_000, windowsHide: true,
    });
  });
}
