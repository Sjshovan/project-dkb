import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  captureLibraryReadFence, withLibraryMutation, withLibraryReadSnapshot, writeLibraryMutationFile,
} from '@sjshovan/dkb-library/mutation.js';
import { applyLibraryLock, libraryStateIdentity, maybeReadLibraryLock, readLibraryState } from '@sjshovan/dkb-library/state.js';
import { syncLibrary } from '@sjshovan/dkb-library/resolver.js';
import { withDkbFileLock } from '@sjshovan/dkb-library/locks.js';

const mutationUrl = pathToFileURL(path.resolve('packages/library/dist/mutation.js')).href;
const recoveryRequired = (error) => error.code === 'library_recovery_required';
const retryRequired = (error) => error.code === 'library_busy' && /Retry/u.test(error.message) && !/Run dkb library recover/u.test(error.message);
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t, installed = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-library-read-snapshot-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'dkb.json'), JSON.stringify({ type: 'library', name: 'Read snapshot fixture', roots: {} }));
  await syncLibrary(root);
  if (installed) {
    await fs.mkdir(path.join(root, 'package'));
    await fs.writeFile(path.join(root, 'package', 'dkb.json'), JSON.stringify({ type: 'dkb', name: '@test/item', version: '1.0.0' }));
    const lock = await maybeReadLibraryLock(root);
    await applyLibraryLock(root, { ...lock, generation: 2, entries: {
      '@test/item': { identity: '@test/item', kind: 'dkb', source: 'local', version: '1.0.0', path: 'package',
        requiredBy: ['root:@test/item'], installedAt: new Date().toISOString() },
    } });
  }
  return root;
}
function countReads(t, root) {
  const originalExec = DatabaseSync.prototype.exec, originalPrepare = DatabaseSync.prototype.prepare;
  const counts = { guards: 0, rows: 0 };
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql, ...args) {
    if (sql === 'BEGIN') counts.guards++;
    return originalExec.call(this, sql, ...args);
  });
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql, ...args) {
    if (/^SELECT \* FROM entries ORDER BY identity$/u.test(sql)) counts.rows++;
    return originalPrepare.call(this, sql, ...args);
  });
  return counts;
}
async function changeFence(root) {
  await assert.rejects(withLibraryMutation(root, async () => { throw new Error('bounded rollback'); }), /bounded rollback/u);
}
async function heldMutation(root, rollback = false) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {withLibraryMutation} from ${JSON.stringify(mutationUrl)};
    try {
      await withLibraryMutation(${JSON.stringify(root)}, async()=>{
        process.send('ready');
        await new Promise(resolve=>process.once('message',resolve));
        if (${rollback}) throw new Error('fixture rollback');
      });
    } catch(error) { if (!${rollback} || error.message !== 'fixture rollback') throw error; }
  `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (value) => stderr += value);
  const exited = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try {
    const message = await Promise.race([
      once(child, 'message').then(([value]) => value),
      exited.then(([code]) => { throw new Error(`Held mutation exited ${code}: ${stderr}`); }),
    ]);
    assert.equal(message, 'ready');
  } catch (error) { child.kill('SIGKILL'); await exited; clearTimeout(timer); throw error; }
  return async () => {
    if (child.connected) child.send('release');
    const [code] = await exited; clearTimeout(timer);
    assert.equal(code, 0, stderr);
  };
}

test('read phase singleflights concurrent state/fence readers and always takes an uncached final barrier', async (t) => {
  const root = await fixture(t, true), counts = countReads(t, root);
  const value = await withLibraryReadSnapshot(async () => {
    const values = await Promise.all([
      ...Array.from({ length: 12 }, () => captureLibraryReadFence(root)),
      ...Array.from({ length: 4 }, () => readLibraryState(root)),
      libraryStateIdentity(root), libraryStateIdentity(root),
    ]);
    assert.deepEqual(counts, { guards: 1, rows: 1 });
    return values.at(-1);
  });
  assert.equal(value.generation, 2);
  assert.deepEqual(counts, { guards: 2, rows: 1 });
  await captureLibraryReadFence(root); await captureLibraryReadFence(root);
  assert.deepEqual(counts, { guards: 4, rows: 1 }, 'standalone fences read fresh metadata without loading entries');
});

test('short native read transactions reject an exclusive ledger writer without waiting or serving stale state', async (t) => {
  const root = await fixture(t);
  const external = new DatabaseSync(path.toNamespacedPath(path.join(root, '.dkb', 'state.sqlite')));
  try {
    external.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    await assert.rejects(captureLibraryReadFence(root), { code: 'library_busy' });
    await assert.rejects(readLibraryState(root), { code: 'library_busy' });
    external.exec('ROLLBACK');
  } finally { external.close(); }
  assert.equal((await readLibraryState(root)).generation, 1);
});

test('state results cannot mutate the phase SQL snapshot', async (t) => {
  const root = await fixture(t, true), counts = countReads(t, root);
  await withLibraryReadSnapshot(async () => {
    const first = await readLibraryState(root);
    first.entries['@test/item'].path = 'operator result edit';
    first.entries['@test/item'].requiredBy.push('edited');
    first.entries['@test/item'].status = 'broken';
    const next = await readLibraryState(root);
    assert.equal(next.entries['@test/item'].path, 'package');
    assert.deepEqual(next.entries['@test/item'].requiredBy, ['root:@test/item']);
    assert.equal(next.entries['@test/item'].status, 'installed');
  });
  assert.deepEqual(counts, { guards: 2, rows: 1 });
});

test('rejecting pending recovery never materializes a large journal in the read result', async (t) => {
  const root = await fixture(t);
  const db = new DatabaseSync(path.toNamespacedPath(path.join(root, '.dkb', 'state.sqlite')));
  try { db.exec("INSERT INTO metadata(key,value) VALUES ('libraryMutation',zeroblob(4194304))"); }
  finally { db.close(); }
  const prepare = DatabaseSync.prototype.prepare;
  let checks = 0;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql, ...args) {
    const statement = prepare.call(this, sql, ...args);
    if (!/FROM metadata/iu.test(sql)) return statement;
    return new Proxy(statement, { get(target, name) {
      const value = Reflect.get(target, name, target);
      if (!['get', 'all'].includes(name)) return typeof value === 'function' ? value.bind(target) : value;
      return (...params) => {
        const result = value.apply(target, params);
        for (const row of Array.isArray(result) ? result : [result]) {
          for (const field of Object.values(row ?? {})) assert.ok(!ArrayBuffer.isView(field), 'Read admission must not load the journal blob');
        }
        checks++;
        return result;
      };
    } });
  });
  await assert.rejects(captureLibraryReadFence(root), recoveryRequired);
  await assert.rejects(readLibraryState(root), recoveryRequired);
  assert.equal(checks, 2);
});

test('each explicit nested phase finishes its own fresh barrier and separate requests never share a view', async (t) => {
  const root = await fixture(t), counts = countReads(t, root);
  await withLibraryReadSnapshot(async () => {
    const fence = await captureLibraryReadFence(root);
    await withLibraryReadSnapshot(async () => assert.equal(await captureLibraryReadFence(root), fence));
    assert.deepEqual(counts, { guards: 3, rows: 2 }, 'inner phase already passed its own final barrier');
    assert.equal(await captureLibraryReadFence(root), fence);
  });
  assert.deepEqual(counts, { guards: 4, rows: 2 });
  await Promise.all(Array.from({ length: 2 }, () => withLibraryReadSnapshot(() => captureLibraryReadFence(root))));
  assert.deepEqual(counts, { guards: 8, rows: 4 });
});

test('expired nested and outer async contexts cannot reuse an earlier view', async (t) => {
  const root = await fixture(t), release = deferred();
  let late, original;
  await withLibraryReadSnapshot(async () => {
    original = await captureLibraryReadFence(root);
    await withLibraryReadSnapshot(async () => {
      await captureLibraryReadFence(root);
      late = release.promise.then(() => captureLibraryReadFence(root));
    });
  });
  await changeFence(root);
  release.resolve();
  assert.notEqual(await late, original);
  assert.equal(await late, await captureLibraryReadFence(root));
});

test('phase closes admission and drains a started SQL read before its final barrier', async (t) => {
  const root = await fixture(t), entered = deferred(), release = deferred();
  const originalStat = fs.lstat.bind(fs);
  let intercepted = false, read, returned = false;
  t.mock.method(fs, 'lstat', async (target, ...options) => {
    if (target === path.join(root, '.dkb', 'state.sqlite') && !intercepted) {
      intercepted = true; entered.resolve(); await release.promise;
    }
    return originalStat(target, ...options);
  });
  const phase = withLibraryReadSnapshot(async () => { read = captureLibraryReadFence(root); }).then(() => { returned = true; });
  await entered.promise;
  assert.equal(returned, false);
  release.resolve(); await phase; await read;
  assert.equal(returned, true);
});

for (const fails of [false, true]) {
  test(`fresh phase-end barrier rejects a real pending writer after ${fails ? 'callback failure' : 'cached reads'}`, async (t) => {
    const root = await fixture(t);
    let release;
    try {
      await assert.rejects(withLibraryReadSnapshot(async () => {
        const initial = await captureLibraryReadFence(root);
        release = await heldMutation(root);
        assert.equal(await captureLibraryReadFence(root), initial, 'within-phase values are provisional until the barrier');
        if (fails) throw new Error('callback failed');
        return 'must not escape';
      }), recoveryRequired);
    } finally { await release?.(); }
  });
}

test('same-context mutation poisons every active ancestor phase even after exact rollback', async (t) => {
  const root = await fixture(t), before = await fs.readFile(path.join(root, 'dkb.json'), 'utf8');
  await assert.rejects(withLibraryReadSnapshot(async () => {
    await captureLibraryReadFence(root);
    await assert.rejects(withLibraryReadSnapshot(async () => {
      await captureLibraryReadFence(root);
      await assert.rejects(withLibraryMutation(root, async () => {
        await writeLibraryMutationFile(root, path.join(root, 'dkb.json'), 'temporary replacement');
        await assert.rejects(captureLibraryReadFence(root), recoveryRequired);
        assert.equal((await readLibraryState(root)).generation, 1, 'internal owning mutation reads still join pending state');
        throw new Error('restore');
      }), /restore/u);
      await assert.rejects(captureLibraryReadFence(root), retryRequired);
    }), retryRequired);
    await assert.rejects(captureLibraryReadFence(root), retryRequired);
  }), retryRequired);
  assert.equal(await fs.readFile(path.join(root, 'dkb.json'), 'utf8'), before);
});

test('a new read phase inside a pending mutation cannot return a public clean fence', async (t) => {
  const root = await fixture(t);
  await withLibraryMutation(root, async () => {
    await assert.rejects(withLibraryReadSnapshot(() => captureLibraryReadFence(root)), recoveryRequired);
  });
});

test('final barrier detects mutation and rollback from a separate process', async (t) => {
  const root = await fixture(t), before = await libraryStateIdentity(root);
  await assert.rejects(withLibraryReadSnapshot(async () => {
    await captureLibraryReadFence(root);
    const release = await heldMutation(root, true);
    await release();
    assert.deepEqual(await libraryStateIdentity(root), before);
  }), retryRequired);
  assert.deepEqual(await libraryStateIdentity(root), before);
});

for (const unresolved of [false, true]) {
  test(`a poisoned-only root requires ${unresolved ? 'recovery for its retained journal' : 'retry after clean rollback'}`, async (t) => {
    const root = await fixture(t), manifestPath = path.join(root, 'dkb.json');
    const original = await fs.readFile(manifestPath, 'utf8');
    await assert.rejects(withLibraryReadSnapshot(async () => {
      await assert.rejects(withLibraryMutation(root, async () => {
        await writeLibraryMutationFile(root, manifestPath, 'temporary replacement');
        if (unresolved) await fs.writeFile(manifestPath, 'operator edit must remain');
        throw new Error('rollback without an initial read');
      }), unresolved ? recoveryRequired : /rollback without an initial read/u);
    }), unresolved ? recoveryRequired : retryRequired);
    assert.equal(await fs.readFile(manifestPath, 'utf8'), unresolved ? 'operator edit must remain' : original);
  });
}

test('poisoned uncached checks are drained before the final classification barrier', async (t) => {
  const root = await fixture(t), entered = deferred(), release = deferred();
  const originalStat = fs.lstat.bind(fs);
  let intercept = false, intercepted = false, checked = false, outcome;
  t.mock.method(fs, 'lstat', async (target, ...options) => {
    if (intercept && !intercepted && target === path.join(root, '.dkb', 'state.sqlite')) {
      intercepted = true; entered.resolve(); await release.promise;
    }
    return originalStat(target, ...options);
  });
  const phase = withLibraryReadSnapshot(async () => {
    await changeFence(root);
    intercept = true;
    outcome = assert.rejects(captureLibraryReadFence(root), retryRequired).then(() => { checked = true; });
  });
  const rejected = assert.rejects(phase, retryRequired);
  await entered.promise;
  assert.equal(checked, false);
  release.resolve();
  await rejected; await outcome;
  assert.equal(checked, true);
});

test('corrupt fence and ledger fields are never accepted or cached across requests', async (t) => {
  const root = await fixture(t, true);
  const corrupt = (sql) => withDkbFileLock(root, 'library-state', async () => {
    const db = new DatabaseSync(path.toNamespacedPath(path.join(root, '.dkb', 'state.sqlite')));
    try { db.exec(sql); } finally { db.close(); }
  });
  await assert.rejects(withLibraryReadSnapshot(async () => {
    await captureLibraryReadFence(root);
    await corrupt("UPDATE metadata SET value='invalid' WHERE key='libraryMutationFence'");
  }), recoveryRequired);
  await assert.rejects(withLibraryReadSnapshot(() => captureLibraryReadFence(root)), recoveryRequired);
  await corrupt("UPDATE metadata SET value='4' WHERE key='libraryMutationFence'; UPDATE entries SET required_by='not-json'");
  await assert.rejects(withLibraryReadSnapshot(() => readLibraryState(root)), /Invalid requiredBy/u);
});

test('read phases remain lazy, isolate Library roots, and create no absent-state control files', async (t) => {
  const root = await fixture(t), other = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-library-read-absent-'));
  t.after(() => fs.rm(other, { recursive: true, force: true }));
  const counts = countReads(t, root);
  assert.equal(await withLibraryReadSnapshot(async () => 7), 7);
  assert.deepEqual(counts, { guards: 0, rows: 0 });
  await withLibraryReadSnapshot(async () => {
    assert.notEqual(await captureLibraryReadFence(root), '0');
    assert.equal(await captureLibraryReadFence(other), '0');
    assert.deepEqual(await readLibraryState(other), { generation: 0, entries: {} });
  });
  assert.deepEqual(await fs.readdir(other), []);
  assert.deepEqual(counts, { guards: 2, rows: 1 });
});
