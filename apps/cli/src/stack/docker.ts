import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { isSha256Digest } from '@sjshovan/dkb-pipeline/validation.js';
import { readEnvironmentFileSync } from './context.js';
import type { DkbStackContext, DkbStackControlContext, DkbStackStatus } from './types.js';

export function assertDockerAvailable(): void {
  const engine = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  });
  if (engine.error || engine.status !== 0 || !String(engine.stdout ?? '').trim()) {
    const reason = engine.error?.message.includes('ETIMEDOUT')
      ? 'Docker did not respond within 5 seconds.'
      : 'The Docker engine is not available.';
    throw new DkbError(`${reason} Start or restart Docker Desktop, then retry: dkb stack up`);
  }

  const compose = spawnSync('docker', ['compose', 'version'], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  });
  if (compose.error || compose.status !== 0) {
    throw new DkbError('Docker Compose is unavailable. Install or enable Docker Compose, then retry: dkb stack up');
  }
}

export async function assertPortAvailable(port: number, label: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new DkbError(`${label} port ${port} is already in use. Stop the conflicting service or choose another stack port in stack.env.`)));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve()));
  });
}

export function assertRequiredImages(context: DkbStackContext): Record<string, string> {
  const values = readEnvironmentFileSync(context.envFile);
  const digests: Record<string, string> = {};
  for (const service of context.requiredServices) {
    if (!service.stack) continue;
    const image = values[service.stack.imageEnvironment] ?? service.image;
    if (!image) throw new DkbError(`Stack service ${service.id} does not declare an image.`);
    let result = inspectImage(image);
    if (result.status !== 0 && !service.stack.build && !service.stack.recovery) {
      result = spawnSync('docker', ['pull', image], { encoding: 'utf8' });
      if (result.status === 0) result = inspectImage(image);
    }
    if (result.status !== 0) {
      const recovery = imageRecovery(service, image, values.DKB_BUILD_COMMIT);
      throw new DkbError(
        `Required stack image ${image} for ${service.id} is unavailable. ${recovery} Then retry: dkb stack up ${context.name}`,
      );
    }

    if (service.stack.build) {
      const labels = parseImageLabels(String(result.stdout ?? ''));
      const issue = localImageMetadataIssue(labels, service.version, values.DKB_BUILD_COMMIT);
      if (issue) {
        throw new DkbError(
          `Required stack image ${image} for ${service.id} is stale: ${issue}. `
          + `${imageRecovery(service, image, values.DKB_BUILD_COMMIT)} Then retry: dkb stack up ${context.name}`,
        );
      }
    }
    if (service.providerExternalIdentities?.some((identity) => identity.kind === 'image')) {
      const digest = resolveImmutableImageDigest(image);
      if (!digest) {
        throw new DkbError(
          `Required stack image ${image} for ${service.id} is present but its immutable OCI digest could not be resolved. `
          + `Pin the image as ${image.split('@')[0]}@sha256:<digest> or rebuild it, then retry: dkb stack up ${context.name}`,
        );
      }
      digests[service.id] = digest;
    }
  }
  return digests;
}

export function immutableDigestFromImageReference(image: string): string | null {
  const separator = image.lastIndexOf('@');
  if (separator < 0) return null;
  const digest = image.slice(separator + 1);
  return isSha256Digest(digest) ? digest : null;
}

export function resolveImmutableImageDigest(image: string): string | null {
  return immutableDigestFromImageReference(image) ?? inspectedImageId(image);
}

export function localImageMetadataIssue(
  labels: Record<string, string>,
  expectedVersion?: string,
  expectedRevision?: string,
): string | null {
  const actualVersion = labels['org.opencontainers.image.version'];
  if (expectedVersion && actualVersion !== expectedVersion) {
    return `OCI version is ${actualVersion ?? 'missing'}; expected ${expectedVersion}`;
  }
  const revision = normalizedExpectedRevision(expectedRevision);
  if (revision && labels['org.opencontainers.image.revision'] !== revision) {
    return `OCI revision is ${labels['org.opencontainers.image.revision'] ?? 'missing'}; expected ${revision}`;
  }
  return null;
}

export async function migrateLegacyRegistryVolume(
  context: DkbStackContext,
): Promise<{ status: 'copied'; volume: string; preserved: true } | null> {
  const destination = path.join(context.root, 'registry', 'data');
  const marker = path.join(destination, '.legacy-volume-migrated');
  if (await exists(marker) || await exists(path.join(destination, 'registry.sqlite'))) return null;

  const volume = `${context.projectName}_dkb-registry-data`;
  const inspected = spawnSync('docker', ['volume', 'inspect', volume], { encoding: 'utf8' });
  if (inspected.status !== 0) return null;

  const values = readEnvironmentFileSync(context.envFile);
  const registry = context.requiredServices.find((service) => service.id === 'registry');
  const image = registry?.stack ? values[registry.stack.imageEnvironment] ?? registry.image : undefined;
  if (!image) throw new DkbError('The active distribution does not define the Registry image needed for state migration.');
  const copied = spawnSync('docker', [
    'run', '--rm',
    '--mount', `type=volume,src=${volume},dst=/from,readonly`,
    '--mount', `type=bind,src=${destination.replace(/\\/gu, '/')},dst=/to`,
    image,
    'sh', '-c', 'cp -a /from/. /to/',
  ], { encoding: 'utf8' });

  if (copied.error || copied.status !== 0) {
    const detail = String(copied.stderr || copied.stdout || copied.error?.message || '').trim();
    throw new DkbError(`Unable to migrate legacy Registry volume ${volume}${detail ? `: ${detail}` : ''}. The volume was left unchanged.`);
  }
  await fs.writeFile(marker, `${new Date().toISOString()}\n`, 'utf8');
  return { status: 'copied', volume, preserved: true };
}

export async function probeStack(context: DkbStackContext): Promise<Array<{ component: string; status: 'ok' | 'failed'; message: string }>> {
  return Promise.all(context.requiredServices.flatMap((service) => {
    const health = service.stack?.health;
    const port = context.servicePorts[service.id];
    if (!health || port === undefined) return [];
    return [probe(health.component, `http://127.0.0.1:${port}${health.path}`, health.expectation)];
  }));
}

export function composeServices(context: DkbStackContext): DkbStackStatus['services'] {
  const result = runCompose(context, ['ps', '--all', '--format', 'json'], false, true);
  const text = result.stdout.trim();
  if (!text) return [];
  const records = parseComposeJson(text);
  return records.map((record) => {
    const name = stringValue(record.Service) || stringValue(record.Name) || 'unknown';
    const state = stringValue(record.State) || stringValue(record.Status) || 'unknown';
    const completed = state === 'exited' && Number(record.ExitCode) === 0;
    return {
      name,
      status: completed ? 'completed' : state,
      health: completed ? 'n/a' : stringValue(record.Health) || 'unknown',
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

export async function composeContainerIds(context: DkbStackContext): Promise<string[]> {
  const result = runCompose(context, ['ps', '-q'], false, true);
  return result.stdout.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
}

export function runCompose(
  context: DkbStackContext,
  args: string[],
  inherit = false,
  allowFailure = false,
  profileScope: 'active' | 'all' = 'active',
): { stdout: string; stderr: string } {
  return executeCompose(context, args, inherit, allowFailure, profileScope);
}

export function runComposeControl(context: DkbStackControlContext, args: ['down' | 'logs', ...string[]], inherit = false): { stdout: string; stderr: string } {
  return executeCompose(context, args, inherit, false, 'all');
}

function executeCompose(
  context: DkbStackContext | DkbStackControlContext,
  args: string[],
  inherit: boolean,
  allowFailure: boolean,
  profileScope: 'active' | 'all',
): { stdout: string; stderr: string } {
  const result = spawnSync('docker', composeArguments(context, args, profileScope), {
    cwd: path.dirname(context.composeFile),
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
  });
  if (result.error) throw new DkbError(`Unable to run Docker Compose: ${result.error.message}`);
  if (!allowFailure && result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new DkbError(`Docker Compose failed for stack ${context.name}${detail ? `: ${detail}` : ''}. Run: dkb stack logs ${context.name}`);
  }
  return { stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

export function composeArguments(
  context: DkbStackContext | DkbStackControlContext,
  args: string[],
  profileScope: 'active' | 'all' = 'active',
): string[] {
  if (!('profiles' in context) && !['down', 'logs'].includes(args[0] ?? '')) {
    throw new DkbError('Stack control topology is only valid for stopping services or reading logs; startup requires validated recipe resolution.');
  }
  const profiles = args.includes('down') || profileScope === 'all' || !('profiles' in context) ? context.allProfiles : context.profiles;
  return [
    'compose',
    '--env-file', context.envFile,
    '-p', context.projectName,
    '-f', context.composeFile,
    ...profiles.flatMap((profile) => ['--profile', profile]),
    ...args,
  ];
}

async function probe(
  component: string,
  url: string,
  expectation: 'http-ok' | 'json-ok' | 'status-available',
): Promise<{ component: string; status: 'ok' | 'failed'; message: string }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { component, status: 'failed', message: `HTTP ${response.status} from ${url}` };
    if (expectation === 'http-ok') return { component, status: 'ok', message: url };
    const text = await response.text();
    const body = text ? JSON.parse(text) as Record<string, unknown> : {};
    const healthy = expectation === 'json-ok' ? body.ok === true : body.status === 'available';
    const expected = expectation === 'json-ok' ? 'ok=true' : 'status=available';
    return healthy
      ? { component, status: 'ok', message: url }
      : { component, status: 'failed', message: `Health response did not report ${expected} at ${url}` };
  } catch (error) {
    return { component, status: 'failed', message: `${url}: ${errorMessage(error)}` };
  }
}

function parseComposeJson(value: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isRecord) : isRecord(parsed) ? [parsed] : [];
  } catch {
    return value.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inspectImage(image: string): ReturnType<typeof spawnSync> {
  return spawnSync('docker', ['image', 'inspect', image, '--format', '{{json .Config.Labels}}'], { encoding: 'utf8' });
}

function inspectedImageId(image: string): string | null {
  const result = spawnSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  });
  const digest = String(result.stdout ?? '').trim();
  return result.status === 0 && isSha256Digest(digest) ? digest : null;
}

function parseImageLabels(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value.trim()) as unknown;
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

function imageRecovery(
  service: DkbStackContext['requiredServices'][number],
  image: string,
  revision?: string,
): string {
  if (service.stack?.recovery) return service.stack.recovery;
  if (!service.stack?.build) return `Run: docker pull ${image}.`;
  const version = service.version ?? 'development';
  const commit = normalizedExpectedRevision(revision) ?? 'development';
  return `Run: docker build --build-arg DKB_VERSION=${version} --build-arg DKB_COMMIT=${commit} -f ${service.stack.build.dockerfile} -t ${image} ${service.stack.build.context}.`;
}

function normalizedExpectedRevision(value?: string): string | null {
  const revision = value?.trim();
  return revision && revision !== 'development' ? revision : null;
}
