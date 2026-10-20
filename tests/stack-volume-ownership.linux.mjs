import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { stageStackVolumeRestore } from '../apps/cli/dist/stack/volumeRestore.js';
import { fixture, limits, restoreStage, snapshot } from './stack-volume-snapshot-fixture.mjs';

// Mandatory CI proof in an isolated Linux container; deliberately outside *.test.mjs.
// Missing ownership privileges fail this proof instead of skipping its assertions.
test('restore preserves service-owned file and link metadata on Linux', async t => {
  assert.equal(process.platform, 'linux', 'Run the required Linux ownership proof container.');
  const status = await fs.readFile('/proc/self/status', 'utf8');
  const capEff = /^CapEff:\s+([a-f\d]+)$/imu.exec(status)?.[1];
  t.diagnostic(JSON.stringify({ euid: process.geteuid(), egid: process.getegid(), capEff }));
  assert.equal(process.geteuid(), 0, 'The isolated ownership proof requires container UID 0.');
  assert(capEff, 'Linux must report effective capabilities for the ownership proof.');
  const capabilities = BigInt(`0x${capEff}`);
  for (const [name, bit] of [['CAP_CHOWN', 1n], ['CAP_DAC_OVERRIDE', 2n], ['CAP_FOWNER', 8n]]) {
    assert.equal(capabilities & bit, bit, `The isolated ownership proof requires ${name}.`);
  }

  const f = await fixture(t), cache = path.join(f.source, 'volumes/cache');
  const file = path.join(cache, 'owned'), link = path.join(cache, 'linked');
  await fs.writeFile(file, 'service data', { mode: 0o640 }); await fs.chown(file, 33, 33);
  // Docker Desktop projects Windows-hosted configuration as 0777. node-tar's
  // regular-file create is umask-filtered; exact restoration must repair it.
  const projected = path.join(f.source, 'host/stack.env');
  await fs.chmod(projected, 0o777);
  await fs.symlink('owned', link); await fs.lchown(link, 33, 33);
  await fs.utimes(file, 1_600_000_000, 1_600_000_000); await fs.lutimes(link, 1_600_000_000, 1_600_000_000);
  const manifest = await snapshot(f), { destination, digest } = await restoreStage(f);
  assert.deepEqual(await stageStackVolumeRestore(f.archive, destination, digest, limits), manifest);
  assert.equal((await fs.stat(path.join(destination, 'host/stack.env'))).mode & 0o777, 0o777);
  for (const name of ['owned', 'linked']) {
    const stat = await fs.lstat(path.join(destination, 'volumes/cache', name));
    assert.equal(stat.uid, 33); assert.equal(stat.gid, 33); assert.equal(stat.mtimeMs / 1000, 1_600_000_000);
  }
});
