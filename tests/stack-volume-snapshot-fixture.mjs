import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStackVolumeSnapshot } from '../apps/cli/dist/stack/volumeSnapshot.js';

export const limits = { maxBytes: 32 * 1024 * 1024, maxArchiveBytes: 40 * 1024 * 1024, maxEntries: 2000 };
const storage = { format: 'dkb.stack-storage.v1', name: 'test', id: '12345678-1234-1234-1234-123456789abc', phase: 'ready',
  owner: { context: 'desktop-linux', image: `sha256:${'a'.repeat(64)}`, libraryVolume: 'test-library', runtimeVolume: 'test-runtime', compilerVolume: 'test-compiler' },
  volumes: { library: 'test-library', runtime: 'test-runtime', compiler: 'test-compiler', cache: 'test-cache' },
  volumeEnvironment: { library: 'DKB_LIBRARY_VOLUME', runtime: 'DKB_RUNTIME_VOLUME', compiler: 'DKB_COMPILER_CONTEXT_VOLUME', cache: 'DKB_CACHE_VOLUME' },
  sharedLibrary: false };

export async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-volume-snapshot-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), archive = path.join(root, 'backup.tgz');
  for (const name of ['host', ...Object.keys(storage.volumes).map(role => `volumes/${role}`)]) await fs.mkdir(path.join(source, name), { recursive: true });
  await fs.writeFile(path.join(source, 'host', 'stack.env'), 'LOCAL_SECRET=private-fixture\n', { mode: 0o600 });
  await fs.writeFile(path.join(source, 'volumes/library', 'source.txt'), 'Original knowledge\n');
  return { root, source, archive };
}

export async function snapshot(f, output = createWriteStream(f.archive, { flags: 'wx', mode: 0o600 }), budget = limits, signal) {
  return createStackVolumeSnapshot(f.source, storage, output, budget, signal);
}

export async function restoreStage(f, archive = f.archive) {
  const destination = path.join(f.root, 'restored');
  for (const name of ['host', ...Object.keys(storage.volumes).map(role => `volumes/${role}`)]) await fs.mkdir(path.join(destination, name), { recursive: true });
  const digest = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  return { destination, digest };
}
