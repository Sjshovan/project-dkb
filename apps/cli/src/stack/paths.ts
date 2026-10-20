import os from 'node:os';
import path from 'node:path';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

export function stackStateRoot(): string {
  return path.resolve(process.env.DKB_STACK_STATE_ROOT ?? path.join(os.homedir(), '.dkb', 'stacks'));
}

export function stackName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u.test(normalized)) {
    throw new DkbError('Stack name must use 1-64 lowercase letters, numbers, dots, dashes, or underscores.');
  }
  return normalized;
}

/** Host-only coordination survives replacement of the Stack data directory. */
export function stackControlRoot(name: string): string {
  return path.join(stackStateRoot(), '.control', stackName(name));
}
