import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LIBRARY_OWNER_ROOT, planLibraryOwnerCommand } from './libraryOwnerContract.js';

// Private image entrypoint. No HTTP listener, shell, host paths, or arbitrary argv.
try {
  if (process.platform !== 'linux' || process.argv.length !== 2) throw new Error('Library owner execution requires the Linux CLI image without command arguments.');
  const chunks: Buffer[] = [];
  let bytes = 0;
  const inputTimer = setTimeout(() => process.stdin.destroy(new Error('Library owner request timed out.')), 10_000);
  try {
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 16 * 1024) throw new Error('Library owner request exceeds 16 KiB.');
      chunks.push(buffer);
    }
  } finally { clearTimeout(inputTimer); }
  const plan = planLibraryOwnerCommand(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  const cli = fileURLToPath(new URL('../cli/index.js', import.meta.url));
  const child = spawn(process.execPath, [cli, ...plan.argv], {
    shell: false, cwd: LIBRARY_OWNER_ROOT, stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      PATH: process.env.PATH, HOME: '/tmp/dkb-owner', NODE_ENV: 'production', NO_COLOR: '1',
      DKB_HOST_INVENTORY: '/tmp/dkb-owner/host.json', DKB_GLOBAL_ROOT: '/tmp/dkb-owner/global',
      DKB_CLI_CONFIG: '/tmp/dkb-owner/config.json', DKB_RUNTIME_CREDENTIALS_ROOT: '/tmp/dkb-owner/credentials',
    },
  });
  const timeout = setTimeout(() => child.kill('SIGTERM'), plan.timeoutMs);
  process.exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 124 : 1)));
  }).finally(() => clearTimeout(timeout));
} catch {
  // Input may contain secrets or untrusted content; never echo it into logs.
  process.stdout.write(JSON.stringify({ ok: false, error: { code: 'invalid_library_owner_request', message: 'Invalid owner request or CLI worker failure. Use a matching DKB CLI image and a supported typed operation.' } }) + '\n');
  process.exitCode = 2;
}
