import fs from 'node:fs/promises';
import path from 'node:path';
import { validateEvidenceBuildLock } from '@sjshovan/dkb-protocol/builds.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { captureFileSnapshot, assertFileSnapshotCurrent } from '@sjshovan/dkb-protocol/fileSnapshot.js';
import { parseDkbIdentity } from '@sjshovan/dkb-protocol/identity.js';
import { loadManifest } from '@sjshovan/dkb-protocol/manifest.js';
import type { DkbEvidenceInspection, DkbEvidenceInspectionField } from '@sjshovan/dkb-protocol/packageInspection.js';
import { resolveContainedPath } from '@sjshovan/dkb-protocol/paths.js';
import { assertNoSymlinkPath } from '@sjshovan/dkb-protocol/security/sourceContent.js';
import { listPackageBuilds } from './builds.js';
import { readEvidenceCatalog } from './evidenceCatalog.js';
import { libraryStatePath, readLibraryState } from './state.js';

interface EvidenceInspectionInput {
  libraryRoot: string; identity: string; version: string; evidenceDigest: string; evidenceId: string;
}

export async function inspectInstalledEvidence(input: EvidenceInspectionInput): Promise<DkbEvidenceInspection> {
  try { return await inspectEvidence(input); }
  catch (error) {
    if (error instanceof DkbError) throw error;
    throw new DkbError(`Cannot inspect retained Evidence: ${error instanceof Error ? error.message : String(error)}. `
      + `Run dkb show ${input.identity} --library "${path.resolve(input.libraryRoot)}" to inspect retained builds; no substitute was opened.`, 'historical_evidence_unavailable');
  }
}

async function inspectEvidence(input: EvidenceInspectionInput): Promise<DkbEvidenceInspection> {
  const root = path.resolve(input.libraryRoot);
  const identity = parseDkbIdentity(input.identity, 'Evidence package identity').identity;
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.evidenceDigest) || !/^sha256:[a-f0-9]{64}$/u.test(input.evidenceId)) {
    throw new DkbError('Evidence inspection requires an exact Evidence Build digest and Evidence ID.', 'invalid_evidence_inspection');
  }
  if (!input.version || input.version.length > 256 || /[\0\r\n]/u.test(input.version)) throw new DkbError('An exact package version is required.', 'invalid_evidence_inspection');
  const recovery = `The exact historical record is unavailable. Run dkb show ${identity} --library "${root}" to inspect retained versions and builds. No current build was substituted.`;
  const state = await readLibraryState(root);
  const entry = state.entries[identity];
  if (!entry || entry.kind !== 'dkb' || entry.status !== 'installed' || entry.version !== input.version) throw new DkbError(recovery, 'historical_evidence_unavailable');
  const packageRoot = resolveContainedPath(root, entry.path, 'Evidence package path');
  await assertNoSymlinkPath(root, packageRoot);
  await assertNoSymlinkPath(root, path.join(packageRoot, '.dkb', 'builds', 'evidence'));
  const matches = (await listPackageBuilds(packageRoot)).evidence.filter((build) => build.evidenceDigest === input.evidenceDigest);
  if (matches.length !== 1) throw new DkbError(recovery, 'historical_evidence_unavailable');
  const build = matches[0]!;
  const files = ['evidence.ir.json', 'evidence.lock.json', 'evidence.catalog.sqlite'].map((name) => path.join(build.path, name));
  for (const file of files) await assertNoSymlinkPath(root, file);
  const ledgerPath = libraryStatePath(root);
  const snapshot = await captureFileSnapshot([ledgerPath, `${ledgerPath}-wal`, path.join(packageRoot, 'dkb.json'), build.path, ...files]);
  const manifest = await loadManifest(packageRoot);
  const lock = validateEvidenceBuildLock(JSON.parse(await fs.readFile(files[1]!, 'utf8')), files[1]);
  const catalog = readEvidenceCatalog(build.path);
  if (manifest.type !== 'dkb' || manifest.name !== identity || manifest.version !== input.version
    || lock.package.id !== identity || lock.package.version !== input.version
    || lock.evidenceDigest !== input.evidenceDigest || lock.evidenceProfileDigest !== build.profileDigest
    || catalog.evidenceDigest !== input.evidenceDigest || catalog.evidenceProfileDigest !== build.profileDigest
    || lock.recordCount !== catalog.records.length || lock.chunkCount !== catalog.records.length
    || catalog.records.some((record) => record.packageId !== identity || record.packageVersion !== input.version)) {
    throw new DkbError(`The retained Evidence Build does not match ${identity}@${input.version}. ${recovery}`, 'historical_evidence_mismatch');
  }
  const record = catalog.records.find((item) => item.evidenceId === input.evidenceId);
  if (!record) throw new DkbError(`That Evidence ID is not part of the requested Evidence Build. ${recovery}`, 'historical_evidence_unavailable');
  const result: DkbEvidenceInspection = {
    format: 'dkb.evidence-inspection.v1', identity, version: input.version,
    evidenceDigest: catalog.evidenceDigest, evidenceProfileDigest: catalog.evidenceProfileDigest,
    evidenceId: record.evidenceId, sourceId: record.sourceId, sourceHash: record.sourceHash, textHash: record.textHash,
    assetId: record.assetId, storeId: record.storeId, sourceType: record.sourceType, updatedAt: record.updatedAt,
    chunk: { ordinal: record.chunkOrdinal, start: record.chunkStart, end: record.chunkEnd },
    title: bounded(record.title, 4096), text: bounded(record.text, 65_536),
    locator: bounded(JSON.stringify(record.locator, null, 2), 16_384),
    assetLocator: bounded(JSON.stringify(record.assetLocator, null, 2), 16_384),
    provenance: bounded(JSON.stringify(record.provenance, null, 2), 16_384),
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 262_144) throw new DkbError('Evidence identity metadata exceeds the bounded inspection limit.', 'evidence_inspection_too_large');
  const current = await readLibraryState(root);
  if (current.generation !== state.generation || stableHash(current.entries[identity] ?? null) !== stableHash(entry)) {
    throw new DkbError(`The Library changed during Evidence inspection. ${recovery}`, 'historical_evidence_changed');
  }
  await assertFileSnapshotCurrent(snapshot);
  return result;
}

function bounded(value: string, limit: number): DkbEvidenceInspectionField {
  const bytes = Buffer.byteLength(value);
  if (bytes <= limit) return { value, bytes, truncated: false };
  const buffer = Buffer.from(value);
  let end = limit;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return { value: buffer.subarray(0, end).toString('utf8'), bytes, truncated: true };
}
