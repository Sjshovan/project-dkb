import { DatabaseSync } from 'node:sqlite';
import type { IndexedSourceUnit } from './sourceIndex.js';
import { tokenize } from '../router/scoring.js';

export interface LexicalPackageDescriptor {
  id: string;
  version: string;
  catalogPath: string;
  chunkCount: number;
}

export interface LexicalSearchScope {
  dkbId?: string;
  packageVersion?: string;
  assetId?: string;
  sourceType?: string;
}

export interface LexicalSearchHit {
  unitId: string;
  score: number;
  matchedTokens: string[];
}

interface OpenLexicalPackage extends LexicalPackageDescriptor {
  database: DatabaseSync;
}

export interface LexicalRuntimeSnapshot {
  packages: LexicalPackageDescriptor[];
  search(query: string, limit: number, scope?: LexicalSearchScope): LexicalSearchHit[];
  close(): void;
}

/**
 * Opens the package-local lexical tables produced with the compiled catalog.
 * The chunk catalog remains canonical; this table is a disposable lookup aid.
 */
export function buildLexicalRuntimeSnapshot(input: {
  packages: LexicalPackageDescriptor[];
  numericIdToUnitId: Map<string, string>;
  unitsById: Map<string, IndexedSourceUnit>;
}): LexicalRuntimeSnapshot | null {
  const opened: OpenLexicalPackage[] = [];

  try {
    for (const descriptor of input.packages) {
      const database = new DatabaseSync(descriptor.catalogPath, { readOnly: true });
      const table = database.prepare(`
        select 1
        from sqlite_master
        where type = 'table' and name = 'lexical_tokens'
        limit 1
      `).get();

      if (!table) {
        database.close();
        continue;
      }

      opened.push({ ...descriptor, database });
    }
  } catch {
    for (const packageCatalog of opened) {
      packageCatalog.database.close();
    }

    return null;
  }

  if (opened.length === 0) {
    return null;
  }

  return {
    packages: opened.map(({ database: _database, ...descriptor }) => descriptor),
    search(query, limit, scope) {
      const tokens = [...new Set(tokenize(query, { keepStopwords: true }))];

      if (tokens.length === 0) {
        return [];
      }

      const hits = new Map<string, { score: number; matchedTokens: Set<string> }>();

      for (const packageCatalog of opened) {
        if (scope?.dkbId && scope.dkbId !== packageCatalog.id) {
          continue;
        }
        if (scope?.packageVersion && scope.packageVersion !== packageCatalog.version) {
          continue;
        }

        const placeholders = tokens.map(() => '?').join(', ');
        const conditions = [`lexical.token in (${placeholders})`];
        const values: Array<string | number | null | Uint8Array> = tokens;

        if (scope?.assetId) {
          conditions.push('chunks.asset_id = ?');
          values.push(scope.assetId);
        }
        if (scope?.sourceType) {
          conditions.push('chunks.type = ?');
          values.push(scope.sourceType);
        }

        const rows = packageCatalog.database.prepare(`
          select lexical.token, lexical.numeric_id, lexical.weight, chunks.chunk_id
          from lexical_tokens lexical
          join chunks on chunks.numeric_id = lexical.numeric_id
          where ${conditions.join(' and ')}
        `).all(...values) as Array<Record<string, unknown>>;

        for (const row of rows) {
          const numericId = String(row.numeric_id);
          const unitId = input.numericIdToUnitId.get(numericId);

          if (!unitId || !input.unitsById.has(unitId)) {
            continue;
          }

          const current = hits.get(unitId) ?? { score: 0, matchedTokens: new Set<string>() };
          current.score += Number(row.weight);
          current.matchedTokens.add(String(row.token));
          hits.set(unitId, current);
        }
      }

      return [...hits.entries()]
        .sort((left, right) => right[1].score - left[1].score || left[0].localeCompare(right[0]))
        .slice(0, Math.max(1, Math.min(limit, 100)))
        .map(([unitId, hit]) => ({
          unitId,
          score: hit.score,
          matchedTokens: [...hit.matchedTokens].sort(),
        }));
    },
    close() {
      for (const packageCatalog of opened) {
        packageCatalog.database.close();
      }
    },
  };
}
