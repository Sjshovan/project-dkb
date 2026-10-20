// Opt-in: real packaged CLI image, Linux volume, no Runtime or host Library.
// Build apps/cli/Dockerfile, then run: node tests/library-owner-cli-proof.mjs --run
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runDockerLibraryOwner } from '../apps/cli/dist/host/libraryOwner.js';
import { ownerDockerProcess } from '../apps/cli/dist/host/dockerOwnerProcess.js';
import { LIBRARY_OWNER_FORMAT } from '../apps/cli/dist/host/libraryOwnerContract.js';
import { ConsoleCommandRunner } from '@sjshovan/dkb-console';
import { ConsoleActivityStore } from '../apps/console/dist/server/activity.js';

if (process.argv.length !== 3 || process.argv[2] !== '--run') throw new Error('Run explicitly: node tests/library-owner-cli-proof.mjs --run');
const context = (await dockerRaw(['context', 'show'])).trim();
const docker = args => dockerRaw(['--context', context, ...args]);
const image = (await docker(['image', 'inspect', 'dkb-cli:owner-candidate', '--format', '{{.Id}}'])).trim();
const id = randomUUID(), volume = `dkb-owner-cli-proof-${id}`, writer = `dkb-owner-writer-${id}`;
const label = `dev.dkb.owner.proof=${id}`;
const target = { context, image, volume };
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-owner-public-cli-'));
const cliPath = fileURLToPath(new URL('../apps/cli/dist/cli/index.js', import.meta.url));
const environment = { ...process.env, DKB_HOST_INVENTORY: path.join(scratch, 'host.json'),
  DKB_GLOBAL_ROOT: path.join(scratch, 'global'), DKB_CLI_CONFIG: path.join(scratch, 'config.json'),
  DKB_RUNTIME_CREDENTIALS_ROOT: path.join(scratch, 'credentials'), DKB_FORCE_TTY: '0' };
delete environment.DKB_LIBRARY_PATH;
delete environment.DKB_REGISTRY_URL;
delete environment.DKB_REGISTRY_TOKEN;
const publicCli = async (args, code = 0) => {
  const result = await cli(args);
  assert.equal(result.code, code, result.stdout || result.stderr);
  return result;
};
let createdVolume = false;
const reports = [];
const record = check => { reports.push(check); console.log(JSON.stringify({ check, status: 'passed' })); };
const request = (command, input = {}, output = 'json') => ({ format: LIBRARY_OWNER_FORMAT, command, input, output });
const invoke = async (command, input = {}) => {
  const result = await runDockerLibraryOwner(target, request(command, input));
  assert.equal(result.code, 0, result.stdout || result.stderr);
  return JSON.parse(result.stdout);
};

try {
  const inspection = JSON.parse(await docker(['run', '--rm', '--pull', 'never', '--network', 'none', '--read-only',
    '--entrypoint', 'node', image, '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      const required = ['LICENSE', 'apps/cli/dist/cli/index.js', 'apps/cli/dist/host/libraryOwnerWorker.js',
        'apps/console/dist/server/server.js', 'apps/console/dist/web/index.html'];
      for (const file of required) assert.ok(fs.statSync(path.join('/workspace', file)).isFile(), file);
      let files = 0;
      const walk = (root, relative = '') => {
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
          if (entry.name === 'node_modules') continue;
          const next = path.posix.join(relative, entry.name);
          assert.ok(!entry.isSymbolicLink(), 'Unexpected product symlink: ' + next);
          assert.doesNotMatch(next, /(^|\\/)(?:\\.git|\\.dkb|\\.env(?:\\..*)?|tests|graphify-out|__pycache__)(?:\\/|$)|\\.tsbuildinfo$|\\.(?:dkbpkg|dkbbuild|dkbevidence|sqlite|pem|key)$/u);
          if (entry.isDirectory()) walk(path.join(root, entry.name), next);
          else { files++; assert.ok(entry.isFile(), 'Unexpected special file: ' + next); }
        }
      };
      walk('/workspace');
      console.log(JSON.stringify({ files, requiredFiles: required.length }));
    `]));
  assert.ok(inspection.files > inspection.requiredFiles);
  record('management image contains the bundled CLI and license without product secrets, knowledge, test caches or state');

  await docker(['volume', 'create', '--label', label, volume]);
  createdVolume = true;
  const init = await invoke('library.init', { displayName: 'Isolated owner proof', registryUrl: 'http://127.0.0.1:1' });
  assert.equal(init.root, '/library');
  await invoke('library.sync');
  await invoke('library.status');
  await invoke('library.packages');
  const human = await runDockerLibraryOwner(target, request('library.status', {}, 'human'));
  assert.equal(human.code, 0, human.stderr);
  assert.doesNotMatch(human.stdout, /\u001b\[/u);
  record('CLI initializes and inspects Linux-owned state without any Runtime');

  const registered = JSON.parse((await publicCli(['--json', 'library', 'register', '--name', 'proof-volume',
    '--docker-volume', volume, '--docker-context', context, '--owner-image', image])).stdout);
  assert.equal(registered.library.path, undefined);
  assert.equal(registered.library.storage.volume, volume);
  await publicCli(['--json', 'library', 'use', 'proof-volume']);
  const listed = JSON.parse((await publicCli(['--json', 'library', 'list'])).stdout);
  assert.equal(listed.libraries[0].status, 'known');
  assert.equal(listed.libraries[0].kind, 'docker');
  const checked = JSON.parse((await publicCli(['--json', 'library', 'list', '--check'])).stdout);
  assert.equal(checked.libraries[0].status, 'ready');
  await publicCli(['--json', 'library', 'status']);
  await publicCli(['--json', 'library', 'storage', '--library', 'proof-volume']);
  await publicCli(['--json', 'list']);
  const unsupported = JSON.parse((await publicCli(['--json', 'show', '@owner-proof/missing', '--verify'], 1)).stdout);
  assert.equal(unsupported.error.code, 'unsupported_capability');
  assert.equal(await fs.stat(path.join(scratch, '.dkb')).then(() => true, () => false), false);
  record('public CLI registers, selects, lists and inspects the volume by name without creating host Library state');

  const changedRegistry = JSON.parse((await publicCli(['--json', 'registry', 'use', 'http://127.0.0.1:2', '--root', 'proof-volume', '--no-verify'])).stdout);
  assert.equal(changedRegistry.status, 'configured');
  assert.equal(changedRegistry.registry.url, 'http://127.0.0.1:2');
  assert.equal(JSON.parse((await publicCli(['--json', 'registry', 'use', 'http://127.0.0.1:2', '--no-verify'])).stdout).status, 'unchanged');
  const host = JSON.parse(await fs.readFile(environment.DKB_HOST_INVENTORY, 'utf8'));
  assert.equal(host.registries[host.libraries['proof-volume'].registry].url, 'http://127.0.0.1:2');
  assert.equal(host.libraries['proof-volume'].path, undefined);
  record('Registry defaults update inside the owner, synchronize host association, and repeat without mutation');

  await Promise.all(['alpha', 'beta'].map(name => invoke('collection.create', { identity: `@owner-proof/${name}` })));
  for (const name of ['alpha', 'beta']) await invoke('collection.show', { identity: `@owner-proof/${name}` });
  record('two independent one-shot CLI containers mutate one Library safely');

  const created = await publicCli(['--json-stream', 'collection', 'create', '@owner-proof/public', '--display-name', 'Public CLI proof']);
  const events = created.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(item => item.event === 'result').length, 1);
  assert.equal(events.filter(item => item.event === 'completion').length, 1);
  assert.equal(events.at(-1).status, 'succeeded');
  await publicCli(['--json', 'collection', 'show', '@owner-proof/public']);
  await publicCli(['--no-progress', 'show', '@owner-proof/public']);
  await publicCli(['--json', 'library', 'remove', '@owner-proof/public']);
  await publicCli(['--json', 'library', 'add', '@owner-proof/public']);
  record('public offline mutations retain one event result and share existing Library and Collection behavior');

  // An applied-state fixture, not a signed-install proof: only this disposable
  // volume is seeded, with no Runtime, Registry, or network in the owner.
  await docker(['run', '--rm', '--pull', 'never', '--network', 'none',
    '--mount', `type=volume,src=${volume},dst=/library,volume-nocopy`, '--entrypoint', 'node', image, '--input-type=module', '-e', `
      import fs from 'node:fs/promises'; import path from 'node:path';
      const write=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value));};
      for(const name of ['shared','private']) {
        const root='/library/vendor/@owner-proof/'+name;
        await write(root+'/dkb.json',{type:'dkb',name:'@owner-proof/'+name,version:'1.0.0'});
        await fs.writeFile(root+'/source.md',name+' source');
        await write(root+'/.dkb/builds/retained-fixture.json',{fixture:true});
      }
      await write('/library/vendor/@owner-proof/bundle/dkb.json',{type:'collection',name:'@owner-proof/bundle',
        members:{'@owner-proof/shared':'1.0.0','@owner-proof/private':'1.0.0'},meta:{revision:1}});
    `]);
  await publicCli(['--json', 'library', 'add', '@owner-proof/shared']);
  await publicCli(['--json', 'library', 'add', '@owner-proof/bundle']);
  const blockedRemoval = JSON.parse((await publicCli(['--json', 'uninstall', '@owner-proof/private'], 1)).stdout);
  assert.match(blockedRemoval.error.message, /required by collection:@owner-proof\/bundle/u);
  const bundleRemoval = JSON.parse((await publicCli(['--json', 'collection', 'uninstall', '@owner-proof/bundle'])).stdout);
  assert.deepEqual(bundleRemoval.removedDkbs, ['@owner-proof/private']);
  await publicCli(['--json', 'show', '@owner-proof/shared']);
  const directRemoval = await publicCli(['--json-stream', 'uninstall', '@owner-proof/shared']);
  const removalEvents = directRemoval.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(removalEvents.filter(event => event.event === 'result').length, 1);
  assert.equal(removalEvents.at(-1).status, 'succeeded');
  await publicCli(['--json', 'uninstall', '@owner-proof/public']);
  await publicCli(['--json', 'library', 'add', '@owner-proof/public']);
  await docker(['run', '--rm', '--pull', 'never', '--network', 'none',
    '--mount', `type=volume,src=${volume},dst=/library,readonly,volume-nocopy`, '--entrypoint', 'node', image, '--input-type=module', '-e', `
      import assert from 'node:assert/strict'; import fs from 'node:fs/promises';
      for(const name of ['shared','private','bundle']) await assert.rejects(fs.stat('/library/vendor/@owner-proof/'+name),{code:'ENOENT'});
      assert.ok(await fs.stat('/library/public/dkb.json'));
    `]);
  record('offline public uninstall respects Collection dependencies, prunes vendor builds, preserves editable source and emits one terminal result');

  await proveConsoleReads();
  record('real Console runner reads the Docker Library through the bundled CLI and retains actionable unsupported errors');

  const before = await docker(['run', '--rm', '--pull', 'never', '--network', 'none', '--mount', `type=volume,src=${volume},dst=/library,readonly,volume-nocopy`,
    '--entrypoint', 'node', image, '-e', "process.stdout.write(require('fs').readFileSync('/library/dkb.json'))"]);
  const fault = `
    import { removeLibraryPath, withLibraryMutation } from '@sjshovan/dkb-library/mutation.js';
    await withLibraryMutation('/library', async () => {
      await removeLibraryPath('/library', '/library/dkb.json');
      console.log('writer-ready');
      await new Promise(() => setInterval(() => {}, 1000));
    });
  `;
  await docker(['run', '--detach', '--name', writer, '--label', label, '--pull', 'never', '--network', 'none',
    '--mount', `type=volume,src=${volume},dst=/library,volume-nocopy`, '--entrypoint', 'node', image, '--input-type=module', '-e', fault]);
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await docker(['logs', writer])).includes('writer-ready')) { ready = true; break; }
    await delay(200);
  }
  assert.equal(ready, true, 'Writer must reach its durable journal before the fault.');
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), 15_000);
  let stream = '', started = false;
  try {
    await assert.rejects(runDockerLibraryOwner(target, request('library.recover', {}, 'json-stream'), {
      signal: abort.signal,
      onOutput(channel, bytes) {
        if (channel !== 'stdout') return;
        stream += bytes.toString();
        for (const line of stream.split('\n').slice(0, -1)) {
          if (JSON.parse(line).event === 'start') { started = true; abort.abort(); }
        }
        stream = stream.slice(stream.lastIndexOf('\n') + 1);
      },
    }), error => error.code === 'library_owner_cancelled');
  } finally { clearTimeout(deadline); }
  assert.equal(started, true, 'Cancellation must interrupt a running CLI operation, not merely its preflight.');
  assert.equal((await docker(['container', 'ls', '--all', '--filter', `volume=${volume}`, '--filter', 'label=dev.dkb.owner.operation', '--format', '{{.Names}}'])).trim(), '');
  record('cancelled owner invocation removes its worker, not the Library volume');

  // Exercise the real public CLI's cooperative Windows/Console cancellation path.
  const cancellation = spawn(process.execPath, [cliPath, '--json-stream', 'library', 'recover'], {
    cwd: scratch, env: environment, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let cancellationOutput = '', controlReady = false;
  cancellation.stdout.on('data', bytes => cancellationOutput += bytes.toString());
  cancellation.stderr.resume();
  cancellation.on('message', value => { if (value?.event === 'ready') controlReady = true; });
  const cancellationDone = new Promise((resolve, reject) => { cancellation.once('error', reject); cancellation.once('close', resolve); });
  const cancelDeadline = setTimeout(() => cancellation.kill(), 45_000);
  try {
    let workerRunning = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const workers = (await docker(['container', 'ls', '--filter', `volume=${volume}`, '--filter', 'label=dev.dkb.owner.operation', '--format', '{{.ID}}'])).trim();
      if (workers && controlReady) { workerRunning = true; break; }
      await delay(200);
    }
    assert.equal(workerRunning, true, 'Public CLI must own a running container before cancellation.');
    cancellation.send({ format: 'dkb.cli-control.v1', event: 'cancel' });
    assert.equal(await cancellationDone, 130, cancellationOutput);
    assert.equal(JSON.parse(cancellationOutput.trim().split('\n').at(-1)).status, 'cancelled');
    assert.equal((await docker(['container', 'ls', '--all', '--filter', `volume=${volume}`, '--filter', 'label=dev.dkb.owner.operation', '--format', '{{.ID}}'])).trim(), '');
  } finally { clearTimeout(cancelDeadline); if (cancellation.exitCode === null) cancellation.kill(); }
  record('public CLI cancellation confirms worker cleanup before its terminal event');

  await docker(['kill', '--signal', 'KILL', writer]);
  const closed = await runDockerLibraryOwner(target, request('library.status'));
  assert.equal(closed.code, 1, closed.stdout);
  assert.equal(JSON.parse(closed.stdout).error.code, 'library_recovery_required');
  const closedPublic = JSON.parse((await publicCli(['--json', 'library', 'status'], 1)).stdout);
  assert.equal(closedPublic.error.code, 'library_recovery_required');
  assert.ok(closedPublic.error.message.includes('dkb library recover --library "proof-volume"'));
  assert.doesNotMatch(closedPublic.error.message, /--library "\/library"/u);
  assert.equal(JSON.parse((await publicCli(['--json', 'library', 'recover'])).stdout).status, 'rolled_back');
  assert.equal((await invoke('library.recover')).status, 'unchanged');
  const after = await docker(['run', '--rm', '--pull', 'never', '--network', 'none', '--mount', `type=volume,src=${volume},dst=/library,readonly,volume-nocopy`,
    '--entrypoint', 'node', image, '-e', "process.stdout.write(require('fs').readFileSync('/library/dkb.json'))"]);
  assert.equal(after, before);
  await invoke('collection.show', { identity: '@owner-proof/alpha' });
  await invoke('collection.show', { identity: '@owner-proof/beta' });
  record('killed writer fails closed; stopped-Runtime recovery restores exact source manifest and both Collections');

  await assert.rejects(runDockerLibraryOwner({ ...target, volume: `${volume}-missing` }, request('library.status')), { code: 'library_owner_preflight_failed' });
  assert.equal((await docker(['volume', 'ls', '--filter', `name=${volume}-missing`, '--format', '{{.Name}}'])).trim(), '');
  record('missing volume is rejected rather than silently created');
  console.log(JSON.stringify({ status: 'passed', image, context, checks: reports.length, userResourcesChanged: false }));
} finally {
  const writers = (await docker(['container', 'ls', '--all', '--filter', `label=${label}`, '--format', '{{.ID}}'])).trim().split(/\s+/u).filter(Boolean);
  for (const container of writers) {
    assert.match(container, /^[a-f0-9]{12,64}$/u);
    await docker(['container', 'rm', '--force', container]);
  }
  if (createdVolume) {
    const [owned] = JSON.parse(await docker(['volume', 'inspect', volume]));
    assert.equal(owned.Labels['dev.dkb.owner.proof'], id);
    await docker(['volume', 'rm', volume]);
  }
  assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
  assert.ok(path.basename(scratch).startsWith('dkb-owner-public-cli-'));
  await fs.rm(scratch, { recursive: true, force: true });
}

async function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd: scratch, env: environment, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => stdout += bytes.toString());
    child.stderr.on('data', bytes => stderr += bytes.toString());
    const timer = setTimeout(() => child.kill(), 60_000);
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function proveConsoleReads() {
  await publicCli(['--json', 'registry', 'register', 'console-registry', 'http://127.0.0.1:3', '--no-verify']);
  const keys = ['DKB_HOST_INVENTORY', 'DKB_CLI_CONFIG', 'DKB_RUNTIME_CREDENTIALS_ROOT'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = environment[key];
  const activity = new ConsoleActivityStore(path.join(scratch, 'console-activity.sqlite'));
  const runner = new ConsoleCommandRunner({ cliEntrypoint: cliPath, cwd: scratch, activity });
  try {
    const list = await runner.run('library.list', { check: true });
    assert.equal(list.status, 'succeeded', JSON.stringify(list.events));
    assert.equal(list.result.libraries[0].status, 'ready');
    assert.equal(list.result.libraries[0].location, `docker://${context}/${volume}`);
    assert.equal(list.result.libraries[0].path, undefined);
    const packages = await runner.run('library.packages', { library: 'proof-volume' });
    assert.equal(packages.status, 'succeeded', JSON.stringify(packages.events));
    const detail = await runner.run('package.show', { library: 'proof-volume', identity: '@owner-proof/public' });
    assert.equal(detail.status, 'succeeded', JSON.stringify(detail.events));
    assert.equal(detail.events.filter(event => event.event === 'result').length, 1);
    const unsupported = await runner.run('package.verify', { library: 'proof-volume', identity: '@owner-proof/public' });
    assert.equal(unsupported.status, 'failed');
    assert.equal(unsupported.events.find(event => event.event === 'failure').error.code, 'unsupported_capability');
    const registry = await runner.run('library.registry.use', { library: 'proof-volume', registry: 'console-registry' });
    assert.equal(registry.status, 'succeeded', JSON.stringify(registry.events));
    assert.equal(registry.result.registry.url, 'http://127.0.0.1:3');
    assert.match(registry.result.warning, /could not be verified/);
    assert.equal(registry.events.filter(event => event.event === 'result').length, 1);
    assert.equal(activity.list().activities.length, 5);
    assert.equal(activity.list().activities.filter(item => item.status === 'succeeded').length, 4);
    assert.equal(await fs.stat(path.join(scratch, '.dkb')).then(() => true, () => false), false);
  } finally {
    await runner.close();
    activity.close();
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
}

async function dockerRaw(args) {
  const result = await ownerDockerProcess(args, { timeoutMs: 30_000 });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout;
}
