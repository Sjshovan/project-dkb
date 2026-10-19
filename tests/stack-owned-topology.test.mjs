import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parse } from 'yaml';
import { DEFAULT_DKB_DISTRIBUTION as distribution } from '@sjshovan/dkb-distribution-default';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { STACK_VOLUME_ENV, validateStackStorage, storageEnvironment, readStackStorage, provisionStackStorage } from '../apps/cli/dist/stack/ownedStorage.js';
import { ownedStackContext, encodeStackEnvironment, readOwnedStack } from '../apps/cli/dist/stack/ownedContext.js';
import { stackEnvironment } from '../apps/cli/dist/stack/context.js';
import { composeArguments } from '../apps/cli/dist/stack/docker.js';
import { createRoot } from './runtime-query-fixture.mjs';

function fixture() {
  const volumeEnvironment = { ...STACK_VOLUME_ENV, ...distribution.stackVolumes };
  const volumes = Object.fromEntries(Object.keys(volumeEnvironment).map(role => [role, `owned-${role}`]));
  const storage = { format: 'dkb.stack-storage.v1', name: 'owned', id: randomUUID(), phase: 'ready', sharedLibrary: false, volumes, volumeEnvironment,
    owner: { context: 'desktop-linux', image: `sha256:${'a'.repeat(64)}`, libraryVolume: volumes.library, runtimeVolume: volumes.runtime, compilerVolume: volumes.compiler } };
  const values = { ...stackEnvironment(distribution, 'owned', '/unused-host-control', {}, { target: 'default', runtimeTarget: 'default', allowedTargets: ['default'] }, {}),
    ...storageEnvironment(storage), DKB_STACK_REQUIRED_SERVICES: distribution.services.filter(s => !s.providerId).map(s => s.id).join(','),
    DKB_STACK_RECIPE_DIGEST: `sha256:${'b'.repeat(64)}` };
  return { storage, values };
}

test('owner topology has distinct explicit volumes and no host Library or Runtime paths', () => {
  const { storage, values } = fixture();
  assert.deepEqual(validateStackStorage(storage, 'owned'), storage);
  const result = ownedStackContext(distribution, storage.owner, encodeStackEnvironment(values), path.resolve('deploy/compose.yaml'));
  assert.equal('libraryRoot' in result, false);
  assert.equal('runtimeStateRoot' in result, false);
  assert.deepEqual(composeArguments(result, ['up']).slice(0, 3), ['--context', 'desktop-linux', 'compose']);
  for (const mutate of [s => { s.volumes.runtime = s.volumes.library; }, s => { s.owner.image = 'dkb-cli:latest'; },
    s => { s.volumes.jobs = '../jobs'; }, s => { s.command = 'arbitrary'; }, s => { s.name = 'foreign'; }]) {
    const broken = structuredClone(storage); mutate(broken);
    assert.throws(() => validateStackStorage(broken, 'owned'));
  }
  assert.throws(() => ownedStackContext(distribution, storage.owner, encodeStackEnvironment({ ...values, DKB_LIBRARY_HOST_PATH: 'C:/data' }), 'compose.yaml'), { code: 'stack_storage_mismatch' });
  assert.throws(() => ownedStackContext(distribution, storage.owner, encodeStackEnvironment({ ...values, DKB_STACK_REQUIRED_SERVICES: 'unknown' }), 'compose.yaml'), { code: 'invalid_stack_topology' });
  assert.throws(() => encodeStackEnvironment({ TOKEN: 'secret\nDKB_RUNTIME_IMAGE=foreign' }), { code: 'invalid_stack_environment' });
});

test('Compose declares Linux volumes as external and has no native database bind mount', async () => {
  const compose = parse(await fs.readFile('deploy/compose.yaml', 'utf8'));
  for (const [name, volume] of Object.entries(compose.volumes)) {
    assert.equal(volume.external, true, name);
    assert.match(volume.name, /^\$\{DKB_[A-Z_]+_VOLUME:\?/u);
  }
  for (const service of Object.values(compose.services)) for (const mount of service.volumes ?? []) {
    assert.equal(typeof mount, 'string');
    assert.ok(compose.volumes[mount.split(':')[0]], mount);
  }
});

test('reading owner topology checks descriptor integrity without creating Library databases or probing Docker', async t => {
  const { root } = await createRoot(t);
  const previous = process.env.DKB_STACK_STATE_ROOT;
  process.env.DKB_STACK_STATE_ROOT = root;
  t.after(() => { if (previous === undefined) delete process.env.DKB_STACK_STATE_ROOT; else process.env.DKB_STACK_STATE_ROOT = previous; });
  const { storage, values } = fixture(), dir = path.join(root, 'owned');
  await fs.mkdir(dir);
  const file = path.join(dir, 'stack-storage.json');
  await fs.writeFile(file, JSON.stringify({ storage, digest: stableHash(storage) }));
  await fs.writeFile(path.join(dir, 'stack.env'), encodeStackEnvironment(values));
  assert.deepEqual(await readStackStorage('owned'), storage);
  assert.equal((await readOwnedStack(distribution, 'owned')).dockerContext, 'desktop-linux');
  assert.deepEqual((await fs.readdir(dir)).sort(), ['stack-storage.json', 'stack.env']);
  await fs.writeFile(file, JSON.stringify({ storage: { ...storage, phase: 'provisioning' }, digest: stableHash(storage) }));
  await assert.rejects(readStackStorage('owned'), { code: 'invalid_stack_storage' });
});

test('existing host state requires explicit migration before Docker creation or data access', async t => {
  const { root } = await createRoot(t);
  const previous = process.env.DKB_STACK_STATE_ROOT;
  process.env.DKB_STACK_STATE_ROOT = root;
  t.after(() => { if (previous === undefined) delete process.env.DKB_STACK_STATE_ROOT; else process.env.DKB_STACK_STATE_ROOT = previous; });
  await fs.mkdir(path.join(root, 'old'));
  const sentinel = path.join(root, 'old', 'stack.env');
  await fs.writeFile(sentinel, 'DKB_LIBRARY_HOST_PATH=C:/keep-me\n');
  await assert.rejects(provisionStackStorage(distribution, 'old'), { code: 'stack_migration_required' });
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'DKB_LIBRARY_HOST_PATH=C:/keep-me\n');
});

test('init --if-absent leaves an existing Library and its Registry configuration byte-identical', async t => {
  const { root } = await createRoot(t), library = path.join(root, 'library');
  const env = { ...process.env, DKB_HOST_INVENTORY: path.join(root, 'host.json'), DKB_CLI_CONFIG: path.join(root, 'config.json') };
  const cli = (...args) => spawnSync(process.execPath, ['apps/cli/dist/cli/index.js', '--json', 'init', '--dir', library, '--yes', '--no-verify', ...args], { env, encoding: 'utf8', timeout: 15_000 });
  const first = cli('--registry-url', 'https://one.invalid', '--if-absent');
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const manifest = await fs.readFile(path.join(library, 'dkb.json'));
  const config = await fs.readFile(path.join(library, '.dkb', 'config.json'));
  const second = cli('--registry-url', 'https://two.invalid', '--if-absent');
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.deepEqual(await fs.readFile(path.join(library, 'dkb.json')), manifest);
  assert.deepEqual(await fs.readFile(path.join(library, '.dkb', 'config.json')), config);
});
