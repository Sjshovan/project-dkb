import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startDisposableStack } from '../scripts/lib/disposable-stack.mjs';

test('disposable proof owns a fresh Stack and isolated inventory, retaining sibling state', async (t) => {
  const fixture = await setup(t);
  await fs.writeFile(path.join(fixture.root, 'unrelated.txt'), 'preserve');
  const stack = await startDisposableStack(fixture.options);
  assert.equal(stack.environment.DKB_HOST_INVENTORY, path.join(fixture.stackRoot, 'host-inventory.json'));
  await stack.cleanup();
  await stack.cleanup();
  await assert.rejects(fs.access(fixture.stackRoot), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(fixture.root, 'unrelated.txt'), 'utf8'), 'preserve');
  assert.equal(fixture.commands.filter((entry) => entry.kind === 'down').length, 1);
  assert.equal(fixture.commands.filter((entry) => entry.kind === 'remove-volumes').length, 1);
});

test('disposable proof refuses an existing Stack directory before commands or preparation', async (t) => {
  const fixture = await setup(t);
  await fs.mkdir(fixture.stackRoot);
  await fs.writeFile(path.join(fixture.stackRoot, 'existing.txt'), 'do not touch');
  await assert.rejects(startDisposableStack(fixture.options), { code: 'EEXIST' });
  assert.deepEqual(fixture.commands, []);
  assert.equal(await fs.readFile(path.join(fixture.stackRoot, 'existing.txt'), 'utf8'), 'do not touch');
});

test('disposable proof refuses existing Docker resources even when filesystem state is fresh', async (t) => {
  const fixture = await setup(t, { existingContainer: true });
  await assert.rejects(startDisposableStack(fixture.options), /refuses existing Docker project/u);
  assert.ok(fixture.commands.every((entry) => entry.kind === 'list-containers' || entry.kind === 'list-volumes'));
  await assert.rejects(fs.access(fixture.stackRoot), { code: 'ENOENT' });
});

test('failed startup and failed stop preserve storage and do not remove volumes', async (t) => {
  const fixture = await setup(t, { failStartup: true, failStop: true });
  await assert.rejects(startDisposableStack(fixture.options), /teardown is unconfirmed/u);
  assert.equal(await fs.readFile(path.join(fixture.stackRoot, 'proof-state.txt'), 'utf8'), 'retain until stopped');
  assert.ok(fixture.commands.every((entry) => entry.kind !== 'remove-volumes'));
});

test('failed teardown is retryable and cannot erase state below a running container', async (t) => {
  const fixture = await setup(t, { failStop: true });
  const stack = await startDisposableStack(fixture.options);
  await assert.rejects(stack.cleanup(), /service teardown was not confirmed/u);
  assert.equal(await fs.readFile(path.join(fixture.stackRoot, 'proof-state.txt'), 'utf8'), 'retain until stopped');
  assert.ok(fixture.commands.every((entry) => entry.kind !== 'remove-volumes'));
  fixture.state.failStop = false;
  await stack.cleanup();
  await assert.rejects(fs.access(fixture.stackRoot), { code: 'ENOENT' });
});

test('successful stop response still requires zero remaining project containers', async (t) => {
  const fixture = await setup(t, { lingeringContainer: true });
  const stack = await startDisposableStack(fixture.options);
  await assert.rejects(stack.cleanup(), /service teardown was not confirmed/u);
  assert.ok(fixture.commands.every((entry) => entry.kind !== 'remove-volumes'));
  assert.equal(await fs.readFile(path.join(fixture.stackRoot, 'proof-state.txt'), 'utf8'), 'retain until stopped');
  fixture.state.lingeringContainer = false;
  await stack.cleanup();
});

test('proof volume enumeration cannot authorize deleting another project volume', async (t) => {
  const fixture = await setup(t, { foreignVolume: true });
  await assert.rejects(startDisposableStack(fixture.options), /outside disposable project/u);
  assert.ok(fixture.commands.every((entry) => entry.kind !== 'remove-volumes'));
});

async function setup(t, initialState = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-disposable-stack-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const name = 'isolated-proof';
  const stackRoot = path.join(root, name);
  const state = { ...initialState, started: false, volumes: false };
  const commands = [];
  // This test emulates only external process responses. It never starts Docker
  // or claims that a real service teardown or lifecycle proof has passed.
  async function execute(command, args, options) {
    assert.equal(options.windowsHide, true);
    if (command === process.execPath) {
      assert.deepEqual(args.slice(0, 3), ['fixture-cli.mjs', '--json', 'stack']);
      const action = args[3];
      commands.push({ kind: action });
      if (action === 'up') {
        state.started = true;
        state.volumes = true;
        await fs.writeFile(path.join(stackRoot, 'proof-state.txt'), 'retain until stopped');
        if (state.failStartup) throw new Error('simulated partial startup');
      } else if (action === 'down') {
        if (state.failStop) throw new Error('simulated offline Docker engine');
        state.started = false;
      } else assert.fail(`Unexpected CLI action ${action}`);
      return { stdout: '{}', stderr: '' };
    }
    assert.equal(command, 'docker');
    if (args[0] === 'ps') {
      assert.ok(args.includes(`label=com.docker.compose.project=dkb-${name}`));
      commands.push({ kind: 'list-containers' });
      return { stdout: state.existingContainer || state.started || (state.volumes && state.lingeringContainer) ? 'proof-container\n' : '' };
    }
    assert.equal(args[0], 'volume');
    if (args[1] === 'ls') {
      assert.ok(args.includes(`label=com.docker.compose.project=dkb-${name}`));
      commands.push({ kind: 'list-volumes' });
      return { stdout: state.foreignVolume ? 'unrelated-volume\n' : state.volumes ? `dkb-${name}_jobs\n` : '' };
    }
    assert.deepEqual(args, ['volume', 'rm', `dkb-${name}_jobs`]);
    commands.push({ kind: 'remove-volumes' });
    state.volumes = false;
    return { stdout: '' };
  }
  return { root, stackRoot, state, commands, options: {
    repositoryRoot: root, cliPath: 'fixture-cli.mjs', prefix: 'proof', target: 'default', execute,
    ambientEnvironment: { DKB_STACK_STATE_ROOT: root, DKB_STACK_NAME: name, DKB_HOST_INVENTORY: path.join(root, 'real-host.json') },
  } };
}
