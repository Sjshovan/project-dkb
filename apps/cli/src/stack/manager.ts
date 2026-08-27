import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DkbError } from '@dkb/protocol/errors.js';
import { readHostInventory, registerHostLibrary, registerHostRegistry, registerHostRuntime } from '../host/inventory.js';

export type DkbStackTarget = 'default' | 'meilisearch';

export interface DkbStackContext {
  name: string;
  projectName: string;
  target: DkbStackTarget;
  root: string;
  composeFile: string;
  envFile: string;
  registryUrl: string;
  runtimeUrl: string;
  registryPort: number;
  runtimePort: number;
  meilisearchPort: number;
}

export interface DkbStackStatus {
  name: string;
  target: DkbStackTarget;
  stateRoot: string;
  composeFile: string;
  registryUrl: string;
  runtimeUrl: string;
  services: Array<{ name: string; status: string; health: string }>;
  checks?: Array<{ component: string; status: 'ok' | 'failed'; message: string }>;
}

export async function upDkbStack(name = 'local', target: DkbStackTarget = 'default'): Promise<DkbStackStatus & {
  status: 'ready';
  registryName: string;
  runtimeName: string;
  libraryName: string;
}> {
  const context = await prepareDkbStack(name, target);
  assertDockerAvailable();
  assertRequiredImages(context);

  if ((await composeContainerIds(context)).length === 0) {
    await assertPortAvailable(context.registryPort, 'Registry');
    await assertPortAvailable(context.runtimePort, 'Runtime');
    if (target === 'meilisearch') await assertPortAvailable(context.meilisearchPort, 'Meilisearch');
  }

  runCompose(context, [
    ...(target === 'meilisearch' ? ['--profile', 'meilisearch'] : []),
    'up', '-d', '--remove-orphans', '--wait', '--wait-timeout', '240',
  ]);

  const checks = await probeStack(context);
  const failed = checks.filter((check) => check.status === 'failed');
  if (failed.length > 0) {
    throw new DkbError(
      `DKB stack ${context.name} started but is not healthy: ${failed.map((check) => `${check.component}: ${check.message}`).join('; ')}. `
      + `Run: dkb stack logs ${context.name} ${failed[0]!.component}`,
    );
  }

  const inventory = await readHostInventory();
  const runtimeStateRoot = path.resolve(context.root, 'runtime');
  const existingLibrary = Object.entries(inventory.libraries).find(([, item]) => samePath(item.path, runtimeStateRoot));
  const existingRegistry = Object.entries(inventory.registries).find(([, item]) => item.url === context.registryUrl);
  const existingRuntime = Object.entries(inventory.runtimes).find(([, item]) => item.url === context.runtimeUrl);
  const registry = await registerHostRegistry(existingRegistry?.[0] ?? `${context.name}-registry`, context.registryUrl, { select: 'if-empty' });
  const library = await registerHostLibrary(runtimeStateRoot, {
    name: existingLibrary?.[0] ?? `${context.name}-library`,
    registryName: registry.name,
    registryUrl: context.registryUrl,
    select: 'if-empty',
  });
  const runtime = await registerHostRuntime(existingRuntime?.[0] ?? `${context.name}-runtime`, context.runtimeUrl, {
    kind: 'docker',
    library: library.name,
    stateRoot: path.join(context.root, 'runtime'),
    composeFile: context.composeFile,
    select: 'if-empty',
  });

  return {
    ...await statusDkbStack(context.name, true),
    status: 'ready',
    registryName: registry.name,
    runtimeName: runtime.name,
    libraryName: library.name,
  };
}

export async function downDkbStack(name = 'local'): Promise<{ status: 'stopped'; name: string; stateRoot: string; preserved: string[] }> {
  const context = await readDkbStack(name);
  assertDockerAvailable();
  runCompose(context, ['down', '--remove-orphans']);

  return {
    status: 'stopped',
    name: context.name,
    stateRoot: context.root,
    preserved: ['Registry data', 'Runtime Library', 'stack secrets', 'host inventory entries'],
  };
}

export async function statusDkbStack(name = 'local', check = false): Promise<DkbStackStatus> {
  const context = await readDkbStack(name);
  assertDockerAvailable();
  const services = composeServices(context);

  return {
    name: context.name,
    target: context.target,
    stateRoot: context.root,
    composeFile: context.composeFile,
    registryUrl: context.registryUrl,
    runtimeUrl: context.runtimeUrl,
    services,
    ...(check ? { checks: await probeStack(context) } : {}),
  };
}

export async function doctorDkbStack(name = 'local'): Promise<DkbStackStatus & { ok: boolean; checks: Array<{ component: string; status: 'ok' | 'failed'; message: string }> }> {
  const context = await readDkbStack(name);
  const checks: Array<{ component: string; status: 'ok' | 'failed'; message: string }> = [];

  try {
    assertDockerAvailable();
    checks.push({ component: 'docker', status: 'ok', message: 'Docker Compose is available.' });
  } catch (error) {
    checks.push({ component: 'docker', status: 'failed', message: errorMessage(error) });
  }
  checks.push({ component: 'compose', status: await exists(context.composeFile) ? 'ok' : 'failed', message: context.composeFile });
  checks.push({ component: 'secrets', status: await exists(context.envFile) ? 'ok' : 'failed', message: context.envFile });
  checks.push(...await probeStack(context));
  const status = await statusDkbStack(context.name, false).catch(() => ({
    name: context.name,
    target: context.target,
    stateRoot: context.root,
    composeFile: context.composeFile,
    registryUrl: context.registryUrl,
    runtimeUrl: context.runtimeUrl,
    services: [],
  }));

  return { ...status, ok: checks.every((item) => item.status === 'ok'), checks };
}

export async function logsDkbStack(name = 'local', service?: string, follow = false): Promise<void> {
  const context = await readDkbStack(name);
  assertDockerAvailable();
  runCompose(context, ['logs', ...(follow ? ['--follow'] : []), '--tail', follow ? '100' : '200', ...(service ? [service] : [])], true);
}

export async function prepareDkbStack(name = 'local', target: DkbStackTarget = 'default'): Promise<DkbStackContext> {
  const normalizedName = stackName(name);
  const root = path.join(stackStateRoot(), normalizedName);
  const ports = portsFor(normalizedName);
  const composeFile = await resolveComposeFile();
  const envFile = path.join(root, 'stack.env');

  await Promise.all([
    fs.mkdir(path.join(root, 'registry', 'data'), { recursive: true }),
    fs.mkdir(path.join(root, 'registry', 'storage'), { recursive: true }),
    fs.mkdir(path.join(root, 'compiler-context', '.dkb'), { recursive: true }),
    fs.mkdir(path.join(root, 'compiler-jobs'), { recursive: true }),
    fs.mkdir(path.join(root, 'runtime', '.dkb'), { recursive: true }),
    fs.mkdir(path.join(root, 'meilisearch'), { recursive: true }),
  ]);

  const existing = await readEnvironmentFile(envFile);
  const values = {
    ...existing,
    DKB_STACK_NAME: normalizedName,
    DKB_STACK_STATE: root.replace(/\\/gu, '/'),
    DKB_PIPELINE_TARGET: target,
    DKB_REGISTRY_PORT: existing.DKB_REGISTRY_PORT ?? String(ports.registry),
    DKB_RUNTIME_PORT: existing.DKB_RUNTIME_PORT ?? String(ports.runtime),
    DKB_MEILI_PORT: existing.DKB_MEILI_PORT ?? String(ports.meilisearch),
    DKB_REGISTRY_IMAGE: existing.DKB_REGISTRY_IMAGE ?? 'dkb-registry:0.1.0',
    DKB_COMPILER_IMAGE: existing.DKB_COMPILER_IMAGE ?? 'dkb-compiler:0.1.0',
    DKB_RUNTIME_IMAGE: existing.DKB_RUNTIME_IMAGE ?? 'dkb-runtime:0.1.0',
    DKB_PROVIDER_IMAGE: existing.DKB_PROVIDER_IMAGE ?? 'dkb-provider-sidecar:0.1.0',
    DKB_BUILD_COMMIT: existing.DKB_BUILD_COMMIT ?? process.env.DKB_BUILD_COMMIT ?? 'development',
    DKB_REGISTRY_APP_KEY: existing.DKB_REGISTRY_APP_KEY ?? `base64:${randomBytes(32).toString('base64')}`,
    DKB_REGISTRY_BOOTSTRAP_NAMESPACE: existing.DKB_REGISTRY_BOOTSTRAP_NAMESPACE ?? namespaceForStack(normalizedName),
    DKB_REGISTRY_BOOTSTRAP_TOKEN: existing.DKB_REGISTRY_BOOTSTRAP_TOKEN ?? `dkb_${randomBytes(48).toString('base64url')}`,
    DKB_MCP_BEARER_TOKEN: existing.DKB_MCP_BEARER_TOKEN ?? randomBytes(32).toString('base64url'),
    DKB_RUNTIME_ADMIN_TOKEN: existing.DKB_RUNTIME_ADMIN_TOKEN ?? randomBytes(32).toString('base64url'),
    DKB_MEILI_MASTER_KEY: existing.DKB_MEILI_MASTER_KEY ?? randomBytes(32).toString('base64url'),
  };

  await writeEnvironmentFile(envFile, values);
  await writePipelineConfig(path.join(root, 'compiler-context', '.dkb', 'config.json'), target);
  await writePipelineConfig(path.join(root, 'runtime', '.dkb', 'config.json'), target);

  return contextFrom(root, composeFile, envFile, values);
}

export async function runtimeAdminTokenForUrl(runtimeUrl: string): Promise<string | undefined> {
  if (process.env.DKB_RUNTIME_ADMIN_TOKEN) return process.env.DKB_RUNTIME_ADMIN_TOKEN;
  const root = stackStateRoot();
  let entries: string[];

  try {
    entries = await fs.readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }

  const expected = normalizedOrigin(runtimeUrl);
  for (const entry of entries) {
    const values = await readEnvironmentFile(path.join(root, entry, 'stack.env'));
    if (!values.DKB_RUNTIME_PORT || !values.DKB_RUNTIME_ADMIN_TOKEN) continue;
    if (normalizedOrigin(`http://127.0.0.1:${values.DKB_RUNTIME_PORT}`) === expected) {
      return values.DKB_RUNTIME_ADMIN_TOKEN;
    }
  }

  return undefined;
}

async function readDkbStack(name: string): Promise<DkbStackContext> {
  const root = path.join(stackStateRoot(), stackName(name));
  const envFile = path.join(root, 'stack.env');
  const values = await readEnvironmentFile(envFile);

  if (Object.keys(values).length === 0) {
    throw new DkbError(`Unknown DKB stack ${name}. Create it with: dkb stack up ${name}`);
  }

  return contextFrom(root, await resolveComposeFile(), envFile, values);
}

function contextFrom(root: string, composeFile: string, envFile: string, values: Record<string, string>): DkbStackContext {
  const target = values.DKB_PIPELINE_TARGET === 'meilisearch' ? 'meilisearch' : 'default';
  const registryPort = positivePort(values.DKB_REGISTRY_PORT, 'Registry');
  const runtimePort = positivePort(values.DKB_RUNTIME_PORT, 'Runtime');
  const meilisearchPort = positivePort(values.DKB_MEILI_PORT, 'Meilisearch');
  const name = stackName(values.DKB_STACK_NAME ?? path.basename(root));

  return {
    name,
    projectName: `dkb-${name}`,
    target,
    root,
    composeFile,
    envFile,
    registryUrl: `http://127.0.0.1:${registryPort}`,
    runtimeUrl: `http://127.0.0.1:${runtimePort}`,
    registryPort,
    runtimePort,
    meilisearchPort,
  };
}

async function writePipelineConfig(targetPath: string, target: DkbStackTarget): Promise<void> {
  const config = target === 'default'
    ? { format: 'dkb.config.v1', activeTarget: 'default' }
    : {
        format: 'dkb.config.v1',
        activeTarget: 'meilisearch',
        targets: {
          meilisearch: {
            ingestion: '@dkb/llamaindex',
            embedding: '@dkb/fastembed',
            index: '@dkb/meilisearch',
            retrieval: '@dkb/hybrid',
            processors: [],
            options: {
              '@dkb/fastembed': { model: 'BAAI/bge-small-en-v1.5', dimensions: 384 },
              '@dkb/meilisearch': { urlEnv: 'MEILI_URL', apiKeyEnv: 'MEILI_MASTER_KEY', semanticRatio: 0.7 },
            },
          },
        },
      };
  await writeAtomic(targetPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function probeStack(context: DkbStackContext): Promise<Array<{ component: string; status: 'ok' | 'failed'; message: string }>> {
  return Promise.all([
    probe('registry-web', `${context.registryUrl}/health`),
    probe('dkb-runtime', `${context.runtimeUrl}/health`),
    ...(context.target === 'meilisearch'
      ? [probe(
          'meilisearch',
          `http://127.0.0.1:${context.meilisearchPort}/health`,
          (body) => body.status === 'available',
          'status=available',
        )]
      : []),
  ]);
}

async function probe(
  component: string,
  url: string,
  isHealthy: (body: Record<string, unknown>) => boolean = (body) => body.ok === true,
  expectation = 'ok=true',
): Promise<{ component: string; status: 'ok' | 'failed'; message: string }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { component, status: 'failed', message: `HTTP ${response.status} from ${url}` };
    const body = await response.json() as Record<string, unknown>;
    return isHealthy(body)
      ? { component, status: 'ok', message: url }
      : { component, status: 'failed', message: `Health response did not report ${expectation} at ${url}` };
  } catch (error) {
    return { component, status: 'failed', message: `${url}: ${errorMessage(error)}` };
  }
}

function composeServices(context: DkbStackContext): DkbStackStatus['services'] {
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

function parseComposeJson(value: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isRecord) : isRecord(parsed) ? [parsed] : [];
  } catch {
    return value.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

async function composeContainerIds(context: DkbStackContext): Promise<string[]> {
  const result = runCompose(context, ['ps', '-q'], false, true);
  return result.stdout.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
}

function runCompose(
  context: DkbStackContext,
  args: string[],
  inherit = false,
  allowFailure = false,
): { stdout: string; stderr: string } {
  const result = spawnSync('docker', [
    'compose', '--env-file', context.envFile, '-p', context.projectName, '-f', context.composeFile, ...args,
  ], {
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

function assertDockerAvailable(): void {
  const result = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new DkbError('Docker Compose is unavailable. Start Docker Desktop, then retry: dkb stack up');
  }
}

function assertRequiredImages(context: DkbStackContext): void {
  const values = readEnvironmentFileSync(context.envFile);
  const required = [
    {
      image: values.DKB_REGISTRY_IMAGE ?? 'dkb-registry:0.1.0',
      recovery: 'From the dkb-registry checkout run: docker build -f deploy/Dockerfile -t dkb-registry:0.1.0 .',
    },
    {
      image: values.DKB_COMPILER_IMAGE ?? 'dkb-compiler:0.1.0',
      recovery: 'From the project-dkb checkout run: docker build -f services/compiler/Dockerfile -t dkb-compiler:0.1.0 .',
    },
    {
      image: values.DKB_RUNTIME_IMAGE ?? 'dkb-runtime:0.1.0',
      recovery: 'From the project-dkb checkout run: docker build -f services/runtime/Dockerfile -t dkb-runtime:0.1.0 .',
    },
    {
      image: values.DKB_PROVIDER_IMAGE ?? 'dkb-provider-sidecar:0.1.0',
      recovery: 'From providers/bundled/python/llamaindex run: docker build -t dkb-provider-sidecar:0.1.0 .',
    },
  ];

  for (const requirement of required) {
    const result = spawnSync('docker', ['image', 'inspect', requirement.image], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new DkbError(
        `Required stack image ${requirement.image} is not installed. ${requirement.recovery} Then retry: dkb stack up ${context.name}`,
      );
    }
  }
}

async function assertPortAvailable(port: number, label: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new DkbError(`${label} port ${port} is already in use. Stop the conflicting service or choose another stack port in stack.env.`)));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve()));
  });
}

async function resolveComposeFile(): Promise<string> {
  const candidates = [
    process.env.DKB_STACK_COMPOSE_FILE,
    fileURLToPath(new URL('./compose.yaml', import.meta.url)),
    path.resolve('deploy', 'compose.yaml'),
  ].filter((value): value is string => Boolean(value)).map((value) => path.resolve(value));
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new DkbError('DKB stack Compose distribution is missing. Reinstall @dkb/cli or set DKB_STACK_COMPOSE_FILE.');
}

function stackStateRoot(): string {
  return path.resolve(process.env.DKB_STACK_STATE_ROOT ?? path.join(os.homedir(), '.dkb', 'stacks'));
}

function stackName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u.test(normalized)) {
    throw new DkbError('Stack name must use 1-64 lowercase letters, numbers, dots, dashes, or underscores.');
  }
  return normalized;
}

function namespaceForStack(name: string): string {
  return name.replace(/[._]+/gu, '-').replace(/-+/gu, '-');
}

function portsFor(name: string): { registry: number; runtime: number; meilisearch: number } {
  if (name === 'local') return { registry: 8018, runtime: 7331, meilisearch: 7700 };
  const offset = [...name].reduce((total, character) => (total * 31 + character.charCodeAt(0)) % 500, 0);
  return { registry: 8100 + offset, runtime: 8600 + offset, meilisearch: 9100 + offset };
}

async function readEnvironmentFile(target: string): Promise<Record<string, string>> {
  try {
    return parseEnvironmentFile(await fs.readFile(target, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

function readEnvironmentFileSync(target: string): Record<string, string> {
  try {
    return parseEnvironmentFile(readFileSync(target, 'utf8'));
  } catch {
    return {};
  }
}

function parseEnvironmentFile(source: string): Record<string, string> {
  return Object.fromEntries(source.split(/\r?\n/u).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return [];
    const separator = trimmed.indexOf('=');
    return separator > 0 ? [[trimmed.slice(0, separator), trimmed.slice(separator + 1)]] : [];
  }));
}

async function writeEnvironmentFile(target: string, values: Record<string, string>): Promise<void> {
  const source = `${Object.entries(values).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
  await writeAtomic(target, source);
  await fs.chmod(target, 0o600).catch(() => undefined);
}

async function writeAtomic(target: string, source: string): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temporary, source, 'utf8');
  await fs.rm(target, { force: true });
  await fs.rename(temporary, target);
}

function positivePort(value: string | undefined, label: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new DkbError(`${label} port is invalid: ${String(value)}`);
  return port;
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

function normalizedOrigin(value: string): string {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return value.replace(/\/+$/gu, '').toLowerCase();
  }
}

function samePath(left: string, right: string): boolean {
  const first = path.resolve(left);
  const second = path.resolve(right);
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}
