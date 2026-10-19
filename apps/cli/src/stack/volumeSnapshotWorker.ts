import { createStackVolumeSnapshot } from './volumeSnapshot.js';
import { stageStackVolumeRestore } from './volumeRestore.js';
import { snapshotError } from './volumeSnapshotInventory.js';
import { validateSnapshotRequest } from './snapshotContract.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

// Private offline worker. Host mounts only acknowledged snapshot/staging volumes;
// input cannot choose a path, executable, environment variable or network target.
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());
try {
  if (process.platform !== 'linux' || process.argv.length !== 2) throw snapshotError('Unsupported snapshot worker invocation.');
  let bytes = 0; const chunks: Buffer[] = [];
  const timer = setTimeout(() => process.stdin.destroy(snapshotError('Snapshot input timed out.')), 10_000);
  try {
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk); bytes += buffer.length;
      if (bytes > 65_536) throw snapshotError('Snapshot request exceeds 64 KiB.');
      chunks.push(buffer);
    }
  } finally { clearTimeout(timer); }
  const request = validateSnapshotRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  const { storage } = request;
  if (request.command === 'snapshot') {
    await createStackVolumeSnapshot('/snapshot', storage, process.stdout, request.limits, controller.signal);
  } else {
    const snapshot = await stageStackVolumeRestore('/input/archive', '/snapshot', request.sha256!, request.limits, controller.signal);
    if (stableHash(snapshot.storage) !== stableHash(storage)) throw snapshotError('Restored storage receipt differs from the requested snapshot.');
    process.stdout.write(`${JSON.stringify({ ok: true, format: request.format, status: 'staged', snapshotDigest: stableHash(snapshot), bytes: snapshot.bytes })}\n`);
  }
} catch (error) {
  // stdout is a binary archive for snapshots. Never append a JSON error to it,
  // echo source paths/secrets, or imply a failed partial stream may be promoted.
  const code = error instanceof DkbError && /^[a-z_]{1,80}$/u.test(error.code) ? error.code : 'stack_snapshot_failed';
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code,
    message: 'Snapshot operation failed. Original storage is unchanged. Retain staging until the worker is confirmed stopped; do not activate or promote partial output.' } })}\n`);
  process.exitCode = 1;
}
