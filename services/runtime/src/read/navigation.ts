import type { DkbEvidenceCatalogRecord } from '@sjshovan/dkb-protocol/evidence/catalog.js';
import { loadLibrary } from '@sjshovan/dkb-protocol/manifest.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbRetrievalScope } from '@sjshovan/dkb-pipeline/types.js';
import { renderUntrustedSourceBlock, renderUntrustedSourceInline, SOURCE_DATA_POLICY_LINE } from '@sjshovan/dkb-protocol/security/sourceContent.js';
import { getQueryContext, type QueryContext } from '../indexes/queryContext.js';
import type { DkbRuntimeContext } from '../runtime/context.js';

export interface DkbNavigationScope extends DkbRetrievalScope {}

export interface DkbNavigationReference {
  id: string;
  evidenceId: string;
  dkbId: string;
  packageVersion: string;
  sourceId: string;
  assetId: string;
  storeId: string;
  title: string;
  preview: string;
  score: number;
  matchedTokens?: string[];
  sourceType: string;
  locator: Record<string, unknown>;
  assetLocator: Record<string, unknown>;
  sourceHash: string;
  chunkOrdinal: number;
  chunkStart: number;
  chunkEnd: number;
}

export interface DkbSemanticSearchResponse {
  status: 'ready' | 'empty';
  query: string;
  results: DkbNavigationReference[];
  trace: Record<string, unknown>;
}

export interface DkbLexicalSearchResponse extends DkbSemanticSearchResponse {}

export interface DkbReadNavigationChunk {
  reference: DkbNavigationReference;
  text: string;
  sourcePolicy: string;
}

export interface DkbSourceDescription {
  id: string;
  dkbId: string;
  storeId: string;
  type: string;
  title: string;
  locator: Record<string, unknown>;
  sourceHash: string;
  updatedAt: string;
  chunkCount: number;
}

export interface DkbReadNavigationResponse {
  status: 'complete' | 'partial' | 'empty';
  chunks: DkbReadNavigationChunk[];
  missing: string[];
  trace: Record<string, unknown>;
}

export async function semanticSearch(
  root: string,
  query: string,
  limit = 10,
  scope?: DkbNavigationScope,
  queryContext?: QueryContext,
  runtime?: DkbRuntimeContext,
): Promise<DkbSemanticSearchResponse> {
  const context = queryContext ?? await contextFor(root, requiredRuntime(runtime));
  const result = await context.retrieval.search({ query, limit: clampLimit(limit), ...(scope ? { scope } : {}) });
  const references = result.hits.flatMap((hit) => {
    const record = context.evidenceById.get(hit.evidenceId);
    return record ? [navigationReference(record, hit.score, hit.matchedTokens ?? [])] : [];
  });

  return {
    status: references.length > 0 ? 'ready' : 'empty',
    query,
    results: references,
    trace: { engine: context.retrieval.providerId, navigation: 'evidence-reference-first', ...result.trace },
  };
}

export async function lexicalSearch(
  root: string,
  query: string,
  limit = 10,
  scope?: DkbNavigationScope,
  queryContext?: QueryContext,
  runtime?: DkbRuntimeContext,
): Promise<DkbLexicalSearchResponse> {
  const context = queryContext ?? await contextFor(root, requiredRuntime(runtime));
  const result = await context.retrieval.search({ query, limit: Math.min(clampLimit(limit) * 5, 500), ...(scope ? { scope } : {}) });
  const references = result.hits
    .filter((hit) => hit.channels.includes('lexical'))
    .flatMap((hit) => {
      const record = context.evidenceById.get(hit.evidenceId);
      return record ? [navigationReference(record, hit.score, hit.matchedTokens ?? [])] : [];
    })
    .slice(0, clampLimit(limit));

  return {
    status: references.length > 0 ? 'ready' : 'empty',
    query,
    results: references,
    trace: { engine: context.retrieval.providerId, channel: 'lexical', navigation: 'evidence-reference-first', ...result.trace },
  };
}

export async function readNavigationChunks(
  root: string,
  targets: string[],
  queryContext?: QueryContext,
  runtime?: DkbRuntimeContext,
): Promise<DkbReadNavigationResponse> {
  const context = queryContext ?? await contextFor(root, requiredRuntime(runtime));
  const byTarget = new Map<string, DkbEvidenceCatalogRecord>();
  for (const record of context.evidenceRecords) {
    byTarget.set(record.evidenceId, record);
    byTarget.set(`${record.packageId}/${record.evidenceId}`, record);
  }

  const chunks: DkbReadNavigationChunk[] = [];
  const missing: string[] = [];
  for (const target of [...new Set(targets)]) {
    const record = byTarget.get(target);
    if (!record) {
      missing.push(target);
      continue;
    }
    chunks.push({
      reference: navigationReference(record, 1),
      text: renderUntrustedSourceBlock(record.text),
      sourcePolicy: SOURCE_DATA_POLICY_LINE,
    });
  }

  return {
    status: chunks.length === 0 ? 'empty' : missing.length > 0 ? 'partial' : 'complete',
    chunks,
    missing,
    trace: { retrievalMode: 'evidence_catalog_direct', chunksRead: chunks.length, sourceCompilation: false, adapterRead: false },
  };
}

export async function describeSources(root: string, queryContext?: QueryContext, runtime?: DkbRuntimeContext): Promise<DkbSourceDescription[]> {
  const context = queryContext ?? await contextFor(root, requiredRuntime(runtime));
  return context.evidenceAssets.map((asset) => ({
    id: asset.id,
    dkbId: asset.packageId,
    storeId: asset.storeId,
    type: asset.type,
    title: asset.title,
    locator: asset.locator,
    sourceHash: asset.sourceHash,
    updatedAt: asset.updatedAt,
    chunkCount: context.evidenceRecords.filter((record) => record.packageId === asset.packageId && record.assetId === asset.id).length,
  })).sort((left, right) => `${left.dkbId}/${left.id}`.localeCompare(`${right.dkbId}/${right.id}`));
}

function navigationReference(record: DkbEvidenceCatalogRecord, score: number, matchedTokens: string[] = []): DkbNavigationReference {
  const preview = record.text.length > 280 ? `${record.text.slice(0, 277)}...` : record.text;
  return {
    id: record.evidenceId,
    evidenceId: record.evidenceId,
    dkbId: record.packageId,
    packageVersion: record.packageVersion,
    sourceId: record.sourceId,
    assetId: record.assetId,
    storeId: record.storeId,
    title: record.title,
    preview: renderUntrustedSourceInline(preview),
    score,
    ...(matchedTokens.length > 0 ? { matchedTokens } : {}),
    sourceType: record.sourceType,
    locator: record.locator,
    assetLocator: record.assetLocator,
    sourceHash: record.sourceHash,
    chunkOrdinal: record.chunkOrdinal,
    chunkStart: record.chunkStart,
    chunkEnd: record.chunkEnd,
  };
}

async function contextFor(root: string, runtime: DkbRuntimeContext): Promise<QueryContext> {
  const library = await loadLibrary(root);
  return getQueryContext(library.root, library.manifest.id, runtime);
}

function requiredRuntime(runtime: DkbRuntimeContext | undefined): DkbRuntimeContext {
  if (!runtime) throw new DkbError('A DKB Runtime context is required when no query context is supplied.');
  return runtime;
}

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(limit, 100));
}
