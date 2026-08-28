import type { QueryContext } from '../indexes/queryContext.js';
import {
  readSourceIndex,
  sourceAssetsFromChunks,
  type IndexedSourceUnit,
} from '@sjshovan/dkb-providers-bundled/sourceIndex.js';
import { querySearchDocuments, vectorDocumentsForSourceUnits } from '@sjshovan/dkb-providers-bundled/vectorStore.js';
import type { LexicalSearchScope } from '@sjshovan/dkb-providers-bundled/lexicalStore.js';
import { tokenize } from '@sjshovan/dkb-providers-bundled/scoring.js';
import { renderUntrustedSourceBlock, renderUntrustedSourceInline, SOURCE_DATA_POLICY_LINE } from '@sjshovan/dkb-protocol/security/sourceContent.js';

export interface DkbNavigationScope extends LexicalSearchScope {}

export interface DkbNavigationReference {
  id: string;
  evidenceId?: string;
  dkbId: string;
  packageVersion?: string;
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

export interface DkbLexicalSearchResponse {
  status: 'ready' | 'empty';
  query: string;
  results: DkbNavigationReference[];
  trace: Record<string, unknown>;
}

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
): Promise<DkbSemanticSearchResponse> {
  const units = activeUnits(queryContext, await maybeReadSourceUnits(root));
  const scopedUnits = units.filter((unit) => unitMatchesScope(unit, scope));

  if (scopedUnits.length === 0) {
    return {
      status: 'empty',
      query,
      results: [],
      trace: { engine: queryContext?.index?.providerId ?? 'unavailable', status: 'empty' },
    };
  }

  const scopedIds = new Set(scopedUnits.map((unit) => unit.id));
  const unitsById = new Map(scopedUnits.map((unit) => [unit.id, unit]));
  const searchLimit = Math.min(Math.max(clampLimit(limit) * 5, 50), 1_000);
  const lexicalResults = queryContext?.lexical
    ? queryContext.lexical.search(query, searchLimit, scope)
      .map((hit) => {
        const unit = unitsById.get(hit.unitId);

        return unit ? navigationReference(unit, hit.score, hit.matchedTokens) : null;
      })
      .filter((reference): reference is DkbNavigationReference => Boolean(reference))
    : memoryLexicalSearch(scopedUnits, query, searchLimit);
  const result = queryContext?.index
    ? await queryContext.index.search(query, searchLimit)
    : await querySearchDocuments(
      queryContext?.searchRegistryId ?? 'compose-index',
      queryContext?.vectorDocuments ?? vectorDocumentsForSourceUnits(scopedUnits),
      query,
      searchLimit,
      queryContext?.vectorArtifactRoot,
    );
  const vectorResults = result.hits
    .filter((hit) => scopedIds.has(hit.id))
    .map((hit) => {
      const unit = unitsById.get(hit.id);

      return unit ? navigationReference(unit, hit.score) : null;
    })
    .filter((reference): reference is DkbNavigationReference => Boolean(reference));
  const results = fuseNavigationReferences(lexicalResults, vectorResults, clampLimit(limit));

  return {
    status: results.length > 0 ? 'ready' : 'empty',
    query,
    results,
    trace: {
      engine: 'hybrid',
      navigation: 'reference_first',
      lexicalHits: lexicalResults.length,
      vectorHits: vectorResults.length,
      vector: result.trace,
    },
  };
}

export async function lexicalSearch(
  root: string,
  query: string,
  limit = 10,
  scope?: DkbNavigationScope,
  queryContext?: QueryContext,
): Promise<DkbLexicalSearchResponse> {
  const units = activeUnits(queryContext, await maybeReadSourceUnits(root));
  const unitsById = new Map(units.map((unit) => [unit.id, unit]));
  let results: DkbNavigationReference[];
  let engine: 'sqlite-token' | 'memory-token' = 'memory-token';

  if (queryContext?.lexical) {
    results = queryContext.lexical.search(query, clampLimit(limit), scope)
      .map((hit) => {
        const unit = unitsById.get(hit.unitId);

        return unit ? navigationReference(unit, hit.score, hit.matchedTokens) : null;
      })
      .filter((reference): reference is DkbNavigationReference => Boolean(reference));
    engine = 'sqlite-token';
  } else {
    results = memoryLexicalSearch(units.filter((unit) => unitMatchesScope(unit, scope)), query, limit);
  }

  return {
    status: results.length > 0 ? 'ready' : 'empty',
    query,
    results,
    trace: {
      engine,
      status: results.length > 0 ? 'ready' : 'empty',
      navigation: 'reference_first',
      packages: new Set(units.map((unit) => unit.dkbId)).size,
    },
  };
}

export async function readNavigationChunks(
  root: string,
  targets: string[],
  queryContext?: QueryContext,
): Promise<DkbReadNavigationResponse> {
  const units = activeUnits(queryContext, await maybeReadSourceUnits(root));
  const byTarget = new Map<string, IndexedSourceUnit>();

  for (const unit of units) {
    byTarget.set(unit.id, unit);
    byTarget.set(`${unit.dkbId}/${unit.id}`, unit);
  }

  const chunks: DkbReadNavigationChunk[] = [];
  const missing: string[] = [];

  for (const target of [...new Set(targets)]) {
    const unit = byTarget.get(target);

    if (!unit) {
      missing.push(target);
      continue;
    }

    chunks.push({
      reference: navigationReference(unit, 1),
      text: renderUntrustedSourceBlock(unit.text),
      sourcePolicy: SOURCE_DATA_POLICY_LINE,
    });
  }

  return {
    status: chunks.length === 0 ? 'empty' : missing.length > 0 ? 'partial' : 'complete',
    chunks,
    missing,
    trace: {
      retrievalMode: 'compiled_chunk_direct',
      chunksRead: chunks.length,
      sourceCompilation: false,
      adapterRead: false,
    },
  };
}

export async function describeSources(root: string, queryContext?: QueryContext): Promise<DkbSourceDescription[]> {
  const units = activeUnits(queryContext, await maybeReadSourceUnits(root));
  const assets = sourceAssetsFromChunks(units);

  return [...assets.values()]
    .map((asset) => ({
      id: asset.id,
      dkbId: asset.dkbId,
      storeId: asset.storeId,
      type: asset.type,
      title: asset.title,
      locator: asset.locator,
      sourceHash: asset.hash,
      updatedAt: asset.updatedAt,
      chunkCount: units.filter((unit) => unit.dkbId === asset.dkbId && unit.assetId === asset.id).length,
    }))
    .sort((left, right) => `${left.dkbId}/${left.id}`.localeCompare(`${right.dkbId}/${right.id}`));
}

function activeUnits(queryContext: QueryContext | undefined, fallback: IndexedSourceUnit[]): IndexedSourceUnit[] {
  return queryContext?.sourceUnits ?? fallback;
}

async function maybeReadSourceUnits(root: string): Promise<IndexedSourceUnit[]> {
  try {
    return (await readSourceIndex(root)).units;
  } catch {
    return [];
  }
}

function navigationReference(unit: IndexedSourceUnit, score: number, matchedTokens: string[] = []): DkbNavigationReference {
  const preview = unit.text.length > 280 ? `${unit.text.slice(0, 277)}...` : unit.text;

  return {
    id: unit.id,
    evidenceId: unit.evidenceId,
    dkbId: unit.dkbId,
    packageVersion: unit.packageVersion,
    sourceId: unit.id,
    assetId: unit.assetId,
    storeId: unit.storeId,
    title: unit.title,
    preview: renderUntrustedSourceInline(preview),
    score,
    ...(matchedTokens.length > 0 ? { matchedTokens } : {}),
    sourceType: unit.type,
    locator: unit.locator,
    assetLocator: unit.assetLocator,
    sourceHash: unit.hash,
    chunkOrdinal: unit.chunkOrdinal,
    chunkStart: unit.chunkStart,
    chunkEnd: unit.chunkEnd,
  };
}

function memoryLexicalSearch(units: IndexedSourceUnit[], query: string, limit: number): DkbNavigationReference[] {
  const queryTokens = [...new Set(tokenize(query, { keepStopwords: true }))];

  return units
    .map((unit) => {
      const titleTokens = new Set(tokenize(unit.title, { keepStopwords: true }));
      const keywordTokens = new Set(tokenize(unit.keywords.join(' '), { keepStopwords: true }));
      const textTokens = new Set(tokenize(unit.text, { keepStopwords: true }));
      const matchedTokens = queryTokens.filter((token) => titleTokens.has(token) || keywordTokens.has(token) || textTokens.has(token));
      const score = matchedTokens.reduce((total, token) => total + (titleTokens.has(token) ? 3 : keywordTokens.has(token) ? 2 : 1), 0);

      return { unit, score, matchedTokens };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.unit.id.localeCompare(right.unit.id))
    .slice(0, clampLimit(limit))
    .map((item) => navigationReference(item.unit, item.score, item.matchedTokens));
}

function fuseNavigationReferences(
  lexicalResults: DkbNavigationReference[],
  vectorResults: DkbNavigationReference[],
  limit: number,
): DkbNavigationReference[] {
  const fused = new Map<string, { reference: DkbNavigationReference; score: number }>();
  const add = (results: DkbNavigationReference[], weight: number): void => {
    results.forEach((reference, index) => {
      const current = fused.get(reference.id);
      const preferred = current?.reference.matchedTokens?.length ? current.reference : reference;

      fused.set(reference.id, {
        reference: preferred,
        score: (current?.score ?? 0) + (weight / (index + 1)),
      });
    });
  };

  add(lexicalResults, 0.65);
  add(vectorResults, 0.35);

  return [...fused.values()]
    .sort((left, right) => longestMatchedToken(right.reference) - longestMatchedToken(left.reference)
      || (right.reference.matchedTokens?.length ?? 0) - (left.reference.matchedTokens?.length ?? 0)
      || right.score - left.score
      || left.reference.id.localeCompare(right.reference.id))
    .slice(0, limit)
    .map(({ reference, score }) => ({ ...reference, score }));
}

function longestMatchedToken(reference: DkbNavigationReference): number {
  return Math.max(0, ...(reference.matchedTokens ?? []).map((token) => token.length));
}

function unitMatchesScope(unit: IndexedSourceUnit, scope?: DkbNavigationScope): boolean {
  return (!scope?.dkbId || scope.dkbId === unit.dkbId)
    && (!scope?.packageVersion || scope.packageVersion === unit.packageVersion)
    && (!scope?.assetId || scope.assetId === unit.assetId)
    && (!scope?.sourceType || scope.sourceType === unit.type);
}

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(limit, 100));
}
