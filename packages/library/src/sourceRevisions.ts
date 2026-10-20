import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbRuntimeActivationEntry } from '@sjshovan/dkb-protocol/runtimeActivation.js';
import type { DkbEvidenceCatalogRecord } from '@sjshovan/dkb-protocol/evidence/catalog.js';
import { evidenceBuildPath, retrievalBuildPath } from '@sjshovan/dkb-protocol/paths.js';
import { assertSourceWritePath } from '@sjshovan/dkb-protocol/writePaths.js';
import { validateStoredPackageBuild } from './builds.js';
import { readEvidenceCatalog } from './evidenceCatalog.js';
import { assertSafePath } from './mutationPaths.js';
import { writeLibraryMutationFile } from './mutation.js';

export const SOURCE_HISTORY = '.dkb/source-history.json';
export interface SourceRevision {
  path: string;
  sourceHash: string;
  selection: DkbRuntimeActivationEntry;
  evidenceIds: string[];
}
export interface HistoricalEvidence {
  record: DkbEvidenceCatalogRecord;
  selection: DkbRuntimeActivationEntry;
}
const digest = /^sha256:[a-f0-9]{64}$/u;
export function sourceRevisionPath(root: string, hash: string): string {
  if (!digest.test(hash)) throw invalid();
  return path.join(root, '.dkb', 'source-revisions', hash.slice(7) + '.txt');
}

export async function sourceHistory(root: string): Promise<SourceRevision[]> {
  const filename = path.join(root, SOURCE_HISTORY);
  await assertSafePath(path.dirname(root), filename);
  let value;
  try { value = JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw invalid(); }
  if (value?.format !== 'dkb.source-history.v1' || !Array.isArray(value.revisions)) throw invalid();
  for (const revision of value.revisions) {
    if (!revision || typeof revision.path !== 'string' || !digest.test(revision.sourceHash)
      || !revision.selection || typeof revision.selection.version !== 'string'
      || !['evidenceProfileDigest', 'evidenceDigest', 'retrievalProfileDigest', 'retrievalBuildDigest']
        .every(key => typeof revision.selection[key] === 'string' && digest.test(revision.selection[key]))
      || !Array.isArray(revision.evidenceIds) || !revision.evidenceIds.every((id: unknown) => typeof id === 'string' && digest.test(id))) throw invalid();
    assertSourceWritePath(revision.path);
  }
  return value.revisions;
}

/** Exact retained inputs, not a scan of arbitrary historical builds. */
export async function sourceHistoryInputs(root: string): Promise<string[]> {
  return [path.join(root, SOURCE_HISTORY), ... (await sourceHistory(root)).flatMap(revision => [
    sourceRevisionPath(root, revision.sourceHash),
    evidenceBuildPath(root, revision.selection.evidenceProfileDigest, revision.selection.evidenceDigest),
    retrievalBuildPath(root, revision.selection.retrievalProfileDigest, revision.selection.retrievalBuildDigest),
  ])];
}

export async function readSourceRevisions(root: string, dkbId: string, version: string): Promise<HistoricalEvidence[]> {
  const records: HistoricalEvidence[] = [];
  for (const revision of await sourceHistory(root)) {
    if (revision.selection.version !== version) continue; // Retention is scoped to the installed version.
    const source = sourceRevisionPath(root, revision.sourceHash);
    for (const filename of [source, evidenceBuildPath(root, revision.selection.evidenceProfileDigest, revision.selection.evidenceDigest),
      retrievalBuildPath(root, revision.selection.retrievalProfileDigest, revision.selection.retrievalBuildDigest)]) await assertSafePath(path.dirname(root), filename);
    if (hash(await fs.readFile(source)) !== revision.sourceHash) throw invalid();
    const graph = await validateStoredPackageBuild(root, revision.selection);
    if (graph.evidence.package.id !== dkbId) throw invalid();
    const prior = readEvidenceCatalog(graph.evidencePath).records.filter(record => record.packageId === dkbId
      && record.packageVersion === version && record.assetLocator.path === revision.path && record.sourceHash === revision.sourceHash);
    if (prior.length !== revision.evidenceIds.length || !prior.every(record => revision.evidenceIds.includes(record.evidenceId))) throw invalid();
    records.push(...prior.map(record => ({ record, selection: revision.selection })));
  }
  return records;
}

/** Called inside the same Library journal transaction as the revised source. */
export async function retainSourceRevision(libraryRoot: string, root: string, revision: SourceRevision, bytes: Uint8Array, expectedHistoryReceipt: string | null): Promise<void> {
  if (hash(bytes) !== revision.sourceHash) throw invalid();
  const filename = sourceRevisionPath(root, revision.sourceHash);
  await assertSafePath(libraryRoot, filename);
  try { if (hash(await fs.readFile(filename)) !== revision.sourceHash) throw invalid(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeLibraryMutationFile(libraryRoot, filename, bytes, null);
  }
  const revisions = await sourceHistory(root);
  if (!revisions.some(item => item.path === revision.path && item.sourceHash === revision.sourceHash
    && item.selection.evidenceDigest === revision.selection.evidenceDigest)) revisions.push(revision);
  await writeLibraryMutationFile(libraryRoot, path.join(root, SOURCE_HISTORY), JSON.stringify({ format: 'dkb.source-history.v1', revisions }, null, 2) + '\n', expectedHistoryReceipt);
}
function hash(bytes: Uint8Array): string { return 'sha256:' + createHash('sha256').update(bytes).digest('hex'); }
function invalid(): DkbError { return new DkbError('Retained source revision is invalid or changed; preserve it and recover before serving citations.', 'source_revision_invalid'); }
