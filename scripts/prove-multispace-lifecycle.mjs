import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repositoryRoot, 'apps', 'cli', 'dist', 'cli', 'index.js');
const suppliedStateRoot = process.env.DKB_STACK_STATE_ROOT?.trim();
const stateRoot = suppliedStateRoot
  ? path.resolve(suppliedStateRoot)
  : await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-multispace-proof-'));
const stackName = process.env.DKB_STACK_NAME?.trim()
  || `multispace-proof-${process.pid}-${Date.now().toString(36)}`;
const initialTarget = process.env.DKB_PROOF_INITIAL_TARGET?.trim() || 'fastembed-faiss';
const alternateTarget = Object.hasOwn(process.env, 'DKB_PROOF_ALTERNATE_TARGET')
  ? process.env.DKB_PROOF_ALTERNATE_TARGET?.trim() ?? ''
  : 'tei-faiss';
const environment = {
  ...process.env,
  DKB_STACK_STATE_ROOT: stateRoot,
  DKB_HOST_INVENTORY: path.join(stateRoot, 'host.json'),
  DKB_STACK_NAME: stackName,
  DKB_PROOF_ALTERNATE_TARGET: alternateTarget,
  DKB_PROOF_VERSION: process.env.DKB_PROOF_VERSION ?? `0.0.${Math.floor(Date.now() / 1000)}`,
};
let started = false;

try {
  await runCli(['stack', 'up', stackName, '--target', initialTarget]);
  started = true;
  const proof = await executeFile(process.execPath, [path.join(repositoryRoot, 'scripts', 'prove-stack-lifecycle.mjs')], {
    cwd: repositoryRoot,
    env: environment,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 90 * 60_000,
    windowsHide: true,
  });
  process.stdout.write(proof.stdout);
  if (proof.stderr) process.stderr.write(proof.stderr);
} finally {
  if (started) {
    await runCli(['stack', 'down', stackName]).catch((error) => {
      process.stderr.write(`Unable to stop proof stack ${stackName}: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }
  if (!suppliedStateRoot) {
    await removeDisposableVolumes(stackName).catch((error) => {
      process.stderr.write(`Unable to remove disposable proof volumes for ${stackName}: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
}

async function runCli(args) {
  const result = await executeFile(process.execPath, [cliPath, '--json', ...args], {
    cwd: repositoryRoot,
    env: environment,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15 * 60_000,
    windowsHide: true,
  });
  return JSON.parse(result.stdout);
}

async function removeDisposableVolumes(name) {
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
