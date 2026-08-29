import { getQueryContext, type QueryContext } from '../indexes/queryContext.js';
import type { LoadedCollection, QueryHit, QueryResponse } from '@sjshovan/dkb-protocol/types.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbRuntimeContext } from '../runtime/context.js';

export interface QueryOptions {
  limit?: number;
  minScore?: number;
  resultProbabilityCutoff?: number;
  queryContext?: QueryContext;
  runtime?: DkbRuntimeContext;
  profile?: boolean;
}

export async function queryCollection(
  collection: LoadedCollection,
  query: string,
  options: QueryOptions = {},
): Promise<QueryResponse> {
  const limit = options.limit ?? 10;
  const context = options.queryContext ?? await getQueryContext(collection.root, collection.manifest.id, requiredRuntime(options.runtime));
  const includedDkbs = new Set(collection.dkbs.map((dkb) => dkb.manifest.id));
  const records = context.evidenceRecords.filter((record) => includedDkbs.has(record.packageId));
  const result = await context.retrieval.search({ query, limit });
  const recordsById = new Map(records.map((record) => [record.evidenceId, record]));
  const results = result.hits
    .map((hit): QueryHit | null => {
      const record = recordsById.get(hit.evidenceId);

      if (!record) {
        return null;
      }

      return {
        id: record.evidenceId,
        dkbId: record.packageId,
        adapter: 'compose',
        score: Math.round(hit.score * 1000) / 1000,
        title: record.title,
        content: record.text,
        source: record.evidenceId,
        topics: record.keywords,
        keywords: record.keywords,
        entities: [record.assetId],
        updatedAt: record.updatedAt,
        sourceRef: {
          storeId: record.storeId,
          type: record.sourceType,
          locator: record.locator,
          hash: record.textHash,
        },
        queryable: record.queryable,
        sourceUnits: [{
          id: record.evidenceId,
          assetId: record.assetId,
          storeId: record.storeId,
          type: record.sourceType,
          locator: record.locator,
          assetLocator: record.assetLocator,
          title: record.title,
          text: record.text,
          keywords: record.keywords,
          hash: record.textHash,
          updatedAt: record.updatedAt,
          chunkOrdinal: record.chunkOrdinal,
          chunkStart: record.chunkStart,
          chunkEnd: record.chunkEnd,
          heading: record.heading,
        }],
      };
    })
    .filter((hit): hit is QueryHit => Boolean(hit));

  return {
    query,
    collectionId: collection.manifest.id,
    results,
    trace: [{
      dkbId: collection.manifest.id,
      adapter: 'compose',
      recordsScanned: records.length,
      hits: results.length,
    }],
  };
}

function requiredRuntime(runtime: DkbRuntimeContext | undefined): DkbRuntimeContext {
  if (!runtime) throw new DkbError('A DKB Runtime context is required when no query context is supplied.');
  return runtime;
}
