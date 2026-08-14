import { adapterFor } from '../adapters/index.js';
import { loadCollection } from '../protocol/manifest.js';
import type { KnowledgeRegion } from '../protocol/types.js';

export interface CollectionCatalog {
  collectionId: string;
  name: string;
  version: string;
  dkbs: Array<{
    id: string;
    name: string;
    version: string;
    adapter: string;
    recordCount: number;
    topics: string[];
  }>;
}

export async function describeCollection(collectionPath: string, collectionId?: string): Promise<CollectionCatalog> {
  const collection = await loadCollection(collectionPath, collectionId);
  const dkbs = await Promise.all(
    collection.dkbs.map(async (dkb) => {
      const adapter = await adapterFor(dkb.manifest.adapter);
      const records = await adapter.readRecords(dkb);

      return {
        id: dkb.manifest.id,
        name: dkb.manifest.name,
        version: dkb.manifest.version,
        adapter: dkb.manifest.adapter,
        recordCount: records.length,
        topics: topicsFor(records),
      };
    }),
  );

  return {
    collectionId: collection.manifest.id,
    name: collection.manifest.name,
    version: collection.manifest.version,
    dkbs,
  };
}

function topicsFor(records: KnowledgeRegion[]): string[] {
  return [...new Set(records.map((record) => record.title).filter(Boolean))].slice(0, 12);
}
