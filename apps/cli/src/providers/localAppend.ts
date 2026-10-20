import fs from 'node:fs/promises';
import path from 'node:path';
import { validateRetrievalBuildLock } from '@sjshovan/dkb-protocol/builds.js';
import type { PrepareDkbAppend } from '@sjshovan/dkb-library/append.js';
import { compileLocalComposeProject } from './localCompilation.js';

/** The operator's existing trusted compiler composition, never selected by MCP input. */
export const prepareLocalAppend: PrepareDkbAppend = async ({ sourceRoot, libraryRoot, target }) => {
  const built = await compileLocalComposeProject(sourceRoot, { contextRoot: libraryRoot, target });
  const lock = validateRetrievalBuildLock(JSON.parse(await fs.readFile(
    path.join(built.retrievalBuildPath, 'retrieval.lock.json'), 'utf8',
  )));
  return {
    version: lock.package.version, evidenceProfileDigest: lock.evidenceProfileDigest,
    evidenceDigest: lock.evidenceDigest, retrievalProfileDigest: lock.retrievalProfileDigest,
    retrievalBuildDigest: lock.retrievalBuildDigest,
  };
};
