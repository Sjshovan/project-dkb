import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  assertLibraryMutation, assertLibraryReadFence, captureLibraryReadFence, promoteLibraryPath,
  recoverLibraryMutation, removeLibraryPath, withLibraryMutation, writeLibraryMutationFile,
} from '@sjshovan/dkb-library/mutation.js';
import { applyLibraryLock, maybeReadLibraryLock, readLibraryState } from '@sjshovan/dkb-library/state.js';
import { syncLibrary } from '@sjshovan/dkb-library/resolver.js';
import { createLocalCollection } from '@sjshovan/dkb-library/collections.js';
import { inspectInstalledPackage, listInstalledPackageContents, previewInstalledPackageFile, verifyInstalledPackage } from '@sjshovan/dkb-library/packageInfo.js';
import { inspectLibraryStorage } from '@sjshovan/dkb-library/storage.js';

const mutationUrl = pathToFileURL(path.resolve('packages/library/dist/mutation.js')).href;
const stateUrl = pathToFileURL(path.resolve('packages/library/dist/state.js')).href;
const before = JSON.stringify({ type: 'library', name: 'Crash fixture', roots: {} });
const after = JSON.stringify({ type: 'library', name: 'Next fixture', roots: {} });

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-library-mutation-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'dkb.json'), before);
  await syncLibrary(root);
  return root;
}
async function freshRecovery(root) {
  return childResult(`import {recoverLibraryMutation} from ${JSON.stringify(mutationUrl)};
    console.log(JSON.stringify(await recoverLibraryMutation(${JSON.stringify(root)})));`);
}
async function childResult(source) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => stdout += chunk);
  child.stderr.on('data', (chunk) => stderr += chunk);
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  const [code] = await once(child, 'exit'); clearTimeout(timer);
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout);
}
async function interrupted(root, phase) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import {withLibraryMutation,writeLibraryMutationFile,removeLibraryPath} from ${JSON.stringify(mutationUrl)};
    import {applyLibraryLock,maybeReadLibraryLock} from ${JSON.stringify(stateUrl)};
    const root=${JSON.stringify(root)}, phase=${JSON.stringify(phase)};
    const hold=async()=>{process.send('ready'); await new Promise(()=>{});};
    const rename=fs.rename.bind(fs), rm=fs.rm.bind(fs), open=fs.open.bind(fs);
    fs.open=async(a,...args)=>{
      const handle=await open(a,...args);
      if(phase==='partial-stage'&&String(a).endsWith('.stage')) {
        handle.writeFile=async(bytes)=>{await handle.write(Buffer.from(bytes).subarray(0,11));await handle.sync();await hold();};
      }
      return handle;
    };
    fs.rename=async(a,b)=>{
      if(phase==='before-backup'&&a===path.join(root,'dkb.json'))await hold();
      if(phase==='rollback-before-restore'&&String(a).endsWith('.backup')&&b===path.join(root,'dkb.json'))await hold();
      const result=await rename(a,b);
      if(phase==='after-backup'&&a===path.join(root,'dkb.json'))await hold();
      if(phase==='after-promotion'&&b===path.join(root,'dkb.json'))await hold();
      if(phase==='rollback-after-restore'&&String(a).endsWith('.backup')&&b===path.join(root,'dkb.json'))await hold();
      return result;
    };
    fs.rm=async(a,options)=>{
      if(phase==='after-commit'&&String(a).endsWith('.backup'))await hold();
      const result=await rm(a,options);
      if(phase==='during-cleanup'&&String(a).endsWith('.backup'))await hold();
      return result;
    };
    await withLibraryMutation(root,async()=>{
      if(phase==='missing-manifest') {await removeLibraryPath(root,path.join(root,'dkb.json'));await hold();}
      await writeLibraryMutationFile(root,path.join(root,'dkb.json'),${JSON.stringify(after)});
      const prior=await maybeReadLibraryLock(root);
      await applyLibraryLock(root,{...prior,library:{name:'Next fixture'},generation:prior.generation+1});
      if(phase==='pending-ledger')await hold();
      if(phase.startsWith('rollback-'))throw new Error('start rollback');
    });
  `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let stderr = ''; child.stderr.on('data', (chunk) => stderr += chunk);
  const ready = await Promise.race([
    once(child, 'message').then(([message]) => message),
    once(child, 'exit').then(([code]) => { throw new Error(`Fixture exited ${code}: ${stderr}`); }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Fixture readiness timeout')), 15_000).unref()),
  ]);
  assert.equal(ready, 'ready');
  const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
}

for (const phase of ['partial-stage', 'before-backup', 'after-backup', 'after-promotion', 'pending-ledger', 'missing-manifest', 'after-commit', 'during-cleanup', 'rollback-before-restore', 'rollback-after-restore']) {
  test(`real process death at ${phase} recovers one complete state`, async (t) => {
    const root = await fixture(t);
    const fence = await captureLibraryReadFence(root);
    await interrupted(root, phase);
    await assert.rejects(captureLibraryReadFence(root), (error) => error.code === 'library_recovery_required');
    await assert.rejects(readLibraryState(root), (error) => error.code === 'library_recovery_required');
    const recovery = await freshRecovery(root);
    const committed = ['after-commit', 'during-cleanup'].includes(phase);
    assert.equal(recovery.status, committed ? 'committed' : 'rolled_back');
    assert.equal(await fs.readFile(path.join(root, 'dkb.json'), 'utf8'), committed ? after : before);
    const lock = await maybeReadLibraryLock(root);
    assert.equal(lock.library.name, committed ? 'Next fixture' : 'Crash fixture');
    assert.equal((await readLibraryState(root)).generation, committed ? 2 : 1);
    assert.equal((await freshRecovery(root)).status, 'unchanged');
    await assert.rejects(assertLibraryReadFence(root, fence), (error) => error.code === 'library_busy' && /Retry/u.test(error.message) && !/Run dkb library recover/u.test(error.message));
    assert.deepEqual(await fs.readdir(path.join(root, '.dkb', 'transactions')), []);
  });
}

test('nested mutation joins one generation and rejects public reads while pending', async (t) => {
  const root = await fixture(t);
  await withLibraryMutation(root, async () => {
    for (const name of ['intermediate', 'final']) {
      await withLibraryMutation(root, async () => {
        const previous = await maybeReadLibraryLock(root);
        await applyLibraryLock(root, { ...previous, library: { name }, generation: previous.generation + 1 });
      });
    }
    assert.equal((await readLibraryState(root)).generation, 2);
    await assert.rejects(captureLibraryReadFence(root), (error) => error.code === 'library_recovery_required');
  });
  assert.equal((await readLibraryState(root)).generation, 2);
  assert.equal((await maybeReadLibraryLock(root)).library.name, 'final');
});

test('ordinary error rolls back exact bytes, and stale async context loses authority', async (t) => {
  const root = await fixture(t);
  let late;
  await assert.rejects(withLibraryMutation(root, async () => {
    late = new Promise((resolve) => setTimeout(() => {
      assert.throws(() => assertLibraryMutation(root), /requires an active/u); resolve();
    }, 100));
    await writeLibraryMutationFile(root, path.join(root, 'dkb.json'), after);
    throw new Error('operation failed');
  }), /operation failed/u);
  await late;
  assert.equal(await fs.readFile(path.join(root, 'dkb.json'), 'utf8'), before);
});

test('external edits and missing backups fail closed without overwriting operator bytes', async (t) => {
  for (const conflict of ['target', 'backup']) {
    const root = await fixture(t);
    await interrupted(root, 'after-promotion');
    if (conflict === 'target') await fs.writeFile(path.join(root, 'dkb.json'), 'operator edited');
    else {
      const [id] = await fs.readdir(path.join(root, '.dkb', 'transactions'));
      await fs.unlink(path.join(root, '.dkb', 'transactions', id, '0.backup'));
    }
    await assert.rejects(recoverLibraryMutation(root), /restore|backup|changed/u);
    if (conflict === 'target') assert.equal(await fs.readFile(path.join(root, 'dkb.json'), 'utf8'), 'operator edited');
    await assert.rejects(readLibraryState(root), (error) => error.code === 'library_recovery_required');
  }
});

test('rename promotion rolls back directories without copying unrelated sources', async (t) => {
  const root = await fixture(t);
  const target = path.join(root, 'vendor', '@test', 'package');
  const staged = path.join(root, '.dkb', 'tmp', 'replacement');
  await fs.mkdir(target, { recursive: true }); await fs.writeFile(path.join(target, 'source'), 'original');
  await fs.mkdir(staged, { recursive: true }); await fs.writeFile(path.join(staged, 'source'), 'next');
  await assert.rejects(withLibraryMutation(root, async () => {
    await promoteLibraryPath(root, staged, target);
    throw new Error('rollback');
  }), /rollback/u);
  assert.equal(await fs.readFile(path.join(target, 'source'), 'utf8'), 'original');
  await assert.rejects(fs.access(staged), { code: 'ENOENT' });
});

test('authored Collection creation commits with its Library root in one generation', async (t) => {
  const root = await fixture(t);
  const result = await createLocalCollection({ libraryRoot: root, identity: '@test/bundle' });
  assert.equal(result.lock.generation, 2);
  assert.equal((await readLibraryState(root)).entries['@test/bundle'].kind, 'collection');
});

test('absent state inspection creates no control files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-library-mutation-empty-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(await captureLibraryReadFence(root), '0');
  assert.deepEqual(await readLibraryState(root), { generation: 0, entries: {} });
  assert.deepEqual(await fs.readdir(root), []);
});

test('all rollback paths are preflighted before any unaffected target is restored', async (t) => {
  const root = await fixture(t);
  const one = path.join(root, 'one.txt'), two = path.join(root, 'two.txt');
  await fs.writeFile(one, 'one before'); await fs.writeFile(two, 'two before');
  await assert.rejects(withLibraryMutation(root, async () => {
    await writeLibraryMutationFile(root, one, 'one next');
    await writeLibraryMutationFile(root, two, 'two next');
    await fs.writeFile(one, 'operator edit');
    throw new Error('fail operation');
  }), /recovery/u);
  assert.equal(await fs.readFile(one, 'utf8'), 'operator edit');
  assert.equal(await fs.readFile(two, 'utf8'), 'two next');
});

test('commit cannot bless an external edit, and parent-child mutations are rejected', async (t) => {
  const root = await fixture(t);
  await assert.rejects(withLibraryMutation(root, async () => {
    await writeLibraryMutationFile(root, path.join(root, 'dkb.json'), after);
    await fs.writeFile(path.join(root, 'dkb.json'), 'operator edit');
  }), /recovery/u);
  assert.equal(await fs.readFile(path.join(root, 'dkb.json'), 'utf8'), 'operator edit');
  const other = await fixture(t);
  const staged = path.join(other, '.dkb', 'tmp', 'staged');
  await fs.mkdir(staged, { recursive: true }); await fs.writeFile(path.join(staged, 'source'), 'next');
  await assert.rejects(withLibraryMutation(other, async () => {
    await promoteLibraryPath(other, staged, path.join(other, 'package'));
    await writeLibraryMutationFile(other, path.join(other, 'package', 'source'), 'child edit');
  }), /Overlapping/u);
  await assert.rejects(fs.access(path.join(other, 'package')), { code: 'ENOENT' });
});

test('control paths and unowned staging cannot be moved by the mutation API', async (t) => {
  const root = await fixture(t);
  await assert.rejects(withLibraryMutation(root, async () => {
    await removeLibraryPath(root, path.join(root, '.dkb'));
  }), /control state/u);
  for (const alias of ['.DKB', '.Dkb']) {
    await assert.rejects(withLibraryMutation(root, async () => {
      await removeLibraryPath(root, path.join(root, alias));
    }), /control state/u);
  }
  await assert.rejects(withLibraryMutation(root, async () => {
    await promoteLibraryPath(root, path.join(root, 'dkb.json'), path.join(root, 'moved'));
  }), /staged under/u);
  for (const alias of ['.dkb.', '.dkb ', 'file:stream', 'NUL']) {
    await assert.rejects(withLibraryMutation(root, async () => {
      await removeLibraryPath(root, path.join(root, alias));
    }), /unambiguous/u);
  }
  assert.equal(await fs.readFile(path.join(root, 'dkb.json'), 'utf8'), before);
});

test('unfinished metadata staging rejects unexpected non-prefix edits', async (t) => {
  const root = await fixture(t);
  await interrupted(root, 'partial-stage');
  const [id] = await fs.readdir(path.join(root, '.dkb', 'transactions'));
  const staged = path.join(root, '.dkb', 'transactions', id, '0.stage');
  await fs.writeFile(staged, 'unexpected operator content');
  await assert.rejects(recoverLibraryMutation(root), /changed|staging/u);
  assert.equal(await fs.readFile(staged, 'utf8'), 'unexpected operator content');
  assert.equal(await fs.readFile(path.join(root, 'dkb.json'), 'utf8'), before);
});

test('journal budget rejection restores only previously persisted intents', async (t) => {
  const root = await fixture(t);
  await assert.rejects(withLibraryMutation(root, async () => {
    await writeLibraryMutationFile(root, path.join(root, 'first.data'), Buffer.alloc(13 * 1024 * 1024, 65));
    await writeLibraryMutationFile(root, path.join(root, 'second.data'), Buffer.alloc(13 * 1024 * 1024, 66));
  }), /journal budget/u);
  await assert.rejects(fs.access(path.join(root, 'first.data')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, 'second.data')), { code: 'ENOENT' });
  assert.equal((await readLibraryState(root)).generation, 1);
  assert.deepEqual(await fs.readdir(path.join(root, '.dkb', 'transactions')), []);
});

test('missing lock during an overlapping mutation is not returned as false absence', async (t) => {
  const root = await fixture(t);
  const read = fs.readFile.bind(fs);
  let intercepted = false, mutation, release;
  const held = new Promise((resolve) => { release = resolve; });
  t.mock.method(fs, 'readFile', async (target, ...args) => {
    if (target === path.join(root, 'dkb-lock.json') && !intercepted) {
      intercepted = true;
      let ready;
      const started = new Promise((resolve) => { ready = resolve; });
      mutation = withLibraryMutation(root, async () => {
        await removeLibraryPath(root, target);
        ready(); await held;
      });
      await started;
      throw Object.assign(new Error('temporarily displaced'), { code: 'ENOENT' });
    }
    return read(target, ...args);
  });
  try {
    await assert.rejects(maybeReadLibraryLock(root), (error) => error.code === 'library_recovery_required');
  } finally { release(); await mutation; }
});

test('installed-package reads and storage reject mutation-rollback ABA before returning content', async (t) => {
  for (const operation of ['details', 'contents', 'preview', 'verify', 'storage']) {
    const root = await fixture(t), packageRoot = path.join(root, 'package');
    await fs.mkdir(packageRoot);
    await fs.writeFile(path.join(packageRoot, 'dkb.json'), JSON.stringify({ type: 'dkb', name: '@test/package', version: '1.0.0' }));
    await fs.writeFile(path.join(packageRoot, 'README.txt'), 'synthetic retained text');
    const previous = await maybeReadLibraryLock(root);
    await applyLibraryLock(root, { ...previous, generation: 2, entries: {
      '@test/package': { identity: '@test/package', kind: 'dkb', source: 'local', version: '1.0.0', path: 'package',
        requiredBy: ['root:@test/package'], installedAt: new Date().toISOString() },
    } });
    const method = operation === 'preview' ? 'stat' : operation === 'contents' || operation === 'storage' ? 'readdir' : 'readFile';
    const target = method === 'readdir' ? packageRoot : path.join(packageRoot, method === 'stat' ? 'README.txt' : 'dkb.json');
    const original = fs[method].bind(fs);
    let raced = false;
    const mock = t.mock.method(fs, method, async (candidate, ...args) => {
      if (candidate === target && !raced) {
        raced = true;
        await assert.rejects(withLibraryMutation(root, async () => {
          await writeLibraryMutationFile(root, path.join(root, 'dkb.json'), after);
          throw new Error('restore original');
        }), /restore original/u);
      }
      return original(candidate, ...args);
    });
    try {
      const request = { libraryRoot: root, identity: '@test/package', file: 'README.txt' };
      const read = operation === 'details' ? inspectInstalledPackage(root, request.identity)
        : operation === 'contents' ? listInstalledPackageContents(request)
        : operation === 'preview' ? previewInstalledPackageFile(request)
        : operation === 'verify' ? verifyInstalledPackage(request) : inspectLibraryStorage(root);
      await assert.rejects(read, (error) => error.code === 'library_busy');
      assert.equal(raced, true);
    } finally { mock.mock.restore(); }
  }
});

test('recovery of absent state does not create files in arbitrary directories', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-library-no-state-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal((await recoverLibraryMutation(root)).status, 'unchanged');
  assert.deepEqual(await fs.readdir(root), []);
  const absent = path.join(root, 'missing');
  assert.equal((await recoverLibraryMutation(absent)).status, 'unchanged');
  await assert.rejects(fs.access(absent), { code: 'ENOENT' });
});

test('partial recursive deletion remains fail-closed after a real process death', async (t) => {
  for (const phase of ['committed-backup', 'rollback-target']) {
    const root = await fixture(t);
    const target = path.join(root, 'package'), staged = path.join(root, '.dkb', 'tmp', 'next');
    await fs.mkdir(target); await fs.mkdir(staged, { recursive: true });
    for (const name of ['one.txt', 'two.txt']) {
      await fs.writeFile(path.join(target, name), 'prior ' + name);
      await fs.writeFile(path.join(staged, name), 'next ' + name);
    }
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs/promises'; import path from 'node:path';
      import {withLibraryMutation,promoteLibraryPath} from ${JSON.stringify(mutationUrl)};
      import {applyLibraryLock,maybeReadLibraryLock} from ${JSON.stringify(stateUrl)};
      const root=${JSON.stringify(root)}, target=${JSON.stringify(target)}, staged=${JSON.stringify(staged)}, phase=${JSON.stringify(phase)};
      const remove=fs.rm.bind(fs);
      fs.rm=async(candidate,options)=>{
        if((phase==='committed-backup'&&String(candidate).endsWith('.backup')||(phase==='rollback-target'&&candidate===target))
          && (await fs.lstat(candidate)).isDirectory()) {
          // Deterministic partial filesystem progress inside recursive removal, not a product fault hook.
          await fs.unlink(path.join(candidate,'one.txt'));
          process.send('partial-delete');
          await new Promise(()=>{});
        }
        return remove(candidate,options);
      };
      await withLibraryMutation(root,async()=>{
        await promoteLibraryPath(root,staged,target);
        const lock=await maybeReadLibraryLock(root);
        await applyLibraryLock(root,{...lock,generation:lock.generation+1});
        if(phase==='rollback-target')throw new Error('start rollback');
      });
    `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    let diagnostics = ''; child.stderr.on('data', (chunk) => diagnostics += chunk);
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    const event = await Promise.race([
      once(child, 'message').then(([message]) => message),
      once(child, 'exit').then(([code]) => { throw new Error('Partial delete child exited ' + code + ': ' + diagnostics); }),
    ]);
    clearTimeout(timer); assert.equal(event, 'partial-delete');
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const report = await childResult(`import {recoverLibraryMutation} from ${JSON.stringify(mutationUrl)};
      try { await recoverLibraryMutation(${JSON.stringify(root)}); console.log(JSON.stringify({unexpected:true})); }
      catch(error) { console.log(JSON.stringify({code:error.code,message:error.message})); }`);
    assert.equal(report.code, 'library_recovery_required');
    assert.match(report.message, /changed|restore/u);
    await assert.rejects(readLibraryState(root), (error) => error.code === 'library_recovery_required');
    const [id] = await fs.readdir(path.join(root, '.dkb', 'transactions'));
    const backup = path.join(root, '.dkb', 'transactions', id, '0.backup');
    assert.equal(await fs.readFile(path.join(target, 'two.txt'), 'utf8'), 'next two.txt');
    assert.equal(await fs.readFile(path.join(backup, 'two.txt'), 'utf8'), 'prior two.txt');
    if (phase === 'committed-backup') {
      assert.equal(await fs.readFile(path.join(target, 'one.txt'), 'utf8'), 'next one.txt');
      await assert.rejects(fs.access(path.join(backup, 'one.txt')), { code: 'ENOENT' });
    } else {
      assert.equal(await fs.readFile(path.join(backup, 'one.txt'), 'utf8'), 'prior one.txt');
      await assert.rejects(fs.access(path.join(target, 'one.txt')), { code: 'ENOENT' });
    }
  }
});
