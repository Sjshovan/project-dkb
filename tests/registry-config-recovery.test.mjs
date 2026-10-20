import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { configuredRegistry, writeConfiguredRegistryUrl } from '../apps/cli/dist/cli/registryConfig.js';
import { syncLibrary } from '@sjshovan/dkb-library/resolver.js';
import { captureLibraryReadFence, recoverLibraryMutation, withLibraryMutation, writeLibraryMutationFile, removeLibraryPath } from '@sjshovan/dkb-library/mutation.js';

const previousUrl = 'https://previous.example';
const nextUrl = 'https://next.example';
const configModule = pathToFileURL(path.resolve('apps/cli/dist/cli/registryConfig.js')).href;
const mutationModule = pathToFileURL(path.resolve('packages/library/dist/mutation.js')).href;
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-registry-config-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifest = path.join(root, 'dkb.json'), config = path.join(root, '.dkb', 'config.json');
  await fs.mkdir(path.dirname(config));
  await fs.writeFile(manifest, JSON.stringify({ type: 'library', name: 'Registry recovery', roots: {}, registry: { url: previousUrl } }));
  await fs.writeFile(config, JSON.stringify({ format: 'dkb.config.v2', registry: { url: previousUrl }, activeTarget: 'preserved' }));
  await syncLibrary(root);
  return { root, manifest, config, before: [await fs.readFile(manifest), await fs.readFile(config)] };
}
async function bytes(f) { return Promise.all([fs.readFile(f.manifest), fs.readFile(f.config)]); }

test('Registry default replacement rolls back both authoritative files on promotion failure', async t => {
  const f = await fixture(t);
  const rename = fs.rename.bind(fs);
  let failed = false;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === f.manifest && !failed) {
      failed = true;
      throw Object.assign(new Error('Synthetic manifest promotion failure'), { code: 'EIO' });
    }
    return rename(from, to);
  });
  await assert.rejects(writeConfiguredRegistryUrl(nextUrl, { root: f.root }), /Synthetic manifest promotion failure/);
  assert.equal(failed, true);
  assert.deepEqual(await bytes(f), f.before);
  assert.equal((await recoverLibraryMutation(f.root)).status, 'unchanged');
});

test('Registry-default reads reject an unfinished Library write instead of using partial configuration', async t => {
  const f = await fixture(t);
  let ready, release;
  const started = new Promise(resolve => { ready = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const writing = withLibraryMutation(f.root, async () => { ready(); await held; });
  await started;
  try {
    await assert.rejects(configuredRegistry({ root: f.root }), error => error.code === 'library_recovery_required' || error.code === 'library_busy');
  } finally { release(); await writing; }
});

async function pausedWriter(t, f, phase) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs/promises';
    import {writeConfiguredRegistryUrl} from ${JSON.stringify(configModule)};
    const manifest=${JSON.stringify(f.manifest)}, config=${JSON.stringify(f.config)}, phase=${JSON.stringify(phase)};
    const hold=async()=>{process.send('ready'); await new Promise(()=>{});};
    const rename=fs.rename.bind(fs), rm=fs.rm.bind(fs);
    fs.rename=async(a,b)=>{
      const result=await rename(a,b);
      if(phase==='config-promoted'&&b===config)await hold();
      if(phase==='manifest-displaced'&&a===manifest)await hold();
      if(phase==='manifest-promoted'&&b===manifest)await hold();
      return result;
    };
    fs.rm=async(a,options)=>{
      if(phase==='committed-cleanup'&&String(a).endsWith('.backup'))await hold();
      return rm(a,options);
    };
    await writeConfiguredRegistryUrl(${JSON.stringify(nextUrl)},{root:${JSON.stringify(f.root)}});
  `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', chunk => stderr += chunk);
  const closed = once(child, 'close');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
  let timer;
  try {
    assert.equal(await Promise.race([once(child, 'message').then(([message]) => message),
      closed.then(([code]) => { throw new Error(`Writer exited ${code}: ${stderr}`); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Registry writer did not pause')), 15_000); }),
    ]), 'ready');
  } finally { clearTimeout(timer); }
  child.kill('SIGKILL');
  await closed;
}

async function freshRecovery(t, root) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {recoverLibraryMutation} from ${JSON.stringify(mutationModule)};
    console.log(JSON.stringify(await recoverLibraryMutation(${JSON.stringify(root)})));
  `], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  const closed = once(child, 'close');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try { assert.equal((await closed)[0], 0, stderr); } finally { clearTimeout(timer); }
  return JSON.parse(stdout);
}

for (const phase of ['config-promoted', 'manifest-displaced', 'manifest-promoted', 'committed-cleanup']) {
  test(`Registry pair survives process death at ${phase} and fresh-process recovery`, async t => {
    const f = await fixture(t);
    const logicalLock = await fs.readFile(path.join(f.root, 'dkb-lock.json'));
    await pausedWriter(t, f, phase);
    await assert.rejects(configuredRegistry({ cwd: f.root }), { code: 'library_recovery_required' });
    await assert.rejects(writeConfiguredRegistryUrl(previousUrl, { root: f.root }), { code: 'library_recovery_required' });
    const result = await freshRecovery(t, f.root);
    const committed = phase === 'committed-cleanup';
    assert.equal(result.status, committed ? 'committed' : 'rolled_back');
    if (!committed) assert.deepEqual(await bytes(f), f.before);
    assert.equal(JSON.parse(await fs.readFile(f.manifest)).registry.url, committed ? nextUrl : previousUrl);
    const config = JSON.parse(await fs.readFile(f.config));
    assert.equal(config.registry.url, committed ? nextUrl : previousUrl);
    assert.equal(config.activeTarget, 'preserved');
    assert.deepEqual(await fs.readFile(path.join(f.root, 'dkb-lock.json')), logicalLock);
    assert.equal((await freshRecovery(t, f.root)).status, 'unchanged');
    assert.equal((await configuredRegistry({ root: f.root })).url, committed ? nextUrl : previousUrl);
  });
}

test('repeating the same Registry is a no-op and invalid roots do not gain control state', async t => {
  const f = await fixture(t);
  const fence = await captureLibraryReadFence(f.root);
  await writeConfiguredRegistryUrl(previousUrl, { root: f.root });
  assert.equal(await captureLibraryReadFence(f.root), fence);
  assert.deepEqual(await bytes(f), f.before);
  const other = path.join(f.root, 'not-a-library');
  await fs.mkdir(other);
  await assert.rejects(writeConfiguredRegistryUrl(nextUrl, { root: other }), /Not a DKB Library/);
  assert.deepEqual(await fs.readdir(other), []);
  await fs.writeFile(f.config, '{invalid');
  await assert.rejects(writeConfiguredRegistryUrl(nextUrl, { root: f.root }), /Invalid DKB configuration/);
  assert.equal(await captureLibraryReadFence(f.root), fence);
  assert.deepEqual(await fs.readFile(f.manifest), f.before[0]);
});

test('Registry writer queues behind a displaced manifest without losing other fields', async t => {
  const f = await fixture(t);
  let writing;
  await withLibraryMutation(f.root, async () => {
    await removeLibraryPath(f.root, f.manifest);
    // Start outside the owning async scope so this is a competing writer.
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import {writeConfiguredRegistryUrl} from ${JSON.stringify(configModule)};
      process.send('started');
      await writeConfiguredRegistryUrl(${JSON.stringify(nextUrl)},{root:${JSON.stringify(f.root)}});
    `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', chunk => stderr += chunk);
    writing = once(child, 'close');
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await writing; });
    await once(child, 'message');
    const manifest = JSON.parse(f.before[0]);
    await writeLibraryMutationFile(f.root, f.manifest, JSON.stringify({ ...manifest, description: 'concurrent edit' }));
    writing = writing.then(([code]) => assert.equal(code, 0, stderr));
  });
  await writing;
  assert.equal(JSON.parse(await fs.readFile(f.manifest)).description, 'concurrent edit');
  assert.equal((await configuredRegistry({ root: f.root })).url, nextUrl);
});

test('configuration exception does not authorize generic control-file replacement or forged recovery', async t => {
  const f = await fixture(t);
  await assert.rejects(withLibraryMutation(f.root, () => writeLibraryMutationFile(f.root, f.config, '{}')), /control state/);
  await assert.rejects(withLibraryMutation(f.root, () => removeLibraryPath(f.root, f.config)), /control state/);
  await pausedWriter(t, f, 'config-promoted');
  const db = new DatabaseSync(path.join(f.root, '.dkb', 'state.sqlite'));
  try {
    const journal = JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='libraryMutation'").get().value);
    journal.changes[0].target = '.dkb/credentials.json';
    db.prepare("UPDATE metadata SET value=? WHERE key='libraryMutation'").run(JSON.stringify(journal));
  } finally { db.close(); }
  const preserved = await bytes(f);
  await assert.rejects(recoverLibraryMutation(f.root), /Invalid Library recovery journal/);
  assert.deepEqual(await bytes(f), preserved);
  await assert.rejects(fs.access(path.join(f.root, '.dkb', 'credentials.json')), { code: 'ENOENT' });
});
