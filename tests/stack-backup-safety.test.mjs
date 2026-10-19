import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { c as createTar } from 'tar';
import { DEFAULT_DKB_DISTRIBUTION as distribution } from '@sjshovan/dkb-distribution-default';
import { withStackControl } from '../apps/cli/dist/stack/control.js';
import { prepareDkbStack } from '../apps/cli/dist/stack/context.js';
import { backupDkbStack, restoreDkbStack, requireStoppedStack } from '../apps/cli/dist/stack/backups.js';
import { downDkbStack } from '../apps/cli/dist/stack/manager.js';
import { upgradeDkbStackRelease } from '../apps/cli/dist/stack/release.js';
import { assertHostBackupCoverage } from '../apps/cli/dist/stack/backupCoverage.js';
import { composeContainerIds } from '../apps/cli/dist/stack/docker.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { storageEnvironment } from '../apps/cli/dist/stack/ownedStorage.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-stack-backup-safety-'));
  const previous = process.env.DKB_STACK_STATE_ROOT;
  process.env.DKB_STACK_STATE_ROOT = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.DKB_STACK_STATE_ROOT; else process.env.DKB_STACK_STATE_ROOT = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  const stack = path.join(root, 'test');
  await fs.mkdir(path.join(stack, 'library'), { recursive: true });
  await fs.mkdir(path.join(stack, 'runtime'));
  await fs.writeFile(path.join(stack, 'stack.env'), 'DKB_STACK_NAME=test\n');
  return { root, stack, env: path.join(stack, 'stack.env') };
}

test('host-folder backup rejects an external Library before writing an archive', async t => {
  const f = await fixture(t), library = path.join(f.root, 'outside');
  await fs.mkdir(library);
  await fs.writeFile(path.join(library, 'source.txt'), 'preserve original');
  await fs.appendFile(f.env, `DKB_LIBRARY_HOST_PATH=${library}\n`);
  const output = path.join(f.root, 'backup.tar.gz');
  await assert.rejects(backupDkbStack(distribution, 'test', output), { code: 'stack_backup_incomplete' });
  await assert.rejects(fs.access(output), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(library, 'source.txt'), 'utf8'), 'preserve original');
});

test('backup never overwrites an existing archive or checksum', async t => {
  const f = await fixture(t);
  dockerStatus(t, args => ({ stdout: args.includes('version') ? 'fixture version' : '' }));
  for (const suffix of ['', '.sha256']) {
    const output = path.join(f.root, `retained${suffix ? '-checksum' : ''}.tar.gz`);
    await fs.writeFile(`${output}${suffix}`, 'retained backup bytes');
    await assert.rejects(backupDkbStack(distribution, 'test', output), { code: 'stack_backup_exists' });
    assert.equal(await fs.readFile(`${output}${suffix}`, 'utf8'), 'retained backup bytes');
  }
});

test('backup staging never adopts or removes an existing predictable temporary file', async t => {
  const f = await fixture(t), output = path.join(f.root, 'protected-stage.tar.gz');
  dockerStatus(t, args => ({ stdout: args.includes('version') ? 'fixture version' : '' }));
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const existing = `${output}.${process.pid}.${now.toString(36)}.tmp`;
  await fs.writeFile(existing, 'An existing file belongs to its creator');
  const backup = await backupDkbStack(distribution, 'test', output);
  assert.equal(backup.status, 'backed_up');
  assert.equal(await fs.readFile(existing, 'utf8'), 'An existing file belongs to its creator');
  assert(!(await fs.readdir(f.root)).some(name => name.startsWith('.dkb-backup-')));
});

test('a racing destination is retained and backup permissions are private before promotion', async t => {
  const f = await fixture(t), output = path.join(f.root, 'racing.tar.gz');
  dockerStatus(t, args => ({ stdout: args.includes('version') ? 'fixture version' : '' }));
  const link = fs.link;
  t.mock.method(fs, 'link', async (source, destination) => {
    if (destination === output) {
      assert.equal(path.basename(path.dirname(source)).startsWith('.dkb-backup-'), true);
      if (process.platform === 'linux') {
        assert.equal((await fs.stat(source)).mode & 0o777, 0o600);
        assert.equal((await fs.stat(path.dirname(source))).mode & 0o777, 0o700);
      }
      await fs.writeFile(output, 'A competing completed backup', { flag: 'wx' });
    }
    return link(source, destination);
  });
  await assert.rejects(backupDkbStack(distribution, 'test', output), { code: 'stack_backup_exists' });
  assert.equal(await fs.readFile(output, 'utf8'), 'A competing completed backup');
  await assert.rejects(fs.access(`${output}.sha256`), { code: 'ENOENT' });
  assert(!(await fs.readdir(f.root)).some(name => name.startsWith('.dkb-backup-')));
});

test('backup destination containment rejects dot-prefixed children and linked parent aliases', async t => {
  const f = await fixture(t);
  dockerStatus(t, args => ({ stdout: args.includes('version') ? 'fixture version' : '' }));
  const alias = path.join(f.root, 'alias');
  await fs.symlink(f.stack, alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const output of [path.join(f.stack, '..backup.tar.gz'), path.join(alias, 'backup.tar.gz')]) {
    await assert.rejects(backupDkbStack(distribution, 'test', output), /must be outside/u);
    await assert.rejects(fs.access(output), { code: 'ENOENT' });
  }
});

test('volume-backed release upgrade cannot mutate state before topology rollback is supported', async t => {
  const f = await ownedFixture(t), original = await fs.readFile(f.env);
  dockerStatus(t, () => assert.fail('Upgrade must not contact Docker before rollback admission'));
  await assert.rejects(upgradeDkbStackRelease(distribution, 'test', 'unused-lock', () => assert.fail('Must not start')),
    { code: 'stack_volume_restore_required' });
  assert.deepEqual(await fs.readFile(f.env), original);
});

test('backup coverage rejects missing, linked, or Docker-owned critical state rather than implying it was included', async t => {
  const f = await fixture(t);
  await assertHostBackupCoverage(f.stack);
  for (const variable of ['DKB_LIBRARY_VOLUME', 'DKB_RUNTIME_VOLUME', 'DKB_REGISTRY_VOLUME', 'DKB_COMPILER_CONTEXT_VOLUME']) {
    await fs.writeFile(f.env, `${variable}=some-volume\n`);
    await assert.rejects(assertHostBackupCoverage(f.stack), { code: 'stack_backup_incomplete' });
  }
  await fs.writeFile(f.env, '');
  await fs.rename(path.join(f.stack, 'library'), path.join(f.root, 'outside'));
  await assert.rejects(assertHostBackupCoverage(f.stack), { code: 'stack_backup_incomplete' });
  await fs.symlink(path.join(f.root, 'outside'), path.join(f.stack, 'library'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(assertHostBackupCoverage(f.stack), { code: 'stack_backup_incomplete' });
});

async function ownedFixture(t) {
  const f = await fixture(t);
  const storage = { format: 'dkb.stack-storage.v1', name: 'test', id: '12345678-1234-1234-1234-123456789abc', phase: 'ready',
    owner: { context: 'desktop-linux', image: `sha256:${'a'.repeat(64)}`, libraryVolume: 'shared-library', runtimeVolume: 'own-runtime', compilerVolume: 'own-compiler' },
    volumes: { library: 'shared-library', runtime: 'own-runtime', compiler: 'own-compiler', registry: 'own-registry' },
    volumeEnvironment: { library: 'DKB_LIBRARY_VOLUME', runtime: 'DKB_RUNTIME_VOLUME', compiler: 'DKB_COMPILER_CONTEXT_VOLUME', registry: 'DKB_REGISTRY_VOLUME' },
    sharedLibrary: true };
  await fs.writeFile(path.join(f.stack, 'stack-storage.json'), JSON.stringify({ storage, digest: stableHash(storage) }));
  await fs.writeFile(f.env, Object.entries({ DKB_STACK_NAME: 'test', ...storageEnvironment(storage) }).map(([key, value]) => `${key}=${value}`).join('\n'));
  return { ...f, storage, context: { name: 'test', projectName: 'dkb-test', root: f.stack, envFile: f.env,
    composeFile: path.join(f.root, 'compose.yaml'), allProfiles: [], dockerContext: 'desktop-linux' } };
}

function dockerStatus(t, respond) {
  const calls = [];
  t.mock.method(childProcess, 'spawnSync', (command, args) => {
    assert.equal(command, 'docker'); calls.push(args);
    return { status: 0, stderr: '', stdout: '', ...respond(args) };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return calls;
}

test('stopped-state checks find shared Library consumers outside the Compose project in every active state', async t => {
  const f = await ownedFixture(t);
  let state = 'running';
  const calls = dockerStatus(t, args => args.includes('volume=shared-library')
    ? { stdout: JSON.stringify({ ID: 'b'.repeat(64), State: state }) } : {});
  for (state of ['running', 'paused', 'restarting', 'removing', 'created']) {
    await assert.rejects(requireStoppedStack(f.context, 'back up'), error => error.code === 'stack_storage_in_use'
      && error.message.includes('volume=shared-library') && error.message.includes('other Runtimes'));
  }
  assert(calls.every(args => args[0] === '--context' && args[1] === 'desktop-linux' && args.includes('--all')));
  assert(calls.every(args => !args.includes('stop') && !args.includes('rm')));
});

test('stopped-state checks cover all recorded volumes and do not consider exited consumers active', async t => {
  const f = await ownedFixture(t);
  let blockRegistry = false;
  const calls = dockerStatus(t, args => ({ stdout: args.some(arg => arg.startsWith('volume='))
    ? JSON.stringify({ ID: 'b'.repeat(64), State: blockRegistry && args.includes('volume=own-registry') ? 'running' : 'exited' }) : '' }));
  await requireStoppedStack(f.context, 'back up');
  for (const volume of Object.values(f.storage.volumes)) assert(calls.some(args => args.includes(`volume=${volume}`)));
  blockRegistry = true;
  await assert.rejects(requireStoppedStack(f.context, 'back up'), { code: 'stack_storage_in_use' });
});

test('volume metadata failure or unknown state fails closed without exposing Docker errors', async t => {
  const f = await ownedFixture(t);
  let response = { status: 1, stderr: 'private daemon diagnostic' };
  dockerStatus(t, args => args.includes('volume=shared-library') ? response : {});
  for (response of [{ status: 1, stderr: 'private daemon diagnostic' }, { stdout: '{broken' },
    { stdout: JSON.stringify({ ID: 'b'.repeat(64), State: 'unknown' }) }, { stdout: JSON.stringify({ ID: '--unexpected', State: 'running' }) }]) {
    await assert.rejects(requireStoppedStack(f.context, 'back up'), error => error.code === 'stack_storage_check_failed'
      && !error.message.includes('private daemon diagnostic'));
  }
});

test('missing or drifted storage ownership cannot be used as stopped-state evidence', async t => {
  const f = await ownedFixture(t);
  const calls = dockerStatus(t, () => ({}));
  await fs.appendFile(f.env, '\nDKB_REGISTRY_VOLUME=different-registry');
  await assert.rejects(requireStoppedStack(f.context, 'back up'), { code: 'stack_storage_mismatch' });
  assert(!calls.some(args => args.some(arg => arg.startsWith('volume='))));
  await fs.rm(path.join(f.stack, 'stack-storage.json'));
  await assert.rejects(requireStoppedStack(f.context, 'back up'), { code: 'stack_storage_check_failed' });
});

test('a host archive cannot restore volume descriptors or incomplete volume-only backups', async t => {
  const f = await fixture(t), source = path.join(f.root, 'archive-source');
  await fs.mkdir(path.join(source, 'test'), { recursive: true });
  const staged = path.join(source, 'test');
  await fs.mkdir(path.join(staged, 'library')); await fs.mkdir(path.join(staged, 'runtime'));
  const original = await fs.readFile(f.env);
  dockerStatus(t, () => ({}));
  for (const kind of ['volume-variable', 'descriptor']) {
    await fs.writeFile(path.join(staged, 'stack.env'), kind === 'volume-variable' ? 'DKB_STACK_NAME=test\nDKB_REGISTRY_VOLUME=external-registry' : 'DKB_STACK_NAME=test');
    if (kind === 'descriptor') await fs.writeFile(path.join(staged, 'stack-storage.json'), '{}');
    const archive = path.join(f.root, `${kind}.tar.gz`);
    await createTar({ cwd: source, file: archive, gzip: true }, ['test']);
    await fs.writeFile(`${archive}.sha256`, createHash('sha256').update(await fs.readFile(archive)).digest('hex'));
    await assert.rejects(restoreDkbStack(distribution, archive, true), { code: 'stack_backup_incomplete' });
    assert.deepEqual(await fs.readFile(f.env), original);
    assert(!(await fs.readdir(f.root)).some(name => name.startsWith('.restore-') || name.includes('.rollback-')));
  }
});

test('legacy restore cannot overwrite volume-backed Stack configuration', async t => {
  const f = await ownedFixture(t), original = await fs.readFile(f.env), output = path.join(f.root, 'backup.tar.gz');
  await createTar({ cwd: f.root, file: output, gzip: true }, ['test']);
  await fs.writeFile(`${output}.sha256`, createHash('sha256').update(await fs.readFile(output)).digest('hex'));
  dockerStatus(t, () => assert.fail('Docker was called before archive coverage rejection'));
  await assert.rejects(restoreDkbStack(distribution, output, true), { code: 'stack_backup_incomplete' });
  assert.deepEqual(await fs.readFile(f.env), original);
});

test('staged host coverage checks archived absolute bindings without opening original storage', async t => {
  const f = await fixture(t), restored = path.join(f.root, 'destination');
  await fs.writeFile(f.env, `DKB_LIBRARY_HOST_PATH=${path.join(restored, 'library')}\n`);
  await assertHostBackupCoverage(f.stack, restored);
  await assert.rejects(fs.access(restored), { code: 'ENOENT' });
  await fs.writeFile(f.env, `DKB_LIBRARY_HOST_PATH=${path.join(f.root, 'outside')}\n`);
  await assert.rejects(assertHostBackupCoverage(f.stack, restored), { code: 'stack_backup_incomplete' });
});

test('a complete native backup can repair missing Library and Runtime directories', async t => {
  const f = await fixture(t), archive = path.join(f.root, 'recoverable.tar.gz');
  await fs.appendFile(f.env, `DKB_LIBRARY_HOST_PATH=${path.join(f.stack, 'library')}\n`);
  await fs.writeFile(path.join(f.stack, 'library', 'source.txt'), 'recover exact bytes');
  await createTar({ cwd: f.root, file: archive, gzip: true }, ['test']);
  await fs.writeFile(`${archive}.sha256`, createHash('sha256').update(await fs.readFile(archive)).digest('hex'));
  await fs.rm(path.join(f.stack, 'library'), { recursive: true });
  await fs.rm(path.join(f.stack, 'runtime'), { recursive: true });
  dockerStatus(t, () => ({}));
  const result = await restoreDkbStack(distribution, archive, true);
  assert.equal(result.status, 'restored');
  assert.equal(await fs.readFile(path.join(f.stack, 'library', 'source.txt'), 'utf8'), 'recover exact bytes');
  assert((await fs.stat(path.join(f.stack, 'runtime'))).isDirectory());
});

test('missing native payload in an archive preserves the existing Stack during restore', async t => {
  const f = await fixture(t), archive = path.join(f.root, 'incomplete-native.tar.gz');
  const original = await fs.readFile(f.env);
  await createTar({ cwd: f.root, file: archive, gzip: true }, ['test/stack.env']);
  await fs.writeFile(`${archive}.sha256`, createHash('sha256').update(await fs.readFile(archive)).digest('hex'));
  dockerStatus(t, () => ({}));
  await assert.rejects(restoreDkbStack(distribution, archive, true), { code: 'stack_backup_incomplete' });
  assert.deepEqual(await fs.readFile(f.env), original);
  assert((await fs.stat(path.join(f.stack, 'library'))).isDirectory());
});

test('a failed Docker status command is never treated as proof that writers are stopped', async t => {
  const f = await fixture(t);
  t.mock.method(childProcess, 'spawnSync', () => ({ status: 1, stdout: '', stderr: 'synthetic daemon failure' }));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(composeContainerIds({ name: 'test', projectName: 'dkb-test', root: f.stack,
    envFile: f.env, composeFile: path.join(f.root, 'compose.yaml'), allProfiles: [] }), { code: 'stack_storage_check_failed' });
});

test('a linked file inside Runtime state aborts backup without promoting a partial archive', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'preserved.txt'), 'outside bytes');
  await fs.symlink(outside, path.join(f.stack, 'runtime', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  t.mock.method(childProcess, 'spawnSync', (_command, args) => ({ status: 0, stderr: '', stdout: args.includes('version') ? 'fixture version' : '' }));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const output = path.join(f.root, 'incomplete.tar.gz');
  await assert.rejects(backupDkbStack(distribution, 'test', output), { code: 'stack_backup_incomplete' });
  await assert.rejects(fs.access(output), { code: 'ENOENT' });
  assert.equal((await fs.readdir(f.root)).some(name => name.includes('.tmp')), false);
  assert.equal(await fs.readFile(path.join(outside, 'preserved.txt'), 'utf8'), 'outside bytes');
});

test('restore rejects archived links before replacing any Stack data', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.stack, 'runtime', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const archive = path.join(f.root, 'links.tar.gz');
  await createTar({ cwd: f.root, file: archive, gzip: true }, ['test']);
  await fs.writeFile(`${archive}.sha256`, createHash('sha256').update(await fs.readFile(archive)).digest('hex'));
  const before = await fs.readFile(f.env);
  await assert.rejects(restoreDkbStack(distribution, archive, true), /link or special file/u);
  assert.deepEqual(await fs.readFile(f.env), before);
  await assert.rejects(fs.access(path.join(f.root, '.control')), { code: 'ENOENT' });
});

test('backup, restore, stop, prepare, and upgrade reject another host operation before touching Stack files or Docker', async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const before = await fs.readFile(f.env);
  const archive = path.join(f.root, 'valid-backup.tar.gz');
  await createTar({ cwd: f.root, file: archive, gzip: true }, ['test']);
  await fs.writeFile(`${archive}.sha256`, createHash('sha256').update(await fs.readFile(archive)).digest('hex'));
  const owner = withStackControl('test', async () => { entered.resolve(); await release.promise; });
  try {
    await entered.promise;
    for (const operation of [
      () => backupDkbStack(distribution, 'test', path.join(f.root, 'backup.tar.gz')),
      () => restoreDkbStack(distribution, archive, true),
      () => downDkbStack(distribution, 'test'),
      () => prepareDkbStack(distribution, 'test'),
      () => upgradeDkbStackRelease(distribution, 'test', 'not-read.json', async () => assert.fail('upgrade started')),
    ]) await assert.rejects(operation(), { code: 'stack_busy' });
    assert.deepEqual(await fs.readFile(f.env), before);
    assert.deepEqual((await fs.readdir(f.stack)).sort(), ['library', 'runtime', 'stack.env']);
  } finally { release.resolve(); await owner; }
});

test('Stack preparation never automatically moves or deletes an earlier co-located Library', async t => {
  const f = await fixture(t), original = path.join(f.stack, 'runtime');
  await fs.writeFile(path.join(original, 'dkb.json'), '{"type":"library","name":"preserve"}\n');
  await fs.mkdir(path.join(original, '.dkb'));
  await fs.writeFile(path.join(original, '.dkb', 'runtime.lock.json'), 'preserve derived state until explicit migration');
  const env = await fs.readFile(f.env);
  await assert.rejects(prepareDkbStack(distribution, 'test'), { code: 'stack_migration_required' });
  assert.deepEqual(await fs.readFile(f.env), env);
  assert.equal(await fs.readFile(path.join(original, '.dkb', 'runtime.lock.json'), 'utf8'), 'preserve derived state until explicit migration');
  assert.deepEqual(await fs.readdir(path.join(f.stack, 'library')), []);
});
