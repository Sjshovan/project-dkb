import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

const execFile = promisify(execFileCallback);

export const FASTEMBED_PROVIDER_IMAGE = 'dkb-embedding-fastembed:0.1.0';
export const FASTEMBED_PROVIDER_SERVICE_VERSION = '1';
export const FASTEMBED_PROVIDER_SERVICE_PORT = 8090;
export const DEFAULT_FASTEMBED_MODEL = 'BAAI/bge-small-en-v1.5';

const starts = new Map<string, Promise<FastEmbedServiceStatus>>();

export interface FastEmbedServiceStatus {
  docker: boolean;
  image: string;
  model: string;
  container: string;
  running: boolean;
  ready: boolean;
  url?: string;
  drift: string[];
  health?: unknown;
}

export async function ensureFastEmbedService(options: {
  image?: string;
  model?: string;
  restart?: boolean;
} = {}): Promise<FastEmbedServiceStatus> {
  const image = options.image ?? process.env.DKB_FASTEMBED_IMAGE ?? FASTEMBED_PROVIDER_IMAGE;
  const model = options.model ?? DEFAULT_FASTEMBED_MODEL;
  const key = `${image}\0${model}`;
  const existing = starts.get(key);

  if (existing && !options.restart) {
    return existing;
  }

  const starting = startFastEmbedService({ image, model, restart: options.restart });
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
  model?: string;
} = {}): Promise<FastEmbedServiceStatus> {
  const image = options.image ?? process.env.DKB_FASTEMBED_IMAGE ?? FASTEMBED_PROVIDER_IMAGE;
  const model = options.model ?? DEFAULT_FASTEMBED_MODEL;
  const container = fastEmbedContainerName(model);

  try {
    await execFile('docker', ['--version'], { timeout: 30_000 });
  } catch {
    return { docker: false, image, model, container, running: false, ready: false, drift: ['docker_unavailable'] };
  }

  const inspected = await inspectContainer(container).catch(() => null);
  const running = inspected?.State?.Running === true;
  const drift: string[] = [];

  if (inspected) {
    if (inspected.Config?.Image !== image) drift.push('image_mismatch');
    if (inspected.Config?.Labels?.['org.dkb.embedding.service.version'] !== FASTEMBED_PROVIDER_SERVICE_VERSION) drift.push('service_version_mismatch');
    if (inspected.Config?.Labels?.['org.dkb.embedding.model'] !== model) drift.push('model_mismatch');
  }

  const port = running ? await hostPort(container).catch(() => undefined) : undefined;
  const url = port ? `http://127.0.0.1:${port}` : undefined;
  let health: unknown;
  let ready = false;

  if (url) {
    health = await readHealth(url).catch((error) => ({ ok: false, error: errorMessage(error) }));
    ready = isReady(health, model);
    if (!ready) drift.push('service_unhealthy');
  }

  return {
    docker: true,
    image,
    model,
    container,
    running,
    ready,
    ...(url ? { url } : {}),
    drift: [...new Set(drift)],
    ...(health !== undefined ? { health } : {}),
  };
}

export async function stopFastEmbedService(options: { model?: string } = {}): Promise<FastEmbedServiceStatus> {
  const model = options.model ?? DEFAULT_FASTEMBED_MODEL;
  const container = fastEmbedContainerName(model);

  try {
    await execFile('docker', ['rm', '-f', container], { timeout: 30_000 });
  } catch (error) {
    if (!/No such container/i.test(errorMessage(error))) throw error;
  }

  return fastEmbedServiceStatus({ model });
}

export async function doctorFastEmbedService(options: { image?: string; model?: string } = {}): Promise<{
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
  if (!status.ready || !status.url) {
    throw new DkbError(`FastEmbed provider service ${status.container} is not ready`);
  }

  return `${status.url}/embed`;
}

async function startFastEmbedService(options: { image: string; model: string; restart?: boolean }): Promise<FastEmbedServiceStatus> {
  await ensureImage(options.image);
  const current = await fastEmbedServiceStatus(options);

  if (current.ready && current.drift.length === 0 && !options.restart) {
    return current;
  }
  // Docker retains stopped containers and their names. Always remove a
  // non-ready instance before creating its deterministic replacement.
  await stopFastEmbedService({ model: options.model });

  const container = fastEmbedContainerName(options.model);
  try {
    await execFile('docker', [
      'run', '-d',
      '--name', container,
      '--label', `org.dkb.embedding.service.version=${FASTEMBED_PROVIDER_SERVICE_VERSION}`,
      '--label', `org.dkb.embedding.model=${options.model}`,
      '--label', 'org.dkb.component=fastembed-provider-service',
      '-p', `127.0.0.1::${FASTEMBED_PROVIDER_SERVICE_PORT}`,
      '--mount', 'type=volume,src=dkb-fastembed-cache,dst=/cache/fastembed',
      '-e', `DKB_FASTEMBED_MODEL=${options.model}`,
      options.image,
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
  State?: { Running?: boolean };
  Config?: { Image?: string; Labels?: Record<string, string> };
}> {
  const { stdout } = await execFile('docker', ['inspect', container], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed) || !parsed[0] || typeof parsed[0] !== 'object') throw new DkbError(`Invalid Docker inspection for ${container}`);
  return parsed[0] as { State?: { Running?: boolean }; Config?: { Image?: string; Labels?: Record<string, string> } };
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

function isReady(value: unknown, model: string): boolean {
  return Boolean(value)
    && typeof value === 'object'
    && (value as { ok?: unknown }).ok === true
    && (value as { model?: unknown }).model === model;
}

function fastEmbedContainerName(model: string): string {
  const key = createHash('sha256').update(model).digest('hex').slice(0, 12);
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
