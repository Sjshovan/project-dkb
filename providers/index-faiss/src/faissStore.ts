import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { resolveFrom } from '@sjshovan/dkb-protocol/paths.js';
import type { LoadedDkb } from '@sjshovan/dkb-protocol/types.js';
import type { DkbRetrievalPipeline, DkbRuntimePackageBuild } from '@sjshovan/dkb-pipeline/types.js';
import { FaissHelperClient, runFaissHelper } from './faissHelperClient.js';

export { faissProviderHealth } from './faissHelperClient.js';
export type { FaissSearchHit } from './faissHelperClient.js';
import type { FaissSearchHit } from './faissHelperClient.js';
export { FAISS_HELPER_SERVICE_PORT, FAISS_PROVIDER_IMAGE } from './constants.js';

export const FAISS_ARTIFACT_DIR = 'faiss';
export const FAISS_CATALOG_PATH = `${FAISS_ARTIFACT_DIR}/chunks.sqlite`;
export const FAISS_SEGMENT_PATH = `${FAISS_ARTIFACT_DIR}/chunks.faiss`;
export const FAISS_MANIFEST_PATH = `${FAISS_ARTIFACT_DIR}/manifest.json`;
const FAISS_ARTIFACT_FORMAT = 'dkb.faiss.package.v1';
const FAISS_RUNTIME_FORMAT = 'dkb.faiss.runtime.v1';

export interface FaissEmbeddingProfile {
  embeddingProvider: string;
  model: string;
  dimensions: number;
  metric: 'cosine';
  normalized: true;
  index: 'IndexIDMap2(IndexFlatIP)';
}

export interface FaissPackageManifest {
  format: typeof FAISS_ARTIFACT_FORMAT;
  packageId: string;
  packageVersion: string;
  chunkCount: number;
  embedding: FaissEmbeddingProfile;
  files: {
    catalog: { path: typeof FAISS_CATALOG_PATH; hash: string; size: number };
    segment: { path: typeof FAISS_SEGMENT_PATH; hash: string; size: number };
  };
}

export interface FaissPackageRuntimeArtifact {
  dkb: LoadedDkb;
  manifest: FaissPackageManifest;
  catalogPath: string;
  segmentPath: string;
  documentCount: number;
  numericIdToEvidenceId: Map<string, string>;
}

export interface FaissRuntimeSnapshot {
  format: typeof FAISS_RUNTIME_FORMAT;
  root: string;
  registryId: string;
  artifactHash: string;
  embedding: FaissEmbeddingProfile;
  packages: Array<{ id: string; version: string; catalogPath: string; segmentPath: string; chunkCount: number }>;
  documentCount: number;
  numericIdToEvidenceId: Map<string, string>;
  helper: FaissHelperClient;
}

export interface FaissSearchResult {
  hits: FaissSearchHit[];
  trace: {
    engine: 'faiss';
    status: 'ready';
    packages: number;
    embedder: string;
    dimensions: number;
    index: string;
  };
}

export interface FaissPackageMutationResult {
  backend: {
    engine: 'faiss';
    status: 'ready';
    index: 'IndexShards';
    embedder: string;
    dimensions: number;
  };
  documentCount: number;
  timingsMs: {
    total: number;
    load: number;
    verify: number;
  };
}

interface FaissCompiledRecord {
  evidenceId: string;
  embedding: number[];
}

export async function writeFaissPackageArtifacts(
  root: string,
  dkb: LoadedDkb,
  compiled: DkbRetrievalPipeline,
  compatibility: Record<string, unknown>,
): Promise<FaissPackageManifest | null> {
  if (compiled.records.length === 0) {
    return null;
  }
  const vectorsByEvidenceId = retrievalVectorsByEvidenceId(compiled, dkb.manifest.id, dkb.manifest.version);
  const profile = embeddingProfileFor(compiled, compatibility);
  const records = compiled.records.map((record) => ({
    evidenceId: record.id,
    embedding: [...vectorsByEvidenceId.get(record.id)!],
  })).sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  const numericIdToRecord = new Map<string, FaissCompiledRecord>();

  for (const record of records) {
    assertCompatibleRecordEmbedding(record, profile, dkb.manifest.id, dkb.manifest.version);
    const numericId = faissNumericIdFor(dkb.manifest.id, dkb.manifest.version, record.evidenceId);

    if (numericIdToRecord.has(numericId)) {
      throw new DkbError(`FAISS numeric ID collision in ${dkb.manifest.id}@${dkb.manifest.version}: ${numericId}`);
    }
    numericIdToRecord.set(numericId, record);
  }

  const catalogPath = resolveFrom(root, FAISS_CATALOG_PATH);
  const segmentPath = resolveFrom(root, FAISS_SEGMENT_PATH);
  const manifestPath = resolveFrom(root, FAISS_MANIFEST_PATH);
  const tempDir = `${resolveFrom(root, FAISS_ARTIFACT_DIR)}.${process.pid}.${Date.now().toString(36)}.tmp`;
  const tempCatalog = path.join(tempDir, 'chunks.sqlite');
  const tempSegment = path.join(tempDir, 'chunks.faiss');
  const tempVectors = path.join(tempDir, 'vectors.json');

  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.mkdir(tempDir, { recursive: true });

  try {
    await writeFaissCatalog(tempCatalog, dkb, numericIdToRecord);
    await writeFaissVectors(tempVectors, dkb, records);
    await runFaissHelper(['build', '--vectors', tempVectors, '--out', tempSegment]);

    await fs.mkdir(path.dirname(catalogPath), { recursive: true });
    await replaceFile(tempCatalog, catalogPath);
    await replaceFile(tempSegment, segmentPath);

    const catalogDigest = await fileDigest(catalogPath);
    const segmentDigest = await fileDigest(segmentPath);
    const manifest: FaissPackageManifest = {
      format: FAISS_ARTIFACT_FORMAT,
      packageId: dkb.manifest.id,
      packageVersion: dkb.manifest.version,
      chunkCount: records.length,
      embedding: profile,
      files: {
        catalog: { path: FAISS_CATALOG_PATH, ...catalogDigest },
        segment: { path: FAISS_SEGMENT_PATH, ...segmentDigest },
      },
    };

    await writeJsonAtomic(manifestPath, manifest);

    return manifest;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function writeFaissVectors(target: string, dkb: LoadedDkb, records: FaissCompiledRecord[]): Promise<void> {
  async function* jsonChunks(): AsyncGenerator<string> {
    yield '{"ids":[';
    for (let index = 0; index < records.length; index += 1) {
      if (index > 0) {
        yield ',';
      }
      yield JSON.stringify(faissNumericIdFor(dkb.manifest.id, dkb.manifest.version, records[index]!.evidenceId));
    }
    yield '],"vectors":[';
    for (let index = 0; index < records.length; index += 1) {
      if (index > 0) {
        yield ',';
      }
      yield JSON.stringify(Array.from(records[index]!.embedding));
    }
    yield ']}\n';
  }

  await pipeline(
    Readable.from(jsonChunks()),
    createWriteStream(target, { encoding: 'utf8' }),
  );
}

export async function validateFaissPackageArtifact(root: string): Promise<FaissPackageManifest> {
  const manifestPath = resolveFrom(root, FAISS_MANIFEST_PATH);
  const manifest = parseFaissPackageManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')) as unknown, manifestPath);
  const catalogDigest = await fileDigest(resolveFrom(root, manifest.files.catalog.path));
  const segmentDigest = await fileDigest(resolveFrom(root, manifest.files.segment.path));

  if (catalogDigest.hash !== manifest.files.catalog.hash || catalogDigest.size !== manifest.files.catalog.size) {
    throw new DkbError(`FAISS catalog hash mismatch for ${manifest.packageId}@${manifest.packageVersion}`);
  }
  if (segmentDigest.hash !== manifest.files.segment.hash || segmentDigest.size !== manifest.files.segment.size) {
    throw new DkbError(`FAISS segment hash mismatch for ${manifest.packageId}@${manifest.packageVersion}`);
  }

  return manifest;
}

export async function loadFaissPackageArtifact(dkb: LoadedDkb, artifactsRoot: string): Promise<FaissPackageRuntimeArtifact> {
  const manifest = await validateFaissPackageArtifact(artifactsRoot);

  if (manifest.packageId !== dkb.manifest.id || manifest.packageVersion !== dkb.manifest.version) {
    throw new DkbError(`FAISS package manifest identity mismatch at ${dkb.root}`);
  }

  const catalogPath = resolveFrom(artifactsRoot, manifest.files.catalog.path);
  const numericIdToEvidenceId = readFaissCatalog(catalogPath);

  return {
    dkb,
    manifest,
    catalogPath,
    segmentPath: resolveFrom(artifactsRoot, manifest.files.segment.path),
    documentCount: numericIdToEvidenceId.size,
    numericIdToEvidenceId,
  };
}

export async function buildFaissRuntimeSnapshot(
  root: string,
  registryId: string,
  packages: readonly DkbRuntimePackageBuild[],
): Promise<FaissRuntimeSnapshot | null> {
  const ready = await Promise.all(packages.map(({ dkb, artifactsRoot }) => loadFaissPackageArtifact(dkb, artifactsRoot)));

  if (ready.length === 0) {
    return null;
  }

  const embedding = assertSingleEmbeddingProfile(ready.map((item) => item.manifest.embedding));
  const helper = new FaissHelperClient();

  try {
    await helper.load({
      dimensions: embedding.dimensions,
      segments: ready.map((item) => ({ path: item.segmentPath })),
    });
  } catch (error) {
    await helper.close().catch(() => undefined);
    throw error;
  }

  const numericIdToEvidenceId = new Map<string, string>();

  for (const item of ready) {
    for (const [numericId, evidenceId] of item.numericIdToEvidenceId.entries()) {
      if (numericIdToEvidenceId.has(numericId)) {
        await helper.close().catch(() => undefined);
        throw new DkbError(`FAISS runtime numeric ID collision: ${numericId}`);
      }
      numericIdToEvidenceId.set(numericId, evidenceId);
    }
  }

  return {
    format: FAISS_RUNTIME_FORMAT,
    root: path.resolve(root),
    registryId,
    artifactHash: stableHash({
      registryId,
      packages: ready.map((item) => ({
        id: item.manifest.packageId,
        version: item.manifest.packageVersion,
        catalog: item.manifest.files.catalog.hash,
        segment: item.manifest.files.segment.hash,
      })),
    }),
    embedding,
    packages: ready.map((item) => ({
      id: item.manifest.packageId,
      version: item.manifest.packageVersion,
      catalogPath: item.catalogPath,
      segmentPath: item.segmentPath,
      chunkCount: item.manifest.chunkCount,
    })),
    documentCount: ready.reduce((total, item) => total + item.documentCount, 0),
    numericIdToEvidenceId,
    helper,
  };
}

export async function searchFaissSnapshot(
  snapshot: FaissRuntimeSnapshot,
  query: string,
  limit: number,
  embedQuery: (query: string) => Promise<number[]>,
): Promise<FaissSearchResult> {
  const vector = await embedQuery(query);

  if (vector.length !== snapshot.embedding.dimensions) {
    throw new DkbError(`Query embedding dimension mismatch: expected ${snapshot.embedding.dimensions}, got ${vector.length}`);
  }
  const helperResult = await snapshot.helper.search(vector, limit);

  return {
    hits: helperResult.hits.flatMap((hit) => {
      const unitId = snapshot.numericIdToEvidenceId.get(hit.id);

      return unitId ? [{ id: unitId, score: hit.score }] : [];
    }),
    trace: {
      engine: 'faiss',
      status: 'ready',
      packages: snapshot.packages.length,
      embedder: snapshot.embedding.model,
      dimensions: snapshot.embedding.dimensions,
      index: snapshot.embedding.index,
    },
  };
}

export async function closeFaissSnapshot(snapshot?: FaissRuntimeSnapshot): Promise<void> {
  await snapshot?.helper.close();
}

export async function validateFaissPackageQueryability(dkb: LoadedDkb, artifactsRoot: string): Promise<void> {
  const artifact = await loadFaissPackageArtifact(dkb, artifactsRoot);
  if (artifact.documentCount === 0) {
    throw new DkbError(`FAISS package has no queryable chunks: ${dkb.manifest.id}@${dkb.manifest.version}`);
  }
  if (artifact.manifest.chunkCount !== artifact.documentCount) {
    throw new DkbError(`FAISS package catalog count mismatch: ${dkb.manifest.id}@${dkb.manifest.version}`);
  }
}

export async function validateFaissRuntimeReady(input: {
  root: string;
  registryId: string;
  packages: readonly DkbRuntimePackageBuild[];
  packageId?: string;
  packageVersion?: string;
}): Promise<FaissPackageMutationResult> {
  const started = performanceNow();
  const loadStart = performanceNow();
  const snapshot = await buildFaissRuntimeSnapshot(input.root, input.registryId, input.packages);
  const loadMs = performanceNow() - loadStart;

  try {
    if (!snapshot) {
      throw new DkbError('FAISS runtime has no active compiled package segments');
    }
    if (input.packageId && !snapshot.packages.some((item) => item.id === input.packageId && (!input.packageVersion || item.version === input.packageVersion))) {
      throw new DkbError(`FAISS runtime did not activate ${input.packageId}${input.packageVersion ? `@${input.packageVersion}` : ''}`);
    }

    return {
      backend: {
        engine: 'faiss',
        status: 'ready',
        index: 'IndexShards',
        embedder: snapshot.embedding.model,
        dimensions: snapshot.embedding.dimensions,
      },
      documentCount: snapshot.documentCount,
      timingsMs: {
        total: roundMs(performanceNow() - started),
        load: roundMs(loadMs),
        verify: roundMs(performanceNow() - started - loadMs),
      },
    };
  } finally {
    await closeFaissSnapshot(snapshot ?? undefined);
  }
}

function embeddingProfileFor(compiled: DkbRetrievalPipeline, compatibility: Record<string, unknown>): FaissEmbeddingProfile {
  const dimensions = compiled.vectors[0]?.values.length ?? 0;

  if (dimensions <= 0) {
    throw new DkbError('FAISS package artifacts require compiler vectors');
  }
  if (compatibility.dimensions !== dimensions) {
    throw new DkbError(`FAISS embedding dimensions do not match pipeline compatibility: expected ${String(compatibility.dimensions)}, got ${dimensions}`);
  }
  if (compatibility.metric !== 'cosine' || compatibility.normalized !== true) {
    throw new DkbError('FAISS IndexFlatIP packages require normalized cosine embeddings');
  }
  if (typeof compatibility.embeddingSpace !== 'string' || compatibility.embeddingSpace.length === 0) {
    throw new DkbError('FAISS pipeline compatibility must declare an embedding space');
  }
  const embeddingProvider = compiled.receipts.find((receipt) => receipt.compatibility)?.providerId ?? 'unknown';

  return {
    embeddingProvider,
    model: compatibility.embeddingSpace,
    dimensions,
    metric: 'cosine',
    normalized: true,
    index: 'IndexIDMap2(IndexFlatIP)',
  };
}

function retrievalVectorsByEvidenceId(
  compiled: DkbRetrievalPipeline,
  packageId: string,
  version: string,
): Map<string, number[]> {
  if (compiled.vectors.length !== compiled.records.length) {
    throw new DkbError(`FAISS vector count mismatch in ${packageId}@${version}: expected ${compiled.records.length}, got ${compiled.vectors.length}`);
  }
  const recordIds = new Set(compiled.records.map((record) => record.id));
  const vectors = new Map<string, number[]>();
  for (const vector of compiled.vectors) {
    if (!recordIds.has(vector.evidenceId) || vectors.has(vector.evidenceId)) {
      throw new DkbError(`FAISS vectors must map one-to-one to Evidence records in ${packageId}@${version}`);
    }
    vectors.set(vector.evidenceId, vector.values);
  }
  if ([...recordIds].some((id) => !vectors.has(id))) {
    throw new DkbError(`FAISS vectors are missing Evidence records in ${packageId}@${version}`);
  }
  return vectors;
}

function assertCompatibleRecordEmbedding(record: FaissCompiledRecord, profile: FaissEmbeddingProfile, packageId: string, version: string): void {
  if (!Array.isArray(record.embedding)
    || record.embedding.length !== profile.dimensions
    || !record.embedding.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    throw new DkbError(`Retrieval vector ${record.evidenceId} in ${packageId}@${version} is incompatible with the selected embedding space`);
  }
}

function assertSingleEmbeddingProfile(profiles: FaissEmbeddingProfile[]): FaissEmbeddingProfile {
  const [first] = profiles;

  if (!first) {
    throw new DkbError('No FAISS embedding profiles loaded');
  }
  for (const profile of profiles.slice(1)) {
    if (profile.model !== first.model || profile.dimensions !== first.dimensions || profile.metric !== first.metric || profile.normalized !== first.normalized) {
      throw new DkbError(`Installed DKB embedding profile mismatch: expected ${first.model}/${first.dimensions}, got ${profile.model}/${profile.dimensions}`);
    }
  }

  return first;
}

function writeFaissCatalog(
  target: string,
  dkb: LoadedDkb,
  numericIdToRecord: Map<string, FaissCompiledRecord>,
): void {
  const database = new DatabaseSync(path.toNamespacedPath(target));

  try {
    database.exec(`
      create table chunks (
        numeric_id text primary key,
        package_id text not null,
        package_version text not null,
        evidence_id text not null
      );
      create index chunks_package_idx on chunks(package_id, package_version);
    `);
    const insert = database.prepare(`
      insert into chunks (numeric_id, package_id, package_version, evidence_id)
      values (?, ?, ?, ?)
    `);

    database.exec('begin');
    try {
      for (const [numericId, record] of numericIdToRecord.entries()) {
        insert.run(
          numericId,
          dkb.manifest.id,
          dkb.manifest.version,
          record.evidenceId,
        );
      }
      database.exec('commit');
    } catch (error) {
      database.exec('rollback');
      throw error;
    }
  } finally {
    database.close();
  }
}

function readFaissCatalog(catalogPath: string): Map<string, string> {
  const database = new DatabaseSync(path.toNamespacedPath(catalogPath), { readOnly: true });

  try {
    const rows = database.prepare('select numeric_id, evidence_id from chunks order by package_id, evidence_id').all() as Array<Record<string, unknown>>;
    return new Map(rows.map((row) => [String(row.numeric_id), String(row.evidence_id)]));
  } finally {
    database.close();
  }
}

function faissNumericIdFor(packageId: string, version: string, chunkId: string): string {
  const hash = createHash('sha256').update(`${packageId}|${version}|${chunkId}`).digest();
  let value = hash.readBigUInt64BE(0) & ((1n << 63n) - 1n);

  if (value === 0n) {
    value = 1n;
  }

  return value.toString(10);
}

async function replaceFile(source: string, target: string): Promise<void> {
  const backup = `${target}.replace-${process.pid}-${Date.now().toString(36)}`;

  await fs.mkdir(path.dirname(target), { recursive: true });
  await moveIfExists(target, backup);
  try {
    await fs.rename(source, target);
    await fs.rm(backup, { force: true });
  } catch (error) {
    await fs.rm(target, { force: true });
    await moveIfExists(backup, target);
    throw error;
  }
}

async function moveIfExists(source: string, target: string): Promise<void> {
  try {
    await fs.rename(source, target);
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : '';

    if (code !== 'ENOENT') {
      throw error;
    }
  }
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const tempPath = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rm(target, { force: true });
  await fs.rename(tempPath, target);
}

async function fileDigest(target: string): Promise<{ hash: string; size: number }> {
  const stat = await fs.stat(target);
  const data = await fs.readFile(target);

  return {
    hash: `sha256:${createHash('sha256').update(data).digest('hex')}`,
    size: stat.size,
  };
}

function parseFaissPackageManifest(value: unknown, source: string): FaissPackageManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DkbError(`Invalid FAISS package manifest at ${source}`);
  }
  const manifest = value as Partial<FaissPackageManifest>;

  if (manifest.format !== FAISS_ARTIFACT_FORMAT || typeof manifest.packageId !== 'string' || typeof manifest.packageVersion !== 'string' || !manifest.embedding || !manifest.files) {
    throw new DkbError(`Invalid FAISS package manifest at ${source}`);
  }

  return manifest as FaissPackageManifest;
}

function commandDetail(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error) {
    return `${String((error as { stdout?: unknown }).stdout ?? '')}${String((error as { stderr?: unknown }).stderr ?? '')}`.trim();
  }

  return error instanceof Error ? error.message : String(error);
}

function performanceNow(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}
