import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startDisposableStack } from './lib/disposable-stack.mjs';

const executeFile = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repositoryRoot, 'apps', 'cli', 'dist', 'cli', 'index.js');
const target = process.env.DKB_REAL_CORPUS_TARGET?.trim() || 'default';
const stack = await startDisposableStack({
  repositoryRoot,
  cliPath,
  prefix: 'real-corpus-proof',
  target,
});

try {
  const proof = await executeFile(process.execPath, [path.join(repositoryRoot, 'scripts', 'prove-real-corpus.mjs')], {
    cwd: repositoryRoot,
    env: stack.environment,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 90 * 60_000,
    windowsHide: true,
  });
  process.stdout.write(proof.stdout);
  if (proof.stderr) process.stderr.write(proof.stderr);
} finally {
  await stack.cleanup();
}
