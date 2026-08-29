import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { readEnvironmentFileSync } from './context.js';
import type { DkbStackContext, DkbStackStatus } from './types.js';

export function assertDockerAvailable(): void {
  const result = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new DkbError('Docker Compose is unavailable. Start Docker Desktop, then retry: dkb stack up');
  }
}

export async function assertPortAvailable(port: number, label: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new DkbError(`${label} port ${port} is already in use. Stop the conflicting service or choose another stack port in stack.env.`)));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve()));
  });
}

export function assertRequiredImages(context: DkbStackContext): void {
  const values = readEnvironmentFileSync(context.envFile);
  for (const service of context.requiredServices) {
    if (!service.stack) continue;
    const image = values[service.stack.imageEnvironment] ?? service.image;
    if (!image) throw new DkbError(`Stack service ${service.id} does not declare an image.`);
    let result = spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8' });
    if (result.status !== 0 && !service.stack.build && !service.stack.recovery) {
      result = spawnSync('docker', ['pull', image], { encoding: 'utf8' });
    }
    if (result.status !== 0) {
      const recovery = service.stack.recovery
        ?? (service.stack.build
          ? `Run: docker build -f ${service.stack.build.dockerfile} -t ${image} ${service.stack.build.context}.`
          : `Run: docker pull ${image}.`);
      throw new DkbError(
        `Required stack image ${image} for ${service.id} is unavailable. ${recovery} Then retry: dkb stack up ${context.name}`,
      );
    }
  }
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
): { stdout: string; stderr: string } {
  const result = spawnSync('docker', composeArguments(context, args), {
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

export function composeArguments(context: DkbStackContext, args: string[]): string[] {
  const profiles = args.includes('down') ? context.allProfiles : context.profiles;
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
