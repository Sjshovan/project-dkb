// Explicit public startup proof, isolated from every user Stack and host default.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_DKB_DISTRIBUTION as distribution } from '@sjshovan/dkb-distribution-default';
import { upDkbStack, downDkbStack, statusDkbStack } from '../apps/cli/dist/stack/manager.js';
import { readStackStorage, provisionStackStorage } from '../apps/cli/dist/stack/ownedStorage.js';
import { readEnvironmentFile } from '../apps/cli/dist/stack/context.js';
import { readHostInventory } from '../apps/cli/dist/host/inventory.js';
import { readDockerLibraryCommand } from '../apps/cli/dist/host/libraryOwnerResult.js';
import { ownerDockerProcess } from '../apps/cli/dist/host/dockerOwnerProcess.js';
import { inspectDockerStackOwner } from '../apps/cli/dist/stack/owner.js';
import { withStackControl } from '../apps/cli/dist/stack/control.js';

if (process.argv.length !== 3 || process.argv[2] !== '--run') throw new Error('Run explicitly with --run after building the candidate CLI, Runtime and compiler images.');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-stack-volume-proof-'));
const name = `volume-proof-${randomUUID().slice(0, 8)}`;
Object.assign(process.env, { DKB_STACK_STATE_ROOT: path.join(root, 'stacks'), DKB_HOST_INVENTORY: path.join(root, 'host.json'),
  DKB_CLI_CONFIG: path.join(root, 'config.json'), DKB_GLOBAL_ROOT: path.join(root, 'global'),
  DKB_CLI_IMAGE: 'dkb-cli:owner-candidate', DKB_RUNTIME_IMAGE: 'dkb-runtime:owner-candidate', DKB_COMPILER_IMAGE: 'dkb-compiler:owner-candidate',
  DKB_COMPILER_ALLOWED_TARGETS: 'fastembed-faiss', DKB_BUILD_COMMIT: 'development',
  DKB_EVIDENCE_IMAGE: 'dkb-evidence-docling-llamaindex:cancel-20260913', DKB_FASTEMBED_IMAGE: 'dkb-embedding-fastembed:auth-20260913' });
let storage;
const record = check => console.log(JSON.stringify({ check, status: 'passed' }));
const docker = async args => {
  const result = await ownerDockerProcess(['--context', storage.owner.context, ...args], { timeoutMs: 120_000 });
  assert.equal(result.code, 0, result.stderr); return result.stdout;
};
try {
  console.log(JSON.stringify({ stage: 'public Stack startup', name }));
  const ready = await upDkbStack(distribution, name, { compilerTarget: 'fastembed-faiss', runtimeTarget: 'fastembed-faiss' });
  storage = await readStackStorage(name);
  assert.equal(ready.status, 'ready'); assert.ok(ready.checks.every(check => check.status === 'ok'));
  const inventory = await readHostInventory();
  assert.equal(inventory.libraries[ready.libraryName].storage.volume, storage.owner.libraryVolume);
  assert.equal(inventory.runtimes[ready.runtimeName].stateRoot, undefined);
  assert.equal(inventory.runtimes[ready.runtimeName].library, ready.libraryName);
  const inspect = () => inspectDockerStackOwner(distribution, storage.owner, { format: 'dkb.stack-owner.v1', command: 'inspect', input: {} });
  const active = await inspect(); assert.equal(active.runtime.state, 'current');
  const containerIds = (await docker(['container', 'ls', '--all', '--filter', `label=com.docker.compose.project=dkb-${name}`, '--format', '{{.ID}}'])).trim().split(/\s+/u);
  const containers = JSON.parse(await docker(['container', 'inspect', ...containerIds]));
  for (const container of containers) for (const mount of container.Mounts) assert.equal(mount.Type, 'volume');
  const owner = { context: storage.owner.context, image: storage.owner.image, volume: storage.owner.libraryVolume };
  assert.ok(await readDockerLibraryCommand(owner, 'library.packages'));
  record('public startup, health, Linux activation, volume-only mounts and host inventory');
  const values = await readEnvironmentFile(path.join(process.env.DKB_STACK_STATE_ROOT, name, 'stack.env'));
  const unauthenticated = await fetch(`${ready.runtimeUrl}/admin/status`);
  assert.notEqual(unauthenticated.status, 200);
  await downDkbStack(distribution, name);
  assert.ok((await statusDkbStack(distribution, name)).services.every(service => service.status !== 'running'));
  const restarted = await upDkbStack(distribution, name);
  assert.equal(restarted.status, 'ready'); assert.equal((await inspect()).library.id, active.library.id);
  const later = await readEnvironmentFile(path.join(process.env.DKB_STACK_STATE_ROOT, name, 'stack.env'));
  for (const key of ['DKB_RUNTIME_ADMIN_TOKEN', 'DKB_REGISTRY_APP_KEY', 'DKB_LIBRARY_VOLUME', 'DKB_RUNTIME_VOLUME']) assert.equal(later[key], values[key]);
  record('stop/restart preserves owner volumes, Library identity, credentials and inventory');
  await downDkbStack(distribution, name);
  // Delete only this disposable proof's stopped Runtime to test loss of authoritative storage.
  await docker(['volume', 'rm', storage.volumes.runtime]);
  await assert.rejects(withStackControl(name, () => provisionStackStorage(distribution, name)), { code: 'stack_storage_missing' });
  record('missing ready volume refuses empty replacement');
} finally {
  storage ??= await readStackStorage(name);
  if (storage) {
    const ids = (await docker(['container', 'ls', '--all', '--filter', `label=com.docker.compose.project=dkb-${name}`, '--format', '{{.ID}}'])).trim().split(/\s+/u).filter(Boolean);
    if (ids.length) await docker(['container', 'rm', '--force', ...ids]);
    const networks = (await docker(['network', 'ls', '--filter', `label=com.docker.compose.project=dkb-${name}`, '--format', '{{.ID}}'])).trim().split(/\s+/u).filter(Boolean);
    if (networks.length) await docker(['network', 'rm', ...networks]);
    const volumes = (await docker(['volume', 'ls', '--filter', `label=dev.dkb.stack.storage=${storage.id}`, '--format', '{{.Name}}'])).trim().split(/\s+/u).filter(Boolean);
    assert.ok(volumes.every(volume => Object.values(storage.volumes).includes(volume)));
    if (volumes.length) await docker(['volume', 'rm', ...volumes]);
  }
  assert.equal(path.dirname(root), os.tmpdir());
  assert.ok(path.basename(root).startsWith('dkb-stack-volume-proof-'));
  await fs.rm(root, { recursive: true, force: true });
}
