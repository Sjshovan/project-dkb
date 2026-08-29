import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { c as createTar, t as listTar, x as extractTar } from 'tar';
import type { DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import {
  pathExists,
  readDkbStack,
  stackName,
  stackStateRoot,
  writeAtomic,
} from './context.js';
import { assertDockerAvailable, composeContainerIds } from './docker.js';
import type { DkbStackBackup, DkbStackContext, DkbStackRestore } from './types.js';

export async function backupDkbStack(
  distribution: DkbDistribution,
  name = 'local',
  output?: string,
): Promise<DkbStackBackup> {
  const context = await readDkbStack(distribution, name);
  assertDockerAvailable();
  await requireStoppedStack(context, 'back up');

  const archive = path.resolve(output ?? path.join(
    stackBackupRoot(),
    `${context.name}-${new Date().toISOString().replace(/[:.]/gu, '-')}.tar.gz`,
  ));
  assertOutsideStack(context.root, archive, 'Backup archive');
  await fs.mkdir(path.dirname(archive), { recursive: true });

  const temporary = `${archive}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await createTar({
      cwd: path.dirname(context.root),
      file: temporary,
      gzip: true,
      portable: true,
      noMtime: true,
    }, [path.basename(context.root)]);
    await fs.rename(temporary, archive);
  } finally {
    await fs.rm(temporary, { force: true });
  }

  await fs.chmod(archive, 0o600).catch(() => undefined);
  const sha256 = await fileSha256(archive);
  const checksumFile = `${archive}.sha256`;
  await writeAtomic(checksumFile, `${sha256}  ${path.basename(archive)}\n`);
  await fs.chmod(checksumFile, 0o600).catch(() => undefined);
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
  const target = path.join(stackStateRoot(), name);
  const existing = await pathExists(target);
  if (existing && !replace) {
    throw new DkbError(`Stack ${name} already exists at ${target}. Stop it, then rerun with --replace to restore this backup.`);
  }
  if (existing) await requireStoppedStack(await readDkbStack(distribution, name), 'replace from backup');

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

export async function requireStoppedStack(context: DkbStackContext, operation: string): Promise<void> {
  const running = await composeContainerIds(context);
  if (running.length > 0) {
    throw new DkbError(`Stack ${context.name} must be stopped before ${operation}. Run: dkb stack down ${context.name}`);
  }
}

function stackBackupRoot(): string {
  return path.resolve(process.env.DKB_STACK_BACKUP_ROOT ?? path.join(os.homedir(), '.dkb', 'backups'));
}

function assertOutsideStack(stackRoot: string, target: string, label: string): void {
  const relative = path.relative(path.resolve(stackRoot), path.resolve(target));
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
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
  await listTar({
    file: target,
    strict: true,
    onentry: (entry) => {
      entries += 1;
      if (entries > 1_000_000) throw new DkbError('Stack backup contains too many entries.');
      const normalized = entry.path.replace(/\\/gu, '/');
      if (normalized.includes('\0') || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) {
        throw new DkbError(`Unsafe absolute path in stack backup: ${entry.path}`);
      }
      const parts = normalized.split('/').filter(Boolean);
      if (parts.length === 0 || parts.some((part) => part === '..')) {
        throw new DkbError(`Unsafe path in stack backup: ${entry.path}`);
      }
      roots.add(parts[0]!);
    },
  });
  if (entries === 0 || roots.size !== 1) throw new DkbError('Stack backup must contain exactly one stack root directory.');
  return [...roots][0]!;
}
