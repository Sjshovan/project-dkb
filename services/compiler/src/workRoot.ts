import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

const SAFE_WORK_PREFIX = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function compilerWorkRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.DKB_COMPILER_WORK_ROOT?.trim();
  if (!configured) return path.resolve(os.tmpdir());
  if (!path.isAbsolute(configured)) {
    throw new DkbError('DKB_COMPILER_WORK_ROOT must be an absolute path');
  }
  return path.resolve(configured);
}

export async function createCompilerWorkDirectory(
  prefix: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (!SAFE_WORK_PREFIX.test(prefix)) {
    throw new DkbError('Compiler work directory prefix may contain only letters, numbers, dots, dashes, and underscores');
  }

  const root = compilerWorkRoot(environment);
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, prefix));
}
