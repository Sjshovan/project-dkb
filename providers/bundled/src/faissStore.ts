import { spawn, execFile as execFileCallback, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { stableHash } from '@dkb/protocol/contracts/hash.js';
import { DkbError } from '@dkb/protocol/errors.js';
import { DKB_ARTIFACTS_DIR, resolveFrom } from '@dkb/protocol/paths.js';
import { loadLibrary, uniqueLoadedDkbs } from '@dkb/protocol/manifest.js';
import { capabilitiesForSourceType, sourceAssetsFromChunks, type IndexedSourceAsset, type IndexedSourceUnit } from './sourceIndex.js';
import type { LoadedDkb } from '@dkb/protocol/types.js';
import { tokenize } from './scoring.js';
import { sourceUnitFromPipelineRecord } from './records.js';
import type { DkbCompiledPipeline } from '@dkb/pipeline/types.js';
import { LLAMAINDEX_COMPILER_IMAGE } from './llamaindex.js';

const execFile = promisify(execFileCallback);

export const FAISS_ARTIFACT_DIR = `${DKB_ARTIFACTS_DIR}/faiss`;
export const FAISS_CATALOG_PATH = `${FAISS_ARTIFACT_DIR}/chunks.sqlite`;
export const FAISS_SEGMENT_PATH = `${FAISS_ARTIFACT_DIR}/chunks.faiss`;
export const FAISS_MANIFEST_PATH = `${FAISS_ARTIFACT_DIR}/manifest.json`;
const FAISS_ARTIFACT_FORMAT = 'dkb.faiss.package.v1';
const FAISS_RUNTIME_FORMAT = 'dkb.faiss.runtime.v1';
const FAISS_HELPER_TIMEOUT_MS = 30_000;

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
  generatedAt: string;
}

export interface FaissPackageRuntimeArtifact {
  dkb: LoadedDkb;
  manifest: FaissPackageManifest;
  catalogPath: string;
  segmentPath: string;
  units: IndexedSourceUnit[];
  assets: IndexedSourceAsset[];
  numericIdToUnitId: Map<string, string>;
}

export interface FaissRuntimeSnapshot {
  format: typeof FAISS_RUNTIME_FORMAT;
  root: string;
  registryId: string;
  artifactHash: string;
  embedding: FaissEmbeddingProfile;
  packages: Array<{ id: string; version: string; catalogPath: string; segmentPath: string; chunkCount: number }>;
  assets: IndexedSourceAsset[];
  units: IndexedSourceUnit[];
  unitsById: Map<string, IndexedSourceUnit>;
  assetsByKey: Map<string, IndexedSourceAsset>;
  numericIdToUnitId: Map<string, string>;
  helper: FaissHelperClient;
}

export interface FaissSearchHit {
  id: string;
  score: number;
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
  unit: IndexedSourceUnit;
  embedding: number[];
  metadata: Record<string, unknown>;
}

export async function writeFaissPackageArtifacts(
  root: string,
  dkb: LoadedDkb,
  compiled: DkbCompiledPipeline,
  compatibility: Record<string, unknown>,
): Promise<FaissPackageManifest | null> {
  if (compiled.records.length === 0) {
    return null;
  }
  const profile = embeddingProfileFor(compiled, compatibility);
  const records = compiled.records.map((record) => ({
    unit: sourceUnitFromPipelineRecord(dkb, record),
    embedding: [...(record.embedding ?? [])],
    metadata: record.metadata,
  })).sort((left, right) => left.unit.id.localeCompare(right.unit.id));
  const numericIdToRecord = new Map<string, FaissCompiledRecord>();

  for (const record of records) {
    assertCompatibleRecordEmbedding(record, profile, dkb.manifest.id, dkb.manifest.version);
    const numericId = faissNumericIdFor(dkb.manifest.id, dkb.manifest.version, record.unit.id);

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
      generatedAt: new Date().toISOString(),
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
      yield JSON.stringify(faissNumericIdFor(dkb.manifest.id, dkb.manifest.version, records[index]!.unit.id));
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

export async function loadFaissPackageArtifact(dkb: LoadedDkb): Promise<FaissPackageRuntimeArtifact> {
  const manifest = await validateFaissPackageArtifact(dkb.root);

  if (manifest.packageId !== dkb.manifest.id || manifest.packageVersion !== dkb.manifest.version) {
    throw new DkbError(`FAISS package manifest identity mismatch at ${dkb.root}`);
  }

  const catalogPath = resolveFrom(dkb.root, manifest.files.catalog.path);
  const { units, numericIdToUnitId } = readFaissCatalog(catalogPath);

  return {
    dkb,
    manifest,
    catalogPath,
    segmentPath: resolveFrom(dkb.root, manifest.files.segment.path),
    units,
    assets: sourceAssetsFromChunks(units),
    numericIdToUnitId,
  };
}

export async function buildFaissRuntimeSnapshot(root: string, registryId: string): Promise<FaissRuntimeSnapshot | null> {
  const library = await loadLibrary(root);
  const dkbs = uniqueLoadedDkbs([
    ...library.collections.flatMap((collection) => collection.dkbs),
    ...library.dkbs,
  ]);
  const packages = await Promise.all(dkbs.map((dkb) => loadFaissPackageArtifact(dkb).catch(() => null)));
  const ready = packages.filter((item): item is FaissPackageRuntimeArtifact => Boolean(item));

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

  const units = ready.flatMap((item) => item.units).sort((left, right) => left.id.localeCompare(right.id));
  const assets = sourceAssetsFromChunks(units);
  const numericIdToUnitId = new Map<string, string>();

  for (const item of ready) {
    for (const [numericId, unitId] of item.numericIdToUnitId.entries()) {
      if (numericIdToUnitId.has(numericId)) {
        await helper.close().catch(() => undefined);
        throw new DkbError(`FAISS runtime numeric ID collision: ${numericId}`);
      }
      numericIdToUnitId.set(numericId, unitId);
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
    assets,
    units,
    unitsById: new Map(units.map((unit) => [unit.id, unit])),
    assetsByKey: new Map(assets.map((asset) => [`${asset.dkbId}/${asset.id}`, asset])),
    numericIdToUnitId,
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
      const unitId = snapshot.numericIdToUnitId.get(hit.id);

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

export async function validateFaissPackageQueryability(dkb: LoadedDkb): Promise<void> {
  const artifact = await loadFaissPackageArtifact(dkb);
  const firstUnit = artifact.units[0];

  if (!firstUnit) {
    throw new DkbError(`FAISS package has no queryable chunks: ${dkb.manifest.id}@${dkb.manifest.version}`);
  }
  if (artifact.manifest.chunkCount !== artifact.units.length) {
    throw new DkbError(`FAISS package catalog count mismatch: ${dkb.manifest.id}@${dkb.manifest.version}`);
  }
}

export async function validateFaissRuntimeReady(input: {
  root: string;
  registryId: string;
  packageId?: string;
  packageVersion?: string;
}): Promise<FaissPackageMutationResult> {
  const started = performanceNow();
  const loadStart = performanceNow();
  const snapshot = await buildFaissRuntimeSnapshot(input.root, input.registryId);
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
      documentCount: snapshot.units.length,
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

function embeddingProfileFor(compiled: DkbCompiledPipeline, compatibility: Record<string, unknown>): FaissEmbeddingProfile {
  const dimensions = compiled.records.find((record) => (record.embedding?.length ?? 0) > 0)?.embedding?.length ?? 0;

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

function assertCompatibleRecordEmbedding(record: FaissCompiledRecord, profile: FaissEmbeddingProfile, packageId: string, version: string): void {
  if (!Array.isArray(record.embedding)
    || record.embedding.length !== profile.dimensions
    || !record.embedding.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    throw new DkbError(`Compiler record ${record.unit.id} in ${packageId}@${version} has an incompatible embedding vector`);
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
  const database = new DatabaseSync(target);

  try {
    database.exec(`
      create table chunks (
        numeric_id text primary key,
        package_id text not null,
        package_version text not null,
        chunk_id text not null,
        evidence_id text,
        asset_id text not null,
        store_id text not null,
        type text not null,
        locator_json text not null,
        asset_locator_json text not null,
        title text not null,
        text text not null,
        keywords_json text not null,
        source_hash text not null,
        updated_at text not null,
        chunk_ordinal integer not null,
        chunk_start integer not null,
        chunk_end integer not null,
        metadata_json text not null
      );
      create index chunks_package_idx on chunks(package_id, package_version);
      create table lexical_tokens (
        token text not null,
        numeric_id text not null,
        weight real not null,
        primary key (token, numeric_id)
      );
      create index lexical_tokens_token_idx on lexical_tokens(token);
    `);
    const insert = database.prepare(`
      insert into chunks (
        numeric_id, package_id, package_version, chunk_id, evidence_id, asset_id, store_id, type,
        locator_json, asset_locator_json, title, text, keywords_json, source_hash,
        updated_at, chunk_ordinal, chunk_start, chunk_end, metadata_json
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertLexicalToken = database.prepare(`
      insert into lexical_tokens (token, numeric_id, weight)
      values (?, ?, ?)
    `);

    database.exec('begin');
    try {
      for (const [numericId, record] of numericIdToRecord.entries()) {
        const unit = record.unit;
        insert.run(
          numericId,
          dkb.manifest.id,
          dkb.manifest.version,
          unit.id,
          unit.evidenceId ?? null,
          unit.assetId,
          unit.storeId,
          unit.type,
          JSON.stringify(unit.locator),
          JSON.stringify(unit.assetLocator),
          unit.title,
          unit.text,
          JSON.stringify(unit.keywords),
          unit.hash,
          unit.updatedAt,
          unit.chunkOrdinal,
          unit.chunkStart,
          unit.chunkEnd,
          JSON.stringify(record.metadata),
        );

        for (const [token, weight] of lexicalTokenWeights(unit).entries()) {
          insertLexicalToken.run(token, numericId, weight);
        }
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

function readFaissCatalog(catalogPath: string): { units: IndexedSourceUnit[]; numericIdToUnitId: Map<string, string> } {
  const database = new DatabaseSync(catalogPath, { readOnly: true });

  try {
    const hasEvidenceId = hasColumn(database, 'chunks', 'evidence_id');
    const rows = database.prepare(`
      select numeric_id, package_id, package_version, chunk_id,
             ${hasEvidenceId ? 'evidence_id' : 'null as evidence_id'},
             asset_id, store_id, type,
             locator_json, asset_locator_json, title, text, keywords_json, source_hash,
             updated_at, chunk_ordinal, chunk_start, chunk_end
      from chunks
      order by package_id, chunk_id
    `).all() as Array<Record<string, unknown>>;
    const numericIdToUnitId = new Map<string, string>();
    const units = rows.map((row) => {
      const unit = rowToSourceUnit(row);
      numericIdToUnitId.set(String(row.numeric_id), unit.id);

      return unit;
    });

    return { units, numericIdToUnitId };
  } finally {
    database.close();
  }
}

function rowToSourceUnit(row: Record<string, unknown>): IndexedSourceUnit {
  return {
    id: String(row.chunk_id),
    evidenceId: typeof row.evidence_id === 'string' ? row.evidence_id : undefined,
    assetId: String(row.asset_id),
    dkbId: String(row.package_id),
    packageVersion: String(row.package_version),
    storeId: String(row.store_id),
    type: String(row.type) as IndexedSourceUnit['type'],
    locator: parseJsonObject(row.locator_json),
    assetLocator: parseJsonObject(row.asset_locator_json),
    title: String(row.title),
    text: String(row.text),
    keywords: parseJsonStringArray(row.keywords_json),
    capabilities: capabilitiesForSourceType(String(row.type) as IndexedSourceUnit['type']),
    hash: String(row.source_hash),
    updatedAt: String(row.updated_at),
    chunkOrdinal: Number(row.chunk_ordinal),
    chunkStart: Number(row.chunk_start),
    chunkEnd: Number(row.chunk_end),
  };
}

function hasColumn(database: DatabaseSync, table: string, column: string): boolean {
  const rows = database.prepare(`pragma table_info(${table})`).all() as Array<{ name?: unknown }>;

  return rows.some((row) => row.name === column);
}

function lexicalTokenWeights(unit: IndexedSourceUnit): Map<string, number> {
  const weights = new Map<string, number>();
  const add = (value: string, weight: number) => {
    for (const token of tokenize(value, { keepStopwords: true })) {
      weights.set(token, Math.max(weight, weights.get(token) ?? 0));
    }
  };

  add(unit.title, 3);
  add(unit.keywords.join(' '), 2);
  add(unit.text, 1);

  return weights;
}

function faissNumericIdFor(packageId: string, version: string, chunkId: string): string {
  const hash = createHash('sha256').update(`${packageId}|${version}|${chunkId}`).digest();
  let value = hash.readBigUInt64BE(0) & ((1n << 63n) - 1n);

  if (value === 0n) {
    value = 1n;
  }

  return value.toString(10);
}

class FaissHelperClient {
  private process?: ChildProcessWithoutNullStreams;
  private pending: Array<{ resolve: (value: FaissHelperResponse) => void; reject: (error: Error) => void }> = [];
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private dockerImage: string | null = null;
  private dockerSegmentMounts: Array<{ hostDir: string; containerDir: string }> = [];

  async load(input: { dimensions: number; segments: Array<{ path: string }> }): Promise<void> {
    await this.ensureStarted(input.segments);
    const result = await this.request({
      op: 'load',
      dimensions: input.dimensions,
      segments: this.containerSegments(input.segments),
    });

    if (!result.ok) {
      throw new DkbError(`FAISS helper load failed: ${result.error ?? 'unknown error'}`);
    }
  }

  async search(vector: number[], limit: number): Promise<{ hits: FaissSearchHit[] }> {
    await this.ensureStarted();
    const result = await this.request({ op: 'search', vector, limit });

    if (!result.ok || !Array.isArray(result.hits)) {
      throw new DkbError(`FAISS helper search failed: ${result.error ?? 'unknown error'}`);
    }

    return {
      hits: result.hits.filter(isFaissSearchHit),
    };
  }

  async close(): Promise<void> {
    if (!this.process) {
      return;
    }
    const child = this.process;
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      child.once('exit', () => resolve());
    });

    try {
      await this.request({ op: 'close' });
      child.stdin.end();
      await waitForExit(exited, 1_000);
    } catch {
      // Process shutdown is best-effort; callers invalidate the snapshot.
      child.kill();
    }
    this.process = undefined;
  }

  private async ensureStarted(segments: Array<{ path: string }> = []): Promise<void> {
    if (this.process) {
      return;
    }
    const helperPath = faissHelperPath();
    const dockerImage = configuredFaissDockerImage();
    this.dockerImage = dockerImage;
    const child = dockerImage
      ? spawn('docker', [
        'run',
        '--rm',
        '-i',
        '--entrypoint',
        'python',
        '-v',
        `${path.dirname(helperPath)}:/dkb-faiss:ro`,
        ...this.prepareDockerSegmentMounts(segments).flatMap((mount) => ['-v', `${mount.hostDir}:${mount.containerDir}:ro`]),
        dockerImage,
        '/dkb-faiss/faiss_helper.py',
        'serve',
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      : spawn(faissPython(), [helperPath, 'serve'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.process = child;
    this.stderrBuffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-8000);
    });
    child.on('error', (error) => this.rejectAll(error));
    child.on('exit', (code) => {
      this.process = undefined;
      const detail = this.stderrBuffer.trim();
      const message = `FAISS helper exited with code ${code ?? 'unknown'}${detail ? `: ${detail}` : ''}`;

      this.rejectAll(new Error(message));
    });
    await this.request({ op: 'health' });
  }

  private prepareDockerSegmentMounts(segments: Array<{ path: string }>): Array<{ hostDir: string; containerDir: string }> {
    this.dockerSegmentMounts = segments.map((segment, index) => ({
      hostDir: path.dirname(path.resolve(segment.path)),
      containerDir: `/segments/${index}`,
    }));

    return this.dockerSegmentMounts;
  }

  private containerSegments(segments: Array<{ path: string }>): Array<{ path: string }> {
    if (!this.dockerImage || this.dockerSegmentMounts.length === 0) {
      return segments;
    }

    return segments.map((segment, index) => ({
      path: `${this.dockerSegmentMounts[index]?.containerDir ?? `/segments/${index}`}/${path.basename(segment.path)}`,
    }));
  }

  private request(payload: Record<string, unknown>): Promise<FaissHelperResponse> {
    const child = this.process;

    if (!child) {
      return Promise.reject(new Error('FAISS helper is not running'));
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('FAISS helper request timed out'));
      }, FAISS_HELPER_TIMEOUT_MS);

      this.pending.push({
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (this.stdoutBuffer.includes('\n')) {
      const index = this.stdoutBuffer.indexOf('\n');
      const line = this.stdoutBuffer.slice(0, index).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      const pending = this.pending.shift();

      if (!pending || !line) {
        continue;
      }
      try {
        pending.resolve(JSON.parse(line) as FaissHelperResponse);
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.splice(0)) {
      pending.reject(error);
    }
  }
}

async function waitForExit(exited: Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      exited,
      new Promise<void>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Timed out waiting for FAISS helper exit')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

type FaissHelperResponse = {
  ok?: boolean;
  error?: string;
  hits?: unknown;
};

function isFaissSearchHit(value: unknown): value is FaissSearchHit {
  return Boolean(value)
    && typeof value === 'object'
    && typeof (value as { id?: unknown }).id === 'string'
    && typeof (value as { score?: unknown }).score === 'number';
}

async function runFaissHelper(args: string[]): Promise<void> {
  const dockerImage = configuredFaissDockerImage();

  if (dockerImage && args[0] === 'build') {
    await runFaissHelperInDocker(dockerImage, args);

    return;
  }

  try {
    await execFile(faissPython(), [faissHelperPath(), ...args], {
      timeout: FAISS_HELPER_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    throw new DkbError(`FAISS helper failed: ${commandDetail(error)}`);
  }
}

async function runFaissHelperInDocker(image: string, args: string[]): Promise<void> {
  const vectorsPath = optionValue(args, '--vectors');
  const outputPath = optionValue(args, '--out');

  if (!vectorsPath || !outputPath) {
    throw new DkbError('Docker FAISS helper build requires --vectors and --out paths.');
  }

  const helperDir = path.dirname(faissHelperPath());
  const vectorsDir = path.dirname(vectorsPath);
  const outputDir = path.dirname(outputPath);

  try {
    await execFile('docker', [
      'run',
      '--rm',
      '--entrypoint',
      'python',
      '-v',
      `${helperDir}:/dkb-faiss:ro`,
      '-v',
      `${vectorsDir}:/vectors:ro`,
      '-v',
      `${outputDir}:/out`,
      image,
      '/dkb-faiss/faiss_helper.py',
      'build',
      '--vectors',
      `/vectors/${path.basename(vectorsPath)}`,
      '--out',
      `/out/${path.basename(outputPath)}`,
    ], {
      timeout: FAISS_HELPER_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    throw new DkbError(`Docker FAISS helper failed: ${commandDetail(error)}`);
  }
}

function faissPython(): string {
  return process.env.DKB_FAISS_PYTHON ?? process.env.PYTHON ?? 'python';
}

function configuredFaissDockerImage(): string | null {
  if (process.env.DKB_FAISS_DOCKER_IMAGE === 'none') {
    return null;
  }
  if (process.env.DKB_FAISS_DOCKER_IMAGE) {
    return process.env.DKB_FAISS_DOCKER_IMAGE;
  }
  if (process.env.DKB_FAISS_PYTHON) {
    return null;
  }

  return LLAMAINDEX_COMPILER_IMAGE;
}

function optionValue(args: string[], option: string): string | null {
  const index = args.indexOf(option);

  return index >= 0 && typeof args[index + 1] === 'string' ? args[index + 1] : null;
}

function faissHelperPath(): string {
  const current = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), 'providers/bundled/python/faiss/faiss_helper.py'),
    path.resolve(current, '../python/faiss/faiss_helper.py'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));

  if (!found) {
    throw new DkbError(`FAISS helper script not found. Checked: ${candidates.join(', ')}`);
  }

  return found;
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

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseJsonStringArray(value: unknown): string[] {
  if (typeof value !== 'string') {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;

    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
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
