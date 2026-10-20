import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { c as createTar, t as listTar, x as extractTar } from 'tar';
import type { DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import {
  pathExists,
  readEnvironmentFile,
  readDkbStackControl,
  stackName,
  stackStateRoot,
} from './context.js';
import { assertDockerAvailable, composeContainerIds, volumeContainerIds } from './docker.js';
import type { DkbStackBackup, DkbStackControlContext, DkbStackRestore } from './types.js';
import { withStackControl } from './control.js';
import { assertHostBackupCoverage, readHostBackupEnvironment } from './backupCoverage.js';
import { readStackStorage, storageEnvironment } from './ownedStorage.js';
import { writeStackVolumeBackup } from './volumeBackup.js';
import { withOwnerCancellation } from '../host/libraryOwnerCancellation.js';

export async function backupDkbStack(
  distribution: DkbDistribution,
  name = 'local',
  output?: string,
  signal?: AbortSignal,
): Promise<DkbStackBackup> {
  return withOwnerCancellation(signal, cancellation => withStackControl(name,
    () => backupStack(distribution, name, output, cancellation), { signal: cancellation }));
}

async function backupStack(distribution: DkbDistribution, name: string, output?: string, signal?: AbortSignal): Promise<DkbStackBackup> {
  const context = await readDkbStackControl(distribution, name);
  const storage = await readStackStorage(context.name);
  if (!storage) await assertHostBackupCoverage(context.root);
  assertDockerAvailable();
  await requireStoppedStack(context, 'back up');

  const archive = path.resolve(output ?? path.join(
    stackBackupRoot(),
    `${context.name}-${new Date().toISOString().replace(/[:.]/gu, '-')}.tar.gz`,
  ));
  assertOutsideStack(context.root, archive, 'Backup archive');
  await fs.mkdir(path.dirname(archive), { recursive: true });
  assertOutsideStack(await fs.realpath(context.root), path.join(await fs.realpath(path.dirname(archive)), path.basename(archive)), 'Backup archive');
  for (const file of [archive, `${archive}.sha256`]) {
    if (await pathExists(file)) throw backupOutputExists();
  }

  // Exclusive directory creation gives this operation ownership of its scratch
  // files. A predictable sibling filename could belong to another operation.
  const staging = await fs.mkdtemp(path.join(path.dirname(archive), '.dkb-backup-'));
  const temporary = path.join(staging, 'archive.tar.gz');
  let rejectedEntry: DkbError | undefined;
  try {
    if (storage) await writeStackVolumeBackup(storage, temporary, signal);
    else await createTar({
      cwd: path.dirname(context.root),
      file: temporary,
      gzip: true,
      portable: true,
      noMtime: true,
      filter: (_entry, stat) => {
        const regular = 'type' in stat ? ['File', 'Directory', 'OldFile'].includes(stat.type) : stat.isFile() || stat.isDirectory();
        if (!regular) {
          rejectedEntry ??= new DkbError('Stack backups require regular files and directories. A link or special file would omit external state; no backup was created.', 'stack_backup_incomplete');
        }
        // tar invokes this callback outside the returned Promise. Record rejection
        // and skip remaining entries; never throw an unhandled callback exception.
        return rejectedEntry === undefined;
      },
    }, [path.basename(context.root)]);
    if (rejectedEntry) throw rejectedEntry;
    signal?.throwIfAborted();
    await fs.chmod(temporary, 0o600);
    const handle = await fs.open(temporary, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    // Same-directory hard-link promotion is atomic and refuses an existing path.
    // rename() could overwrite a previous backup on POSIX after preflight.
    await fs.link(temporary, archive).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw backupOutputExists();
      throw error;
    });
  } finally {
    await fs.rm(temporary, { force: true });
    // Do not recursively delete unexpected files, even from owned staging.
    await fs.rmdir(staging);
  }

  const sha256 = await fileSha256(archive);
  const checksumFile = `${archive}.sha256`;
  const checksum = await fs.open(checksumFile, 'wx', 0o600).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw backupOutputExists();
    throw error;
  });
  try {
    await checksum.writeFile(`${sha256}  ${path.basename(archive)}\n`);
    await checksum.sync();
  } finally { await checksum.close(); }
  const stat = await fs.stat(archive);

  return {
    status: 'backed_up',
    name: context.name,
    archive,
    checksumFile,
    sha256,
    bytes: stat.size,
    containsSecrets: true,
  };
}

export async function restoreDkbStack(
  distribution: DkbDistribution,
  archivePath: string,
  replace = false,
): Promise<DkbStackRestore> {
  const archive = path.resolve(archivePath);
  const checksumFile = `${archive}.sha256`;
  const expectedHash = await readChecksum(checksumFile);
  const actualHash = await fileSha256(archive);
  if (actualHash !== expectedHash) {
    throw new DkbError(`Stack backup checksum mismatch for ${archive}. Expected ${expectedHash}, received ${actualHash}.`);
  }

  const archiveRoot = await validateStackArchive(archive);
  const name = stackName(archiveRoot);
  return withStackControl(name, () => restoreStack(distribution, archive, actualHash, name, replace));
}

async function restoreStack(distribution: DkbDistribution, archive: string, actualHash: string, name: string, replace: boolean): Promise<DkbStackRestore> {
  const archiveRoot = name;
  const target = path.join(stackStateRoot(), name);
  const existing = await pathExists(target);
  if (existing && !replace) {
    throw new DkbError(`Stack ${name} already exists at ${target}. Stop it, then rerun with --replace to restore this backup.`);
  }
  if (existing) {
    // A legacy host archive cannot replace a volume-backed topology or restore
    // the live data its descriptor points to. Reject before renaming anything.
    await readHostBackupEnvironment(target);
    await requireStoppedStack(await readDkbStackControl(distribution, name), 'replace from backup');
  }

  await fs.mkdir(stackStateRoot(), { recursive: true });
  const stage = await fs.mkdtemp(path.join(stackStateRoot(), '.restore-'));
  const previous = `${target}.rollback-${process.pid}-${Date.now().toString(36)}`;
  let movedPrevious = false;

  try {
    await extractTar({ cwd: stage, file: archive, strict: true, preservePaths: false, unlink: false });
    const stagedRoot = path.join(stage, archiveRoot);
    if (!await pathExists(path.join(stagedRoot, 'stack.env'))) {
      throw new DkbError('Stack backup is missing stack.env and cannot be restored.');
    }
    await assertHostBackupCoverage(stagedRoot, target);
    if (existing) {
      await fs.rename(target, previous);
      movedPrevious = true;
    }
    await fs.rename(stagedRoot, target);
    if (movedPrevious) await fs.rm(previous, { recursive: true, force: true });
  } catch (error) {
    if (movedPrevious && !await pathExists(target) && await pathExists(previous)) await fs.rename(previous, target);
    throw error;
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }

  return { status: 'restored', name, archive, stateRoot: target, sha256: actualHash, replaced: existing };
}

export async function requireStoppedStack(context: DkbStackControlContext, operation: string): Promise<void> {
  const running = await composeContainerIds(context);
  if (running.length > 0) {
    throw new DkbError(`Stack ${context.name} must be stopped before ${operation}. Run: dkb stack down ${context.name}`);
  }
  const values = await readEnvironmentFile(context.envFile);
  const storage = await readStackStorage(context.name);
  const volumeKeys = Object.keys(values).filter(key => /^DKB_.*_VOLUME$/u.test(key));
  if (!storage) {
    if (volumeKeys.length) throw new DkbError('Stack volume ownership is not recorded. Preserve its data and recover the storage descriptor before backup or restore.', 'stack_storage_check_failed');
    return;
  }
  if (storage.phase !== 'ready' || storage.owner.context !== context.dockerContext
    || Object.entries(storageEnvironment(storage)).some(([key, value]) => values[key] !== value)
    || volumeKeys.some(key => !Object.values(storage.volumeEnvironment).includes(key))) {
    throw new DkbError('Stack environment and recorded storage disagree. Preserve both for recovery; no stopped-state assumption was made.', 'stack_storage_mismatch');
  }
  for (const [role, volume] of Object.entries(storage.volumes)) {
    const consumers = await volumeContainerIds(storage.owner.context, volume);
    if (consumers.length) {
      throw new DkbError(`Stack ${context.name} cannot ${operation}: its ${role} volume ${volume} is also attached to active containers. `
        + `Stop every consumer, including other Runtimes sharing this Library, then retry. Inspect: docker --context ${storage.owner.context} container ls --all --filter volume=${volume}`,
      'stack_storage_in_use');
    }
  }
}

function stackBackupRoot(): string {
  return path.resolve(process.env.DKB_STACK_BACKUP_ROOT ?? path.join(os.homedir(), '.dkb', 'backups'));
}

function backupOutputExists(): DkbError {
  return new DkbError('Backup output or checksum already exists. Choose a new --output path; existing backups were not overwritten.', 'stack_backup_exists');
}

function assertOutsideStack(stackRoot: string, target: string, label: string): void {
  const relative = path.relative(path.resolve(stackRoot), path.resolve(target));
  if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new DkbError(`${label} must be outside the stack state root so it is not archived recursively.`);
  }
}

async function fileSha256(target: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await fs.open(target, 'r');
  try {
    for await (const chunk of handle.readableWebStream()) hash.update(Buffer.from(chunk));
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function readChecksum(target: string): Promise<string> {
  let source: string;
  try {
    source = await fs.readFile(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DkbError(`Stack backup checksum is missing: ${target}`);
    throw error;
  }
  const digest = source.trim().split(/\s+/u)[0] ?? '';
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new DkbError(`Stack backup checksum is invalid: ${target}`);
  return digest;
}

async function validateStackArchive(target: string): Promise<string> {
  const roots = new Set<string>();
  let entries = 0;
  let rejectedEntry: Error | undefined;
  await listTar({
    file: target,
    strict: true,
    onentry: (entry) => {
      if (rejectedEntry) return;
      try {
        entries += 1;
        if (entries > 1_000_000) throw new DkbError('Stack backup contains too many entries.');
        if (!['File', 'Directory', 'OldFile'].includes(entry.type)) {
          throw new DkbError('Stack backup contains a link or special file. Only regular files and directories can be restored.');
        }
        const normalized = entry.path.replace(/\\/gu, '/');
        if (normalized.includes('\0') || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) {
          throw new DkbError(`Unsafe absolute path in stack backup: ${entry.path}`);
        }
        const parts = normalized.split('/').filter(Boolean);
        if (parts.length === 0 || parts.some((part) => part === '..')) {
          throw new DkbError(`Unsafe path in stack backup: ${entry.path}`);
        }
        roots.add(parts[0]!);
      } catch (error) {
        rejectedEntry = error instanceof Error ? error : new DkbError('Invalid Stack backup entry.');
      }
    },
  });
  if (rejectedEntry) throw rejectedEntry;
  if (entries === 0 || roots.size !== 1) throw new DkbError('Stack backup must contain exactly one stack root directory.');
  return [...roots][0]!;
}
