import { spawn, execFile as execFileCallback, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { resolveDockerImageIdentity } from '@sjshovan/dkb-pipeline/serviceIdentity.js';
import {
  FAISS_HELPER_TIMEOUT_MS,
  FAISS_PROVIDER_IMAGE,
} from './constants.js';

const execFile = promisify(execFileCallback);

export interface FaissSearchHit {
  id: string;
  score: number;
}

export interface FaissExecutionOptions { imageDigest?: string }

export async function faissProviderHealth(options: FaissExecutionOptions = {}): Promise<{ ok: boolean; detail: string }> {
  const serviceUrl = configuredFaissServiceUrl();
  if (serviceUrl) {
    try {
      const result = await requestFaissService(serviceUrl, '/health', { method: 'GET' });
      return { ok: result.ok === true, detail: result.ok === true ? `FAISS service ${serviceUrl}` : 'FAISS service unhealthy' };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  const dockerImage = configuredFaissDockerImage();
  try {
    if (dockerImage) {
      const imageId = await resolveDockerImageIdentity(dockerImage, options.imageDigest);
      return { ok: true, detail: `FAISS helper image ${imageId}` };
    }
    assertNativeExecutionAllowed(options);
    await execFile(faissPython(), ['-c', 'import faiss; print(faiss.__version__)'], { timeout: FAISS_HELPER_TIMEOUT_MS });
    return { ok: true, detail: `FAISS available through ${faissPython()}` };
  } catch (error) {
    return { ok: false, detail: `FAISS helper unavailable: ${commandDetail(error)}` };
  }
}

export class FaissHelperClient {
  private process?: ChildProcessWithoutNullStreams;
  private pending: Array<{ resolve: (value: FaissHelperResponse) => void; reject: (error: Error) => void }> = [];
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private dockerImage: string | null = null;
  private dockerSegmentMounts: Array<{ hostDir: string; containerDir: string }> = [];
  private readonly serviceUrl = configuredFaissServiceUrl();
  private serviceSessionId?: string;

  constructor(private readonly execution: FaissExecutionOptions = {}) {}

  async load(input: { dimensions: number; segments: Array<{ path: string }> }): Promise<void> {
    if (this.serviceUrl) {
      const result = await requestFaissService(this.serviceUrl, '/sessions', {
        method: 'POST',
        body: { dimensions: input.dimensions, segments: input.segments },
      });
      if (!result.ok || typeof result.sessionId !== 'string') {
        throw new DkbError(`FAISS service load failed: ${result.error ?? 'missing session ID'}`);
      }
      this.serviceSessionId = result.sessionId;
      return;
    }

    await this.ensureStarted(input.segments);
    const result = await this.request({
      op: 'load',
      dimensions: input.dimensions,
      segments: this.containerSegments(input.segments),
    });

    if (!result.ok) {
      throw new DkbError(`FAISS helper load failed: ${result.error ?? 'unknown error'}`);
    }
  }

  async search(vector: number[], limit: number): Promise<{ hits: FaissSearchHit[] }> {
    if (this.serviceUrl) {
      if (!this.serviceSessionId) throw new DkbError('FAISS service session is not loaded');
      const result = await requestFaissService(this.serviceUrl, `/sessions/${encodeURIComponent(this.serviceSessionId)}/search`, {
        method: 'POST',
        body: { vector, limit },
      });
      if (!result.ok || !Array.isArray(result.hits)) {
        throw new DkbError(`FAISS service search failed: ${result.error ?? 'unknown error'}`);
      }
      return { hits: result.hits.filter(isFaissSearchHit) };
    }

    await this.ensureStarted();
    const result = await this.request({ op: 'search', vector, limit });

    if (!result.ok || !Array.isArray(result.hits)) {
      throw new DkbError(`FAISS helper search failed: ${result.error ?? 'unknown error'}`);
    }

    return {
      hits: result.hits.filter(isFaissSearchHit),
    };
  }

  async close(): Promise<void> {
    if (this.serviceUrl) {
      const sessionId = this.serviceSessionId;
      this.serviceSessionId = undefined;
      if (sessionId) {
        await requestFaissService(this.serviceUrl, `/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      }
      return;
    }

    if (!this.process) {
      return;
    }
    const child = this.process;
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      child.once('exit', () => resolve());
    });

    try {
      await this.request({ op: 'close' });
      child.stdin.end();
      await waitForExit(exited, 1_000);
    } catch {
      // Process shutdown is best-effort; callers invalidate the snapshot.
      child.kill();
    }
    this.process = undefined;
  }

  private async ensureStarted(segments: Array<{ path: string }> = []): Promise<void> {
    if (this.process) {
      return;
    }
    const helperPath = faissHelperPath();
    const selectedImage = configuredFaissDockerImage();
    if (!selectedImage) assertNativeExecutionAllowed(this.execution);
    const dockerImage = selectedImage ? await resolveDockerImageIdentity(selectedImage, this.execution.imageDigest) : null;
    this.dockerImage = dockerImage;
    const child = dockerImage
      ? spawn('docker', [
        'run',
        '--rm',
        '-i',
        '--entrypoint',
        'python',
        '-v',
        `${path.dirname(helperPath)}:/dkb-faiss:ro`,
        ...this.prepareDockerSegmentMounts(segments).flatMap((mount) => ['-v', `${mount.hostDir}:${mount.containerDir}:ro`]),
        dockerImage,
        '/dkb-faiss/faiss_helper.py',
        'serve',
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      : spawn(faissPython(), [helperPath, 'serve'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.process = child;
    this.stderrBuffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-8000);
    });
    child.on('error', (error) => this.rejectAll(error));
    child.on('exit', (code) => {
      this.process = undefined;
      const detail = this.stderrBuffer.trim();
      const message = `FAISS helper exited with code ${code ?? 'unknown'}${detail ? `: ${detail}` : ''}`;

      this.rejectAll(new Error(message));
    });
    await this.request({ op: 'health' });
  }

  private prepareDockerSegmentMounts(segments: Array<{ path: string }>): Array<{ hostDir: string; containerDir: string }> {
    this.dockerSegmentMounts = segments.map((segment, index) => ({
      hostDir: path.dirname(path.resolve(segment.path)),
      containerDir: `/segments/${index}`,
    }));

    return this.dockerSegmentMounts;
  }

  private containerSegments(segments: Array<{ path: string }>): Array<{ path: string }> {
    if (!this.dockerImage || this.dockerSegmentMounts.length === 0) {
      return segments;
    }

    return segments.map((segment, index) => ({
      path: `${this.dockerSegmentMounts[index]?.containerDir ?? `/segments/${index}`}/${path.basename(segment.path)}`,
    }));
  }

  private request(payload: Record<string, unknown>): Promise<FaissHelperResponse> {
    const child = this.process;

    if (!child) {
      return Promise.reject(new Error('FAISS helper is not running'));
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('FAISS helper request timed out'));
      }, FAISS_HELPER_TIMEOUT_MS);

      this.pending.push({
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (this.stdoutBuffer.includes('\n')) {
      const index = this.stdoutBuffer.indexOf('\n');
      const line = this.stdoutBuffer.slice(0, index).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      const pending = this.pending.shift();

      if (!pending || !line) {
        continue;
      }
      try {
        pending.resolve(JSON.parse(line) as FaissHelperResponse);
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.splice(0)) {
      pending.reject(error);
    }
  }
}

async function waitForExit(exited: Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      exited,
      new Promise<void>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Timed out waiting for FAISS helper exit')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

type FaissHelperResponse = {
  ok?: boolean;
  error?: string;
  sessionId?: unknown;
  hits?: unknown;
};

function isFaissSearchHit(value: unknown): value is FaissSearchHit {
  return Boolean(value)
    && typeof value === 'object'
    && typeof (value as { id?: unknown }).id === 'string'
    && typeof (value as { score?: unknown }).score === 'number';
}

export async function runFaissHelper(args: string[], options: FaissExecutionOptions = {}): Promise<void> {
  const serviceUrl = configuredFaissServiceUrl();
  if (serviceUrl && args[0] === 'build') {
    const vectors = optionValue(args, '--vectors');
    const output = optionValue(args, '--out');
    if (!vectors || !output) throw new DkbError('FAISS service build requires --vectors and --out paths.');
    const result = await requestFaissService(serviceUrl, '/build', {
      method: 'POST',
      body: { vectors, output },
      timeoutMs: Math.max(FAISS_HELPER_TIMEOUT_MS, 5 * 60_000),
    });
    if (!result.ok) throw new DkbError(`FAISS service build failed: ${result.error ?? 'unknown error'}`);
    return;
  }

  const dockerImage = configuredFaissDockerImage();

  if (dockerImage && args[0] === 'build') {
    await runFaissHelperInDocker(await resolveDockerImageIdentity(dockerImage, options.imageDigest), args);

    return;
  }
  assertNativeExecutionAllowed(options);

  try {
    await execFile(faissPython(), [faissHelperPath(), ...args], {
      timeout: FAISS_HELPER_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    throw new DkbError(`FAISS helper failed: ${commandDetail(error)}`);
  }
}

async function runFaissHelperInDocker(image: string, args: string[]): Promise<void> {
  const vectorsPath = optionValue(args, '--vectors');
  const outputPath = optionValue(args, '--out');

  if (!vectorsPath || !outputPath) {
    throw new DkbError('Docker FAISS helper build requires --vectors and --out paths.');
  }

  const helperDir = path.dirname(faissHelperPath());
  const vectorsDir = path.dirname(vectorsPath);
  const outputDir = path.dirname(outputPath);

  try {
    await execFile('docker', [
      'run',
      '--rm',
      '--entrypoint',
      'python',
      '-v',
      `${helperDir}:/dkb-faiss:ro`,
      '-v',
      `${vectorsDir}:/vectors:ro`,
      '-v',
      `${outputDir}:/out`,
      image,
      '/dkb-faiss/faiss_helper.py',
      'build',
      '--vectors',
      `/vectors/${path.basename(vectorsPath)}`,
      '--out',
      `/out/${path.basename(outputPath)}`,
    ], {
      timeout: FAISS_HELPER_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    throw new DkbError(`Docker FAISS helper failed: ${commandDetail(error)}`);
  }
}

function faissPython(): string {
  return process.env.DKB_FAISS_PYTHON ?? process.env.PYTHON ?? 'python';
}

function assertNativeExecutionAllowed(options: FaissExecutionOptions): void {
  if (options.imageDigest) throw new DkbError('FAISS native Python cannot verify the selected imageDigest. Enable the pinned Docker helper or configure its trusted service endpoint.');
}

function configuredFaissDockerImage(): string | null {
  if (process.env.DKB_FAISS_DOCKER_IMAGE === 'none') {
    return null;
  }
  if (process.env.DKB_FAISS_DOCKER_IMAGE) {
    return process.env.DKB_FAISS_DOCKER_IMAGE;
  }
  if (process.env.DKB_FAISS_PYTHON) {
    return null;
  }

  return FAISS_PROVIDER_IMAGE;
}

function configuredFaissServiceUrl(): string | null {
  const value = process.env.DKB_FAISS_SERVICE_URL?.trim();
  return value ? value.replace(/\/+$/u, '') : null;
}

async function requestFaissService(
  baseUrl: string,
  route: string,
  options: { method: 'GET' | 'POST' | 'DELETE'; body?: Record<string, unknown>; timeoutMs?: number },
): Promise<FaissHelperResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? FAISS_HELPER_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}${route}`, {
      method: options.method,
      headers: options.body ? { 'content-type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const detail = typeof payload.detail === 'string' ? payload.detail : `HTTP ${response.status}`;
      throw new DkbError(`FAISS service request failed: ${detail}`);
    }
    return payload as FaissHelperResponse;
  } catch (error) {
    if (error instanceof DkbError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new DkbError(`Unable to reach FAISS service at ${baseUrl}: ${detail}`);
  } finally {
    clearTimeout(timeout);
  }
}

function optionValue(args: string[], option: string): string | null {
  const index = args.indexOf(option);

  return index >= 0 && typeof args[index + 1] === 'string' ? args[index + 1] : null;
}

function faissHelperPath(): string {
  const current = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(current, '../python/faiss/faiss_helper.py'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));

  if (!found) {
    throw new DkbError(`FAISS helper script not found. Checked: ${candidates.join(', ')}`);
  }

  return found;
}

function commandDetail(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error) {
    return `${String((error as { stdout?: unknown }).stdout ?? '')}${String((error as { stderr?: unknown }).stderr ?? '')}`.trim();
  }
  return error instanceof Error ? error.message : String(error);
}
