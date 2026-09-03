import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);

export function proofStackLibraryRoot(stackRoot, environment) {
  return path.resolve(environment.DKB_LIBRARY_HOST_PATH?.trim() || path.join(stackRoot, 'library'));
}

export async function startDisposableStack({
  repositoryRoot,
  cliPath,
  prefix,
  target,
  environment: overrides = {},
  prepare,
  ambientEnvironment = process.env,
  execute = executeFile,
}) {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(prefix)) throw new Error('Disposable proof prefix must be a lowercase safe name.');
  const suppliedStateRoot = ambientEnvironment.DKB_STACK_STATE_ROOT?.trim();
  const stackName = ambientEnvironment.DKB_STACK_NAME?.trim()
    || `${prefix}-${process.pid}-${Date.now().toString(36)}`;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(stackName)) throw new Error('Disposable proof Stack name is invalid.');
  const stateRoot = suppliedStateRoot
    ? path.resolve(suppliedStateRoot)
    : await fs.mkdtemp(path.join(os.tmpdir(), `dkb-${prefix}-`));
  const stackRoot = path.resolve(stateRoot, stackName);
  if (path.dirname(stackRoot) !== stateRoot) throw new Error('Disposable proof Stack escaped its state root.');
  const environment = {
    ...ambientEnvironment,
    ...overrides,
    DKB_STACK_STATE_ROOT: stateRoot,
    DKB_HOST_INVENTORY: path.join(stackRoot, 'host-inventory.json'),
    DKB_STACK_NAME: stackName,
  };
  let owned = false;
  let startupAttempted = false;
  let cleaned = false;

  try {
    await fs.mkdir(stateRoot, { recursive: true });
    await fs.mkdir(stackRoot);
    owned = true;
    await assertUnusedProject(repositoryRoot, stackName, execute);
    await prepare?.({ stateRoot, stackName, environment });
    startupAttempted = true;
    await runJsonCli(cliPath, repositoryRoot, environment, [
      'stack',
      'up',
      stackName,
      '--compiler-target',
      target,
      '--pipeline',
      target,
    ], execute);
  } catch (error) {
    if (owned) {
      try { await cleanup(); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Proof startup failed; teardown is unconfirmed. Preserved ${stackRoot}. ${cleanupError.message}`);
      }
    }
    throw error;
  }

  return {
    environment,
    stackName,
    stateRoot,
    cleanup,
  };

  async function cleanup() {
    if (cleaned || !owned) return;
    if (startupAttempted) {
      try {
        await runJsonCli(cliPath, repositoryRoot, environment, ['stack', 'down', stackName], execute);
        const containers = await projectContainers(repositoryRoot, stackName, execute);
        if (containers.length) throw new Error('Containers still reference the proof project after Stack down.');
        await removeDisposableVolumes(repositoryRoot, stackName, execute);
      } catch (error) {
        throw new Error(`Proof storage preserved at ${stackRoot}; service teardown was not confirmed. `
          + `Recover with DKB_STACK_STATE_ROOT set to "${stateRoot}" and dkb stack down ${stackName}.`, { cause: error });
      }
    }
    await fs.rm(stackRoot, { recursive: true, force: true });
    if (!suppliedStateRoot) await fs.rmdir(stateRoot);
    cleaned = true;
  }
}

async function runJsonCli(cliPath, repositoryRoot, environment, args, execute) {
  const result = await execute(process.execPath, [cliPath, '--json', ...args], {
    cwd: repositoryRoot,
    env: environment,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15 * 60_000,
    windowsHide: true,
  });
  return JSON.parse(result.stdout);
}

async function assertUnusedProject(repositoryRoot, name, execute) {
  const containers = await projectContainers(repositoryRoot, name, execute);
  const volumes = await projectVolumes(repositoryRoot, name, execute);
  if (containers.length || volumes.length) throw new Error(`Disposable proof refuses existing Docker project dkb-${name}. Choose a fresh Stack name.`);
}

async function projectContainers(repositoryRoot, name, execute) {
  const result = await execute('docker', ['ps', '--all', '--filter', `label=com.docker.compose.project=dkb-${name}`, '--format', '{{.ID}}'], {
    cwd: repositoryRoot, windowsHide: true, timeout: 10_000,
  });
  return result.stdout.split(/\r?\n/u).filter((value) => value.trim());
}

async function projectVolumes(repositoryRoot, name, execute) {
  const project = `dkb-${name}`;
  const listed = await execute('docker', [
    'volume',
    'ls',
    '--filter', `label=com.docker.compose.project=${project}`,
    '--format', '{{.Name}}',
  ], { cwd: repositoryRoot, windowsHide: true, timeout: 10_000 });
  const volumes = listed.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  if (volumes.some((volume) => !volume.startsWith(`${project}_`))) {
    throw new Error(`Docker returned a volume outside disposable project ${project}`);
  }
  return volumes;
}

async function removeDisposableVolumes(repositoryRoot, name, execute) {
  const volumes = await projectVolumes(repositoryRoot, name, execute);
  if (volumes.length > 0) {
    await execute('docker', ['volume', 'rm', ...volumes], { cwd: repositoryRoot, windowsHide: true, timeout: 30_000 });
  }
}
