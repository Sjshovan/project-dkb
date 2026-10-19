import { DEFAULT_DKB_DISTRIBUTION } from '@sjshovan/dkb-distribution-default';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { inspectStackOwnerState } from './ownerInspection.js';
import { configureStackOwner } from './ownerConfiguration.js';
import { initializeStackOwner } from './ownerInitialization.js';
import { planStackOwnerRequest } from './ownerContract.js';

// Private offline composition root. No paths, code, environment or credentials come from the request.
try {
  if (process.platform !== 'linux' || process.argv.length !== 2) throw new Error('Unsupported owner invocation');
  const chunks: Buffer[] = [];
  let size = 0;
  const timer = setTimeout(() => process.stdin.destroy(new Error('Owner input timed out')), 10_000);
  try {
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 256 * 1024) throw new Error('Owner input exceeds 256 KiB');
      chunks.push(bytes);
    }
  } finally { clearTimeout(timer); }
  const request = planStackOwnerRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  const execute = request.command === 'inspect' ? inspectStackOwnerState
    : request.command === 'binding.initialize' ? initializeStackOwner : configureStackOwner;
  const result = await execute(DEFAULT_DKB_DISTRIBUTION,
    { compilerRoot: '/context', runtimeRoot: '/state', libraryRoot: '/library' }, request);
  process.stdout.write(`${JSON.stringify({ ok: true, value: result })}\n`);
} catch (error) {
  // Plugin/config errors can contain operator secrets. Report bounded known categories, never raw messages.
  const code = error instanceof DkbError && /^[a-z_]{1,80}$/u.test(error.code) ? error.code : 'stack_owner_inspection_failed';
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code,
    message: 'Stack owner operation failed. Inspect the mounted Library, Runtime and pending configuration journal in their owning environment before retrying. No activation was written by this operation.' } })}\n`);
  process.exitCode = 1;
}
