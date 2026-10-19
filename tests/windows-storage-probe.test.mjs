import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import vm from 'node:vm';
import test from 'node:test';

const source = await fs.readFile(new URL('../packages/library/platform/windows-volume-probe.js', import.meta.url), 'utf8');
function probe(volume, drive = 'C:\\', options = {}) {
  const output = []; let reads = 0, exit;
  const halted = new Error('WScript.Quit');
  try {
    vm.runInNewContext(source, {
      WScript: {
        Arguments: { length: options.count ?? 1, Item: () => drive },
        StdOut: { WriteLine: value => output.push(value) },
        Quit(code) { exit = code; throw halted; },
      },
      ActiveXObject: function(name) {
        assert.equal(name, 'Scripting.FileSystemObject');
        if (options.unavailable) throw new Error('disabled');
        return { GetDrive(value) { reads++; assert.equal(value, drive); return volume; } };
      },
    });
  } catch (error) { assert.equal(error, halted); }
  return { output, reads, exit };
}

test('Windows metadata probe only admits ready fixed NTFS with strict OS value types', () => {
  const ready = { DriveType: 2, IsReady: true, FileSystem: 'NTFS' };
  assert.deepEqual(probe(ready).output, ['dkb.windows-storage.v1:supported']);
  for (const volume of [
    ...[0, 1, 3, 4, 5, '2'].map(DriveType => ({ ...ready, DriveType })),
    ...[false, 'true', 1].map(IsReady => ({ ...ready, IsReady })),
    ...['FAT', 'exFAT', 'ReFS', 'ntfs', undefined].map(FileSystem => ({ ...ready, FileSystem })),
  ]) assert.deepEqual(probe(volume).output, ['dkb.windows-storage.v1:unsupported']);
});

test('Windows metadata probe emits no success for invalid arguments or unavailable OS scripting', () => {
  for (const drive of ['\\\\server\\share', 'relative', 'C:\\folder', 'C:\\;write something', '', 'C:']) {
    assert.deepEqual(probe({}, drive), { output: [], reads: 0, exit: 1 });
  }
  assert.deepEqual(probe({}, 'C:\\', { count: 0 }), { output: [], reads: 0, exit: 1 });
  assert.deepEqual(probe({}, 'C:\\', { unavailable: true }), { output: [], reads: 0, exit: 1 });
});

test('Windows probe failure requires positive .NET verification; a negative OS answer cannot fall through',
  { skip: process.platform !== 'win32' }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-windows-probe-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    for (const mode of ['unavailable', 'malformed', 'negative', 'both-unavailable']) {
      const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict'; import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; import {promisify} from 'node:util';
        const original=cp.execFile, mode=process.argv[2], calls=[];
        cp.execFile=(file,args,options,callback)=>{
          const script=file.endsWith('cscript.exe'); calls.push(script?'script':'dotnet');
          if(script && mode==='negative') return callback(null,'dkb.windows-storage.v1:unsupported','');
          if(script && mode==='malformed') return callback(null,'not a volume result','');
          if(script || mode==='both-unavailable') return callback(new Error('unavailable'));
          const started=Date.now();
          const diagnosticArgs=[...args], commandIndex=diagnosticArgs.indexOf('-Command')+1;
          assert.ok(commandIndex>0);
          diagnosticArgs[commandIndex]='[Console]::Error.WriteLine("dkb.storage.probe.entered"); '
            +diagnosticArgs[commandIndex]+'; [Console]::Error.WriteLine("dkb.storage.probe.completed");';
          return original(file,diagnosticArgs,options,(error,stdout,stderr)=>{
            if(error) console.error(JSON.stringify({
              event:'windows_storage_powershell_failed', mode, elapsedMs:Date.now()-started,
              code:error.code??null, signal:error.signal??null, killed:error.killed??null,
              stdout:Buffer.from(stdout??'').subarray(-4096).toString('utf8'),
              stderr:Buffer.from(stderr??'').subarray(-4096).toString('utf8'),
            }));
            callback(error,stdout,stderr);
          });
        };
        cp.execFile[promisify.custom]=(file,args,options)=>new Promise((resolve,reject)=>cp.execFile(file,args,options,
          (error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr})));
        syncBuiltinESMExports();
        const {assertLocalLibraryStorage}=await import('@sjshovan/dkb-library/storageAccess.js');
        if(['negative','both-unavailable'].includes(mode)) await assert.rejects(assertLocalLibraryStorage(process.argv[1]),{code:'library_storage_unsupported'});
        else await assertLocalLibraryStorage(process.argv[1]);
        assert.deepEqual(calls,mode==='negative'?['script']:['script','dotnet']);
        console.log('verified');
      `, root, mode], { windowsHide: true, timeout: 15_000 });
      assert.equal(stdout.trim(), 'verified');
    }
    assert.deepEqual(await fs.readdir(root), []);
  });
