import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { distributableWorkspaces, findForbiddenPackagePaths } from './package-policy.mjs';

const repositoryRoot = process.cwd();
const npmCli = process.env.npm_execpath;
const windowsOnly = process.argv.includes('--windows-only');
const linuxOnly = process.argv.includes('--linux-only');

if (!npmCli) {
  throw new Error('npm_execpath is unavailable. Run this proof through npm run proof:cli.');
}
if (windowsOnly && linuxOnly) {
  throw new Error('Choose at most one of --windows-only or --linux-only.');
}

const proofRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-cli-distribution-'));
const tarballRoot = path.join(proofRoot, 'packages');

try {
  await fs.mkdir(tarballRoot, { recursive: true });
  const tarballs = [];

  for (const workspace of distributableWorkspaces) {
    const result = run(process.execPath, [
      npmCli,
      'pack',
      '--workspace',
      workspace,
      '--pack-destination',
      tarballRoot,
      '--json',
    ]);
    const report = JSON.parse(result.stdout)[0];
    const paths = report.files.map((file) => file.path);
    const rejected = findForbiddenPackagePaths(paths);
    if (rejected.length > 0) {
      throw new Error(`${workspace} package contains forbidden files: ${rejected.join(', ')}`);
    }
    if (workspace === '@sjshovan/dkb-cli' && !paths.includes('dist/version.js')) {
      throw new Error('@sjshovan/dkb-cli package is missing dist/version.js required by the executable.');
    }
    tarballs.push(path.join(tarballRoot, report.filename));
  }

  const results = {};
  if (!linuxOnly) results.windows = proveHostInstall(tarballs);
  if (!windowsOnly) results.linux = proveLinuxInstall(tarballRoot, tarballs);

  console.log(JSON.stringify({
    status: 'passed',
    packages: tarballs.map((file) => path.basename(file)),
    ...results,
  }, null, 2));
} finally {
  await fs.rm(proofRoot, { recursive: true, force: true });
}

function proveHostInstall(tarballs) {
  const prefix = path.join(proofRoot, 'host-prefix');
  const unrelatedRoot = path.join(proofRoot, 'unrelated-host-directory');
  const inventory = path.join(proofRoot, 'host.json');
  mkdirSync(unrelatedRoot, { recursive: true });
  run(process.execPath, [npmCli, 'install', '--global', '--prefix', prefix, ...tarballs]);

  const executable = process.platform === 'win32'
    ? path.join(prefix, 'dkb.cmd')
    : path.join(prefix, 'bin', 'dkb');
  const environment = { ...process.env, DKB_HOST_INVENTORY: inventory, NO_COLOR: '1' };
  const cliOptions = { cwd: unrelatedRoot, env: environment, shell: process.platform === 'win32' };
  const cliVersion = run(executable, ['--version'], cliOptions).stdout.trim();
  const componentVersions = run(executable, ['version'], cliOptions).stdout;
  run(executable, ['--help'], cliOptions);
  const initialized = JSON.parse(run(executable, ['--json', 'init', '--yes'], {
    ...cliOptions,
  }).stdout);

  assertVersionProof(cliVersion, componentVersions);
  if (!initialized.root || path.resolve(initialized.root) !== path.resolve(unrelatedRoot)) {
    throw new Error('Globally installed CLI did not initialize the unrelated host directory.');
  }
  return { platform: process.platform, cliVersion, initialized: true };
}

function proveLinuxInstall(tarballRoot, tarballs) {
  const packageArguments = tarballs.map((file) => `/packages/${path.basename(file)}`).join(' ');
  const script = [
    'set -eu',
    'mkdir -p /tmp/dkb-prefix /tmp/dkb-unrelated',
    `npm install --global --prefix /tmp/dkb-prefix ${packageArguments} >/tmp/npm-install.log`,
    'export PATH="/tmp/dkb-prefix/bin:$PATH"',
    'export DKB_HOST_INVENTORY=/tmp/dkb-host.json',
    'export NO_COLOR=1',
    'cd /tmp/dkb-unrelated',
    'dkb --version',
    'dkb version',
    'dkb --help >/tmp/dkb-help.txt',
    'dkb --json init --yes >/tmp/dkb-init.json',
    'node -e "const fs=require(\'fs\');const x=JSON.parse(fs.readFileSync(\'/tmp/dkb-init.json\',\'utf8\'));if(x.root!==\'/tmp/dkb-unrelated\')process.exit(1)"',
  ].join('\n');
  const result = run('docker', [
    'run',
    '--rm',
    '--mount',
    `type=bind,source=${tarballRoot},target=/packages,readonly`,
    'node:22-bookworm-slim',
    'sh',
    '-lc',
    script,
  ]);
  const lines = result.stdout.trim().split(/\r?\n/u);
  const cliVersion = lines[0];
  assertVersionProof(cliVersion, result.stdout);
  return { container: 'node:22-bookworm-slim', cliVersion, initialized: true };
}

function assertVersionProof(cliVersion, componentVersions) {
  if (!/^\d+\.\d+\.\d+$/u.test(cliVersion)) {
    throw new Error(`Unexpected CLI version output: ${cliVersion}`);
  }
  for (const label of ['CLI:', 'Protocol:', 'Runtime:', 'Compiler:', 'Providers:', 'Build:']) {
    if (!componentVersions.includes(label)) {
      throw new Error(`Component version output is missing ${label}`);
    }
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error([
      `Command failed (${result.status}): ${command} ${args.join(' ')}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result;
}
