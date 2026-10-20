import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startDisposableStack } from './lib/disposable-stack.mjs';
import { prepareMultispaceFixture } from './lib/multispace-fixture.mjs';

const executeFile = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repositoryRoot, 'apps', 'cli', 'dist', 'cli', 'index.js');
const requestedTarget = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
const initialTarget = process.env.DKB_PROOF_INITIAL_TARGET?.trim()
  || requestedTarget
  || 'fastembed-faiss';
const singleTarget = process.argv.includes('--single-target');
const alternateTarget = Object.hasOwn(process.env, 'DKB_PROOF_ALTERNATE_TARGET')
  ? process.env.DKB_PROOF_ALTERNATE_TARGET?.trim() ?? ''
  : singleTarget ? '' : 'tei-faiss';
const proofEnvironment = {
  DKB_PROOF_ALTERNATE_TARGET: alternateTarget,
  DKB_PROOF_VERSION: process.env.DKB_PROOF_VERSION ?? `0.0.${Math.floor(Date.now() / 1000)}`,
  // This disposable Stack contains only the synthetic citation/security corpus.
  DKB_MCP_PUBLIC_DOCUMENTS: 'true',
};
const stack = await startDisposableStack({
  repositoryRoot,
  cliPath,
  prefix: 'multispace-proof',
  target: initialTarget,
  environment: proofEnvironment,
  ...(alternateTarget ? {
    prepare: (input) => prepareMultispaceFixture({ ...input, repositoryRoot, initial: initialTarget, alternate: alternateTarget }),
  } : {}),
});

try {
  const proof = await executeFile(process.execPath, [path.join(repositoryRoot, 'scripts', 'prove-stack-lifecycle.mjs')], {
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
