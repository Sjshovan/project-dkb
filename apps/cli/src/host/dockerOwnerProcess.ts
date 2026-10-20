import { spawn } from 'node:child_process';
import { Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

/** Bound Docker control calls; request bytes are stdin, never process arguments. */
export async function ownerDockerProcess(args: string[], options: {
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onOutput?: (channel: 'stdout' | 'stderr', bytes: Buffer) => void;
  /** Binary output is streamed with backpressure, never buffered or decoded. */
  stdout?: Writable;
  maxStdoutBytes?: number;
} = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  if (options.stdout && (!Number.isSafeInteger(options.maxStdoutBytes) || options.maxStdoutBytes! <= 0)) {
    throw new DkbError('Binary owner output requires an explicit positive byte limit.', 'library_owner_output_limit');
  }
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] };
    let size = 0, failure: Error | undefined;
    const terminate = (error: Error) => {
      failure ??= error;
      child.kill();
      if (options.stdout) child.stdout.destroy(error);
    };
    const abort = () => terminate(new DkbError('Library owner operation cancelled. Check Library status before retrying.', 'library_owner_cancelled'));
    const timer = setTimeout(() => terminate(new DkbError('Library owner operation timed out. Check Library status before retrying.', 'library_owner_timeout')), options.timeoutMs ?? 10_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    let binaryBytes = 0;
    const streamed = options.stdout ? pipeline(child.stdout, new Transform({
      transform(bytes: Buffer, _encoding, done) {
        binaryBytes += bytes.length;
        if (binaryBytes > options.maxStdoutBytes!) {
          done(new DkbError('Owner archive exceeds its destination byte budget. Free disk space or select another backup location.', 'library_owner_output_limit'));
        } else done(null, bytes);
      },
    }), options.stdout).catch(error => terminate(error instanceof DkbError ? error : new DkbError(
      'Owner archive streaming failed. Check destination space and permissions; partial output is not a backup.', 'library_owner_output_failed'))) : Promise.resolve();
    for (const channel of (options.stdout ? ['stderr'] : ['stdout', 'stderr']) as Array<'stdout' | 'stderr'>) {
      child[channel].on('data', (bytes: Buffer) => {
        size += bytes.length;
        if (size > 16 * 1024 * 1024) {
          terminate(new DkbError('Library owner output exceeds 16 MiB. Request a bounded inspection.', 'library_owner_output_limit'));
          return;
        }
        output[channel].push(bytes);
        try { options.onOutput?.(channel, bytes); } catch { terminate(new DkbError('Library owner output consumer failed.', 'library_owner_output_failed')); }
      });
    }
    // A failed Docker preflight may close stdin before consuming a request.
    child.stdin.on('error', () => {});
    child.once('error', () => { failure ??= new DkbError('Docker could not be started. Start Docker Desktop and retry.', 'library_owner_docker_unavailable'); });
    child.once('close', async code => {
      await streamed;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else resolve({ code: code ?? 1, stdout: Buffer.concat(output.stdout).toString('utf8'), stderr: Buffer.concat(output.stderr).toString('utf8') });
    });
    child.stdin.end(options.input);
  });
}
