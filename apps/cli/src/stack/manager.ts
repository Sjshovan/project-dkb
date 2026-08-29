import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { c as createTar, t as listTar, x as extractTar } from 'tar';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { maybeReadRuntimeLock } from '@sjshovan/dkb-library/builds.js';
import type { DkbDistribution, DkbDistributionService } from '@sjshovan/dkb-pipeline/host.js';
import { readHostInventory, registerHostLibrary, registerHostRegistry, registerHostRuntime } from '../host/inventory.js';

export type DkbStackTarget = string;

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
  requiredServices: DkbDistributionService[];
  profiles: string[];
  allProfiles: string[];
  servicePorts: Record<string, number>;
  version?: string;
}

export interface DkbStackStatus {
  name: string;
  target: DkbStackTarget;
  stateRoot: string;
  composeFile: string;
  registryUrl: string;
  runtimeUrl: string;
  version?: string;
  services: Array<{ name: string; status: string; health: string }>;
  checks?: Array<{ component: string; status: 'ok' | 'failed'; message: string }>;
}

export interface DkbStackBackup {
  status: 'backed_up';
  name: string;
  archive: string;
  checksumFile: string;
  sha256: string;
  bytes: number;
  containsSecrets: true;
}

export interface DkbStackRestore {
  status: 'restored';
  name: string;
  archive: string;
  stateRoot: string;
  sha256: string;
  replaced: boolean;
}

export interface DkbStackUpgrade {
  status: 'upgraded';
  name: string;
  fromVersion: string;
  toVersion: string;
  lockFile: string;
  backup: DkbStackBackup;
  services: DkbStackStatus['services'];
}

export async function upDkbStack(distribution: DkbDistribution, name = 'local', target?: DkbStackTarget): Promise<DkbStackStatus & {
  status: 'ready';
  registryName: string;
  runtimeName: string;
  libraryName: string;
  legacyRegistryVolume?: { status: 'copied'; volume: string; preserved: true };
}> {
  const context = await prepareDkbStack(distribution, name, target);
  assertDockerAvailable();
  assertRequiredImages(context);
  const legacyRegistryVolume = await migrateLegacyRegistryVolume(context);

  if ((await composeContainerIds(context)).length === 0) {
    await assertPortAvailable(context.registryPort, 'Registry');
    await assertPortAvailable(context.runtimePort, 'Runtime');
    for (const service of context.requiredServices) {
      const port = context.servicePorts[service.id];
      if (port !== undefined) await assertPortAvailable(port, service.stack?.health?.component ?? service.id);
    }
  }

  runCompose(context, ['up', '-d', '--remove-orphans', '--wait', '--wait-timeout', '240']);

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
    ...await statusDkbStack(distribution, context.name, true),
    status: 'ready',
    registryName: registry.name,
    runtimeName: runtime.name,
    libraryName: library.name,
    ...(legacyRegistryVolume ? { legacyRegistryVolume } : {}),
  };
}

export async function downDkbStack(distribution: DkbDistribution, name = 'local'): Promise<{ status: 'stopped'; name: string; stateRoot: string; preserved: string[] }> {
  const context = await readDkbStack(distribution, name);
  assertDockerAvailable();
  runCompose(context, ['down', '--remove-orphans']);

  return {
    status: 'stopped',
    name: context.name,
    stateRoot: context.root,
    preserved: ['Registry data', 'Runtime Library', 'stack secrets', 'host inventory entries'],
  };
}

export async function statusDkbStack(distribution: DkbDistribution, name = 'local', check = false): Promise<DkbStackStatus> {
  const context = await readDkbStack(distribution, name);
  assertDockerAvailable();
  const services = composeServices(context);

  return {
    name: context.name,
    target: context.target,
    stateRoot: context.root,
    composeFile: context.composeFile,
    registryUrl: context.registryUrl,
    runtimeUrl: context.runtimeUrl,
    ...(context.version ? { version: context.version } : {}),
    services,
    ...(check ? { checks: await probeStack(context) } : {}),
  };
}

export async function doctorDkbStack(distribution: DkbDistribution, name = 'local'): Promise<DkbStackStatus & { ok: boolean; checks: Array<{ component: string; status: 'ok' | 'failed'; message: string }> }> {
  const context = await readDkbStack(distribution, name);
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
  const status = await statusDkbStack(distribution, context.name, false).catch(() => ({
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

export async function logsDkbStack(distribution: DkbDistribution, name = 'local', service?: string, follow = false): Promise<void> {
  const context = await readDkbStack(distribution, name);
  assertDockerAvailable();
  runCompose(context, ['logs', ...(follow ? ['--follow'] : []), '--tail', follow ? '100' : '200', ...(service ? [service] : [])], true);
}

export async function backupDkbStack(distribution: DkbDistribution, name = 'local', output?: string): Promise<DkbStackBackup> {
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

export async function restoreDkbStack(distribution: DkbDistribution, archivePath: string, replace = false): Promise<DkbStackRestore> {
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
  const existing = await exists(target);

  if (existing && !replace) {
    throw new DkbError(`Stack ${name} already exists at ${target}. Stop it, then rerun with --replace to restore this backup.`);
  }

  if (existing) {
    const context = await readDkbStack(distribution, name);
    assertDockerAvailable();
    await requireStoppedStack(context, 'replace from backup');
  }

  await fs.mkdir(stackStateRoot(), { recursive: true });
  const stage = await fs.mkdtemp(path.join(stackStateRoot(), '.restore-'));
  const previous = `${target}.rollback-${process.pid}-${Date.now().toString(36)}`;
  let movedPrevious = false;

  try {
    await extractTar({
      cwd: stage,
      file: archive,
      strict: true,
      preservePaths: false,
      unlink: false,
    });
    const stagedRoot = path.join(stage, archiveRoot);
    if (!await exists(path.join(stagedRoot, 'stack.env'))) {
      throw new DkbError('Stack backup is missing stack.env and cannot be restored.');
    }

    if (existing) {
      await fs.rename(target, previous);
      movedPrevious = true;
    }
    await fs.rename(stagedRoot, target);
    if (movedPrevious) await fs.rm(previous, { recursive: true, force: true });
  } catch (error) {
    if (movedPrevious && !await exists(target) && await exists(previous)) {
      await fs.rename(previous, target);
    }
    throw error;
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }

  return {
    status: 'restored',
    name,
    archive,
    stateRoot: target,
    sha256: actualHash,
    replaced: existing,
  };
}

export async function upgradeDkbStack(distribution: DkbDistribution, name: string, lockPath: string): Promise<DkbStackUpgrade> {
  const context = await readDkbStack(distribution, name);
  assertDockerAvailable();
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
    const ready = await upDkbStack(distribution, name, context.target);
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
      await upDkbStack(distribution, name, context.target);
      rollbackMessage = 'Previous state restored and restarted.';
    } catch (rollbackError) {
      rollbackMessage = `Previous state restored but restart failed: ${errorMessage(rollbackError)}`;
    }
    throw new DkbError(`Stack upgrade to ${lock.version} failed: ${errorMessage(error)} ${rollbackMessage}`);
  }
}

export async function prepareDkbStack(distribution: DkbDistribution, name = 'local', requestedTarget?: DkbStackTarget): Promise<DkbStackContext> {
  const normalizedName = stackName(name);
  const root = path.join(stackStateRoot(), normalizedName);
  const target = requestedTarget ?? distributionDefaultTarget(distribution);
  const recipe = targetRecipe(distribution, target);
  const composeFile = await resolveComposeFile();
  const envFile = path.join(root, 'stack.env');
  const requiredServices = requiredStackServices(distribution, target);

  await Promise.all([
    fs.mkdir(path.join(root, 'registry', 'data'), { recursive: true }),
    fs.mkdir(path.join(root, 'registry', 'storage'), { recursive: true }),
    fs.mkdir(path.join(root, 'compiler-context', '.dkb'), { recursive: true }),
    fs.mkdir(path.join(root, 'compiler-jobs'), { recursive: true }),
    fs.mkdir(path.join(root, 'runtime', '.dkb'), { recursive: true }),
    ...distribution.services.flatMap((service) => service.stack?.stateDirectory
      ? [fs.mkdir(path.join(root, service.stack.stateDirectory), { recursive: true })]
      : []),
  ]);

  const existing = await readEnvironmentFile(envFile);
  const runtimeRoot = path.join(root, 'runtime');
  const activeRuntimeBuild = await maybeReadRuntimeLock(runtimeRoot);
  const values: Record<string, string> = {
    ...existing,
    DKB_STACK_NAME: normalizedName,
    DKB_STACK_STATE: root.replace(/\\/gu, '/'),
    DKB_PIPELINE_TARGET: target,
    DKB_BUILD_COMMIT: existing.DKB_BUILD_COMMIT ?? process.env.DKB_BUILD_COMMIT ?? 'development',
    DKB_REGISTRY_APP_KEY: existing.DKB_REGISTRY_APP_KEY ?? `base64:${randomBytes(32).toString('base64')}`,
    DKB_REGISTRY_BOOTSTRAP_NAMESPACE: existing.DKB_REGISTRY_BOOTSTRAP_NAMESPACE ?? namespaceForStack(normalizedName),
    DKB_REGISTRY_BOOTSTRAP_TOKEN: existing.DKB_REGISTRY_BOOTSTRAP_TOKEN ?? `dkb_${randomBytes(48).toString('base64url')}`,
    DKB_MCP_BEARER_TOKEN: existing.DKB_MCP_BEARER_TOKEN ?? randomBytes(32).toString('base64url'),
    DKB_RUNTIME_ADMIN_TOKEN: existing.DKB_RUNTIME_ADMIN_TOKEN ?? randomBytes(32).toString('base64url'),
  };

  for (const service of distribution.services) {
    const stack = service.stack;
    if (!stack) continue;
    if (service.image) values[stack.imageEnvironment] = existing[stack.imageEnvironment] ?? service.image;
    if (stack.health) {
      values[stack.health.portEnvironment] = existing[stack.health.portEnvironment]
        ?? String(hostPortFor(normalizedName, stack.health.defaultHostPort, stack.health.namedPortBase));
    }
    for (const environment of stack.secretEnvironment ?? []) {
      values[environment] = existing[environment] ?? randomBytes(32).toString('base64url');
    }
    if (!requiredServices.some((candidate) => candidate.id === service.id) || !service.providerId) continue;
    const providerOptions = recipe.options?.[service.providerId] ?? {};
    for (const [option, environment] of Object.entries(stack.optionEnvironment ?? {})) {
      const value = providerOptions[option];
      if (value !== undefined) values[environment] = environmentValue(value, service.id, option);
    }
  }

  await writeEnvironmentFile(envFile, values);
  await writePipelineConfig(path.join(root, 'compiler-context', '.dkb', 'config.json'), target);
  // Changing the Registry compiler target must not put a populated Runtime on
  // a configuration that its active package builds do not satisfy. The
  // coordinated `pipeline use` transaction updates Runtime config only after
  // every package build has been staged and verified.
  await writePipelineConfig(
    path.join(runtimeRoot, '.dkb', 'config.json'),
    parseStoredTarget(distribution, activeRuntimeBuild?.target ?? target),
  );

  return contextFrom(distribution, root, composeFile, envFile, values);
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

async function readDkbStack(distribution: DkbDistribution, name: string): Promise<DkbStackContext> {
  const root = path.join(stackStateRoot(), stackName(name));
  const envFile = path.join(root, 'stack.env');
  const values = await readEnvironmentFile(envFile);

  if (Object.keys(values).length === 0) {
    throw new DkbError(`Unknown DKB stack ${name}. Create it with: dkb stack up ${name}`);
  }

  return contextFrom(distribution, root, await resolveComposeFile(), envFile, values);
}

function contextFrom(distribution: DkbDistribution, root: string, composeFile: string, envFile: string, values: Record<string, string>): DkbStackContext {
  const target = parseStoredTarget(distribution, values.DKB_PIPELINE_TARGET);
  const name = stackName(values.DKB_STACK_NAME ?? path.basename(root));
  const requiredServices = requiredStackServices(distribution, target);
  const servicePorts = Object.fromEntries(distribution.services.flatMap((service) => {
    const health = service.stack?.health;
    return health ? [[service.id, positivePort(values[health.portEnvironment], health.component)]] : [];
  }));
  const registryPort = requiredServicePort(distribution, servicePorts, 'registry');
  const runtimePort = requiredServicePort(distribution, servicePorts, 'runtime');

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
    requiredServices,
    profiles: serviceProfiles(requiredServices),
    allProfiles: serviceProfiles(distribution.services),
    servicePorts,
    ...(values.DKB_STACK_VERSION ? { version: values.DKB_STACK_VERSION } : {}),
  };
}

async function writePipelineConfig(targetPath: string, target: DkbStackTarget): Promise<void> {
  const config = { format: 'dkb.config.v2', activeTarget: target };
  await writeAtomic(targetPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function probeStack(context: DkbStackContext): Promise<Array<{ component: string; status: 'ok' | 'failed'; message: string }>> {
  return Promise.all(context.requiredServices.flatMap((service) => {
    const health = service.stack?.health;
    const port = context.servicePorts[service.id];
    if (!health || port === undefined) return [];
    return [probe(
      health.component,
      `http://127.0.0.1:${port}${health.path}`,
      health.expectation,
    )];
  }));
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

function assertDockerAvailable(): void {
  const result = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new DkbError('Docker Compose is unavailable. Start Docker Desktop, then retry: dkb stack up');
  }
}

function assertRequiredImages(context: DkbStackContext): void {
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

async function migrateLegacyRegistryVolume(
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
  const image = registry?.stack
    ? values[registry.stack.imageEnvironment] ?? registry.image
    : undefined;
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
  throw new DkbError('DKB stack Compose distribution is missing. Reinstall @sjshovan/dkb-cli or set DKB_STACK_COMPOSE_FILE.');
}

function stackStateRoot(): string {
  return path.resolve(process.env.DKB_STACK_STATE_ROOT ?? path.join(os.homedir(), '.dkb', 'stacks'));
}

function stackBackupRoot(): string {
  return path.resolve(process.env.DKB_STACK_BACKUP_ROOT ?? path.join(os.homedir(), '.dkb', 'backups'));
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

function hostPortFor(name: string, defaultPort: number, namedPortBase: number): number {
  if (name === 'local') return defaultPort;
  const offset = [...name].reduce((total, character) => (total * 31 + character.charCodeAt(0)) % 500, 0);
  return namedPortBase + offset;
}

function targetRecipe(distribution: DkbDistribution, target: DkbStackTarget) {
  const recipe = distribution.defaults.targets?.[target];
  if (!recipe) {
    const available = Object.keys(distribution.defaults.targets ?? {}).sort().join(', ');
    throw new DkbError(`Pipeline target ${target} is not available in ${distribution.id}. Available targets: ${available || 'none'}.`);
  }
  return recipe;
}

function requiredStackServices(distribution: DkbDistribution, target: DkbStackTarget): DkbDistributionService[] {
  targetRecipe(distribution, target);
  return distribution.services.filter((service) => service.requiredBy.includes(target));
}

function serviceProfiles(services: readonly DkbDistributionService[]): string[] {
  return [...new Set(services.flatMap((service) => service.stack?.composeProfile ? [service.stack.composeProfile] : []))];
}

function requiredServicePort(distribution: DkbDistribution, ports: Record<string, number>, id: string): number {
  const port = ports[id];
  if (port === undefined) throw new DkbError(`Distribution ${distribution.id} does not define a health port for required service ${id}.`);
  return port;
}

function parseStoredTarget(distribution: DkbDistribution, value: string | undefined): DkbStackTarget {
  const target = value ?? distributionDefaultTarget(distribution);
  targetRecipe(distribution, target);
  return target;
}

function distributionDefaultTarget(distribution: DkbDistribution): string {
  const target = distribution.defaults.activeTarget;
  if (!target) throw new DkbError(`Distribution ${distribution.id} does not define a default pipeline target.`);
  return target;
}

function environmentValue(value: unknown, serviceId: string, option: string): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new DkbError(`Stack option ${serviceId}.${option} must be a string, number, or boolean to map into a service environment variable.`);
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

async function requireStoppedStack(context: DkbStackContext, operation: string): Promise<void> {
  const running = await composeContainerIds(context);
  if (running.length > 0) {
    throw new DkbError(`Stack ${context.name} must be stopped before ${operation}. Run: dkb stack down ${context.name}`);
  }
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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new DkbError(`Stack backup checksum is missing: ${target}`);
    }
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
