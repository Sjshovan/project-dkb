import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import {
  createBundledIntegrityReceipt,
  writeBundledIntegrityReceipt,
  verifyBundledIntegrityReceipt,
  DKB_BUNDLED_INTEGRITY_PATH,
  DKB_BUNDLED_INTEGRITY_MAX_BYTES,
} from '@sjshovan/dkb-pipeline/bundledIntegrity.js';

const identity = {
  apiVersion: 3,
  id: '@test/bundled-provider',
  version: '1.0.0',
  protocols: ['test.second.v1', 'test.first.v1'],
  artifactFormats: ['test.index.v1'],
};

async function fixture(t, { dependency = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-bundled-integrity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'provider');
  const entrypoint = path.join(packageRoot, 'dist/plugin.mjs');
  const manifest = {
    name: '@test/provider-package', version: '1.2.0', type: 'module',
    files: ['dist/', 'assets/'],
    ...(dependency ? { dependencies: { helper: '1.0.0' } } : {}),
  };
  await fs.mkdir(path.dirname(entrypoint), { recursive: true });
  await fs.mkdir(path.join(packageRoot, 'assets'));
  await fs.writeFile(entrypoint, 'export const apiVersion=3;\n');
  await fs.writeFile(path.join(packageRoot, 'assets/Dockerfile'), 'FROM scratch\n');
  await fs.writeFile(path.join(packageRoot, 'assets/compile.py'), 'value = 1\n');
  await fs.writeFile(path.join(packageRoot, 'assets/Ω.json'), '{"revision":1}\n');
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify(manifest));
  let dependencyRoot;
  if (dependency) {
    dependencyRoot = path.join(packageRoot, 'node_modules/helper');
    await fs.mkdir(dependencyRoot, { recursive: true });
    await fs.writeFile(path.join(dependencyRoot, 'package.json'), JSON.stringify({ name: 'helper', version: '1.0.0', files: ['index.js'] }));
    await fs.writeFile(path.join(dependencyRoot, 'index.js'), 'export const value=1;');
  }
  return {
    root, packageRoot, entrypoint, manifest, dependencyRoot,
    receiptPath: path.join(packageRoot, DKB_BUNDLED_INTEGRITY_PATH),
    options: { packageRoot, entrypoint, identity },
  };
}

test('bundled receipts are deterministic, portable, and do not hash themselves', async (t) => {
  const first = await fixture(t, { dependency: true });
  const second = await fixture(t, { dependency: true });
  const created = await createBundledIntegrityReceipt(first.options);
  await assert.rejects(fs.stat(first.receiptPath), { code: 'ENOENT' });
  const written = await writeBundledIntegrityReceipt(first.options);
  const other = await writeBundledIntegrityReceipt({ ...second.options, entrypoint: 'dist/plugin.mjs' });
  assert.deepEqual(created, written);
  assert.deepEqual(written, other);
  assert.equal(written.format, 'dkb.provider-integrity.v1');
  assert.equal(written.packageName, '@test/provider-package');
  assert.equal(written.packageVersion, '1.2.0');
  assert.equal(written.version, '1.0.0');
  assert.equal(written.entrypoint, 'dist/plugin.mjs');
  assert.deepEqual(written.protocols, ['test.first.v1', 'test.second.v1']);
  assert.deepEqual(written.files.map((file) => file.path), [
    'assets/Dockerfile', 'assets/compile.py', 'assets/Ω.json', 'dist/plugin.mjs', 'package.json',
  ]);
  assert.equal(written.filesDigest, stableHash(written.files));
  assert.ok(!written.files.some((file) => file.path === DKB_BUNDLED_INTEGRITY_PATH));
  const bytes = await fs.readFile(first.receiptPath, 'utf8');
  assert.ok(!bytes.includes(first.root));
  assert.ok(!('externalDigests' in written));
  assert.ok(!('options' in written));
  assert.deepEqual(await verifyBundledIntegrityReceipt(first.options), written);
});

test('unchanged generation preserves receipt bytes and mtime without changing provider source', async (t) => {
  const item = await fixture(t);
  await writeBundledIntegrityReceipt(item.options);
  const old = new Date('2020-01-01T00:00:00Z');
  await fs.utimes(item.receiptPath, old, old);
  const sourceBefore = await fs.readFile(item.entrypoint);
  const bytesBefore = await fs.readFile(item.receiptPath);
  const before = await fs.stat(item.receiptPath, { bigint: true });
  await writeBundledIntegrityReceipt(item.options);
  assert.equal((await fs.stat(item.receiptPath, { bigint: true })).mtimeNs, before.mtimeNs);
  assert.deepEqual(await fs.readFile(item.receiptPath), bytesBefore);
  assert.deepEqual(await fs.readFile(item.entrypoint), sourceBefore);
  assert.deepEqual((await fs.readdir(item.root)).sort(), ['provider']);
});

test('verification never creates or repairs missing and malformed receipts', async (t) => {
  const item = await fixture(t);
  await assert.rejects(verifyBundledIntegrityReceipt(item.options), /integrity receipt is missing/u);
  await assert.rejects(fs.stat(item.receiptPath), { code: 'ENOENT' });
  await fs.writeFile(item.receiptPath, '{broken');
  await assert.rejects(verifyBundledIntegrityReceipt(item.options), /not valid JSON/u);
  assert.equal(await fs.readFile(item.receiptPath, 'utf8'), '{broken');
  await writeBundledIntegrityReceipt(item.options);
  await verifyBundledIntegrityReceipt(item.options);
});

test('identity, inventory, unknown fields, duplicates, traversal and bounds fail closed', async (t) => {
  const mutations = [
    (receipt) => { receipt.id = '@other/provider'; },
    (receipt) => { receipt.apiVersion = 2; },
    (receipt) => { receipt.packageVersion = '9.0.0'; },
    (receipt) => { receipt.entrypoint = '../outside.mjs'; },
    (receipt) => { receipt.options = { secret: 'must-not-be-accepted' }; },
    (receipt) => { receipt.files.push(receipt.files[0]); receipt.filesDigest = stableHash(receipt.files); },
    (receipt) => { receipt.files[0].hash = 'not-a-hash'; },
    (receipt) => { receipt.files[0].path = '/absolute'; receipt.filesDigest = stableHash(receipt.files); },
    (receipt) => { receipt.files[0].path = 'a'.repeat(2049); receipt.filesDigest = stableHash(receipt.files); },
    (receipt) => { receipt.files = Array(10_001).fill(receipt.files[0]); receipt.filesDigest = stableHash(receipt.files); },
  ];
  for (const mutate of mutations) {
    const item = await fixture(t);
    const receipt = await writeBundledIntegrityReceipt(item.options);
    mutate(receipt);
    const bytes = JSON.stringify(receipt);
    await fs.writeFile(item.receiptPath, bytes);
    await assert.rejects(verifyBundledIntegrityReceipt(item.options), /integrity/iu);
    assert.equal(await fs.readFile(item.receiptPath, 'utf8'), bytes);
  }
  const large = await fixture(t);
  await fs.writeFile(large.receiptPath, Buffer.alloc(DKB_BUNDLED_INTEGRITY_MAX_BYTES + 1));
  await assert.rejects(verifyBundledIntegrityReceipt(large.options), /size limit/u);
});

test('changed and added shipped code or assets reject while unshipped files remain irrelevant', async (t) => {
  for (const relative of ['dist/plugin.mjs', 'assets/compile.py', 'assets/Ω.json', 'dist/new-helper.mjs']) {
    const item = await fixture(t);
    await writeBundledIntegrityReceipt(item.options);
    await fs.writeFile(path.join(item.packageRoot, 'unshipped-notes.txt'), 'not part of the package');
    await verifyBundledIntegrityReceipt(item.options);
    await fs.writeFile(path.join(item.packageRoot, relative), 'changed bytes');
    await assert.rejects(verifyBundledIntegrityReceipt(item.options), /does not match/u);
  }
});

test('exact declared dependency changes reject even when a caller reuses its cache', async (t) => {
  for (const reuseCache of [false, true]) {
    const item = await fixture(t, { dependency: true });
    const cache = new Map();
    await writeBundledIntegrityReceipt(item.options, cache);
    await verifyBundledIntegrityReceipt(item.options, cache);
    const target = path.join(item.dependencyRoot, 'index.js');
    const stat = await fs.stat(target);
    await fs.writeFile(target, 'export const value=2;');
    await fs.utimes(target, stat.atime, stat.mtime);
    await assert.rejects(verifyBundledIntegrityReceipt(item.options, reuseCache ? cache : undefined), /changed.*(?:disk|loaded)|does not match/iu);
  }
});

test('generation requires an explicit allowlist that ships both entrypoint and receipt', async (t) => {
  for (const files of [undefined, [], ['dist/plugin.mjs'], ['dist/', '!dist/provider.integrity.json'], ['dist/provider.integrity.json']]) {
    const item = await fixture(t);
    await fs.writeFile(path.join(item.packageRoot, 'package.json'), JSON.stringify({ ...item.manifest, files }));
    await assert.rejects(writeBundledIntegrityReceipt(item.options), /allowlist|entrypoint/u);
    await assert.rejects(fs.stat(item.receiptPath), { code: 'ENOENT' });
  }
  const item = await fixture(t);
  await assert.rejects(createBundledIntegrityReceipt({ ...item.options, identity: { ...identity, externalDigests: { image: 'forbidden' } } }), /unsupported fields/u);
});

test('entrypoint traversal and directory symlinks never escape the package', async (t) => {
  const item = await fixture(t);
  const outside = path.join(item.root, 'outside');
  await fs.mkdir(outside);
  const outsideFile = path.join(outside, 'plugin.mjs');
  await fs.writeFile(outsideFile, 'untouched');
  await assert.rejects(writeBundledIntegrityReceipt({ ...item.options, entrypoint: '../outside/plugin.mjs' }), /contained/u);
  const link = path.join(item.packageRoot, 'dist/link');
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(writeBundledIntegrityReceipt({ ...item.options, entrypoint: 'dist/link/plugin.mjs' }), /ordinary contained/u);
  assert.equal(await fs.readFile(outsideFile, 'utf8'), 'untouched');
});

test('receipt reads reject a symlinked parent rather than opening an external file', async (t) => {
  const item = await fixture(t);
  const external = path.join(item.root, 'external');
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, 'provider.integrity.json'), 'untouched');
  await fs.rename(path.join(item.packageRoot, 'dist'), path.join(item.packageRoot, 'original-dist'));
  await fs.symlink(external, path.join(item.packageRoot, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyBundledIntegrityReceipt(item.options), /ordinary contained/u);
  assert.equal(await fs.readFile(path.join(external, 'provider.integrity.json'), 'utf8'), 'untouched');
});
