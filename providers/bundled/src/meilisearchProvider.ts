import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { loadLibrary, uniqueLoadedDkbs } from '@sjshovan/dkb-protocol/manifest.js';
import { resolveFrom } from '@sjshovan/dkb-protocol/paths.js';
import type { LoadedDkb } from '@sjshovan/dkb-protocol/types.js';
import type {
  DkbCompiledPipeline,
  DkbIndexMutationResult,
  DkbIndexRuntime,
  DkbProviderBuildReceipt,
  DkbRuntimePackageBuild,
} from '@sjshovan/dkb-pipeline/types.js';
import { sourceUnitFromPipelineRecord } from './records.js';
import { sourceAssetsFromChunks, type IndexedSourceUnit } from './sourceIndex.js';

export const MEILISEARCH_PROVIDER_ID = '@dkb/index-meilisearch';
export const MEILISEARCH_IMPORT_FORMAT = 'dkb.meilisearch.import.v1';
export const MEILISEARCH_INDEX_FORMAT = 'meilisearch.userProvided.v1';
export const MEILISEARCH_ARTIFACT_DIR = 'meilisearch';
export const MEILISEARCH_RECORDS_PATH = `${MEILISEARCH_ARTIFACT_DIR}/records.jsonl`;
export const MEILISEARCH_MANIFEST_PATH = `${MEILISEARCH_ARTIFACT_DIR}/manifest.json`;
const MEILI_EMBEDDER = 'dkb';
const DEFAULT_TIMEOUT_MS = 60_000;

export interface MeilisearchImportManifest {
  format: typeof MEILISEARCH_IMPORT_FORMAT;
  packageId: string;
  packageVersion: string;
  recordCount: number;
  dimensions: number;
  compatibility: Record<string, unknown>;
  compatibilityDigest: string;
  releaseDigest: string;
  files: {
    records: { path: typeof MEILISEARCH_RECORDS_PATH; hash: string; size: number };
  };
  import: {
    provider: typeof MEILISEARCH_PROVIDER_ID;
    indexFormat: typeof MEILISEARCH_INDEX_FORMAT;
    embedder: typeof MEILI_EMBEDDER;
  };
  generatedAt: string;
}

interface MeilisearchImportRecord {
  unit: IndexedSourceUnit;
  embedding: number[];
}

interface MeilisearchDocument {
  id: string;
  canonicalId: string;
  packageId: string;
  packageVersion: string;
  importDigest: string;
  dkbId: string;
  assetId: string;
  storeId: string;
  sourceType: string;
  title: string;
  text: string;
  keywords: string[];
  updatedAt: string;
  sourceHash: string;
  _vectors: Record<typeof MEILI_EMBEDDER, number[]>;
  _rankingScore?: number;
}

export async function writeMeilisearchPackageArtifacts(input: {
  artifactsRoot: string;
  dkb: LoadedDkb;
  compiled: DkbCompiledPipeline;
  compatibility: Record<string, unknown>;
  providerVersion: string;
}): Promise<DkbProviderBuildReceipt | null> {
  const records = compiledRecords(input.dkb, input.compiled);

  if (records.length === 0) {
    return null;
  }
  const dimensions = assertUniformDimensions(records, input.dkb.manifest.id);
  const compatibilityDigest = stableHash(input.compatibility);
  const releaseDigest = stableHash(records.map(stableImportRecord));
  const recordsPath = resolveFrom(input.artifactsRoot, MEILISEARCH_RECORDS_PATH);

  await fs.mkdir(path.dirname(recordsPath), { recursive: true });
  await pipeline(
    Readable.from(records.map((record) => `${JSON.stringify(record)}\n`)),
    createWriteStream(recordsPath, { encoding: 'utf8' }),
  );
  const recordsFile = await fileDigest(recordsPath);
  const manifest: MeilisearchImportManifest = {
    format: MEILISEARCH_IMPORT_FORMAT,
    packageId: input.dkb.manifest.id,
    packageVersion: input.dkb.manifest.version,
    recordCount: records.length,
    dimensions,
    compatibility: input.compatibility,
    compatibilityDigest,
    releaseDigest,
    files: {
      records: { path: MEILISEARCH_RECORDS_PATH, ...recordsFile },
    },
    import: {
      provider: MEILISEARCH_PROVIDER_ID,
      indexFormat: MEILISEARCH_INDEX_FORMAT,
      embedder: MEILI_EMBEDDER,
    },
    generatedAt: new Date().toISOString(),
  };

  await writeJsonAtomic(resolveFrom(input.artifactsRoot, MEILISEARCH_MANIFEST_PATH), manifest);

  return {
    providerId: MEILISEARCH_PROVIDER_ID,
    providerVersion: input.providerVersion,
    build: {
      format: manifest.format,
      recordCount: manifest.recordCount,
      releaseDigest,
      files: manifest.files,
    },
    compatibility: input.compatibility,
  };
}

export async function validateMeilisearchPackageArtifact(
  dkb: LoadedDkb,
  compatibility?: Record<string, unknown>,
  artifactsRoot = dkb.root,
): Promise<{ manifest: MeilisearchImportManifest; records: MeilisearchImportRecord[] }> {
  const manifestPath = resolveFrom(artifactsRoot, MEILISEARCH_MANIFEST_PATH);
  const parsed = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as unknown;
  const manifest = parseManifest(parsed, manifestPath);

  if (manifest.packageId !== dkb.manifest.id || manifest.packageVersion !== dkb.manifest.version) {
    throw new DkbError(`Meilisearch import identity mismatch at ${dkb.root}`);
  }
  if (compatibility && manifest.compatibilityDigest !== stableHash(compatibility)) {
    throw new DkbError(`Meilisearch compatibility mismatch for ${dkb.manifest.id}@${dkb.manifest.version}`);
  }
  const recordsPath = resolveFrom(artifactsRoot, manifest.files.records.path);
  const digest = await fileDigest(recordsPath);

  if (digest.hash !== manifest.files.records.hash || digest.size !== manifest.files.records.size) {
    throw new DkbError(`Meilisearch import records hash mismatch for ${dkb.manifest.id}@${dkb.manifest.version}`);
  }
  const records = await readJsonLines(recordsPath);

  if (records.length !== manifest.recordCount) {
    throw new DkbError(`Meilisearch import count mismatch for ${dkb.manifest.id}@${dkb.manifest.version}: expected ${manifest.recordCount}, got ${records.length}`);
  }
  if (assertUniformDimensions(records, dkb.manifest.id) !== manifest.dimensions) {
    throw new DkbError(`Meilisearch import vector dimensions do not match its manifest for ${dkb.manifest.id}@${dkb.manifest.version}`);
  }
  if (stableHash(records.map(stableImportRecord)) !== manifest.releaseDigest) {
    throw new DkbError(`Meilisearch import release digest mismatch for ${dkb.manifest.id}@${dkb.manifest.version}`);
  }

  return { manifest, records };
}

export async function installMeilisearchPackage(input: {
  libraryRoot: string;
  libraryId: string;
  dkb: LoadedDkb;
  artifactsRoot: string;
  compatibility: Record<string, unknown>;
  options: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
}): Promise<DkbIndexMutationResult> {
  throwIfAborted(input.signal);
  const { manifest, records } = await validateMeilisearchPackageArtifact(input.dkb, input.compatibility, input.artifactsRoot);
  const client = await createClient(input.options);
  const indexId = meilisearchIndexId(
    input.libraryRoot,
    input.libraryId,
    input.dkb.manifest.id,
    input.dkb.manifest.version,
    manifest.compatibilityDigest,
  );
  const existing = await indexExists(client, indexId, input.options);

  if (existing) {
    const current = await inspectExistingRelease(client, indexId, manifest.releaseDigest, input.options);

    if (current.matches) {
      return { indexId, documentCount: current.count, status: 'ready', created: false };
    }
    if (await isPackageActive(input.libraryRoot, input.dkb.manifest.id, input.dkb.manifest.version)) {
      throw new DkbError(`Immutable Meilisearch index ${indexId} differs from the active package release; uninstall it before retrying`);
    }
    await deleteIndex(client, indexId, input.options);
  }

  try {
    const createTask = await withMeilisearchTimeout(client.createIndex(indexId, { primaryKey: 'id' }), input.options, `create index ${indexId}`);
    await waitForTask(client, createTask, input.options);
    const index = client.index<MeilisearchDocument>(indexId);
    const settingsTask = await withMeilisearchTimeout(index.updateSettings(meilisearchSettings(manifest.dimensions)), input.options, `configure index ${indexId}`);
    await waitForTask(client, settingsTask, input.options);
    throwIfAborted(input.signal);
    const documents = records.map((record) => documentFor(record, manifest));

    if (documents.length > 0) {
      const importTask = await withMeilisearchTimeout(index.addDocuments(documents, { primaryKey: 'id' }), input.options, `import ${documents.length} documents into ${indexId}`);
      await waitForTask(client, importTask, input.options);
    }
    if (process.env.DKB_TEST_ABORT_MEILI_AFTER_IMPORT === '1') {
      throw new DkbError(`Aborted Meilisearch activation after importing ${input.dkb.manifest.id}@${input.dkb.manifest.version}`);
    }
    const verification = await waitForExistingRelease(
      client,
      indexId,
      manifest.releaseDigest,
      manifest.recordCount,
      input.options,
      input.signal,
    );

    if (!verification.matches || verification.count !== manifest.recordCount) {
      throw new DkbError(`Meilisearch import verification failed for ${input.dkb.manifest.id}@${input.dkb.manifest.version}: expected ${manifest.recordCount}, got ${verification.count}`);
    }

    return { indexId, documentCount: verification.count, status: 'ready', created: true };
  } catch (error) {
    await deleteIndex(client, indexId, input.options).catch(() => undefined);
    throw error;
  }
}

export async function uninstallMeilisearchPackage(input: {
  libraryRoot: string;
  libraryId: string;
  packageId: string;
  packageVersion: string;
  options: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
}): Promise<DkbIndexMutationResult> {
  const indexPrefix = meilisearchIndexPrefix(input.libraryRoot, input.libraryId, input.packageId, input.packageVersion);

  try {
    throwIfAborted(input.signal);
    const client = await createClient(input.options);
    const indexIds = (await listIndexIds(client, input.options)).filter((indexId) => indexId.startsWith(`${indexPrefix}_`));
    await Promise.all(indexIds.map((indexId) => deleteIndex(client, indexId, input.options)));

    return { indexId: `${indexPrefix}_*`, documentCount: 0, status: 'removed' };
  } catch (error) {
    return {
      indexId: `${indexPrefix}_*`,
      documentCount: 0,
      status: 'orphaned',
      warning: `Knowledge is inactive, but Meilisearch indexes ${indexPrefix}_* could not be removed. Retry uninstall cleanup after restoring the service: ${errorMessage(error)}`,
    };
  }
}

export async function openMeilisearchRuntime(input: {
  libraryRoot: string;
  libraryId: string;
  packages: readonly DkbRuntimePackageBuild[];
  compatibility: Record<string, unknown>;
  embedQuery(text: string, signal?: AbortSignal): Promise<number[]>;
  options: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
}): Promise<DkbIndexRuntime | null> {
  const loaded = await Promise.all(input.packages.map(async ({ dkb, artifactsRoot }) => ({
    dkb,
    ...await validateMeilisearchPackageArtifact(dkb, input.compatibility, artifactsRoot),
  })));

  if (loaded.length === 0) {
    return null;
  }
  const packages = loaded.map(({ dkb, manifest }) => ({
    id: dkb.manifest.id,
    version: dkb.manifest.version,
    indexId: meilisearchIndexId(
      input.libraryRoot,
      input.libraryId,
      dkb.manifest.id,
      dkb.manifest.version,
      manifest.compatibilityDigest,
    ),
    documentCount: manifest.recordCount,
  }));
  const units = loaded.flatMap((item) => item.records.map((record) => record.unit))
    .sort((left, right) => left.id.localeCompare(right.id));
  const dimensions = positiveInteger(input.compatibility.dimensions, 'embedding compatibility dimensions');

  return {
    providerId: MEILISEARCH_PROVIDER_ID,
    mode: 'managed',
    format: MEILISEARCH_INDEX_FORMAT,
    packages,
    async search(query, limit, signal) {
      throwIfAborted(signal ?? input.signal);
      const vector = await input.embedQuery(query, signal ?? input.signal);

      if (vector.length !== dimensions) {
        throw new DkbError(`Query embedding dimension mismatch: expected ${dimensions}, got ${vector.length}`);
      }
      const client = await createClient(input.options);
      const searches = await Promise.all(packages.map(async (item) => {
        const response = await withMeilisearchTimeout(client.index<MeilisearchDocument>(item.indexId).search(query, {
          limit: Math.max(1, Math.min(limit, 1_000)),
          showRankingScore: true,
          hybrid: { embedder: MEILI_EMBEDDER, semanticRatio: semanticRatio(input.options) },
          vector,
        } as never), input.options, `search index ${item.indexId}`);

        return response.hits.map((hit, rank) => ({
          id: hit.canonicalId,
          rank,
          rankingScore: typeof hit._rankingScore === 'number' ? hit._rankingScore : 0,
          indexId: item.indexId,
        }));
      }));
      const fused = fuseHits(searches, limit);

      return {
        hits: fused.map(({ id, score }) => ({ id, score })),
        trace: {
          engine: 'meilisearch',
          status: 'ready',
          mode: 'managed-package-fanout',
          indexes: packages.length,
          embedder: MEILI_EMBEDDER,
          dimensions,
          semanticRatio: semanticRatio(input.options),
        },
      };
    },
    close() {},
  };
}

export async function verifyMeilisearchRuntime(input: {
  libraryRoot: string;
  libraryId: string;
  packages: readonly DkbRuntimePackageBuild[];
  packageId?: string;
  packageVersion?: string;
  compatibility: Record<string, unknown>;
  options: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
}): Promise<DkbIndexMutationResult> {
  throwIfAborted(input.signal);
  const active = input.packages
    .filter(({ dkb }) => !input.packageId || (dkb.manifest.id === input.packageId && (!input.packageVersion || dkb.manifest.version === input.packageVersion)));

  if (input.packageId && active.length === 0) {
    throw new DkbError(`Meilisearch runtime did not activate ${input.packageId}${input.packageVersion ? `@${input.packageVersion}` : ''}`);
  }
  const client = await createClient(input.options);
  let documentCount = 0;
  let lastIndexId = '';

  for (const { dkb, artifactsRoot } of active) {
    const { manifest } = await validateMeilisearchPackageArtifact(dkb, input.compatibility, artifactsRoot);
    const indexId = meilisearchIndexId(
      input.libraryRoot,
      input.libraryId,
      dkb.manifest.id,
      dkb.manifest.version,
      manifest.compatibilityDigest,
    );

    if (!(await indexExists(client, indexId, input.options))) {
      throw new DkbError(`Meilisearch index ${indexId} is missing for ${dkb.manifest.id}@${dkb.manifest.version}`);
    }
    const release = await inspectExistingRelease(client, indexId, manifest.releaseDigest, input.options);

    if (!release.matches || release.count !== manifest.recordCount) {
      throw new DkbError(`Meilisearch index ${indexId} is incomplete for ${dkb.manifest.id}@${dkb.manifest.version}: expected ${manifest.recordCount}, got ${release.count}`);
    }
    documentCount += release.count;
    lastIndexId = indexId;
  }

  return {
    indexId: active.length === 1 ? lastIndexId : `meilisearch:${active.length}-indexes`,
    documentCount,
    status: 'ready',
  };
}

export async function meilisearchProviderHealth(options: Readonly<Record<string, unknown>>): Promise<{ ok: boolean; detail: string }> {
  try {
    const client = await createClient(options);
    await withMeilisearchTimeout(client.health(), options, 'health check');
    return { ok: true, detail: `Meilisearch ready at ${meilisearchUrl(options)}` };
  } catch (error) {
    return { ok: false, detail: errorMessage(error) };
  }
}

export function meilisearchIndexId(
  libraryRoot: string,
  libraryId: string,
  packageId: string,
  packageVersion: string,
  compatibilityDigest: string,
): string {
  const prefix = meilisearchIndexPrefix(libraryRoot, libraryId, packageId, packageVersion);
  const space = createHash('sha256').update(compatibilityDigest).digest('hex').slice(0, 12);

  return `${prefix}_${space}`;
}

export function meilisearchIndexPrefix(libraryRoot: string, libraryId: string, packageId: string, packageVersion: string): string {
  const namespace = createHash('sha256').update(`${path.resolve(libraryRoot)}\0${libraryId}`).digest('hex').slice(0, 12);
  const release = createHash('sha256').update(`${packageId}\0${packageVersion}`).digest('hex').slice(0, 20);

  return `dkb_${safePart(libraryId).slice(0, 20)}_${namespace}_${release}`;
}

function compiledRecords(dkb: LoadedDkb, compiled: DkbCompiledPipeline): MeilisearchImportRecord[] {
  return compiled.records.map((record) => ({
    unit: sourceUnitFromPipelineRecord(dkb, record),
    embedding: [...(record.embedding ?? [])],
  })).sort(compareImportRecords);
}

function documentFor(record: MeilisearchImportRecord, manifest: MeilisearchImportManifest): MeilisearchDocument {
  return {
    id: Buffer.from(`${manifest.packageId}|${manifest.packageVersion}|${record.unit.id}`, 'utf8').toString('base64url'),
    canonicalId: record.unit.id,
    packageId: manifest.packageId,
    packageVersion: manifest.packageVersion,
    importDigest: manifest.releaseDigest,
    dkbId: record.unit.dkbId,
    assetId: record.unit.assetId,
    storeId: record.unit.storeId,
    sourceType: record.unit.type,
    title: record.unit.title,
    text: record.unit.text,
    keywords: record.unit.keywords,
    updatedAt: record.unit.updatedAt,
    sourceHash: record.unit.hash,
    _vectors: { [MEILI_EMBEDDER]: record.embedding },
  };
}

function meilisearchSettings(dimensions: number): Record<string, unknown> {
  return {
    searchableAttributes: ['title', 'text', 'keywords'],
    filterableAttributes: ['packageId', 'packageVersion', 'importDigest', 'dkbId', 'assetId', 'storeId', 'sourceType'],
    displayedAttributes: ['id', 'canonicalId', 'packageId', 'packageVersion', 'importDigest', 'dkbId', 'assetId', 'storeId', 'sourceType', 'title', 'text', 'keywords', 'updatedAt', 'sourceHash'],
    embedders: {
      [MEILI_EMBEDDER]: { source: 'userProvided', dimensions },
    },
  };
}

function fuseHits(searches: Array<Array<{ id: string; rank: number; rankingScore: number; indexId: string }>>, limit: number): Array<{ id: string; score: number }> {
  const fused = new Map<string, number>();

  for (const hits of searches) {
    for (const hit of hits) {
      const score = 1 / (60 + hit.rank + 1) + Math.max(0, Math.min(hit.rankingScore, 1)) / 1_000;
      fused.set(hit.id, (fused.get(hit.id) ?? 0) + score);
    }
  }

  return [...fused.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, Math.max(1, Math.min(limit, 1_000)))
    .map(([id, score]) => ({ id, score }));
}

async function inspectExistingRelease(client: MeiliClient, indexId: string, releaseDigest: string, options: Readonly<Record<string, unknown>>): Promise<{ matches: boolean; count: number }> {
  const response = await withMeilisearchTimeout(client.index<MeilisearchDocument>(indexId).search('', {
    limit: 1,
    filter: `importDigest = "${escapeFilter(releaseDigest)}"`,
  } as never), options, `inspect index ${indexId}`) as { estimatedTotalHits?: number; hits: MeilisearchDocument[] };
  const count = Number(response.estimatedTotalHits ?? 0);

  return { matches: count > 0 && response.hits[0]?.importDigest === releaseDigest, count };
}

async function waitForExistingRelease(
  client: MeiliClient,
  indexId: string,
  releaseDigest: string,
  expectedCount: number,
  options: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<{ matches: boolean; count: number }> {
  const deadline = Date.now() + timeoutMs(options);
  let last = { matches: false, count: 0 };

  while (Date.now() < deadline) {
    throwIfAborted(signal);
    last = await inspectExistingRelease(client, indexId, releaseDigest, options);
    if (last.matches && last.count === expectedCount) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return last;
}

async function isPackageActive(libraryRoot: string, packageId: string, packageVersion: string): Promise<boolean> {
  try {
    const library = await loadLibrary(libraryRoot);
    return uniqueLoadedDkbs([...library.collections.flatMap((collection) => collection.dkbs), ...library.dkbs])
      .some((dkb) => dkb.manifest.id === packageId && dkb.manifest.version === packageVersion);
  } catch {
    return false;
  }
}

async function deleteIndex(client: MeiliClient, indexId: string, options: Readonly<Record<string, unknown>>): Promise<void> {
  const task = await withMeilisearchTimeout(client.deleteIndexIfExists(indexId), options, `delete index ${indexId}`);

  if (task && typeof task === 'object' && 'taskUid' in task) {
    await waitForTask(client, task, options);
  }
}

async function indexExists(client: MeiliClient, indexId: string, options: Readonly<Record<string, unknown>>): Promise<boolean> {
  try {
    await withMeilisearchTimeout(client.getIndex(indexId), options, `inspect index ${indexId}`);
    return true;
  } catch (error) {
    if (/index.*not found|index_not_found/i.test(errorMessage(error))) {
      return false;
    }
    throw error;
  }
}

async function listIndexIds(client: MeiliClient, options: Readonly<Record<string, unknown>>): Promise<string[]> {
  const ids: string[] = [];
  let offset = 0;
  const limit = 1_000;

  while (true) {
    const page = await withMeilisearchTimeout(
      client.getIndexes({ offset, limit }),
      options,
      'list package indexes',
    ) as { results?: Array<{ uid?: unknown }>; total?: number };
    const results = page.results ?? [];
    ids.push(...results.flatMap((index) => typeof index.uid === 'string' ? [index.uid] : []));
    offset += results.length;
    if (results.length < limit || offset >= Number(page.total ?? offset)) break;
  }

  return ids;
}

type MeiliClient = InstanceType<(typeof import('meilisearch'))['MeiliSearch']>;

async function createClient(options: Readonly<Record<string, unknown>>): Promise<MeiliClient> {
  const { MeiliSearch } = await import('meilisearch');
  const url = meilisearchUrl(options);
  const apiKey = environmentValue(options, 'apiKeyEnv', 'MEILI_MASTER_KEY', false);

  return new MeiliSearch({ host: url, ...(apiKey ? { apiKey } : {}) });
}

async function waitForTask(
  client: MeiliClient,
  task: Parameters<MeiliClient['tasks']['waitForTask']>[0],
  options: Readonly<Record<string, unknown>>,
): Promise<void> {
  await client.tasks.waitForTask(task, { timeout: timeoutMs(options), interval: 100 });
}

function meilisearchUrl(options: Readonly<Record<string, unknown>>): string {
  return environmentValue(options, 'urlEnv', 'MEILI_URL', true)!;
}

function environmentValue(
  options: Readonly<Record<string, unknown>>,
  optionName: string,
  fallbackName: string,
  required: boolean,
): string | undefined {
  const name = typeof options[optionName] === 'string' && options[optionName].trim().length > 0
    ? options[optionName].trim()
    : fallbackName;

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new DkbError(`Meilisearch ${optionName} must name an environment variable`);
  }
  const value = process.env[name]?.trim();

  if (required && !value) {
    throw new DkbError(`${name} is required by ${MEILISEARCH_PROVIDER_ID}`);
  }

  return value || undefined;
}

function semanticRatio(options: Readonly<Record<string, unknown>>): number {
  const value = typeof options.semanticRatio === 'number' ? options.semanticRatio : 0.7;

  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new DkbError('Meilisearch semanticRatio must be between 0 and 1');
  }
  return value;
}

function timeoutMs(options: Readonly<Record<string, unknown>>): number {
  return typeof options.timeoutMs === 'number' && Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
}

async function withMeilisearchTimeout<T>(promise: Promise<T>, options: Readonly<Record<string, unknown>>, operation: string): Promise<T> {
  const duration = timeoutMs(options);
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DkbError(`Meilisearch ${operation} timed out after ${duration} ms`)), duration);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseManifest(value: unknown, source: string): MeilisearchImportManifest {
  if (!isRecord(value) || value.format !== MEILISEARCH_IMPORT_FORMAT || !isRecord(value.files) || !isRecord(value.import)) {
    throw new DkbError(`Invalid Meilisearch import manifest at ${source}`);
  }

  return value as unknown as MeilisearchImportManifest;
}

async function readJsonLines(target: string): Promise<MeilisearchImportRecord[]> {
  const source = await fs.readFile(target, 'utf8');

  return source.split(/\r?\n/).filter(Boolean).map((line, index) => {
    const value = JSON.parse(line) as unknown;

    if (!isRecord(value) || !isRecord(value.unit) || !Array.isArray(value.embedding)) {
      throw new DkbError(`Invalid Meilisearch import record ${index + 1} at ${target}`);
    }

    return value as unknown as MeilisearchImportRecord;
  });
}

function assertUniformDimensions(records: MeilisearchImportRecord[], packageId: string): number {
  const dimensions = records[0]?.embedding.length ?? 0;

  if (dimensions <= 0 || records.some((record) => record.embedding.length !== dimensions || record.embedding.some((value) => !Number.isFinite(value)))) {
    throw new DkbError(`Meilisearch package ${packageId} contains missing or inconsistent compiler vectors`);
  }

  return dimensions;
}

function compareImportRecords(left: MeilisearchImportRecord, right: MeilisearchImportRecord): number {
  return left.unit.id.localeCompare(right.unit.id);
}

function stableImportRecord(record: MeilisearchImportRecord): Record<string, unknown> {
  const { updatedAt: _updatedAt, ...unit } = record.unit;

  return { unit, embedding: record.embedding };
}

async function fileDigest(target: string): Promise<{ hash: string; size: number }> {
  const stat = await fs.stat(target);
  const hash = createHash('sha256');

  for await (const chunk of createReadStream(target)) {
    hash.update(chunk);
  }

  return { hash: `sha256:${hash.digest('hex')}`, size: stat.size };
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const temp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rm(target, { force: true });
  await fs.rename(temp, target);
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new DkbError(`${label} must be a positive integer`);
  }
  return Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'library';
}

function escapeFilter(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DkbError('Meilisearch operation was cancelled');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
