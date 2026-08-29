import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { DKB_PACKAGE_MEDIA_TYPE } from './archive.js';

const execFile = promisify(execFileCallback);

export const ORAS_DOCKER_IMAGE = 'ghcr.io/oras-project/oras:v1.2.3';
export const COSIGN_DOCKER_IMAGE = 'gcr.io/projectsigstore/cosign:v2.4.1';

export interface OciToolAvailability {
  docker: boolean;
  orasBinary: boolean;
  cosignBinary: boolean;
  orasDockerImage: boolean;
  cosignDockerImage: boolean;
}

export interface OciPushResult {
  status: 'pushed';
  ref: string;
  toolRef: string;
  digest: string | null;
  archivePath: string;
}

export interface OciPullResult {
  status: 'pulled';
  ref: string;
  toolRef: string;
  outputDir: string;
  files: string[];
}

export interface CosignKeyPairResult {
  status: 'created';
  keyPath: string;
  publicKeyPath: string;
}

export interface CosignSignResult {
  status: 'signed';
  ref: string;
  toolRef: string;
}

export interface CosignVerifyResult {
  ok: boolean;
  ref: string;
  toolRef: string;
  output: string;
}

export async function inspectOciToolAvailability(): Promise<OciToolAvailability> {
  return {
    docker: await commandOk('docker', ['--version']),
    orasBinary: await commandOk('oras', ['version']),
    cosignBinary: await commandOk('cosign', ['version']),
    orasDockerImage: await dockerImageRuns(ORAS_DOCKER_IMAGE, ['version']),
    cosignDockerImage: await dockerImageRuns(COSIGN_DOCKER_IMAGE, ['version']),
  };
}

export async function orasPushArtifact(input: {
  archivePath: string;
  ref: string;
}): Promise<OciPushResult> {
  const archivePath = path.resolve(input.archivePath);
  const toolRef = dockerToolRegistryRef(input.ref);
  const output = await runOras([
    'push',
    '--plain-http',
    toolRef,
    `${path.basename(archivePath)}:${DKB_PACKAGE_MEDIA_TYPE}`,
  ], {
    mountDir: path.dirname(archivePath),
  });

  return {
    status: 'pushed',
    ref: input.ref,
    toolRef,
    digest: digestFrom(output),
    archivePath,
  };
}

export async function orasPullArtifact(input: {
  ref: string;
  outputDir: string;
}): Promise<OciPullResult> {
  const outputDir = path.resolve(input.outputDir);
  const toolRef = dockerToolRegistryRef(input.ref);

  await fs.mkdir(outputDir, { recursive: true });
  await runOras([
    'pull',
    '--plain-http',
    toolRef,
    '-o',
    '/workspace',
  ], {
    mountDir: outputDir,
  });

  return {
    status: 'pulled',
    ref: input.ref,
    toolRef,
    outputDir,
    files: await listRelativeFiles(outputDir),
  };
}

export async function cosignGenerateKeyPair(input: {
  outputPrefix: string;
  password: string;
}): Promise<CosignKeyPairResult> {
  const outputPrefix = path.resolve(input.outputPrefix);
  const outputDir = path.dirname(outputPrefix);
  const baseName = path.basename(outputPrefix);

  await fs.mkdir(outputDir, { recursive: true });
  await runCosign([
    'generate-key-pair',
    '--output-key-prefix',
    `/workspace/${baseName}`,
  ], {
    mountDir: outputDir,
    password: input.password,
  });

  return {
    status: 'created',
    keyPath: `${outputPrefix}.key`,
    publicKeyPath: `${outputPrefix}.pub`,
  };
}

export async function cosignSignArtifact(input: {
  ref: string;
  keyPath: string;
  password: string;
}): Promise<CosignSignResult> {
  const keyPath = path.resolve(input.keyPath);
  const toolRef = dockerToolRegistryRef(input.ref);

  await runCosign([
    'sign',
    '--key',
    `/workspace/${path.basename(keyPath)}`,
    '--allow-http-registry',
    '--allow-insecure-registry',
    '--tlog-upload=false',
    '--yes',
    toolRef,
  ], {
    mountDir: path.dirname(keyPath),
    password: input.password,
  });

  return {
    status: 'signed',
    ref: input.ref,
    toolRef,
  };
}

export async function cosignVerifyArtifact(input: {
  ref: string;
  publicKeyPath: string;
}): Promise<CosignVerifyResult> {
  const publicKeyPath = path.resolve(input.publicKeyPath);
  const toolRef = dockerToolRegistryRef(input.ref);

  try {
    const output = await runCosign([
      'verify',
      '--key',
      `/workspace/${path.basename(publicKeyPath)}`,
      '--allow-http-registry',
      '--allow-insecure-registry',
      '--insecure-ignore-tlog',
      toolRef,
    ], {
      mountDir: path.dirname(publicKeyPath),
    });

    return {
      ok: true,
      ref: input.ref,
      toolRef,
      output,
    };
  } catch (error) {
    return {
      ok: false,
      ref: input.ref,
      toolRef,
      output: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runOras(args: string[], options: { mountDir: string }): Promise<string> {
  return runDockerTool(ORAS_DOCKER_IMAGE, args, {
    mountDir: options.mountDir,
  });
}

async function runCosign(args: string[], options: { mountDir: string; password?: string }): Promise<string> {
  return runDockerTool(COSIGN_DOCKER_IMAGE, args, {
    mountDir: options.mountDir,
    env: options.password ? { COSIGN_PASSWORD: options.password } : {},
  });
}

async function runDockerTool(image: string, args: string[], options: {
  mountDir: string;
  env?: Record<string, string>;
}): Promise<string> {
  const dockerArgs = [
    'run',
    '--rm',
    ...Object.entries(options.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    '-v',
    `${path.resolve(options.mountDir)}:/workspace`,
    '-w',
    '/workspace',
    image,
    ...args,
  ];

  try {
    const result = await execFile('docker', dockerArgs, {
      timeout: 180_000,
      maxBuffer: 20 * 1024 * 1024,
    });

    return `${result.stdout}${result.stderr}`;
  } catch (error) {
    const detail = error && typeof error === 'object' && 'stdout' in error
      ? `${String((error as { stdout?: unknown }).stdout ?? '')}${String((error as { stderr?: unknown }).stderr ?? '')}`
      : error instanceof Error ? error.message : String(error);

    throw new DkbError(`Dockerized OCI tool failed: ${detail.trim()}`);
  }
}

async function commandOk(command: string, args: string[]): Promise<boolean> {
  try {
    await execFile(command, args, { timeout: 30_000 });

    return true;
  } catch {
    return false;
  }
}

async function dockerImageRuns(image: string, args: string[]): Promise<boolean> {
  try {
    await execFile('docker', ['run', '--rm', image, ...args], {
      timeout: 180_000,
      maxBuffer: 20 * 1024 * 1024,
    });

    return true;
  } catch {
    return false;
  }
}

function dockerToolRegistryRef(ref: string): string {
  return ref.replace(/^localhost:/, 'host.docker.internal:').replace(/^127\.0\.0\.1:/, 'host.docker.internal:');
}

function digestFrom(output: string): string | null {
  return output.match(/Digest:\s*(sha256:[a-f0-9]+)/i)?.[1] ?? null;
}

async function listRelativeFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name);

    if (entry.isDirectory()) {
      return (await listRelativeFiles(target)).map((item) => `${entry.name}/${item}`);
    }

    return entry.isFile() ? [entry.name] : [];
  }));

  return nested.flat().sort((left, right) => left.localeCompare(right));
}
