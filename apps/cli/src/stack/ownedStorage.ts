import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { assertLocalLibraryStorage } from '@sjshovan/dkb-library/storageAccess.js';
import type { DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import { assertLocalOwnerImage, assertLocalOwnerVolume } from '../host/dockerOwnerWorker.js';
import { ownerDockerProcess } from '../host/dockerOwnerProcess.js';
import { readHostInventory } from '../host/inventory.js';
import { DKB_CLI_VERSION } from '../version.js';
import { writeAtomic } from './context.js';
import { STACK_OWNER_FORMAT, validateDockerStackOwner, type DockerStackOwner } from './ownerContract.js';
import { stackName, stackStateRoot } from './paths.js';

export const STACK_STORAGE_FILE = 'stack-storage.json';
export const STACK_VOLUME_ENV = {
  library: 'DKB_LIBRARY_VOLUME', runtime: 'DKB_RUNTIME_VOLUME', compiler: 'DKB_COMPILER_CONTEXT_VOLUME',
} as const;
export interface StackStorage {
  format: 'dkb.stack-storage.v1'; name: string; id: string; phase: 'provisioning' | 'ready';
  owner: DockerStackOwner; volumes: Record<string, string>; volumeEnvironment: Record<string, string>; sharedLibrary: boolean;
}

/** Call under the Stack control lease. Intent precedes creation; no automatic deletion or migration. */
export async function provisionStackStorage(distribution: DkbDistribution, name: string, library?: string): Promise<StackStorage> {
  const normalized = stackName(name), root = path.join(stackStateRoot(), normalized), file = path.join(root, STACK_STORAGE_FILE);
  await assertLocalLibraryStorage(stackStateRoot(), [file]);
  let storage = await readStackStorage(normalized);
  if (!storage) {
    const entries = await fs.readdir(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []; throw error;
    });
    if (entries.length) migration(normalized);
    const context = process.env.DKB_DOCKER_CONTEXT?.trim() || (await docker(['context', 'show'])).trim();
    const reference = process.env.DKB_CLI_IMAGE ?? `dkb-cli:${DKB_CLI_VERSION}`;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(context) || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,511}$/u.test(reference)) {
      throw new DkbError('DKB_DOCKER_CONTEXT must be a named local context and DKB_CLI_IMAGE a valid installed image reference.', 'invalid_stack_storage');
    }
    const inspected = await ownerDockerProcess(['--context', context, 'image', 'inspect', reference, '--format', '{{.Id}}']);
    if (inspected.code !== 0) throw new DkbError(`The matching Linux management image is unavailable. Install the DKB CLI image, or from the DKB checkout run: docker build --build-arg DKB_VERSION=${DKB_CLI_VERSION} -f apps/cli/Dockerfile -t dkb-cli:${DKB_CLI_VERSION} . Then select that installed image with DKB_CLI_IMAGE and retry dkb stack up ${normalized}. No volume was created.`, 'library_owner_image_missing');
    const image = inspected.stdout.trim();
    const id = randomUUID();
    if (Object.keys(distribution.stackVolumes ?? {}).some(key => key in STACK_VOLUME_ENV)) invalid();
    const volumeEnvironment = { ...STACK_VOLUME_ENV, ...distribution.stackVolumes };
    const volumes = Object.fromEntries(Object.keys(volumeEnvironment).map(role => [role, `dkb-${normalized}-${id}-${role.toLowerCase()}`]));
    if (library) {
      const entry = (await readHostInventory()).libraries[library];
      if (!entry?.storage || entry.storage.context !== context) {
        throw new DkbError('Stack --library requires a registered Docker Library in the same local Docker context. Native Libraries need an explicit copy-and-verify migration; no data was moved.', 'stack_library_owner_required');
      }
      volumes.library = entry.storage.volume;
    }
    storage = validateStackStorage({ format: 'dkb.stack-storage.v1', name: normalized, id, phase: 'provisioning',
      owner: { context, image, libraryVolume: volumes.library, runtimeVolume: volumes.runtime, compilerVolume: volumes.compiler }, volumes, volumeEnvironment, sharedLibrary: Boolean(library) }, normalized);
    await assertLocalOwnerImage(storage.owner, 'dev.dkb.stack-owner.protocol', STACK_OWNER_FORMAT);
    // A lost host descriptor must never silently create a replacement for an older Compose project.
    const prefix = ['--context', context];
    const containers = await docker([...prefix, 'container', 'ls', '--all', '--filter', `label=com.docker.compose.project=dkb-${normalized}`, '--format', '{{.ID}}']);
    const existingVolumes = (await docker([...prefix, 'volume', 'ls', '--format', '{{.Name}}'])).split(/\r?\n/u);
    const labelledVolumes = await docker([...prefix, 'volume', 'ls', '--filter', `label=dev.dkb.stack.name=${normalized}`, '--format', '{{.Name}}']);
    if (containers.trim() || labelledVolumes.trim() || existingVolumes.some(value => value.startsWith(`dkb-${normalized}_`))) migration(normalized);
    await save(file, storage);
  } else if (library) {
    const selected = (await readHostInventory()).libraries[library]?.storage;
    if (!selected || selected.context !== storage.owner.context || selected.volume !== storage.owner.libraryVolume) {
      throw new DkbError('This Stack already has a different Library volume. Use an explicit Runtime Library switch; startup does not remount or migrate an existing Library.', 'stack_owner_library_mismatch');
    }
  }
  await assertLocalOwnerImage(storage.owner, 'dev.dkb.stack-owner.protocol', STACK_OWNER_FORMAT);
  const prefix = ['--context', storage.owner.context];
  // A failed list is not proof that a volume is absent.
  const existing = new Set((await docker([...prefix, 'volume', 'ls', '--format', '{{.Name}}'])).split(/\r?\n/u));
  for (const [role, volume] of Object.entries(storage.volumes)) {
    if (!existing.has(volume)) {
      if (storage.phase === 'ready' || (role === 'library' && storage.sharedLibrary)) {
        throw new DkbError(`Stack ${normalized} volume ${volume} is missing. Restore its backup before starting; an empty replacement was not created.`, 'stack_storage_missing');
      }
      await docker([...prefix, 'volume', 'create', '--driver', 'local', '--label', `dev.dkb.stack.storage=${storage.id}`, '--label', `dev.dkb.stack.name=${normalized}`, '--label', `dev.dkb.stack.role=${role}`, volume]);
    }
    const result = JSON.parse(await docker([...prefix, 'volume', 'inspect', volume])) as Array<Record<string, unknown>>;
    assertLocalOwnerVolume(result[0], volume);
    if (!(role === 'library' && storage.sharedLibrary)) {
      const labels = result[0]?.Labels as Record<string, string> | undefined;
      if (labels?.['dev.dkb.stack.storage'] !== storage.id || labels['dev.dkb.stack.role'] !== role) {
        throw new DkbError(`Volume ${volume} does not belong to this Stack storage intent. It was not adopted or removed.`, 'stack_storage_collision');
      }
    }
  }
  if (storage.phase !== 'ready') { storage.phase = 'ready'; await save(file, storage); }
  return storage;
}

export async function readStackStorage(name: string): Promise<StackStorage | null> {
  const normalized = stackName(name), file = path.join(stackStateRoot(), normalized, STACK_STORAGE_FILE);
  await assertLocalLibraryStorage(stackStateRoot(), [file]);
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_768) invalid();
    const envelope = JSON.parse(await fs.readFile(file, 'utf8'));
    if (Object.keys(envelope).sort().join(',') !== 'digest,storage' || stableHash(envelope.storage) !== envelope.digest) invalid();
    return validateStackStorage(envelope.storage, normalized);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export function validateStackStorage(value: unknown, name: string): StackStorage {
  const storage = value as StackStorage;
  if (!storage || Object.keys(storage).sort().join(',') !== 'format,id,name,owner,phase,sharedLibrary,volumeEnvironment,volumes'
    || storage.format !== 'dkb.stack-storage.v1' || storage.name !== stackName(name)
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(storage.id)
    || !['ready', 'provisioning'].includes(storage.phase) || typeof storage.sharedLibrary !== 'boolean') invalid();
  validateDockerStackOwner(storage.owner);
  const bindings = storage.volumeEnvironment;
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings) || Object.keys(bindings).length > 64
    || Object.entries(bindings).some(([role, environment]) => !/^[a-z][a-zA-Z0-9]{0,20}$/u.test(role) || typeof environment !== 'string' || !/^DKB_[A-Z_]{1,64}_VOLUME$/u.test(environment))
    || Object.entries(STACK_VOLUME_ENV).some(([role, environment]) => bindings[role] !== environment)
    || new Set(Object.values(bindings)).size !== Object.keys(bindings).length) invalid();
  if (!storage.volumes || Object.keys(storage.volumes).sort().join(',') !== Object.keys(bindings).sort().join(',')
    || Object.values(storage.volumes).some(volume => typeof volume !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/u.test(volume))
    || new Set(Object.values(storage.volumes)).size !== Object.keys(bindings).length
    || storage.owner.libraryVolume !== storage.volumes.library || storage.owner.runtimeVolume !== storage.volumes.runtime
    || storage.owner.compilerVolume !== storage.volumes.compiler) invalid();
  return structuredClone(storage);
}
export function storageEnvironment(storage: StackStorage): Record<string, string> {
  return { DKB_DOCKER_CONTEXT: storage.owner.context, DKB_CLI_IMAGE: storage.owner.image,
    ...Object.fromEntries(Object.entries(storage.volumeEnvironment).map(([role, key]) => [key, storage.volumes[role]!])) };
}
async function save(file: string, storage: StackStorage) { await writeAtomic(file, `${JSON.stringify({ storage, digest: stableHash(storage) })}\n`); }
async function docker(args: string[]): Promise<string> {
  const result = await ownerDockerProcess(args);
  if (result.code !== 0) throw new DkbError('Stack storage preparation failed. Check the local Docker context and installed CLI image. The storage intent and existing data were preserved; retry dkb stack up after resolving Docker health.', 'stack_storage_preparation_failed');
  return result.stdout;
}
function invalid(): never { throw new DkbError('Invalid Stack storage descriptor. Preserve it and the volumes for recovery; no storage was adopted.', 'invalid_stack_storage'); }
function migration(name: string): never { throw new DkbError(`Stack ${name} has existing storage without a verified Linux owner descriptor. Stop its writers and perform an explicit copy-and-verify migration. No source, databases, volumes, credentials or defaults were changed.`, 'stack_migration_required'); }
