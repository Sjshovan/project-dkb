import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  consoleAutostartStatus,
  disableConsoleAutostart,
  enableConsoleAutostart,
  startConsoleAutostart,
} from '../apps/console/dist/server/autostart.js';

test('Windows Console autostart is user-scoped, supervised, and reversible', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-console-autostart-test-'));
  const previousRoot = process.env.DKB_CONSOLE_STATE_ROOT;
  process.env.DKB_CONSOLE_STATE_ROOT = path.join(root, 'state');
  const files = await fixtureEntrypoints(root);
  const appDataDirectory = path.join(root, 'AppData', 'Roaming');
  const launcher = path.join(appDataDirectory, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DKB Console.lnk');
  const calls = [];
  let registered = false;
  const runCommand = async (command, args) => {
    calls.push([command, ...args]);
    if (args.includes('/Create')) registered = true;
    if (args.includes('/Delete')) registered = false;
    if (args.includes('/Query')) return { code: registered ? 0 : 1, stdout: registered ? '<Task><Settings></Settings></Task>' : '', stderr: '' };
    if (command === 'powershell.exe') await fs.mkdir(path.dirname(launcher), { recursive: true }).then(() => fs.writeFile(launcher, 'shortcut'));
    return { code: 0, stdout: '', stderr: '' };
  };
  const environment = { platform: 'win32', homeDirectory: root, appDataDirectory, windowsUser: 'TEST\\operator', runCommand, ...files };

  try {
    const enabled = await enableConsoleAutostart(files.cliEntrypoint, environment);
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.provider, 'windows-task');
    assert.equal(enabled.configuration, 'current');
    const task = await fs.readFile(enabled.registration, 'utf16le');
    assert.match(task, /<LogonType>InteractiveToken<\/LogonType>/u);
    assert.match(task, /<RunLevel>LeastPrivilege<\/RunLevel>/u);
    assert.match(task, /<RestartOnFailure>/u);
    assert.match(task, new RegExp(escapeRegExp(files.cliEntrypoint.replaceAll('&', '&amp;').replaceAll('"', '&quot;')), 'u'));

    assert.equal((await consoleAutostartStatus(files.cliEntrypoint, environment)).enabled, true);
    assert.equal((await consoleAutostartStatus(files.cliEntrypoint, environment)).launcherAvailable, true);
    await startConsoleAutostart(environment);
    assert.equal(calls.some((call) => call.includes('/Run')), true);

    const disabled = await disableConsoleAutostart(environment);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.changed, true);
    assert.equal(calls.some((call) => call.includes('/Delete')), true);
    await assert.rejects(fs.access(enabled.registration));
  } finally {
    if (previousRoot === undefined) delete process.env.DKB_CONSOLE_STATE_ROOT;
    else process.env.DKB_CONSOLE_STATE_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Linux and macOS Console registrations use their user service managers', async () => {
  for (const platform of ['linux', 'darwin']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `dkb-console-${platform}-autostart-test-`));
    const previousRoot = process.env.DKB_CONSOLE_STATE_ROOT;
    process.env.DKB_CONSOLE_STATE_ROOT = path.join(root, 'state');
    const files = await fixtureEntrypoints(root);
    const calls = [];
    const runCommand = async (command, args) => {
      calls.push([command, ...args]);
      if (args.includes('is-enabled') || args.includes('print')) return { code: 0, stdout: 'enabled', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const environment = { platform, homeDirectory: root, userId: 1000, runCommand, ...files };

    try {
      const enabled = await enableConsoleAutostart(files.cliEntrypoint, environment);
      const registration = await fs.readFile(enabled.registration, 'utf8');
      if (platform === 'linux') {
        assert.match(registration, /Restart=on-failure/u);
        assert.equal(calls.some((call) => call[0] === 'systemctl' && call.includes('enable')), true);
      } else {
        assert.match(registration, /<key>KeepAlive<\/key>/u);
        assert.equal(calls.some((call) => call[0] === 'launchctl' && call.includes('bootstrap')), true);
      }
    } finally {
      if (previousRoot === undefined) delete process.env.DKB_CONSOLE_STATE_ROOT;
      else process.env.DKB_CONSOLE_STATE_ROOT = previousRoot;
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

async function fixtureEntrypoints(root) {
  const nodeExecutable = path.join(root, 'node.exe');
  const serviceEntrypoint = path.join(root, 'service.js');
  const cliEntrypoint = path.join(root, 'cli.js');
  await Promise.all([
    fs.writeFile(nodeExecutable, ''),
    fs.writeFile(serviceEntrypoint, ''),
    fs.writeFile(cliEntrypoint, ''),
  ]);
  return { nodeExecutable, serviceEntrypoint, cliEntrypoint };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
