import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { isDkbIdentity } from '@sjshovan/dkb-protocol/identity.js';
import { loadDkbPackage } from '@sjshovan/dkb-protocol/manifest.js';
import type { DkbRuntimeActivationEntry } from '@sjshovan/dkb-protocol/runtimeActivation.js';
import { assertSourceWritePath, assertSupportedWritePolicy, permitsSourceWrite } from '@sjshovan/dkb-protocol/writePaths.js';
import { readSourceRevisions, retainSourceRevision, SOURCE_HISTORY, sourceHistoryInputs } from './sourceRevisions.js';
import { assertFileSnapshotCurrent, captureFileSnapshot } from '@sjshovan/dkb-protocol/fileSnapshot.js';
import { evaluateDkbWriteIntent } from '@sjshovan/dkb-protocol/writeGate.js';
import { validateStoredPackageBuild } from './builds.js';
import { readEvidenceCatalog } from './evidenceCatalog.js';
import { withDkbFileLock } from './locks.js';
import { promoteLibraryPath, stageLibraryLock, withLibraryMutation, writeLibraryMutationFile } from './mutation.js';
import { assertSafePath, pathReceipt } from './mutationPaths.js';
import { listPortablePackageDirectory } from './packageTree.js';
import { evaluateDkbWrite } from '@sjshovan/dkb-protocol/writeGate.js';
import { hashPortablePackageTree } from './packageTree.js';
import { maybeReadLibraryLock, readLibraryState } from './state.js';

export interface DkbAppendRequest {
  dkbId: string;
  requestId: string;
  text: string;
  evidenceRefs: string[];
  confirmed?: boolean;
  operation?: 'append' | 'create';
  path?: string;
  expectedSourceHash?: string;
}

export interface DkbAppendReceipt {
  format: 'dkb.append.v1' | 'dkb.source-write.v2';
  operation?: 'append' | 'create';
  beforeSourceHash?: string;
  requestId: string;
  requestHash: string;
  dkbId: string;
  packageVersion: string;
  assetLocator: { path: string };
  sourceHash: string;
  packageSourceHash: string;
  libraryGeneration: number;
  evidenceIds: string[];
  selection: DkbRuntimeActivationEntry;
}

export type PrepareDkbAppend = (input: {
  sourceRoot: string;
  libraryRoot: string;
  target: string;
}) => Promise<DkbRuntimeActivationEntry>;

/** Operator-selected compiler; never chosen by an MCP argument or source text. */
export async function appendLocalDkb(options: {
  libraryRoot: string;
  target: string;
  previousSelection: DkbRuntimeActivationEntry;
  expectedGeneration: number;
  request: DkbAppendRequest;
  prepare: PrepareDkbAppend;
}): Promise<{ receipt: DkbAppendReceipt; selection: DkbRuntimeActivationEntry }> {
  validateRequest(options.request);
  const libraryRoot = path.resolve(options.libraryRoot);
  return withDkbFileLock(libraryRoot, 'library-mutation', async () => {
    const request = options.request;
    const state = await readLibraryState(libraryRoot);
    const entry = state.entries[request.dkbId];
    if (!entry || entry.status !== 'installed' || entry.kind !== 'dkb' || entry.source !== 'local') {
      throw new DkbError('Append requires an installed, editable local DKB in this Runtime Library.', 'append_target_unavailable');
    }
    const packageRoot = path.resolve(libraryRoot, entry.path);
    if (path.dirname(packageRoot) !== libraryRoot) {
      throw new DkbError('Append targets must be direct editable Library children.', 'append_target_invalid');
    }
    await assertSafePath(libraryRoot, packageRoot);
    const assertPermission = async () => {
      const dkb = await loadDkbPackage(packageRoot, request.dkbId);
      if (dkb.manifest.id !== request.dkbId || dkb.manifest.version !== entry.version) {
        throw new DkbError('The installed package identity/version changed. Synchronize the Library first.', 'append_target_changed');
      }
      if (dkb.manifest.permissions?.write !== true) {
        throw new DkbError('Append is denied: permissions.write must explicitly be true in the target dkb.json. Ask the operator to authorize this package; do not edit permissions through MCP.', 'append_permission_denied');
      }
      assertSupportedWritePolicy(dkb.manifest.write);
      const gate = evaluateDkbWriteIntent(dkb, { operation: request.operation ?? 'append', evidenceRefs: request.evidenceRefs });
      if (gate.status !== 'accepted') {
        throw new DkbError(`Append is denied (${gate.reason ?? gate.status}). The operator must allow append in direct mode; queued writes are unsupported.`, 'append_permission_denied');
      }
      if (gate.capabilities.writePolicy.confirmationRequired && request.confirmed !== true) {
        throw new DkbError('This package requires explicit user confirmation for this append. Obtain it before retrying with confirmed=true.', 'append_confirmation_required');
      }
      return dkb;
    };
    const dkb = await assertPermission();
    const targeted = request.path !== undefined;
    const operation = request.operation ?? 'append';
    const filename = request.path ?? `append-${request.requestId}.md`;
    const assertDestinationPolicy = (manifest = dkb.manifest) => {
      if (!targeted && manifest.write?.paths) throw new DkbError('write.paths disables legacy generated-asset append; select an explicit create or append destination.', 'append_target_required');
      if (targeted && !permitsSourceWrite(manifest.write!, operation, filename)) throw new DkbError('Destination is not allowed by write.paths, or is excluded.', 'append_permission_denied');
    };
    assertDestinationPolicy();
    const sourcePath = path.join(packageRoot, filename);
    const receiptPath = path.join(packageRoot, '.dkb', 'appends', `${request.requestId}.json`);
    await assertSafePath(libraryRoot, sourcePath);
    await assertSafePath(libraryRoot, receiptPath);
    const requestHash = stableHash({ dkbId: request.dkbId, requestId: request.requestId, text: request.text, evidenceRefs: request.evidenceRefs,
      ...(targeted ? { operation, path: filename, expectedSourceHash: request.expectedSourceHash ?? null } : {}) });
    const existing = await readReceipt(receiptPath);
    if (existing) {
      if (!['dkb.append.v1', 'dkb.source-write.v2'].includes(existing.format) || existing.requestHash !== requestHash
        || existing.dkbId !== request.dkbId || existing.packageVersion !== dkb.manifest.version
        || existing.assetLocator.path !== filename) {
        throw new DkbError('This requestId already identifies different or changed content. Preserve the earlier append; use a new requestId only for a new fact.', 'append_request_conflict');
      }
      await validateStoredPackageBuild(packageRoot, existing.selection);
      const historical = await readSourceRevisions(packageRoot, request.dkbId, dkb.manifest.version);
      if (hash(await fs.readFile(sourcePath)) !== existing.sourceHash
        && !historical.some(item => item.record.sourceHash === existing.sourceHash && item.record.assetLocator.path === filename)) {
        throw new DkbError('The receipt source changed without a retained revision.', 'append_request_conflict');
      }
      if (state.generation === existing.libraryGeneration && (await hashPortablePackageTree(packageRoot)).hash === existing.packageSourceHash) {
        return { receipt: existing, selection: existing.selection };
      }
      const current = await validateStoredPackageBuild(packageRoot, options.previousSelection);
      const currentRecords = [...readEvidenceCatalog(current.evidencePath).records, ...historical.map(item => item.record)];
      if (state.generation === options.expectedGeneration && existing.evidenceIds.every(id => currentRecords.some(record => record.evidenceId === id && record.sourceHash === existing.sourceHash))) {
        return { receipt: existing, selection: options.previousSelection };
      }
      throw new DkbError('Later source changes prevent replaying this older activation. Refresh the most recent append first; the earlier fact was preserved.', 'append_replay_requires_refresh');
    }
    if ((!targeted || operation === 'create') && await pathReceipt(sourcePath) !== null) {
      throw new DkbError('The append asset already exists without a matching receipt. No content was replaced; ask the operator to inspect it.', 'append_request_conflict');
    }
    if (state.generation !== options.expectedGeneration) {
      throw new DkbError('This Runtime is stale. Refresh it before appending a new fact; retry a committed append only with its original requestId.', 'append_runtime_stale');
    }
    const previousBytes = targeted && operation === 'append' ? await readAppendSource(sourcePath) : null;
    if (previousBytes && hash(previousBytes) !== request.expectedSourceHash) throw new DkbError('Source changed since destination selection; discover it again.', 'append_source_stale');
    const sourceBytes = Buffer.concat([previousBytes ?? Buffer.alloc(0), Buffer.from(request.text)]);
    if (sourceBytes.length > 16 * 1024 * 1024) throw new DkbError('The resulting text source exceeds 16 MiB.', 'append_text_invalid');
    const sourceHash = hash(sourceBytes);
    const historyPath = path.join(packageRoot, SOURCE_HISTORY);
    const historyFence = await captureFileSnapshot([historyPath]);
    const historyReceipt = await pathReceipt(historyPath);
    const historySnapshot = await captureFileSnapshot(await sourceHistoryInputs(packageRoot), { recursive: true });
    await assertFileSnapshotCurrent(historyFence);
    await readSourceRevisions(packageRoot, request.dkbId, dkb.manifest.version);
    const previous = await validateStoredPackageBuild(packageRoot, options.previousSelection);
    const previousEvidence = readEvidenceCatalog(previous.evidencePath).records;
    const before = await hashPortablePackageTree(packageRoot);
    const stagingParent = path.join(libraryRoot, '.dkb', 'tmp');
    await assertSafePath(libraryRoot, stagingParent);
    await fs.mkdir(stagingParent, { recursive: true });
    const staging = path.join(stagingParent, `append-${randomUUID()}`);
    await fs.mkdir(staging);
    try {
      // Copy canonical inputs only. Operator plugins/config stay in the trusted context.
      for (const relative of before.files) {
        const input = path.join(packageRoot, relative);
        await assertSafePath(libraryRoot, input);
        const destination = path.join(staging, relative);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(input, destination);
      }
      if ((await hashPortablePackageTree(staging)).hash !== before.hash) {
        throw new DkbError('Source changed while preparing the append. Retry after the current author finishes.', 'append_source_changed');
      }
      // Exact caller text; never synthesize headings or conversation/provenance paragraphs.
      const stagedSource = path.join(staging, filename);
      await fs.mkdir(path.dirname(stagedSource), { recursive: true });
      await fs.writeFile(stagedSource, sourceBytes, { flag: previousBytes ? 'w' : 'wx' });
      const stagedHash = (await hashPortablePackageTree(staging)).hash;
      const selection = await options.prepare({ sourceRoot: staging, libraryRoot, target: options.target });
      if ((await hashPortablePackageTree(staging)).hash !== stagedHash) throw new DkbError('Compiler changed canonical staged sources.', 'append_source_changed');
      if (selection.version !== dkb.manifest.version
        || selection.evidenceProfileDigest !== options.previousSelection.evidenceProfileDigest
        || selection.retrievalProfileDigest !== options.previousSelection.retrievalProfileDigest) {
        throw new DkbError('Append compilation changed the package version or active Pipeline profile.', 'append_build_incompatible');
      }
      const graph = await validateStoredPackageBuild(staging, selection);
      const records = readEvidenceCatalog(graph.evidencePath).records;
      const byId = new Map(records.map(record => [record.evidenceId, record]));
      for (const old of previousEvidence) {
        if (previousBytes && old.assetLocator.path === filename) {
          if (old.sourceHash !== hash(previousBytes)) throw new DkbError('Selected source does not match the active evidence revision.', 'append_source_stale');
          continue; // Replaced by exact byte-prefix preservation and transactionally retained old source/build.
        }
        const retained = byId.get(old.evidenceId);
        if (!retained || retained.text !== old.text || retained.sourceHash !== old.sourceHash) {
          throw new DkbError('Append compilation did not preserve prior evidence. The original package remains unchanged.', 'append_evidence_changed');
        }
      }
      const added = records.filter(record => record.assetLocator.path === filename && record.sourceHash === sourceHash);
      if (!added.length) {
        throw new DkbError('The selected Pipeline did not ingest the appended Markdown asset. No source was committed; use a Pipeline that supports this source format.', 'append_source_unsupported');
      }
      if ((await hashPortablePackageTree(packageRoot)).hash !== before.hash) {
        throw new DkbError('Source changed during append preparation. No source was committed; retry after the current author finishes.', 'append_source_changed');
      }
      assertDestinationPolicy((await assertPermission()).manifest);
      await assertFileSnapshotCurrent(historySnapshot);
      const receipt: DkbAppendReceipt = {
        format: targeted ? 'dkb.source-write.v2' : 'dkb.append.v1', requestId: request.requestId, requestHash,
        ...(targeted ? { operation, ...(previousBytes ? { beforeSourceHash: hash(previousBytes) } : {}) } : {}),
        dkbId: request.dkbId, packageVersion: dkb.manifest.version,
        assetLocator: { path: filename }, sourceHash,
        packageSourceHash: (await hashPortablePackageTree(staging)).hash, libraryGeneration: state.generation + 1,
        evidenceIds: added.map(record => record.evidenceId), selection,
      };
      await withLibraryMutation(libraryRoot, async () => {
        const lock = await maybeReadLibraryLock(libraryRoot);
        if (!lock) throw new DkbError('Append requires a resolved Library lock.', 'append_target_unavailable');
        // Recheck the precise source immediately before promotion, not only before compilation.
        await assertSafePath(libraryRoot, sourcePath);
        const expected = previousBytes ? 'file:' + hash(previousBytes).slice(7) : null;
        if (await pathReceipt(sourcePath) !== expected) throw new DkbError('Destination changed before commit.', 'append_source_stale');
        if (previousBytes) await retainSourceRevision(libraryRoot, packageRoot, {
          path: filename, sourceHash: hash(previousBytes), selection: options.previousSelection,
          evidenceIds: previousEvidence.filter(record => record.assetLocator.path === filename).map(record => record.evidenceId),
        }, previousBytes, historyReceipt);
        await writeLibraryMutationFile(libraryRoot, sourcePath, sourceBytes, expected);
        for (const build of [graph.evidencePath, graph.retrievalPath]) {
          const destination = path.join(packageRoot, path.relative(staging, build));
          await assertSafePath(libraryRoot, destination);
          const present = await pathReceipt(destination);
          if (present !== null) {
            if (present !== await pathReceipt(build)) throw new DkbError('An immutable build collides with the append result.', 'append_build_collision');
          } else {
            await promoteLibraryPath(libraryRoot, build, destination);
          }
        }
        await writeLibraryMutationFile(libraryRoot, receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
        await writeLibraryMutationFile(libraryRoot, path.join(packageRoot, '.dkb', 'append-current.json'), `${JSON.stringify(receipt, null, 2)}\n`);
        // The source generation changes even when package version/manifest do not.
        stageLibraryLock(libraryRoot, { ...lock, generation: lock.generation + 1, resolvedAt: new Date().toISOString() });
      });
      return { receipt, selection };
    } finally {
      await assertSafePath(libraryRoot, staging);
      await fs.rm(staging, { recursive: true, force: true });
    }
  });
}

/**
 * An exact committed selection, not a newest-build heuristic. Lifecycle refresh
 * can reuse it after restart and other Runtimes can catch up to this source.
 */
export async function currentLocalAppendSelection(packageRoot: string): Promise<DkbRuntimeActivationEntry | null> {
  const filename = path.join(packageRoot, '.dkb', 'append-current.json');
  await assertSafePath(path.dirname(packageRoot), filename);
  const receipt = await readReceipt(filename);
  if (!receipt) return null;
  if (!['dkb.append.v1', 'dkb.source-write.v2'].includes(receipt.format) || (await hashPortablePackageTree(packageRoot)).hash !== receipt.packageSourceHash) {
    throw new DkbError('Package source changed after its committed append selection. Reconcile and compile the operator changes before refreshing; no historical build was guessed.', 'append_source_changed');
  }
  return receipt.selection;
}

function validateRequest(request: DkbAppendRequest): void {
  if (request.operation !== undefined && !['append', 'create'].includes(request.operation)) throw new DkbError('Unsupported source operation.', 'append_target_invalid');
  if (request.path !== undefined) {
    assertSourceWritePath(request.path);
    if ((request.operation ?? 'append') === 'append' && !/^sha256:[a-f0-9]{64}$/u.test(request.expectedSourceHash ?? '')) throw new DkbError('Existing-source append requires its expectedSourceHash.', 'append_source_stale');
    if (request.operation === 'create' && request.expectedSourceHash !== undefined) throw new DkbError('Create requires a missing target, not a source hash.', 'append_target_invalid');
  } else if (request.operation === 'create' || request.expectedSourceHash !== undefined) throw new DkbError('Targeted writes require a path.', 'append_target_invalid');
  if (typeof request.requestId !== 'string' || !isDkbIdentity(request.dkbId) || !/^[a-zA-Z0-9_-]{1,80}$/u.test(request.requestId)) {
    throw new DkbError('Use a canonical @namespace/name target and a 1–80 character requestId containing only letters, digits, underscores or hyphens.', 'append_target_invalid');
  }
  if (typeof request.text !== 'string' || !request.text.trim() || Buffer.byteLength(request.text) > 64 * 1024 || request.text.includes('\0') || Buffer.from(request.text).toString('utf8') !== request.text) {
    throw new DkbError('Append requires nonempty UTF-8 text, at most 64 KiB, without NUL bytes.', 'append_text_invalid');
  }
  if (!Array.isArray(request.evidenceRefs) || !request.evidenceRefs.length || request.evidenceRefs.length > 32
    || request.evidenceRefs.some(ref => typeof ref !== 'string' || !ref.trim() || ref.length > 2048)) {
    throw new DkbError('Supply 1–32 caller-known evidence references. DKB does not invent or authenticate conversation attribution.', 'append_evidence_required');
  }
}

async function readAppendSource(filename: string): Promise<Buffer> {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw new DkbError('Append requires a regular, unlinked text source of at most 16 MiB.', 'append_target_invalid');
  const bytes = await fs.readFile(filename);
  try { new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new DkbError('Existing source is not valid UTF-8.', 'append_text_invalid'); }
  if (bytes.includes(0)) throw new DkbError('Existing source contains NUL bytes.', 'append_text_invalid');
  return bytes;
}

async function readReceipt(filename: string): Promise<DkbAppendReceipt | null> {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')) as DkbAppendReceipt; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new DkbError('The saved append receipt cannot be read. Preserve it and ask the operator to inspect the package.', 'append_receipt_invalid');
  }
}

function hash(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}


/** Discovery is advisory; writes repeat all checks under exclusive ownership. */
export async function listLocalDkbWriteTargets(libraryRoot: string, dkbId: string, after = '') {
  const root = path.resolve(libraryRoot);
  return withDkbFileLock(root, 'library-mutation', async () => {
    const state = await readLibraryState(root);
    const entry = state.entries[dkbId];
    if (!entry || entry.status !== 'installed' || entry.kind !== 'dkb' || entry.source !== 'local') throw new DkbError('Not an editable installed DKB.', 'append_target_unavailable');
    const packageRoot = path.resolve(root, entry.path);
    if (path.dirname(packageRoot) !== root) throw new DkbError('Expected a direct Library child.', 'append_target_invalid');
    await assertSafePath(root, packageRoot);
    const dkb = await loadDkbPackage(packageRoot, dkbId);
    if (dkb.manifest.version !== entry.version || dkb.manifest.permissions?.write !== true) throw new DkbError('Package write permission is unavailable.', 'append_permission_denied');
    assertSupportedWritePolicy(dkb.manifest.write);
    const write = dkb.manifest.write!;
    const appendAllowed = evaluateDkbWrite(dkb, 'append').status === 'accepted';
    const createAllowed = evaluateDkbWrite(dkb, 'create').status === 'accepted';
    const candidates: string[] = [];
    let visited = 0;
    const visit = async (directory: string) => {
      let cursor: string | undefined;
      do {
        const page = await listPortablePackageDirectory({ root: packageRoot, directory, cursor });
        for (const item of page.entries) {
          if (++visited > 10_000) throw new DkbError('Write discovery is limited to 10000 source entries.', 'write_discovery_limit');
          if (item.kind === 'directory') {
            try { assertSourceWritePath(item.path + '/probe.md'); } catch { continue; }
            await visit(item.path);
          } else {
            try { if (appendAllowed && permitsSourceWrite(write, 'append', item.path)) candidates.push(item.path); } catch (error) {
              if (!(error instanceof DkbError) || error.code !== 'write_policy_invalid') throw error;
            }
          }
          if (candidates.length > 10_000) throw new DkbError('Too many writable files; narrow write.paths.', 'write_discovery_limit');
        }
        cursor = page.nextCursor;
      } while (cursor);
    };
    if (appendAllowed && write.paths) await visit('.');
    const selected = candidates.sort().filter(item => item > after).slice(0, 101);
    const existing = [];
    for (const relative of selected.slice(0, 100)) {
      const filename = path.join(packageRoot, relative);
      await assertSafePath(root, filename);
      const bytes = await readAppendSource(filename);
      existing.push({ path: relative, operation: 'append' as const, format: /\.md$/iu.test(relative) ? 'text/markdown' : 'text/plain',
        sourceHash: hash(bytes), bytes: bytes.length, dkbId, packageVersion: entry.version });
    }
    return { dkbId, packageVersion: entry.version, libraryGeneration: state.generation,
      confirmationRequired: write.confirmationRequired ?? false,
      legacyGeneratedAppend: !write.paths && appendAllowed, existing,
      creation: { operation: 'create' as const, allow: createAllowed ? write.paths?.create ?? [] : [],
        exclude: write.paths?.exclude ?? [], formats: ['text/markdown', 'text/plain'], sourceHash: null,
        requiresMissingTarget: true, reservedPathsAlwaysDenied: true, patternSyntax: 'dkb-write-glob-v1' },
      ...(selected.length > 100 ? { nextCursor: selected[99] } : {}) };
  }, { purpose: 'read' });
}
