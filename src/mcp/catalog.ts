import { loadCollection } from '../protocol/manifest.js';
import { sourceIndexForInstalledDkb } from '../runtime/catalog.js';

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
      const compiled = await sourceIndexForInstalledDkb(dkb);

      return {
        id: dkb.manifest.id,
        name: dkb.manifest.name,
        version: dkb.manifest.version,
        adapter: dkb.manifest.adapter,
        recordCount: compiled.units.length,
        topics: topicsFor(compiled.units.map((unit) => unit.title)),
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

function topicsFor(titles: string[]): string[] {
  return [...new Set(titles.filter(Boolean))].slice(0, 12);
}
