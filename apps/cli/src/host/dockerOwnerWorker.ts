import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { DKB_CLI_VERSION } from '../version.js';
import { LIBRARY_OWNER_FORMAT, LIBRARY_OWNER_ROOT, LIBRARY_OWNER_WORKER, planLibraryOwnerCommand } from './libraryOwnerContract.js';
import { STACK_OWNER_FORMAT, STACK_OWNER_WORKER, planStackOwnerRequest, stackOwnerScopeDigest, validateDockerStackOwner, type DockerStackOwner } from '../stack/ownerContract.js';
import { ownerDockerProcess } from './dockerOwnerProcess.js';
import { LIBRARY_INSTALL_FORMAT, LIBRARY_INSTALL_WORKER, validateLibraryInstallRequest } from './libraryInstallContract.js';
import { stackStateRoot } from '../stack/paths.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';

export interface DockerLibraryOwner {
  context: string;
  volume: string;
  /** Installed immutable image ID. Tags and automatic pulls are not accepted. */
  image: string;
}

export function validateDockerLibraryOwner(value: DockerLibraryOwner): DockerLibraryOwner {
  if (!value || Object.keys(value).some(key => !['context', 'volume', 'image'].includes(key))
    || typeof value.context !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(value.context)
    || typeof value.volume !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/u.test(value.volume)
    || typeof value.image !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.image)) {
    throw new DkbError('Docker Library ownership requires a named context, an existing volume, and an installed immutable CLI image ID.', 'invalid_library_owner');
  }
  return { context: value.context, volume: value.volume, image: value.image };
}

export function assertLocalOwnerVolume(value: unknown, name: string): void {
  const volume = value as { Name?: unknown; Driver?: unknown; Scope?: unknown; Options?: unknown; Mountpoint?: unknown } | null;
  if (!volume || volume.Name !== name || volume.Driver !== 'local' || volume.Scope !== 'local'
    || (volume.Options !== null && (typeof volume.Options !== 'object' || Array.isArray(volume.Options) || Object.keys(volume.Options as object).length !== 0))
    || typeof volume.Mountpoint !== 'string' || !volume.Mountpoint.startsWith('/')) {
    throw new DkbError('Library volume must use Linux-local Docker storage without bind, NFS, CIFS, or other driver options. No volume was created or migrated.', 'unsupported_library_owner_volume');
  }
}

/** Fixed private worker profiles only: no caller-selected executable, mount path, environment or network. */
export async function runDockerOwnerWorker(kind: 'library' | 'stack' | 'install' | 'snapshot', owner: DockerLibraryOwner | DockerStackOwner, request: unknown, options: {
  signal?: AbortSignal;
  onOutput?: (channel: 'stdout' | 'stderr', bytes: Buffer) => void;
  stdout?: Writable;
} = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  if (!['library', 'stack', 'install', 'snapshot'].includes(kind) || (kind === 'snapshot') !== Boolean(options.stdout)) {
    throw new DkbError('Unknown private worker profile or invalid binary output selection.', 'invalid_library_owner_request');
  }
  const profile = kind === 'library' ? libraryProfile(owner, request) : kind === 'install' ? installProfile(owner, request)
    : kind === 'snapshot' ? await snapshotProfile(owner, request) : stackProfile(owner, request);
  const { target, plan } = profile;
  const prefix = ['--context', target.context];
  const inspect = async (args: string[]) => {
    const result = await ownerDockerProcess([...prefix, ...args], { signal: options.signal });
    if (result.code !== 0) throw new DkbError('Docker owner preflight failed. Verify the context, existing Library volume, and matching CLI image; no resources were created.', 'library_owner_preflight_failed');
    try { return JSON.parse(result.stdout); } catch { throw new DkbError('Docker returned invalid owner metadata.', 'library_owner_preflight_failed'); }
  };
  await assertLocalOwnerImage(target, profile.protocolLabel, profile.format, options.signal);
  for (const mount of profile.mounts) {
    const volumes = await inspect(['volume', 'inspect', mount.volume]);
    assertLocalOwnerVolume(volumes?.[0], mount.volume);
    if (mount.labels && Object.entries(mount.labels).some(([key, value]) => volumes?.[0]?.Labels?.[key] !== value)) {
      throw new DkbError('Snapshot volume no longer belongs to its recorded Stack. No worker was created.', 'stack_storage_collision');
    }
  }
  options.signal?.throwIfAborted();
  const id = randomUUID(), name = `dkb-${kind}-owner-${id}`;
  let result: Awaited<ReturnType<typeof ownerDockerProcess>> | undefined;
  let failure: unknown;
  let creationAcknowledged = false;
  try {
    // Finish creation before observing cancellation. Cancelling `docker run`
    // during creation can leave a daemon-side request racing with cleanup.
    const created = await ownerDockerProcess([...prefix,
      'create', '--rm', '--pull', 'never', '--name', name, '--label', `dev.dkb.owner.operation=${id}`,
      '--interactive', '--init', '--network', kind === 'install' ? 'bridge' : 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '512m',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
      ...(kind === 'snapshot' ? ['--tmpfs', '/snapshot:rw,nosuid,nodev,size=64m', '--cap-add', 'DAC_OVERRIDE',
        '--mount', `type=bind,src=${profile.hostRoot!},dst=/snapshot/host,readonly`] : []),
      ...(kind === 'install' ? [
        ...(process.platform === 'linux' ? ['--add-host', 'host.docker.internal:host-gateway'] : []),
        '--mount', 'type=volume,dst=/scratch,volume-driver=local,volume-nocopy'] : []),
      ...profile.mounts.flatMap(mount => ['--mount', `type=volume,src=${mount.volume},dst=${mount.path},volume-nocopy${mount.readOnly ? ',readonly' : ''}`]),
      '--workdir', profile.workdir, '--entrypoint', 'node', target.image, profile.worker,
    ]);
    if (created.code !== 0 || !/^[a-f0-9]{64}$/u.test(created.stdout.trim())) {
      throw new DkbError('Library owner container could not be created. Verify Docker capacity and the CLI image; Library data was retained.', 'library_owner_create_failed');
    }
    creationAcknowledged = true;
    if (kind === 'install') {
      const containers = await inspect(['container', 'inspect', name]);
      const scratch = containers?.[0]?.Mounts?.find((mount: { Destination?: unknown }) => mount.Destination === '/scratch');
      if (scratch?.Type !== 'volume' || typeof scratch.Name !== 'string' || !/^[a-f0-9]{64}$/u.test(scratch.Name)) {
        throw new DkbError('Download scratch storage is not a disposable Linux volume; no worker was started.', 'library_owner_preflight_failed');
      }
      const volumes = await inspect(['volume', 'inspect', scratch.Name]);
      assertLocalOwnerVolume(volumes?.[0], scratch.Name);
    }
    result = await ownerDockerProcess([...prefix, 'start', '--attach', '--interactive', name],
      { input: JSON.stringify(plan.request), timeoutMs: plan.timeoutMs + 15_000, ...options, maxStdoutBytes: profile.maxStdoutBytes });
  } catch (error) { failure = error; }
  // Killing the Docker client does not stop its container. Always check ownership
  // and finish cleanup before returning; never delete the Library volume.
  const state = await ownerDockerProcess([...prefix, 'container', 'ls', '--all', '--filter', `label=dev.dkb.owner.operation=${id}`, '--format', '{{.ID}}']);
  if (state.code !== 0) throw new DkbError(`Could not verify owner cleanup. Inspect the labelled operation container ${name}; Library data was retained.`, 'library_owner_cleanup_failed');
  const ids = state.stdout.trim().split(/\s+/u).filter(Boolean);
  if (ids.some(item => !/^[a-f0-9]{12,64}$/u.test(item))) throw new DkbError('Invalid Docker cleanup identity; no container was removed.', 'library_owner_cleanup_failed');
  for (const container of ids) {
    const removed = await ownerDockerProcess([...prefix, 'container', 'rm', '--force', ...(kind === 'install' ? ['--volumes'] : []), container]);
    if (removed.code !== 0) {
      // Auto-removal may finish between listing and explicit removal. Accept
      // that race only after Docker confirms this operation has no containers.
      const observe = async (args: string[]) => {
        try {
          return await ownerDockerProcess([...prefix, ...args]);
        } catch (error) {
          return { code: null, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
        }
      };
      const remaining = await observe(['container', 'ls', '--all', '--filter', `label=dev.dkb.owner.operation=${id}`, '--format', '{{.ID}}']);
      if (remaining.code === 0 && remaining.stdout.trim() === '') break;
      const bounded = (observation: Awaited<ReturnType<typeof observe>>) => ({
        code: observation.code, stdout: observation.stdout.slice(0, 2048), stderr: observation.stderr.slice(0, 2048),
      });
      const diagnostics = {
        context: target.context, operation: id, container,
        removal: { code: removed.code, stderr: removed.stderr.slice(0, 2048) },
        remaining: bounded(remaining),
        state: bounded(await observe(['container', 'inspect', '--format', '{{json .State}}', container])),
      };
      throw new DkbError(`Owner container ${name} still needs cleanup. Library data was retained. `
        + `Docker cleanup diagnostics: ${JSON.stringify(diagnostics)}`, 'library_owner_cleanup_failed');
    }
  }
  if (!creationAcknowledged && ids.length === 0) {
    // A timed-out client can finish before the daemon creates the container.
    // A single empty listing is not confirmation that no delayed create remains.
    throw new DkbError(`Docker did not confirm creation or cleanup of ${name}; a delayed creation may still finish. `
      + `Inspect: docker --context ${target.context} container inspect ${name}. `
      + 'Preserve the Library volume and any Stack recovery record until this operation is settled. No worker was started by this caller.',
    'library_owner_cleanup_unconfirmed');
  }
  if (failure) throw failure;
  return result!;
}


interface OwnerProfile {
  target: { context: string; image: string };
  plan: { request: unknown; timeoutMs: number };
  format: string;
  protocolLabel: string;
  worker: string;
  workdir: string;
  mounts: Array<{ volume: string; path: string; readOnly?: boolean; labels?: Record<string, string> }>;
  hostRoot?: string;
  maxStdoutBytes?: number;
}
async function snapshotProfile(owner: DockerLibraryOwner | DockerStackOwner, request: unknown): Promise<OwnerProfile> {
  // Snapshot validation reaches Stack/Library storage modules. Load it only for
  // this operation, after CLI bootstrap (not during help/JSON initialization).
  const { STACK_SNAPSHOT_FORMAT, STACK_SNAPSHOT_WORKER, validateSnapshotRequest } = await import('../stack/snapshotContract.js');
  const target = validateDockerStackOwner(owner), plan = validateSnapshotRequest(request);
  if (plan.command !== 'snapshot' || stableHash(plan.storage.owner) !== stableHash(target)) {
    throw new DkbError('Snapshot request differs from the recorded storage owner.', 'stack_owner_scope_mismatch');
  }
  // Unlike databases, host configuration is read-only input. Its path is derived
  // from the trusted Stack root; requests cannot supply a bind mount or command.
  const hostRoot = path.join(stackStateRoot(), plan.storage.name);
  const stat = await fs.lstat(hostRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || /[,\x00-\x1f]/u.test(hostRoot)
    || path.resolve(await fs.realpath(hostRoot)) !== path.resolve(hostRoot)) {
    throw new DkbError('Stack configuration must be a real, unlinked directory for backup.', 'stack_snapshot_invalid');
  }
  return { target, plan: { request: plan, timeoutMs: 60 * 60_000 }, format: STACK_SNAPSHOT_FORMAT,
    protocolLabel: 'dev.dkb.stack-snapshot.protocol', worker: STACK_SNAPSHOT_WORKER, workdir: '/snapshot',
    hostRoot, maxStdoutBytes: plan.limits.maxArchiveBytes,
    mounts: Object.entries(plan.storage.volumes).map(([role, volume]) => ({ volume, path: `/snapshot/volumes/${role}`,
      ...(role === 'library' && plan.storage.sharedLibrary ? {} : { labels: {
        'dev.dkb.stack.storage': plan.storage.id, 'dev.dkb.stack.role': role,
      } }),
    })) };
}
function libraryProfile(owner: DockerLibraryOwner | DockerStackOwner, request: unknown): OwnerProfile {
  const target = validateDockerLibraryOwner(owner as DockerLibraryOwner);
  return { target, plan: planLibraryOwnerCommand(request), format: LIBRARY_OWNER_FORMAT,
    protocolLabel: 'dev.dkb.library-owner.protocol', worker: LIBRARY_OWNER_WORKER, workdir: LIBRARY_OWNER_ROOT,
    mounts: [{ volume: target.volume, path: LIBRARY_OWNER_ROOT }] };
}
function installProfile(owner: DockerLibraryOwner | DockerStackOwner, request: unknown): OwnerProfile {
  const target = validateDockerLibraryOwner(owner as DockerLibraryOwner);
  const validated = validateLibraryInstallRequest(request);
  return { target, plan: { request: validated, timeoutMs: 5 * 60_000 },
    format: validated.format, protocolLabel: validated.format === LIBRARY_INSTALL_FORMAT ? 'dev.dkb.library-install.protocol' : 'dev.dkb.library-collection-install.protocol',
    worker: LIBRARY_INSTALL_WORKER, workdir: LIBRARY_OWNER_ROOT,
    mounts: [{ volume: target.volume, path: LIBRARY_OWNER_ROOT }] };
}
function stackProfile(owner: DockerLibraryOwner | DockerStackOwner, request: unknown): OwnerProfile {
  const target = validateDockerStackOwner(owner);
  const planned = planStackOwnerRequest(request);
  if (planned.command !== 'inspect' && planned.input.scopeDigest !== stackOwnerScopeDigest(target)) {
    throw new DkbError('Stack request does not match its storage binding.', 'stack_owner_scope_mismatch');
  }
  return { target, plan: { request: planned, timeoutMs: 120_000 }, format: STACK_OWNER_FORMAT,
    protocolLabel: 'dev.dkb.stack-owner.protocol', worker: STACK_OWNER_WORKER, workdir: '/state',
    mounts: [{ volume: target.libraryVolume, path: '/library' }, { volume: target.runtimeVolume, path: '/state' },
      { volume: target.compilerVolume, path: '/context', readOnly: planned.command === 'inspect' }] };
}

/** Shared preflight for provisioning and disposable workers; never pulls an image. */
export async function assertLocalOwnerImage(target: {context: string; image: string}, protocolLabel: string, format: string, signal?: AbortSignal): Promise<void> {
  const inspect = async (args: string[]) => {
    const result = await ownerDockerProcess(['--context', target.context, ...args], { signal });
    if (result.code !== 0) throw new DkbError('Docker owner preflight failed. Verify the local context and installed CLI image.', 'library_owner_preflight_failed');
    try { return JSON.parse(result.stdout); } catch { throw new DkbError('Invalid Docker owner metadata.', 'library_owner_preflight_failed'); }
  };
  const contexts = await inspect(['context', 'inspect', target.context]);
  const endpoint = contexts?.[0]?.Endpoints?.docker?.Host;
  if (typeof endpoint !== 'string' || !/^(?:unix:\/\/\/[^\0\r\n]+|npipe:\/{4}\.\/pipe\/[^/\\\s]+)$/u.test(endpoint)) {
    throw new DkbError('Library owner management requires a local Docker socket context, not a remote Docker daemon.', 'unsupported_library_owner_context');
  }
  const images = await inspect(['image', 'inspect', target.image]);
  const image = images?.[0];
  if (image?.Id !== target.image || image?.Os !== 'linux' || image?.Config?.Labels?.[protocolLabel] !== format
    || image?.Config?.Labels?.['org.opencontainers.image.version'] !== DKB_CLI_VERSION) {
    throw new DkbError('Library owner image does not match this CLI version and owner protocol. Build or install the matching DKB CLI image.', 'library_owner_image_mismatch');
  }
}
