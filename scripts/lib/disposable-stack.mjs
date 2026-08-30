import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);

export async function startDisposableStack({
  repositoryRoot,
  cliPath,
  prefix,
  target,
  environment: overrides = {},
}) {
  const suppliedStateRoot = process.env.DKB_STACK_STATE_ROOT?.trim();
  const stateRoot = suppliedStateRoot
    ? path.resolve(suppliedStateRoot)
    : await fs.mkdtemp(path.join(os.tmpdir(), `dkb-${prefix}-`));
  const stackName = process.env.DKB_STACK_NAME?.trim()
    || `${prefix}-${process.pid}-${Date.now().toString(36)}`;
  const environment = {
    ...process.env,
    ...overrides,
    DKB_STACK_STATE_ROOT: stateRoot,
    DKB_HOST_INVENTORY: process.env.DKB_HOST_INVENTORY?.trim() || path.join(stateRoot, 'host.json'),
    DKB_STACK_NAME: stackName,
  };
  let started = false;
  let cleaned = false;

  try {
    await runJsonCli(cliPath, repositoryRoot, environment, ['stack', 'up', stackName, '--target', target]);
    started = true;
  } catch (error) {
    await runJsonCli(cliPath, repositoryRoot, environment, ['stack', 'down', stackName]).catch(() => undefined);
    if (!suppliedStateRoot) {
      await removeDisposableVolumes(repositoryRoot, stackName).catch(() => undefined);
      await fs.rm(stateRoot, { recursive: true, force: true });
    }
    throw error;
  }

  return {
    environment,
    stackName,
    stateRoot,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (started) {
        await runJsonCli(cliPath, repositoryRoot, environment, ['stack', 'down', stackName]).catch((error) => {
          process.stderr.write(`Unable to stop proof stack ${stackName}: ${error instanceof Error ? error.message : String(error)}\n`);
        });
      }
      if (!suppliedStateRoot) {
        await removeDisposableVolumes(repositoryRoot, stackName).catch((error) => {
          process.stderr.write(`Unable to remove disposable proof volumes for ${stackName}: ${error instanceof Error ? error.message : String(error)}\n`);
        });
        await fs.rm(stateRoot, { recursive: true, force: true });
      }
    },
  };
}

async function runJsonCli(cliPath, repositoryRoot, environment, args) {
  const result = await executeFile(process.execPath, [cliPath, '--json', ...args], {
    cwd: repositoryRoot,
    env: environment,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15 * 60_000,
    windowsHide: true,
  });
  return JSON.parse(result.stdout);
}

async function removeDisposableVolumes(repositoryRoot, name) {
  const project = `dkb-${name}`;
  const listed = await executeFile('docker', [
    'volume',
    'ls',
    '--filter', `label=com.docker.compose.project=${project}`,
    '--format', '{{.Name}}',
  ], { cwd: repositoryRoot, windowsHide: true });
  const volumes = listed.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  if (volumes.some((volume) => !volume.startsWith(`${project}_`))) {
    throw new Error(`Docker returned a volume outside disposable project ${project}`);
  }
  if (volumes.length > 0) {
    await executeFile('docker', ['volume', 'rm', ...volumes], { cwd: repositoryRoot, windowsHide: true });
  }
}
