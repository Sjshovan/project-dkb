import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { backupDkbStack, requireStoppedStack, restoreDkbStack } from './backups.js';
import {
  parseEnvironmentFile,
  readDkbStack,
  writeAtomic,
  writeEnvironmentFile,
} from './context.js';
import { runCompose } from './docker.js';
import type { DkbStackStatus, DkbStackTarget, DkbStackUpgrade } from './types.js';

type StartStack = (name: string, target: DkbStackTarget) => Promise<{ services: DkbStackStatus['services'] }>;

export async function upgradeDkbStackRelease(
  distribution: DkbDistribution,
  name: string,
  lockPath: string,
  startStack: StartStack,
): Promise<DkbStackUpgrade> {
  const context = await readDkbStack(distribution, name);
  await requireStoppedStack(context, 'upgrade');
  const lockFile = path.resolve(lockPath);
  const lock = await readStackLock(lockFile, distribution);
  const backup = await backupDkbStack(distribution, name);
  const originalEnvironment = await fs.readFile(context.envFile, 'utf8');

  for (const image of Object.values(lock.images)) {
    const pulled = spawnSync('docker', ['pull', image], { encoding: 'utf8' });
    if (pulled.error || pulled.status !== 0) {
      const detail = String(pulled.stderr || pulled.stdout || pulled.error?.message || '').trim();
      throw new DkbError(`Unable to pull ${image}${detail ? `: ${detail}` : ''}. Stack ${name} remains unchanged.`);
    }
  }

  const values = parseEnvironmentFile(originalEnvironment);
  const updated: Record<string, string> = { ...values, DKB_STACK_VERSION: lock.version };
  for (const service of distribution.services) {
    const image = lock.images[service.id];
    if (image && service.stack) updated[service.stack.imageEnvironment] = image;
  }
  await writeEnvironmentFile(context.envFile, updated);
  await writeAtomic(path.join(context.root, 'release.lock.json'), `${JSON.stringify(lock, null, 2)}\n`);

  try {
    const ready = await startStack(name, context.target);
    return {
      status: 'upgraded',
      name,
      fromVersion: context.version ?? 'development',
      toVersion: lock.version,
      lockFile,
      backup,
      services: ready.services,
    };
  } catch (error) {
    const failedContext = await readDkbStack(distribution, name);
    runCompose(failedContext, ['down', '--remove-orphans'], false, true);
    await restoreDkbStack(distribution, backup.archive, true);
    let rollbackMessage = 'Previous state restored but left stopped.';
    try {
      await startStack(name, context.target);
      rollbackMessage = 'Previous state restored and restarted.';
    } catch (rollbackError) {
      rollbackMessage = `Previous state restored but restart failed: ${errorMessage(rollbackError)}`;
    }
    throw new DkbError(`Stack upgrade to ${lock.version} failed: ${errorMessage(error)} ${rollbackMessage}`);
  }
}

async function readStackLock(target: string, distribution: DkbDistribution): Promise<{
  format: 'dkb.stack-lock.v2';
  version: string;
  distribution: string;
  images: Record<string, string>;
}> {
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(target, 'utf8')) as unknown;
  } catch (error) {
    throw new DkbError(`Unable to read stack release lock ${target}: ${errorMessage(error)}`);
  }
  if (!isRecord(value)
    || value.format !== 'dkb.stack-lock.v2'
    || typeof value.version !== 'string'
    || typeof value.distribution !== 'string'
    || !isRecord(value.images)) {
    throw new DkbError(`Invalid DKB stack release lock: ${target}`);
  }
  const expectedDistribution = `${distribution.id}@${distribution.version}`;
  if (value.distribution !== expectedDistribution) {
    throw new DkbError(`Stack release lock targets ${value.distribution}; this CLI loaded ${expectedDistribution}.`);
  }
  const images: Record<string, string> = {};
  const expected = distribution.services.filter((service) => service.stack && service.image).map((service) => service.id);
  for (const id of expected) {
    const image = value.images[id];
    if (typeof image !== 'string' || !/^\S+@sha256:[a-f0-9]{64}$/u.test(image)) {
      throw new DkbError(`Stack release lock has an invalid or unpinned ${id} image.`);
    }
    images[id] = image;
  }
  for (const id of Object.keys(value.images)) {
    if (!expected.includes(id)) throw new DkbError(`Stack release lock declares unknown service image ${id}.`);
  }
  return { format: 'dkb.stack-lock.v2', version: value.version, distribution: value.distribution, images };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
