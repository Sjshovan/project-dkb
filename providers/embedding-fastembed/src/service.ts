import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { resolveDockerImageIdentity } from '@sjshovan/dkb-pipeline/serviceIdentity.js';
import { fastEmbedModelPin } from './model.js';

const execFile = promisify(execFileCallback);

export const FASTEMBED_PROVIDER_IMAGE = 'dkb-embedding-fastembed:0.1.0';
export const FASTEMBED_PROVIDER_SERVICE_VERSION = '1';
export const FASTEMBED_PROVIDER_SERVICE_PORT = 8090;
export const DEFAULT_FASTEMBED_MODEL = 'BAAI/bge-small-en-v1.5';

const starts = new Map<string, Promise<FastEmbedServiceStatus>>();

export interface FastEmbedServiceStatus {
  docker: boolean;
  image: string;
  imageId?: string;
  model: string;
  modelRepository: string;
  modelRevision: string;
  container: string;
  running: boolean;
  ready: boolean;
  url?: string;
  drift: string[];
  health?: unknown;
}

export async function ensureFastEmbedService(options: {
  image?: string;
  imageDigest?: string;
  model?: string;
  modelRepository?: string;
  modelRevision?: string;
  restart?: boolean;
} = {}): Promise<FastEmbedServiceStatus> {
  const image = options.image ?? process.env.DKB_FASTEMBED_IMAGE ?? FASTEMBED_PROVIDER_IMAGE;
  const model = options.model ?? DEFAULT_FASTEMBED_MODEL;
  const pin = fastEmbedModelPin(model, options);
  const key = fastEmbedContainerName({ image, imageDigest: options.imageDigest, model, modelRepository: pin.repository, modelRevision: pin.revision });
  const existing = starts.get(key);

  if (existing && !options.restart) {
    return existing;
  }

  const starting = startFastEmbedService({ image, imageDigest: options.imageDigest, model, modelRepository: pin.repository, modelRevision: pin.revision, restart: options.restart });
  starts.set(key, starting);

  try {
    return await starting;
  } finally {
    if (starts.get(key) === starting) {
      starts.delete(key);
    }
  }
}

export async function fastEmbedServiceStatus(options: {
  image?: string;
  imageDigest?: string;
  model?: string;
  modelRepository?: string;
  modelRevision?: string;
} = {}): Promise<FastEmbedServiceStatus> {
  const image = options.image ?? process.env.DKB_FASTEMBED_IMAGE ?? FASTEMBED_PROVIDER_IMAGE;
  const model = options.model ?? DEFAULT_FASTEMBED_MODEL;
  const pin = fastEmbedModelPin(model, options);
  const identity = { model, modelRepository: pin.repository, modelRevision: pin.revision };
  const container = fastEmbedContainerName({ ...identity, image, imageDigest: options.imageDigest });

  try {
    await execFile('docker', ['--version'], { timeout: 30_000 });
  } catch {
    return { docker: false, image, ...identity, container, running: false, ready: false, drift: ['docker_unavailable'] };
  }

  const inspected = await inspectContainer(container).catch(() => null);
  const running = inspected?.State?.Running === true;
  const drift: string[] = [];
  const imageId = await resolveDockerImageIdentity(image, options.imageDigest).catch(() => {
    drift.push('image_identity_unverified');
    return undefined;
  });

  if (inspected) {
    if (!imageId || inspected.Image !== imageId) drift.push('image_mismatch');
    if (inspected.Config?.Labels?.['org.dkb.embedding.service.version'] !== FASTEMBED_PROVIDER_SERVICE_VERSION) drift.push('service_version_mismatch');
    if (inspected.Config?.Labels?.['org.dkb.embedding.model'] !== model) drift.push('model_mismatch');
    if (inspected.Config?.Labels?.['org.dkb.embedding.model-repository'] !== pin.repository) drift.push('model_repository_mismatch');
    if (inspected.Config?.Labels?.['org.dkb.embedding.model-revision'] !== pin.revision) drift.push('model_revision_mismatch');
  }

  const port = running ? await hostPort(container).catch(() => undefined) : undefined;
  const url = port ? `http://127.0.0.1:${port}` : undefined;
  let health: unknown;
  let ready = false;

  if (url) {
    health = await readHealth(url).catch((error) => ({ ok: false, error: errorMessage(error) }));
    ready = isReady(health, identity);
    if (!ready) drift.push('service_unhealthy');
  }

  return {
    docker: true,
    image,
    ...(imageId ? { imageId } : {}),
    ...identity,
    container,
    running,
    ready,
    ...(url ? { url } : {}),
    drift: [...new Set(drift)],
    ...(health !== undefined ? { health } : {}),
  };
}

export async function stopFastEmbedService(options: { image?: string; imageDigest?: string; model?: string; modelRepository?: string; modelRevision?: string } = {}): Promise<FastEmbedServiceStatus> {
  const image = options.image ?? process.env.DKB_FASTEMBED_IMAGE ?? FASTEMBED_PROVIDER_IMAGE;
  const model = options.model ?? DEFAULT_FASTEMBED_MODEL;
  const pin = fastEmbedModelPin(model, options);
  const identity = { model, modelRepository: pin.repository, modelRevision: pin.revision };
  const container = fastEmbedContainerName({ ...identity, image, imageDigest: options.imageDigest });

  try {
    await execFile('docker', ['rm', '-f', container], { timeout: 30_000 });
  } catch (error) {
    if (!/No such container/i.test(errorMessage(error))) throw error;
  }

  return fastEmbedServiceStatus({ ...identity, image, imageDigest: options.imageDigest });
}

export async function doctorFastEmbedService(options: { image?: string; imageDigest?: string; model?: string; modelRepository?: string; modelRevision?: string } = {}): Promise<{
  ok: boolean;
  status: FastEmbedServiceStatus;
  recovery?: string;
}> {
  const status = await fastEmbedServiceStatus(options);

  return status.ready && status.drift.length === 0
    ? { ok: true, status }
    : {
        ok: false,
        status,
        recovery: status.docker
          ? 'Run dkb compiler start, or start the selected embedding provider through dkb pipeline verify.'
          : 'Start Docker Desktop, then retry the command.',
      };
}

export function fastEmbedEndpoint(status: FastEmbedServiceStatus): string {
  if (!status.ready || status.drift.length > 0 || !status.url) {
    throw new DkbError(`FastEmbed provider service ${status.container} is not ready`);
  }

  return `${status.url}/embed`;
}

async function startFastEmbedService(options: { image: string; imageDigest?: string; model: string; modelRepository: string; modelRevision: string; restart?: boolean }): Promise<FastEmbedServiceStatus> {
  await ensureImage(options.image);
  const imageId = await resolveDockerImageIdentity(options.image, options.imageDigest);
  const current = await fastEmbedServiceStatus(options);

  if (current.ready && current.drift.length === 0 && !options.restart) {
    return current;
  }
  // Docker retains stopped containers and their names. Always remove a
  // non-ready instance before creating its deterministic replacement.
  await stopFastEmbedService(options);

  const container = fastEmbedContainerName(options);
  try {
    await execFile('docker', [
      'run', '-d',
      '--name', container,
      '--label', `org.dkb.embedding.service.version=${FASTEMBED_PROVIDER_SERVICE_VERSION}`,
      '--label', `org.dkb.embedding.model=${options.model}`,
      '--label', `org.dkb.embedding.model-repository=${options.modelRepository}`,
      '--label', `org.dkb.embedding.model-revision=${options.modelRevision}`,
      '--label', 'org.dkb.component=fastembed-provider-service',
      '-p', `127.0.0.1::${FASTEMBED_PROVIDER_SERVICE_PORT}`,
      '--mount', 'type=volume,src=dkb-fastembed-cache,dst=/cache/fastembed',
      '-e', `DKB_FASTEMBED_MODEL=${options.model}`,
      '-e', `DKB_FASTEMBED_MODEL_REPOSITORY=${options.modelRepository}`,
      '-e', `DKB_FASTEMBED_MODEL_REVISION=${options.modelRevision}`,
      imageId,
      'python', '-m', 'uvicorn', 'embedder:app', '--host', '0.0.0.0', '--port', String(FASTEMBED_PROVIDER_SERVICE_PORT),
    ], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    throw new DkbError(`Unable to start FastEmbed provider service: ${errorMessage(error)}`);
  }

  const deadline = Date.now() + 120_000;
  let status = await fastEmbedServiceStatus(options);
  while (!status.ready && Date.now() < deadline) {
    await delay(500);
    status = await fastEmbedServiceStatus(options);
  }
  if (!status.ready || status.drift.length > 0) {
    throw new DkbError(`FastEmbed provider service ${container} did not become ready: ${status.drift.join(', ') || 'health check failed'}`);
  }

  return status;
}

async function ensureImage(image: string): Promise<void> {
  try {
    await execFile('docker', ['image', 'inspect', image], { timeout: 30_000 });
    return;
  } catch {
    // Build the bundled provider image below.
  }

  const context = providerContextPath();
  if (!existsSync(path.join(context, 'Dockerfile'))) {
    throw new DkbError(`FastEmbed provider image ${image} is missing and its build context was not found at ${context}`);
  }
  try {
    await execFile('docker', ['build', '--pull', '--tag', image, context], {
      timeout: 20 * 60_000,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    throw new DkbError(`Unable to build FastEmbed provider image: ${errorMessage(error)}`);
  }
}

async function inspectContainer(container: string): Promise<{
  Image?: string;
  State?: { Running?: boolean };
  Config?: { Image?: string; Labels?: Record<string, string> };
}> {
  const { stdout } = await execFile('docker', ['inspect', container], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed) || !parsed[0] || typeof parsed[0] !== 'object') throw new DkbError(`Invalid Docker inspection for ${container}`);
  return parsed[0] as { Image?: string; State?: { Running?: boolean }; Config?: { Image?: string; Labels?: Record<string, string> } };
}

async function hostPort(container: string): Promise<number | undefined> {
  const { stdout } = await execFile('docker', ['port', container, String(FASTEMBED_PROVIDER_SERVICE_PORT)], { timeout: 30_000 });
  const match = /127\.0\.0\.1:(\d+)/.exec(stdout) ?? /0\.0\.0\.0:(\d+)/.exec(stdout);
  return match ? Number.parseInt(match[1]!, 10) : undefined;
}

async function readHealth(url: string): Promise<unknown> {
  const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5_000) });
  const body = await response.json() as unknown;
  if (!response.ok) throw new DkbError(`FastEmbed health failed (${response.status})`);
  return body;
}

function isReady(value: unknown, identity: { model: string; modelRepository: string; modelRevision: string }): boolean {
  return Boolean(value)
    && typeof value === 'object'
    && (value as { ok?: unknown }).ok === true
    && (value as { model?: unknown }).model === identity.model
    && (value as { modelRepository?: unknown }).modelRepository === identity.modelRepository
    && (value as { modelRevision?: unknown }).modelRevision === identity.modelRevision;
}

function fastEmbedContainerName(identity: { image: string; imageDigest?: string; model: string; modelRepository: string; modelRevision: string }): string {
  const key = createHash('sha256').update(`${identity.imageDigest ?? identity.image}\0${identity.model}\0${identity.modelRepository}\0${identity.modelRevision}`).digest('hex').slice(0, 12);
  return `dkb-fastembed-${key}`;
}

function providerContextPath(): string {
  const candidates = [
    path.resolve(process.cwd(), 'providers/embedding-fastembed/python'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../python'),
  ];
  return candidates.find((candidate) => existsSync(path.join(candidate, 'Dockerfile'))) ?? candidates[0]!;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error) {
    return `${String((error as { stdout?: unknown }).stdout ?? '')}${String((error as { stderr?: unknown }).stderr ?? '')}`.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
