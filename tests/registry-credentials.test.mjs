import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DKB_REGISTRY_CREDENTIALS_FORMAT,
  loadRegistryCredentialSync,
  removeRegistryCredential,
  saveRegistryCredential,
} from '../packages/registry-client/dist/credentials.js';

test('Registry credentials are URL-scoped, atomic, and removable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-registry-credentials-'));
  const target = path.join(root, 'credentials.json');
  const previous = process.env.DKB_REGISTRY_CREDENTIALS;
  process.env.DKB_REGISTRY_CREDENTIALS = target;

  try {
    const token = `dkb_${'_a-b'.repeat(16)}`;
    await saveRegistryCredential('https://registry.example.test/', {
      token,
      savedAt: '2026-08-28T12:00:00.000Z',
      user: 'operator@example.test',
      team: 'operator',
    });

    assert.deepEqual(loadRegistryCredentialSync('https://registry.example.test'), {
      token,
      savedAt: '2026-08-28T12:00:00.000Z',
      user: 'operator@example.test',
      team: 'operator',
    });
    assert.equal((JSON.parse(await fs.readFile(target, 'utf8'))).format, DKB_REGISTRY_CREDENTIALS_FORMAT);
    assert.equal(await removeRegistryCredential('https://registry.example.test'), true);
    assert.equal(loadRegistryCredentialSync('https://registry.example.test'), null);
    assert.equal(await removeRegistryCredential('https://registry.example.test'), false);
  } finally {
    if (previous === undefined) delete process.env.DKB_REGISTRY_CREDENTIALS;
    else process.env.DKB_REGISTRY_CREDENTIALS = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Malformed credentials are never overwritten', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-registry-credentials-'));
  const target = path.join(root, 'credentials.json');
  const previous = process.env.DKB_REGISTRY_CREDENTIALS;
  process.env.DKB_REGISTRY_CREDENTIALS = target;
  await fs.writeFile(target, '{broken', 'utf8');

  try {
    await assert.rejects(
      saveRegistryCredential('https://registry.example.test', {
        token: `dkb_${'b'.repeat(64)}`,
        savedAt: new Date().toISOString(),
      }),
      /Invalid DKB Registry credentials JSON/u,
    );
    assert.equal(await fs.readFile(target, 'utf8'), '{broken');
  } finally {
    if (previous === undefined) delete process.env.DKB_REGISTRY_CREDENTIALS;
    else process.env.DKB_REGISTRY_CREDENTIALS = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
