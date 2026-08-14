import path from 'node:path';
import fs from 'node:fs/promises';
import { stableHash } from '../contracts/hash.js';
import { loadDkb, loadRegistry } from '../protocol/manifest.js';
import { manifestPath } from '../protocol/paths.js';
import type { LoadedCollection, LoadedDkb, QueryResponse, QueryTrace } from '../protocol/types.js';
import { queryCollection, type QueryOptions } from '../router/search.js';

export type KnowledgeTargetType = 'dkb' | 'dkc' | 'dkr';

export interface KnowledgeTargetDkbRef {
  dkbId: string;
  root: string;
  collectionId: string | null;
  standalone: boolean;
}

export interface KnowledgeTargetDuplicate {
  root: string;
  firstSeenAt: string;
  duplicateAt: string;
  dkbId: string;
}

export interface KnowledgeTargetResolution {
  path: string;
  type: KnowledgeTargetType;
  id: string;
  name: string;
  version: string;
  targetHash: string;
  units: Array<{
    collection: LoadedCollection;
    collectionId: string | null;
    standalone: boolean;
  }>;
  includedDkbs: KnowledgeTargetDkbRef[];
  duplicateDkbRoots: KnowledgeTargetDuplicate[];
}

export interface KnowledgeTargetSummary {
  path: string;
  type: KnowledgeTargetType;
  id: string;
  name: string;
  version: string;
  targetHash: string;
  includedDkbs: KnowledgeTargetDkbRef[];
  duplicateDkbRoots: KnowledgeTargetDuplicate[];
}

export async function resolveKnowledgeTarget(targetPath: string): Promise<KnowledgeTargetResolution> {
  const resolvedPath = path.resolve(targetPath);

  if (!(await exists(manifestPath(resolvedPath, 'dkb.json')))) {
    const registry = await loadRegistry(resolvedPath);
    const duplicateTracker = createDuplicateTracker();
    const units: KnowledgeTargetResolution['units'] = [];
    const includedDkbs: KnowledgeTargetDkbRef[] = [];

    for (const collection of registry.collections) {
      const dkbs = collection.dkbs.filter((dkb) => duplicateTracker.track(dkb, `collection:${collection.manifest.id}`));

      if (dkbs.length === 0) {
        continue;
      }

      units.push({
        collection: {
          ...collection,
          dkbs,
        },
        collectionId: collection.manifest.id,
        standalone: false,
      });
      includedDkbs.push(...dkbs.map((dkb) => dkbRef(dkb, collection.manifest.id, false)));
    }

    const standalone = registry.dkbs.filter((dkb) => duplicateTracker.track(dkb, 'dkb'));

    if (standalone.length > 0) {
      units.push({
        collection: {
          root: registry.root,
          manifest: {
            id: `${registry.manifest.id}-standalone`,
            name: `${registry.manifest.name} Standalone DKBs`,
            version: registry.manifest.version,
            dkbs: [],
          },
          dkbs: standalone,
        },
        collectionId: null,
        standalone: true,
      });
      includedDkbs.push(...standalone.map((dkb) => dkbRef(dkb, null, true)));
    }

    return {
      path: resolvedPath,
      type: 'dkr',
      id: registry.manifest.id,
      name: registry.manifest.name,
      version: registry.manifest.version,
      targetHash: stableHash({
        type: 'dkr-target',
        id: registry.manifest.id,
        version: registry.manifest.version,
        includedDkbs,
      }),
      units,
      includedDkbs,
      duplicateDkbRoots: duplicateTracker.duplicates,
    };
  }

  const dkb = await loadDkb(resolvedPath);
  const includedDkbs = [dkbRef(dkb, null, true)];

  return {
    path: resolvedPath,
    type: 'dkb',
    id: dkb.manifest.id,
    name: dkb.manifest.name,
    version: dkb.manifest.version,
    targetHash: stableHash({
      type: 'dkb-target',
      id: dkb.manifest.id,
      version: dkb.manifest.version,
      root: dkb.root,
    }),
    units: [
      {
        collection: {
          root: dkb.root,
          manifest: {
            id: dkb.manifest.id,
            name: dkb.manifest.name,
            version: dkb.manifest.version,
            dkbs: [],
          },
          dkbs: [dkb],
        },
        collectionId: null,
        standalone: true,
      },
    ],
    includedDkbs,
    duplicateDkbRoots: [],
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);

    return true;
  } catch {
    return false;
  }
}

export async function queryKnowledgeTarget(
  targetPath: string,
  query: string,
  options: QueryOptions = {},
): Promise<{ target: KnowledgeTargetResolution; response: QueryResponse }> {
  return queryResolvedKnowledgeTarget(await resolveKnowledgeTarget(targetPath), query, options);
}

export async function queryResolvedKnowledgeTarget(
  target: KnowledgeTargetResolution,
  query: string,
  options: QueryOptions = {},
): Promise<{ target: KnowledgeTargetResolution; response: QueryResponse }> {
  const results: QueryResponse['results'] = [];
  const trace: QueryTrace[] = [];

  for (const unit of target.units) {
    const response = await queryCollection(unit.collection, query, {
      ...options,
      resultProbabilityCutoff: options.resultProbabilityCutoff ?? 0,
    });

    results.push(...response.results);
    trace.push(...response.trace);
  }

  const dedupedResults = dedupeHits(results);
  results.length = 0;
  results.push(...dedupedResults);
  results.sort((a, b) => b.score - a.score || a.dkbId.localeCompare(b.dkbId) || a.id.localeCompare(b.id));

  return {
    target,
    response: {
      query,
      collectionId: target.id,
      results: results.slice(0, options.limit ?? 10),
      trace,
    },
  };
}

function dedupeHits(results: QueryResponse['results']): QueryResponse['results'] {
  const byId = new Map<string, QueryResponse['results'][number]>();

  for (const result of results) {
    const key = `${result.dkbId}/${result.id}`;
    const previous = byId.get(key);

    if (!previous || result.score > previous.score) {
      byId.set(key, result);
    }
  }

  return [...byId.values()];
}

export function summarizeKnowledgeTarget(target: KnowledgeTargetResolution): KnowledgeTargetSummary {
  return {
    path: target.path,
    type: target.type,
    id: target.id,
    name: target.name,
    version: target.version,
    targetHash: target.targetHash,
    includedDkbs: target.includedDkbs,
    duplicateDkbRoots: target.duplicateDkbRoots,
  };
}

function dkbRef(dkb: LoadedDkb, collectionId: string | null, standalone: boolean): KnowledgeTargetDkbRef {
  return {
    dkbId: dkb.manifest.id,
    root: dkb.root,
    collectionId,
    standalone,
  };
}

function createDuplicateTracker() {
  const seen = new Map<string, { seenAt: string; dkbId: string }>();
  const duplicates: KnowledgeTargetDuplicate[] = [];

  return {
    duplicates,
    track(dkb: LoadedDkb, seenAt: string): boolean {
      const identity = dkb.identityKey ?? `root:${path.resolve(dkb.root)}`;
      const previous = seen.get(identity);

      if (previous) {
        duplicates.push({
          root: path.resolve(dkb.root),
          firstSeenAt: previous.seenAt,
          duplicateAt: seenAt,
          dkbId: dkb.manifest.id,
        });

        return false;
      }

      seen.set(identity, {
        seenAt,
        dkbId: dkb.manifest.id,
      });

      return true;
    },
  };
}
