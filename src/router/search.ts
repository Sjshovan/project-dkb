import { adapterFor } from '../adapters/index.js';
import { krIndexExists, queryKrIndex } from '../indexes/knowledgeIndex.js';
import type { QueryContext } from '../indexes/queryContext.js';
import type { LoadedCollection, QueryHit, QueryResponse, QueryTrace } from '../protocol/types.js';
import { applyScoreProbabilityCutoff, defaultMinimumScore, hasSufficientQueryCoverage, scoreRecord, type ScoredRecord, tokenize } from './scoring.js';

export interface QueryOptions {
  limit?: number;
  minScore?: number;
  resultProbabilityCutoff?: number;
  queryContext?: QueryContext;
  profile?: boolean;
}

export async function queryCollection(
  collection: LoadedCollection,
  query: string,
  options: QueryOptions = {},
): Promise<QueryResponse> {
  const limit = options.limit ?? 10;
  const minScore = options.minScore ?? defaultMinimumScore;

  if (await krIndexExists(collection.root)) {
    const response = await queryKrIndex(collection.root, collection.manifest.id, query, limit, minScore, {
      includedDkbs: collection.dkbs.map((dkb) => dkb.manifest.id),
      resultProbabilityCutoff: options.resultProbabilityCutoff,
      queryContext: options.queryContext,
      profile: options.profile,
    });

    return {
      query,
      collectionId: collection.manifest.id,
      results: response.results,
      trace: response.trace,
    };
  }

  const queryTokens = tokenize(query);
  const traces: QueryTrace[] = [];
  const hits: QueryHit[] = [];

  for (const dkb of collection.dkbs) {
    const adapter = await adapterFor(dkb.manifest.adapter);
    const records = await adapter.readRecords(dkb);
    const dkbHits = records
      .map((record) => scoreRecord(record, queryTokens))
      .filter((result): result is ScoredRecord => result.score >= minScore && hasSufficientQueryCoverage(result, queryTokens))
      .filter((result) => isManifestQuery(queryTokens) || !isManifestOnlyRegion(result))
      .map((record) => ({
        ...record,
        dkbId: dkb.manifest.id,
        adapter: dkb.manifest.adapter,
      }));

    traces.push({
      dkbId: dkb.manifest.id,
      adapter: dkb.manifest.adapter,
      recordsScanned: records.length,
      hits: dkbHits.length,
    });

    hits.push(...dkbHits);
  }

  hits.sort((a, b) => b.score - a.score || a.dkbId.localeCompare(b.dkbId) || a.id.localeCompare(b.id));
  const results = applyScoreProbabilityCutoff(hits, options.resultProbabilityCutoff).slice(0, limit);

  return {
    query,
    collectionId: collection.manifest.id,
    results,
    trace: traces,
  };
}

function isManifestOnlyRegion(record: ScoredRecord): boolean {
  const paths = record.sourceRef?.locator && typeof record.sourceRef.locator === 'object'
    ? (record.sourceRef.locator as { paths?: unknown }).paths
    : null;

  return Array.isArray(paths) && paths.length > 0 && paths.every((item) => item === 'dkb.json');
}

function isManifestQuery(queryTokens: string[]): boolean {
  const manifestTerms = new Set(['manifest', 'package', 'version', 'license', 'author', 'collection', 'description']);

  return queryTokens.some((token) => manifestTerms.has(token));
}
