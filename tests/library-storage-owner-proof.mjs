// Opt-in proof: actual DKB modules, one Linux volume, two independent containers.
// Run after building Library: node tests/library-storage-owner-proof.mjs --run
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const suite = ['library-storage-access', 'library-lock-ownership', 'library-lock-authority', 'library-mutation-recovery', 'library-read-snapshot'];
if (process.argv[2] === '--worker') await worker();
else if (process.argv[2] === '--run' && process.argv.length === 3) await proof();
else { console.error('Run explicitly: node tests/library-storage-owner-proof.mjs --run'); process.exitCode = 1; }

async function proof() {
  assert.equal(process.platform, 'win32', 'Use Windows + Docker Linux to prove rejection of the host bind mount.');
  const image = await docker(['image', 'inspect', 'node:22-bookworm-slim', '--format', '{{.Id}}']);
  assert.match(image, /^sha256:[a-f0-9]{64}$/u, 'The proof uses an installed immutable image, never an implicit pull.');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-library-storage-owner-proof-'));
  const identity = randomUUID(), volume = 'dkb-library-owner-' + identity;
  const snapshotRoot = path.join(root, 'snapshot');
  const label = 'dkb.storage-proof=' + identity, workers = [];
  let created = false;
  const report = (check, evidence) => console.log(JSON.stringify({ check, status: 'passed', evidence }));
  try {
    const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    await fs.mkdir(snapshotRoot);
    await fs.copyFile(fileURLToPath(import.meta.url), path.join(snapshotRoot, 'proof.mjs'));
    const snapshot = await stageBuiltLibrary(snapshotRoot);
    await fs.mkdir(path.join(snapshotRoot, 'tests'));
    for (const name of [...suite.map(name => name + '.test.mjs'), 'test-environment.mjs']) {
      await fs.copyFile(path.join(repository, 'tests', name), path.join(snapshotRoot, 'tests', name));
    }
    const hostLibrary = path.join(snapshotRoot, 'host-library');
    await fs.mkdir(hostLibrary);
    await fs.writeFile(path.join(hostLibrary, 'dkb.json'), JSON.stringify({ type: 'library', name: 'Unsupported bind fixture', roots: {} }));
    const { syncLibrary } = await import('@sjshovan/dkb-library/resolver.js');
    await syncLibrary(hostLibrary);
    const hostLedger = await fs.readFile(path.join(hostLibrary, '.dkb', 'state.sqlite'));
    // Send one archive through the host sharing layer rather than thousands of metadata operations.
    await command('tar', ['-cf', path.join(root, 'snapshot.tar'), '-C', snapshotRoot, '.'], 60_000);
    await docker(['volume', 'create', '--driver', 'local', '--label', label, volume]);
    created = true;
    const info = JSON.parse(await docker(['volume', 'inspect', volume]))[0];
    assert.equal(info.Driver, 'local'); assert.equal(info.Labels['dkb.storage-proof'], identity);
    assert.equal(Object.keys(info.Options ?? {}).length, 0, 'No external/shared filesystem volume driver options');
    await docker(['run', '--rm', '--name', volume + '-stage', '--network', 'none', '--read-only', '--label', label,
      '--mount', 'type=volume,source=' + volume + ',target=/proof',
      '--mount', 'type=bind,source=' + root + ',target=/input,readonly', image,
      'node', '--input-type=module', '-e', String.raw`
        import assert from 'node:assert/strict';
        import fs from 'node:fs/promises';
        import {execFileSync} from 'node:child_process';
        await fs.mkdir('/proof/work');
        execFileSync('tar',['-xf','/input/snapshot.tar','-C','/proof/work']);
        const {assertLocalLibraryStorage}=await import('/proof/work/node_modules/@sjshovan/dkb-library/dist/storageAccess.js');
        const {readLibraryState}=await import('/proof/work/node_modules/@sjshovan/dkb-library/dist/state.js');
        await assert.rejects(assertLocalLibraryStorage('/input'), {code:'library_storage_unsupported'});
        await assert.rejects(readLibraryState('/input/snapshot/host-library'), {code:'library_storage_unsupported'});
        await assertLocalLibraryStorage('/proof');
        await fs.mkdir('/proof/tmp');
        await fs.mkdir('/proof/work/packages');
        await fs.symlink('../node_modules/@sjshovan/dkb-library','/proof/work/packages/library');
        await fs.symlink('../node_modules/@sjshovan/dkb-protocol','/proof/work/packages/protocol');
        console.log(JSON.stringify({hostMountRejected:true,nativeVolumeAccepted:true}));
      `], 90_000);
    report('Windows bind rejected before database access; Linux-local volume accepted', { image, snapshot });

    const output = await docker(['run', '--rm', '--name', volume + '-suite', '--network', 'none', '--read-only', '--label', label,
      '--mount', 'type=volume,source=' + volume + ',target=/proof', '--workdir', '/proof/work',
      '--env', 'TMPDIR=/proof/tmp', image, 'node', '--import', './tests/test-environment.mjs',
      '--test', '--test-concurrency=2', ...suite.map(name => 'tests/' + name + '.test.mjs')], 180_000);
    report('Production Library storage, ownership, recovery, and snapshot suites in Linux', {
      summary: output.split('\n').filter(line => /^# (tests|pass|fail|skipped|duration_ms) /u.test(line)),
    });

    for (const suffix of ['a', 'b']) {
      workers.push(startWorker(volume + '-' + suffix, image, volume, label));
      await workers.at(-1).ready;
    }
    const [a, b] = workers;
    await a.call({ operation: 'init' });
    await Promise.all([a.call({ operation: 'increment', count: 10 }), b.call({ operation: 'increment', count: 10 })]);
    const stable = await b.call({ operation: 'read' });
    assert.equal(stable.generation, 21);
    assert.equal(stable.name, 'counter-20');
    report('Two independent containers serialize 20 Library mutations without lost updates', stable);

    assert.equal(await a.call({ operation: 'hold-write' }), 'owned');
    assert.equal((await b.call({ operation: 'read-failure' })).code, 'library_recovery_required');
    assert.equal((await b.call({ operation: 'contend' })).code, 'library_busy');
    await docker(['kill', a.name]);
    await a.closed;
    assert.equal((await b.call({ operation: 'read-failure' })).code, 'library_recovery_required');
    const recovery = await b.call({ operation: 'recover' });
    assert.equal(recovery.status, 'rolled_back');
    assert.deepEqual(await b.call({ operation: 'read' }), stable);
    assert.equal((await b.call({ operation: 'recover' })).status, 'unchanged');
    report('Killed owner releases native lease; reads fail closed until exact rollback', recovery);
    const finalSnapshot = await stagedIdentity(snapshotRoot);
    assert.deepEqual(finalSnapshot, snapshot.files, 'Proof must not mutate the frozen host module snapshot');
    assert.deepEqual(await fs.readFile(path.join(hostLibrary, '.dkb', 'state.sqlite')), hostLedger, 'Unsupported host ledger is never modified');
  } finally {
    for (const name of [volume + '-stage', volume + '-suite', ...workers.map(item => item.name)]) {
      const inspection = await docker(['inspect', name], 20_000, true);
      if (!inspection) continue;
      const info = JSON.parse(inspection)[0];
      assert.equal(info.Config.Labels['dkb.storage-proof'], identity, 'Refuse cleanup without exact proof ownership');
      await docker(['rm', '-f', name]);
      await workers.find(item => item.name === name)?.closed;
    }
    if (created) {
      const info = JSON.parse(await docker(['volume', 'inspect', volume]))[0];
      assert.equal(info.Labels['dkb.storage-proof'], identity, 'Refuse removal of an unrelated volume');
      await docker(['volume', 'rm', volume]);
    }
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('dkb-library-storage-owner-proof-'));
    await fs.rm(root, { recursive: true, force: true });
    report('Removed only this proof’s labeled containers, volume, and copied fixture', { volume });
  }
}

function startWorker(name, image, volume, label) {
  const child = spawn('docker', ['run', '-i', '--name', name, '--label', label, '--network', 'none', '--read-only',
    '--mount', 'type=volume,source=' + volume + ',target=/proof', '--workdir', '/proof/work',
    '--env', 'TMPDIR=/proof/tmp', image, 'node', '/proof/work/proof.mjs', '--worker'],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let sequence = 0, readyResolve, readyReject, stderr = '';
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const readyTimeout = setTimeout(() => readyReject(new Error('Worker startup timed out')), 30_000);
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  const closed = once(child, 'close').then(([code]) => {
    clearTimeout(readyTimeout);
    const error = new Error('Proof worker closed (' + code + '): ' + stderr);
    readyReject(error);
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
    pending.clear();
  });
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.ready) { clearTimeout(readyTimeout); readyResolve(); return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  return { name, ready, closed, call: (input) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Proof request timed out')); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ ...input, id }) + '\n');
  }) };
}

async function worker() {
  const root = '/proof/library';
  const state = await import('@sjshovan/dkb-library/state.js');
  const mutation = await import('@sjshovan/dkb-library/mutation.js');
  const { syncLibrary } = await import('@sjshovan/dkb-library/resolver.js');
  const { withDkbFileLock } = await import('@sjshovan/dkb-library/locks.js');
  const before = () => fs.readFile(path.join(root, 'dkb.json'), 'utf8');
  let held;
  async function action(message) {
    if (message.operation === 'init') {
      await fs.mkdir(root);
      await fs.writeFile(path.join(root, 'dkb.json'), JSON.stringify({ type: 'library', name: 'counter-0', roots: {} }));
      await syncLibrary(root); return true;
    }
    if (message.operation === 'increment') {
      assert.ok(Number.isInteger(message.count) && message.count > 0 && message.count <= 10);
      for (let index = 0; index < message.count; index++) await mutation.withLibraryMutation(root, async () => {
        const previous = await state.maybeReadLibraryLock(root);
        const name = 'counter-' + (Number(previous.library.name.split('-')[1]) + 1);
        await mutation.writeLibraryMutationFile(root, path.join(root, 'dkb.json'), JSON.stringify({ type: 'library', name, roots: {} }));
        await state.applyLibraryLock(root, { ...previous, generation: previous.generation + 1, library: { name } });
      });
      return true;
    }
    if (message.operation === 'read') {
      const result = await state.readLibraryState(root);
      return { generation: result.generation, name: JSON.parse(await before()).name };
    }
    if (message.operation === 'read-failure' || message.operation === 'contend') {
      try {
        if (message.operation === 'contend') await withDkbFileLock(root, 'library-mutation', async () => true, { timeoutMs: 50 });
        else await state.readLibraryState(root);
        throw new Error('Expected the operation to fail closed');
      } catch (error) { assert.ok(error.code); return { code: error.code }; }
    }
    if (message.operation === 'hold-write') {
      return new Promise((resolve, reject) => {
        held = mutation.withLibraryMutation(root, async () => {
          await mutation.writeLibraryMutationFile(root, path.join(root, 'dkb.json'), JSON.stringify({ type: 'library', name: 'uncommitted', roots: {} }));
          resolve('owned');
          await new Promise(() => {});
        });
        void held.catch(reject);
      });
    }
    if (message.operation === 'recover') return mutation.recoverLibraryMutation(root);
    throw new Error('Unknown proof operation');
  }
  console.log(JSON.stringify({ ready: true }));
  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    try { console.log(JSON.stringify({ id: message.id, result: await action(message) })); }
    catch (error) { console.log(JSON.stringify({ id: message.id, error: { code: error.code, message: error.message, stack: error.stack } })); }
  }
  await held;
}

async function stagedIdentity(root) {
  const files = {};
  for (const file of ['locks.js', 'mutation.js', 'mutationPaths.js', 'readFence.js', 'state.js', 'stateStore.js', 'storageAccess.js']) {
    files[file] = createHash('sha256').update(await fs.readFile(path.join(root, 'node_modules', '@sjshovan', 'dkb-library', 'dist', file))).digest('hex');
  }
  return files;
}

async function docker(args, timeoutMs = 20_000, absentAllowed = false) {
  return command('docker', args, timeoutMs, absentAllowed);
}
async function command(executable, args, timeoutMs, absentAllowed = false) {
  const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', stderr = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-32_768); });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  try {
    const [code] = await once(child, 'close');
    if (absentAllowed && code === 1 && /No such object/u.test(stderr)) return '';
    assert.equal(code, 0, output + '\n' + stderr);
    return output.trim();
  } finally { clearTimeout(timer); }
}

async function stageBuiltLibrary(root) {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const workspaceRoots = new Map([
    ['@sjshovan/dkb-library', path.join(repository, 'packages', 'library')],
    ['@sjshovan/dkb-protocol', path.join(repository, 'packages', 'protocol')],
  ]);
  const modules = path.join(root, 'node_modules');
  const staged = new Map();
  async function stage(name, source) {
    const manifest = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
    assert.equal(manifest.name, name);
    if (staged.has(name)) {
      assert.equal(staged.get(name), manifest.version, 'Proof dependency closure must not silently flatten competing versions');
      return;
    }
    staged.set(name, manifest.version);
    const destination = path.join(modules, ...name.split('/'));
    await fs.mkdir(destination, { recursive: true });
    if (workspaceRoots.has(name)) {
      await fs.copyFile(path.join(source, 'package.json'), path.join(destination, 'package.json'));
      await fs.cp(path.join(source, 'dist'), path.join(destination, 'dist'), { recursive: true });
      if (name === '@sjshovan/dkb-protocol') await fs.cp(path.join(source, 'schemas'), path.join(destination, 'schemas'), { recursive: true });
    } else {
      await fs.cp(source, destination, { recursive: true, filter: target => !['node_modules', '.git', '.env'].includes(path.basename(target)) });
    }
    const require = createRequire(path.join(source, 'package.json'));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      let dependencyRoot = workspaceRoots.get(dependency);
      if (!dependencyRoot) {
        try { dependencyRoot = path.dirname(require.resolve(`${dependency}/package.json`)); }
        catch {
          dependencyRoot = path.dirname(require.resolve(dependency));
          while (true) {
            try {
              if (JSON.parse(await fs.readFile(path.join(dependencyRoot, 'package.json'), 'utf8')).name === dependency) break;
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
            const parent = path.dirname(dependencyRoot);
            assert.notEqual(parent, dependencyRoot, `Unable to resolve installed dependency ${dependency}`);
            dependencyRoot = parent;
          }
        }
      }
      await stage(dependency, dependencyRoot);
    }
  }
  await stage('@sjshovan/dkb-library', workspaceRoots.get('@sjshovan/dkb-library'));
  const identity = {};
  for (const file of ['locks.js', 'mutation.js', 'mutationPaths.js', 'readFence.js', 'state.js', 'stateStore.js', 'storageAccess.js']) {
    identity[file] = createHash('sha256').update(await fs.readFile(path.join(modules, '@sjshovan', 'dkb-library', 'dist', file))).digest('hex');
  }
  return { files: identity, packages: Object.fromEntries(staged) };
}
