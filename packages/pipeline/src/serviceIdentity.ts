import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { isSha256Digest } from './validation.js';

const execFile = promisify(execFileCallback);

/** Resolve the actual local image, not its mutable tag, before executing it. */
export async function resolveDockerImageIdentity(image: string, expectedDigest?: string): Promise<string> {
  if (!image || image.startsWith('-')) throw new DkbError('A Docker image reference is required.');
  if (expectedDigest !== undefined && !isSha256Digest(expectedDigest)) throw new DkbError('Expected Docker image identity must be an exact sha256 digest.');
  const referenceDigest = image.includes('@') ? image.slice(image.lastIndexOf('@') + 1) : undefined;
  if (referenceDigest !== undefined && !isSha256Digest(referenceDigest)) throw new DkbError('Docker image references must use an exact sha256 digest.');
  let value: unknown;
  try {
    const result = await execFile('docker', ['image', 'inspect', image], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    value = JSON.parse(result.stdout) as unknown;
  } catch {
    throw new DkbError(`Cannot verify Docker image ${image}. Pull or build the selected image, then retry.`);
  }
  const record = Array.isArray(value) && value.length === 1 ? value[0] as Record<string, unknown> : undefined;
  if (!record || !isSha256Digest(record.Id)) throw new DkbError(`Docker returned an invalid immutable image identity for ${image}.`);
  const digests = new Set([record.Id]);
  if (Array.isArray(record.RepoDigests)) {
    for (const item of record.RepoDigests) {
      if (typeof item !== 'string') continue;
      const digest = item.slice(item.lastIndexOf('@') + 1);
      if (isSha256Digest(digest)) digests.add(digest);
    }
  }
  for (const required of [referenceDigest, expectedDigest]) {
    if (required !== undefined && !digests.has(required)) {
      throw new DkbError(`Docker image identity mismatch for ${image}: the selected image does not match ${required}. Restore the pinned image or select a new Pipeline build.`);
    }
  }
  // Executing this ID prevents a tag being retargeted between inspection and run.
  return record.Id;
}
