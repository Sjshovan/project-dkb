import path from 'node:path';
import { readSourceIndex } from '../indexes/sourceIndex.js';
import { querySearchDocuments, vectorDocumentsForSourceUnits } from '../indexes/vectorStore.js';
import type { QueryContext } from '../indexes/queryContext.js';
import type { LoadedCollection, QueryHit, QueryResponse } from '../protocol/types.js';

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
  const sourceIndex = options.queryContext
    ? { units: options.queryContext.sourceUnits }
    : await readSourceIndex(collection.root);
  const includedDkbs = new Set(collection.dkbs.map((dkb) => dkb.manifest.id));
  const sourceUnits = sourceIndex.units.filter((unit) => includedDkbs.has(unit.dkbId));
  const documents = vectorDocumentsForSourceUnits(sourceUnits);
  const result = await querySearchDocuments(
    options.queryContext?.searchRegistryId ?? collection.manifest.id,
    documents,
    query,
    limit,
    options.queryContext?.vectorArtifactRoot ?? path.join(collection.root, '.dkb', 'artifacts'),
  );
  const unitsById = new Map(sourceUnits.map((unit) => [unit.id, unit]));
  const results = result.hits
    .map((hit): QueryHit | null => {
      const unit = unitsById.get(hit.id);

      if (!unit) {
        return null;
      }

      return {
        id: unit.id,
        dkbId: unit.dkbId,
        adapter: 'compose',
        score: Math.round(hit.score * 1000) / 1000,
        title: unit.title,
        content: unit.text,
        source: unit.id,
        topics: unit.keywords,
        keywords: unit.keywords,
        entities: [unit.assetId],
        updatedAt: unit.updatedAt,
        sourceRef: {
          storeId: unit.storeId,
          type: unit.type,
          locator: unit.locator,
          hash: unit.hash,
        },
        queryable: unit.queryable,
        sourceUnits: [{
          id: unit.id,
          assetId: unit.assetId,
          storeId: unit.storeId,
          type: unit.type,
          locator: unit.locator,
          assetLocator: unit.assetLocator,
          title: unit.title,
          text: unit.text,
          keywords: unit.keywords,
          hash: unit.hash,
          updatedAt: unit.updatedAt,
          chunkOrdinal: unit.chunkOrdinal,
          chunkStart: unit.chunkStart,
          chunkEnd: unit.chunkEnd,
          heading: unit.heading,
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
      recordsScanned: sourceUnits.length,
      hits: results.length,
    }],
  };
}
