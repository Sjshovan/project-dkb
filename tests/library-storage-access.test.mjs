import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertLinuxLibraryMounts, assertLocalLibraryStorage } from '@sjshovan/dkb-library/storageAccess.js';

const mount = (id, location, type, device = '8:1') => `${id} 1 ${device} / ${location} rw,relatime - ${type} /dev/test rw`;
const base = mount(1, '/', 'ext4');

test('Linux admits a local named-volume mount and same-mount state paths', () => {
  const source = `${base}\n${mount(2, '/library', 'ext4', '8:16')}\n`;
  assertLinuxLibraryMounts('/library', ['/library/.dkb/state.sqlite', '/library/.dkb/locks/library-state.sqlite'], source);
});

for (const type of ['9p', 'virtiofs', 'cifs', 'nfs', 'nfs4', 'fuse', 'fuseblk', 'drvfs', 'unknown']) {
  test(`Linux rejects ${type} without falling back to its parent local mount`, () => {
    assert.throws(() => assertLinuxLibraryMounts('/library', [], `${base}\n${mount(2, '/library', type)}`), { code: 'library_storage_unsupported' });
  });
}

test('Linux uses path boundaries, handles escaped spaces, and chooses the deepest mount', () => {
  const source = `${base}\n${mount(2, '/library', '9p')}\n${mount(3, '/library-safe', 'ext4')}\n${mount(4, '/my\\040library', 'ext4')}`;
  assertLinuxLibraryMounts('/library-safe', ['/library-safe/.dkb/state.sqlite'], source);
  assertLinuxLibraryMounts('/my library', ['/my library/.dkb/state.sqlite'], source);
  assert.throws(() => assertLinuxLibraryMounts('/library/child', [], source), { code: 'library_storage_unsupported' });
});

test('nested state and lease mounts cannot bypass the Library storage boundary', () => {
  for (const type of ['9p', 'ext4']) {
    const source = `${base}\n${mount(2, '/library/.dkb', type)}`;
    assert.throws(() => assertLinuxLibraryMounts('/library', ['/library/.dkb/state.sqlite'], source), { code: 'library_storage_unsupported' });
  }
});

test('unknown, missing, and malformed mount information fails closed', () => {
  for (const source of ['', 'malformed', '1 1 missing / / rw - ext4 /dev/a rw']) {
    assert.throws(() => assertLinuxLibraryMounts('/library', [], source), { code: 'library_storage_unsupported' });
  }
});

test('noncanonical and escaped database paths are rejected', () => {
  for (const target of ['/elsewhere/state.sqlite', '/library/../state.sqlite', 'relative/state.sqlite']) {
    assert.throws(() => assertLinuxLibraryMounts('/library', [target], base), { code: 'library_storage_unsupported' });
  }
});

test('native local storage can be verified without creating a Library or database', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-library-storage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assertLocalLibraryStorage(root, [path.join(root, '.dkb', 'state.sqlite')]);
  assert.deepEqual(await fs.readdir(root), []);
});
