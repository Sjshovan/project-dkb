import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { replaceFileAtomically } from '@sjshovan/dkb-protocol/atomicFile.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { parseDkbIdentity } from '@sjshovan/dkb-protocol/identity.js';
import { loadLibraryManifest } from '@sjshovan/dkb-protocol/manifest.js';
import { assertDkbFileLock, withDkbFileLock } from '@sjshovan/dkb-library/locks.js';
import { captureLibraryReadFence } from '@sjshovan/dkb-library/mutation.js';
import { readLibraryState } from '@sjshovan/dkb-library/state.js';
import { DkbProviderHost } from '@sjshovan/dkb-pipeline/host.js';
import { resolveProviderRetrievalProfile } from '@sjshovan/dkb-pipeline/profile.js';
import type { DkbIndexProvider } from '@sjshovan/dkb-pipeline/types.js';
import { validateIndexMutationResult, validateManagedStorageIdentity } from '@sjshovan/dkb-pipeline/validation.js';
import type { DkbRuntimeContext } from '../runtime/context.js';

const FORMAT = 'dkb.managed-index-retention.v1';
const DIRECTORY = '.dkb/managed-index-retention';
interface ManagedIndexRetention {
  format: typeof FORMAT;
  runtimeId: string;
  libraryRoot: string;
  libraryId: string;
  target: string;
  providerId: string;
  retrievalProfileDigest: string;
  optionsDigest: string;
  storageIdentity: string;
  packageId: string;
  packageVersion: string;
}

export interface ManagedIndexCleanup {
  /** Counts are retention scopes, not provider-native index counts. */
  removed: number;
  retained: number;
  pending: number;
  warnings: string[];
}

/** Record authority before an external import, including retained/ambiguous imports. */
export async function retainManagedIndexPackage(stateRoot: string, input: Omit<ManagedIndexRetention, 'format'>): Promise<void> {
  assertDkbFileLock(stateRoot, 'runtime-mutation');
  assertDkbFileLock(input.libraryRoot, 'library-mutation');
  const record = validateRecord({ ...input, libraryRoot: path.resolve(input.libraryRoot), format: FORMAT });
  const directory = path.join(stateRoot, DIRECTORY);
  await fs.mkdir(directory, { recursive: true });
  await assertRegularDirectory(directory);
  const destination = path.join(directory, `${stableHash(record).slice(7)}.json`);
  try {
    await readRecord(destination);
    return;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const staged = `${destination}.stage-${randomUUID()}`;
  try {
    const handle = await fs.open(staged, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(record)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await replaceFileAtomically(staged, destination);
    if (process.platform === 'linux') {
      const handle = await fs.open(directory, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    }
  } finally { await fs.rm(staged, { force: true }); }
}

/** Run after activation commit and outside its Library lease; never undo activation. */
export async function reconcileManagedIndexPackages(input: {
  runtime: DkbRuntimeContext; stateRoot: string; runtimeId: string;
}): Promise<ManagedIndexCleanup> {
  assertDkbFileLock(input.stateRoot, 'runtime-mutation');
  const result: ManagedIndexCleanup = { removed: 0, retained: 0, pending: 0, warnings: [] };
  const directory = path.join(input.stateRoot, DIRECTORY);
  const warn = (detail: string) => {
    result.pending++;
    if (result.warnings.length < 20) result.warnings.push(`${detail} Cleanup is not confirmed; the retention receipt was preserved. Restore the recorded provider/Library, then run dkb runtime refresh ${input.runtimeId}.`);
  };
  const groups = new Map<string, Array<{ file: string; record: ManagedIndexRetention }>>();
  try {
    await assertRegularDirectory(directory);
    for (const name of (await fs.readdir(directory)).sort()) {
      // Interrupted staging preceded the provider call and grants no cleanup authority.
      if (/^[a-f0-9]{64}\.json\.stage-[a-f0-9-]+$/u.test(name)) {
        const staged = path.join(directory, name);
        if ((await fs.lstat(staged)).isFile()) await fs.unlink(staged);
        continue;
      }
      try {
        const file = path.join(directory, name);
        const record = await readRecord(file);
        if (record.runtimeId !== input.runtimeId) throw new Error('Foreign Runtime receipt');
        const items = groups.get(record.libraryRoot) ?? [];
        items.push({ file, record });
        groups.set(record.libraryRoot, items);
      } catch { warn('A managed-index retention receipt is invalid; inspect the Runtime retention directory.'); }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn('Managed-index retention could not be read.');
    return result;
  }

  for (const [libraryRoot, entries] of groups) {
    try {
      await withDkbFileLock(libraryRoot, 'library-mutation', async () => {
        await captureLibraryReadFence(libraryRoot);
        const library = await loadLibraryManifest(libraryRoot);
        const state = await readLibraryState(libraryRoot);
        for (const { file, record } of entries) {
          try {
            if (library.id !== record.libraryId) throw new Error('Library identity changed');
            const installed = state.entries[record.packageId];
            // Even a broken/non-active entry reserves this version. Never reclaim by health.
            if (installed?.kind === 'dkb' && installed.version === record.packageVersion) {
              result.retained++;
              continue;
            }
            await removeRetiredPackage(input, record);
            await fs.unlink(file);
            result.removed++;
          } catch {
            warn(`Managed-index cleanup for ${record.packageId}@${record.packageVersion} (${record.providerId}, Pipeline ${record.target}) needs attention.`);
          }
        }
      }, { timeoutMs: 5000 });
    } catch { warn('A Library with retained managed indexes is unavailable, busy, or requires recovery.'); }
  }
  if (result.pending > result.warnings.length) result.warnings.push(`${result.pending - result.warnings.length} additional cleanup scopes need attention; all retry receipts were retained.`);
  return result;
}

async function removeRetiredPackage(input: { runtime: DkbRuntimeContext; stateRoot: string }, record: ManagedIndexRetention): Promise<void> {
  const host = await DkbProviderHost.create({ root: input.stateRoot, libraryRoot: record.libraryRoot,
    target: record.target, distribution: input.runtime.distribution });
  try {
    const profile = await resolveProviderRetrievalProfile(host);
    const options = host.optionsFor(record.providerId);
    const provider = host.provider<DkbIndexProvider>('index');
    if (host.config.target.index !== record.providerId || provider.mode !== 'managed'
      || profile.retrievalProfileDigest !== record.retrievalProfileDigest || stableHash(options) !== record.optionsDigest
      || validateManagedStorageIdentity(await provider.storageIdentity({ options })) !== record.storageIdentity) {
      throw new DkbError('Recorded managed-index provider changed; cleanup was not attempted.', 'runtime_index_cleanup_required');
    }
    await host.assertCurrent();
    const result = validateIndexMutationResult(await provider.uninstallPackage({
      libraryRoot: record.libraryRoot, libraryId: record.libraryId, packageId: record.packageId,
      packageVersion: record.packageVersion, options,
    }), record.providerId);
    if (result.status !== 'removed' || result.documentCount !== 0) {
      throw new DkbError('Managed-index removal is incomplete.', 'runtime_index_cleanup_required');
    }
  } finally { await host.dispose(); }
}

async function readRecord(file: string): Promise<ManagedIndexRetention> {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) throw new Error('Invalid retention file');
  const record = validateRecord(JSON.parse(await fs.readFile(file, 'utf8')));
  if (path.basename(file) !== `${stableHash(record).slice(7)}.json`) throw new Error('Retention digest mismatch');
  return record;
}

function validateRecord(value: unknown): ManagedIndexRetention {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid retention receipt');
  const record = value as ManagedIndexRetention;
  const fields = ['format', 'runtimeId', 'libraryRoot', 'libraryId', 'target', 'providerId', 'retrievalProfileDigest', 'optionsDigest', 'storageIdentity', 'packageId', 'packageVersion'];
  if (Object.keys(record).length !== fields.length || fields.some(key => typeof (record as unknown as Record<string, unknown>)[key] !== 'string')
    || record.format !== FORMAT || !/^[a-z0-9][a-z0-9._-]*$/u.test(record.runtimeId)
    || !/^[a-z0-9][a-z0-9._-]*$/u.test(record.target)
    || !path.isAbsolute(record.libraryRoot) || !record.libraryId.trim()
    || !record.packageVersion.trim() || /[\x00-\x1f\x7f]/u.test(record.packageVersion)
    || ![record.retrievalProfileDigest, record.optionsDigest, record.storageIdentity].every(digest => /^sha256:[a-f0-9]{64}$/u.test(digest))) {
    throw new Error('Invalid retention receipt fields');
  }
  parseDkbIdentity(record.packageId, 'retained package');
  parseDkbIdentity(record.providerId, 'retained provider');
  return record;
}

async function assertRegularDirectory(directory: string): Promise<void> {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid managed-index retention directory');
}
