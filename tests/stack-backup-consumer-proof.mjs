// Bounded read-only quiescence proof. Does not claim a consistent volume archive.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { ownerDockerProcess } from '../apps/cli/dist/host/dockerOwnerProcess.js';
import { requireStoppedStack } from '../apps/cli/dist/stack/backups.js';
import { storageEnvironment } from '../apps/cli/dist/stack/ownedStorage.js';

if (process.argv.length !== 3 || process.argv[2] !== '--run') throw new Error('Run explicitly: node tests/stack-backup-consumer-proof.mjs --run');
const context = (await raw(['context', 'show'])).trim();
const docker = args => raw(['--context', context, ...args]);
const endpoint = JSON.parse(await docker(['context', 'inspect', context]))[0]?.Endpoints?.docker?.Host;
assert.match(endpoint, /^(?:unix:\/\/\/[^\0\r\n]+|npipe:\/{4}\.\/pipe\/[^/\\\s]+)$/u);
const image = (await docker(['image', 'inspect', process.env.DKB_BACKUP_PROOF_IMAGE ?? 'dkb-cli:pipeline-owner-candidate', '--format', '{{.Id}}'])).trim();
assert.match(image, /^sha256:[a-f0-9]{64}$/u);
const id = randomUUID(), prefix = `dkb-backup-consumer-${id}`, label = `dev.dkb.backup-consumer-proof=${id}`;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-stack-backup-consumer-proof-'));
const previous = process.env.DKB_STACK_STATE_ROOT;
process.env.DKB_STACK_STATE_ROOT = root;
const stackName = `proof-${id}`, stack = path.join(root, stackName), name = `${prefix}-other-runtime`;
const volumes = Object.fromEntries(['library', 'runtime', 'compiler', 'registry'].map(role => [role, `${prefix}-${role}`]));
const storage = { format: 'dkb.stack-storage.v1', name: stackName, id, phase: 'ready',
  owner: { context, image, libraryVolume: volumes.library, runtimeVolume: volumes.runtime, compilerVolume: volumes.compiler },
  volumes, volumeEnvironment: { library: 'DKB_LIBRARY_VOLUME', runtime: 'DKB_RUNTIME_VOLUME', compiler: 'DKB_COMPILER_CONTEXT_VOLUME', registry: 'DKB_REGISTRY_VOLUME' },
  sharedLibrary: true };
const control = { name: stackName, projectName: `dkb-${stackName}`, root: stack, envFile: path.join(stack, 'stack.env'),
  composeFile: path.join(root, 'not-read.yaml'), allProfiles: [], dockerContext: context };
const checks = [];
const record = check => { checks.push(check); console.log(JSON.stringify({ status: 'passed', check })); };
try {
  await fs.mkdir(stack);
  await fs.writeFile(path.join(stack, 'stack-storage.json'), JSON.stringify({ storage, digest: stableHash(storage) }));
  await fs.writeFile(control.envFile, Object.entries({ DKB_STACK_NAME: stackName, ...storageEnvironment(storage) }).map(([key, value]) => `${key}=${value}`).join('\n'));
  for (const volume of Object.values(volumes)) await docker(['volume', 'create', '--driver', 'local', '--label', label, volume]);
  const before = await fs.readFile(control.envFile);
  await requireStoppedStack(control, 'back up');
  await docker(['create', '--pull', 'never', '--name', name, '--label', label,
    '--label', 'com.docker.compose.project=dkb-unrelated-proof-runtime', '--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '64m', '--pids-limit', '32',
    '--mount', `type=volume,src=${volumes.library},dst=/library,volume-nocopy`, '--entrypoint', 'node', image,
    '-e', 'setInterval(()=>{},1000)']);
  await assert.rejects(requireStoppedStack(control, 'back up'), { code: 'stack_storage_in_use' });
  record('created consumer in another Compose project blocks the target Stack');
  await docker(['start', name]);
  await assert.rejects(requireStoppedStack(control, 'back up'), { code: 'stack_storage_in_use' });
  await docker(['pause', name]);
  await assert.rejects(requireStoppedStack(control, 'back up'), { code: 'stack_storage_in_use' });
  record('running and paused independent Runtime consumers are rejected');
  await docker(['unpause', name]); await docker(['stop', '--time', '1', name]);
  await requireStoppedStack(control, 'back up');
  assert.deepEqual(await fs.readFile(control.envFile), before);
  record('confirmed stopped consumer is admitted without changing topology or starting a service');
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, hostPlatform: process.platform, image,
    userResourcesChanged: false, volumeBackupImplemented: false }));
} finally {
  const ids = (await docker(['container', 'ls', '--all', '--filter', `label=${label}`, '--format', '{{.ID}}'])).trim().split(/\s+/u).filter(Boolean);
  for (const container of ids) {
    assert.match(container, /^[a-f0-9]{12,64}$/u);
    const [info] = JSON.parse(await docker(['container', 'inspect', container]));
    assert.equal(info.Config.Labels['dev.dkb.backup-consumer-proof'], id); assert.equal(info.Image, image);
    if (info.State.Paused) await docker(['unpause', container]);
    await docker(['container', 'rm', '--force', container]);
  }
  const names = (await docker(['volume', 'ls', '--filter', `label=${label}`, '--format', '{{.Name}}'])).trim().split(/\s+/u).filter(Boolean);
  for (const volume of names) {
    assert(Object.values(volumes).includes(volume));
    const [info] = JSON.parse(await docker(['volume', 'inspect', volume]));
    assert.equal(info.Labels['dev.dkb.backup-consumer-proof'], id);
    await docker(['volume', 'rm', volume]);
  }
  if (previous === undefined) delete process.env.DKB_STACK_STATE_ROOT; else process.env.DKB_STACK_STATE_ROOT = previous;
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert(path.basename(root).startsWith('dkb-stack-backup-consumer-proof-'));
  await fs.rm(root, { recursive: true, force: true });
}
async function raw(args) {
  const result = await ownerDockerProcess(args, { timeoutMs: 45_000 });
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
