import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  compilerWorkRoot,
  createCompilerWorkDirectory,
} from '@sjshovan/dkb-compiler/workRoot.js';

test('compiler work directories use the configured absolute shared root', async (context) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-compiler-work-root-'));
  const root = path.join(parent, 'shared', 'jobs');
  context.after(() => fs.rm(parent, { recursive: true, force: true }));

  const created = await createCompilerWorkDirectory('registry-job-', {
    DKB_COMPILER_WORK_ROOT: root,
  });

  assert.equal(compilerWorkRoot({ DKB_COMPILER_WORK_ROOT: root }), path.resolve(root));
  assert.equal(path.dirname(created), path.resolve(root));
  assert.match(path.basename(created), /^registry-job-/);
  assert.equal((await fs.stat(created)).isDirectory(), true);
});

test('compiler work roots and prefixes reject ambiguous paths', async () => {
  assert.throws(
    () => compilerWorkRoot({ DKB_COMPILER_WORK_ROOT: 'relative/jobs' }),
    /must be an absolute path/,
  );
  await assert.rejects(
    createCompilerWorkDirectory('../escape-', { DKB_COMPILER_WORK_ROOT: os.tmpdir() }),
    /prefix may contain only/,
  );
});
