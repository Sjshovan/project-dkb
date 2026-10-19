// Actual Linux volume -> Windows archive -> fresh Linux volumes. Not Stack promotion.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerDockerProcess } from '../apps/cli/dist/host/dockerOwnerProcess.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { storageEnvironment } from '../apps/cli/dist/stack/ownedStorage.js';

if (process.argv[2] !== '--run' || process.argv.slice(3).some(value => value !== '--public') || process.argv.length > 4) throw new Error('Run explicitly: node tests/stack-volume-snapshot-proof.mjs --run [--public]');
const publicCommand = process.argv.includes('--public');
const context = (await raw(['context', 'show'])).trim(), docker = args => raw(['--context', context, ...args]);
const endpoint = JSON.parse(await docker(['context', 'inspect', context]))[0]?.Endpoints?.docker?.Host;
assert.match(endpoint, /^(?:unix:\/\/\/[^\0\r\n]+|npipe:\/{4}\.\/pipe\/[^/\\\s]+)$/u);
const image = (await docker(['image', 'inspect', process.env.DKB_BACKUP_PROOF_IMAGE ?? (publicCommand ? 'dkb-cli:volume-backup-candidate' : 'dkb-cli:pipeline-owner-candidate'), '--format', '{{.Id}}'])).trim();
assert.match(image, /^sha256:[a-f0-9]{64}$/u);
const id = randomUUID(), label = `dev.dkb.volume-snapshot-proof=${id}`;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-volume-snapshot-proof-'));
const roles = ['host', 'library', 'runtime', 'compiler', 'cache'];
const volumes = Object.fromEntries(['original', 'restored'].map(kind => [kind, Object.fromEntries(roles.map(role => [role, `dkb-snapshot-${id}-${kind}-${role}`]))]));
const storage = { format: 'dkb.stack-storage.v1', name: `proof-${id}`, id, phase: 'ready',
  owner: { context, image, libraryVolume: volumes.original.library, runtimeVolume: volumes.original.runtime, compilerVolume: volumes.original.compiler },
  volumes: Object.fromEntries(Object.entries(volumes.original).filter(([role]) => role !== 'host')),
  volumeEnvironment: { library: 'DKB_LIBRARY_VOLUME', runtime: 'DKB_RUNTIME_VOLUME', compiler: 'DKB_COMPILER_CONTEXT_VOLUME', cache: 'DKB_CACHE_VOLUME' }, sharedLibrary: true };
const limits = { maxBytes: 8 * 1024 * 1024, maxArchiveBytes: 10 * 1024 * 1024, maxEntries: 2000 };
const code = fileURLToPath(new URL('../apps/cli/dist', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/volume-snapshot-proof.mjs', import.meta.url));
const checks = [], archive = path.join(root, 'snapshot.tgz');
const cli = fileURLToPath(new URL('../apps/cli/dist/cli/index.js', import.meta.url));
const hostStack = path.join(root, 'stacks', storage.name), compose = path.join(root, 'compose.yaml');
const env = { ...process.env, DKB_STACK_STATE_ROOT: path.dirname(hostStack), DKB_STACK_COMPOSE_FILE: compose, DKB_HOST_INVENTORY: path.join(root, 'host.json') };
async function publicBackup(output, json = true) {
  return promisify(execFile)(process.execPath, [cli, ...(json ? ['--json'] : ['--no-progress']), 'stack', 'backup', storage.name, '--output', output],
    { env, windowsHide: true, timeout: 90_000, maxBuffer: 128 * 1024 });
}
function record(check) { checks.push(check); console.log(JSON.stringify({ status: 'passed', check })); }
function args(kind, suffix, extra = []) {
  return ['create', '--name', `dkb-snapshot-${id}-${suffix}`, '--label', label, '--pull', 'never', '--interactive', '--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER', '--security-opt', 'no-new-privileges',
    '--memory', '512m', '--pids-limit', '64', '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m', '--tmpfs', '/snapshot:rw,nosuid,nodev,size=64m',
    ...(!publicCommand ? ['--mount', `type=bind,src=${code},dst=/workspace/apps/cli/dist,readonly`] : []),
    '--mount', `type=bind,src=${fixture},dst=/workspace/tests/volume-snapshot-proof.mjs,readonly`,
    ...Object.entries(volumes[kind]).flatMap(([role, volume]) => ['--mount', `type=volume,src=${volume},dst=/snapshot/${role === 'host' ? 'host' : `volumes/${role}`},volume-nocopy`]),
    ...extra, '--entrypoint', 'node', image];
}
async function fixtureRun(kind, action) {
  const container = (await docker([...args(kind, `${kind}-${action}`), '/workspace/tests/volume-snapshot-proof.mjs', action])).trim();
  assert.match(container, /^[a-f0-9]{64}$/u);
  return JSON.parse(await docker(['start', '--attach', container]));
}
try {
  for (const group of Object.values(volumes)) for (const [role, volume] of Object.entries(group)) {
    await docker(['volume', 'create', '--driver', 'local', '--label', label, '--label', `dev.dkb.stack.storage=${id}`, '--label', `dev.dkb.stack.role=${role}`, volume]);
  }
  if (publicCommand) {
    await fs.mkdir(hostStack, { recursive: true });
    await fs.writeFile(path.join(hostStack, 'stack.env'), Object.entries({ DKB_STACK_NAME: storage.name, ...storageEnvironment(storage), SYNTHETIC_SECRET: 'only-a-fixture' }).map(([key, value]) => `${key}=${value}`).join('\n'));
    await fs.writeFile(path.join(hostStack, 'stack-storage.json'), JSON.stringify({ storage, digest: stableHash(storage) }));
    await fs.writeFile(compose, `services:\n  fixture:\n    image: "${image}"\n`);
  }
  const original = await fixtureRun('original', 'seed');
  record('seeded SQLite, source, Runtime fixture and service-owned cache links in Linux volumes');
  const holder = (await docker([...args('original', 'holder'), '/workspace/tests/volume-snapshot-proof.mjs', 'hold'])).trim();
  await docker(['start', holder]);
  let held = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    if ((await docker(['logs', holder])).includes('"ownership":"held"')) { held = true; break; }
    await delay(100);
  }
  assert.equal(held, true, 'Independent ownership fixture must actually acquire its native lease');
  if (publicCommand) {
    await assert.rejects(publicBackup(archive), error => error.stdout.includes('stack_storage_in_use'));
    await assert.rejects(fs.access(archive), { code: 'ENOENT' });
    record('public backup rejects another active consumer before creating an archive');
  }
  const busy = (await docker([...args('original', 'busy-backup'), '/workspace/apps/cli/dist/stack/volumeSnapshotWorker.js'])).trim();
  const refused = await ownerDockerProcess(['--context', context, 'start', '--attach', '--interactive', busy], {
    input: JSON.stringify({ format: 'dkb.stack-snapshot-worker.v1', command: 'snapshot', storage, limits }), timeoutMs: 60_000 });
  assert.notEqual(refused.code, 0); assert.equal(refused.stdout, ''); assert(refused.stderr.includes('library_busy'));
  await docker(['stop', '--time', '10', holder]);
  assert.equal(JSON.parse(await docker(['inspect', holder]))[0].State.Running, false);
  record('another Linux owner blocks snapshot admission; confirmed stop releases native ownership');
  if (publicCommand) {
    const result = await publicBackup(archive);
    assert.match(result.stdout, /"status":\s*"backed_up"/u);
    assert(!result.stdout.includes('only-a-fixture')); assert(!result.stderr.includes('only-a-fixture'));
    const retained = await fs.readFile(archive);
    await assert.rejects(publicBackup(archive), error => error.stdout.includes('stack_backup_exists'));
    assert.deepEqual(await fs.readFile(archive), retained);
    const human = await publicBackup(path.join(root, 'human.tgz'), false);
    assert.match(human.stdout, /Archive:/u); assert.match(human.stdout, /Contains secrets: yes/u);
    record('public human and JSON backup report verified archives and refuse overwrite');
  } else {
    const backup = (await docker([...args('original', 'backup'), '/workspace/apps/cli/dist/stack/volumeSnapshotWorker.js'])).trim();
    assert.match(backup, /^[a-f0-9]{64}$/u);
    await binaryArchive(backup, JSON.stringify({ format: 'dkb.stack-snapshot-worker.v1', command: 'snapshot', storage, limits }));
    assert.equal(JSON.parse(await docker(['inspect', backup]))[0].State.ExitCode, 0);
  }
  record('streamed verified archive from Linux volumes to a bounded Windows file');
  const digest = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  const rejectedRestore = (await docker([...args('restored', 'bad-restore', ['--mount', `type=bind,src=${archive},dst=/input/archive,readonly`]),
    '/workspace/apps/cli/dist/stack/volumeSnapshotWorker.js'])).trim();
  const rejected = await ownerDockerProcess(['--context', context, 'start', '--attach', '--interactive', rejectedRestore], {
    input: JSON.stringify({ format: 'dkb.stack-snapshot-worker.v1', command: 'restore-stage', storage, limits, sha256: '0'.repeat(64) }), timeoutMs: 60_000 });
  assert.notEqual(rejected.code, 0); assert.equal(rejected.stdout, '');
  record('wrong checksum refuses restoration without occupying the fresh staging volumes');
  const restore = (await docker([...args('restored', 'restore', ['--mount', `type=bind,src=${archive},dst=/input/archive,readonly`]),
    '/workspace/apps/cli/dist/stack/volumeSnapshotWorker.js'])).trim();
  assert.match(restore, /^[a-f0-9]{64}$/u);
  const result = await ownerDockerProcess(['--context', context, 'start', '--attach', '--interactive', restore], {
    input: JSON.stringify({ format: 'dkb.stack-snapshot-worker.v1', command: 'restore-stage', storage, limits, sha256: digest }), timeoutMs: 60_000 });
  if (result.code !== 0) {
    const diagnostic = (await docker([...args('restored', 'diagnose-restore', ['--mount', `type=bind,src=${archive},dst=/input/archive,readonly`]),
      '/workspace/tests/volume-snapshot-proof.mjs', 'diagnose-restore'])).trim();
    console.log(await docker(['start', '--attach', diagnostic]));
  }
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).status, 'staged');
  record('restored and verified exact bytes into different fresh Linux volumes');
  assert.deepEqual(await fixtureRun('restored', 'inspect'), original);
  assert.deepEqual(await fixtureRun('original', 'inspect'), original);
  record('restored SQLite integrity and links pass; originals remain independently readable');
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, image, publicBackup: publicCommand, currentCompiledCodeMounted: !publicCommand,
    bytes: (await fs.stat(archive)).size, userResourcesChanged: false, stackPromotionProven: false }));
} finally {
  const containers = (await docker(['container', 'ls', '--all', '--filter', `label=${label}`, '--format', '{{.ID}}'])).trim().split(/\s+/u).filter(Boolean);
  for (const container of containers) {
    assert.match(container, /^[a-f0-9]{12,64}$/u);
    const [info] = JSON.parse(await docker(['inspect', container]));
    assert.equal(info.Config.Labels['dev.dkb.volume-snapshot-proof'], id); assert.equal(info.Image, image);
    await docker(['container', 'rm', '--force', container]);
  }
  const created = (await docker(['volume', 'ls', '--filter', `label=${label}`, '--format', '{{.Name}}'])).trim().split(/\s+/u).filter(Boolean);
  for (const volume of created) {
    assert(Object.values(volumes).flatMap(Object.values).includes(volume));
    const [info] = JSON.parse(await docker(['volume', 'inspect', volume]));
    assert.equal(info.Labels['dev.dkb.volume-snapshot-proof'], id);
    await docker(['volume', 'rm', volume]);
  }
  assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith('dkb-volume-snapshot-proof-'));
  await fs.rm(root, { recursive: true, force: true });
}

async function binaryArchive(container, input) {
  const child = spawn('docker', ['--context', context, 'start', '--attach', '--interactive', container], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostic = '', timeout = false, count = 0;
  const timer = setTimeout(() => { timeout = true; child.kill(); }, 60_000);
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  child.stderr.on('data', data => { diagnostic += data.toString(); if (diagnostic.length > 65_536) child.kill(); });
  child.stdin.on('error', () => {}); child.stdin.end(input);
  child.stdout.on('data', data => { count += data.length; if (count > limits.maxArchiveBytes) child.kill(); });
  try {
    const results = await Promise.allSettled([pipeline(child.stdout, createWriteStream(archive, { flags: 'wx', mode: 0o600 })), closed]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    assert.equal(timeout, false); assert.equal(results[1].value, 0, diagnostic);
  } finally { clearTimeout(timer); }
}
async function raw(args) {
  const result = await ownerDockerProcess(args, { timeoutMs: 60_000 });
  assert.equal(result.code, 0, result.stderr); return result.stdout;
}
