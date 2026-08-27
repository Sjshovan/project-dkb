import path from 'node:path';
import { readSourceIndex } from '@dkb/providers-bundled/sourceIndex.js';
import { loadCollection, loadDkb, loadLibrary, loadManifest } from '@dkb/protocol/manifest.js';

export type AlignmentTargetType = 'library' | 'collection' | 'dkb';
export type AlignmentAuditStatus = 'aligned' | 'issues';

export interface KnowledgeAlignmentAuditChunk {
  sourceId: string;
  dkbId: string;
  assetId: string;
  title: string;
  searchEligible: boolean;
  issues: string[];
  sourceContentHash: string;
  updatedAt: string;
}

export interface KnowledgeAlignmentAuditDkbSummary {
  collectionId: string | null;
  dkbId: string;
  totalChunks: number;
  searchEligible: number;
  ignored: number;
  issueCounts: Record<string, number>;
}

export interface KnowledgeAlignmentAudit {
  target: {
    path: string;
    type: AlignmentTargetType;
    id: string;
    name: string;
    version: string;
  };
  status: AlignmentAuditStatus;
  totals: {
    chunks: number;
    searchEligible: number;
    ignored: number;
    issueCounts: Record<string, number>;
  };
  dkbSummaries: KnowledgeAlignmentAuditDkbSummary[];
  ignoredChunks: KnowledgeAlignmentAuditChunk[];
  chunks: KnowledgeAlignmentAuditChunk[];
  metadata: {
    duplicateDkbRoots?: Array<{
      root: string;
      firstSeenAt: string;
      duplicateAt: string;
      dkbId: string;
    }>;
  };
}

export async function auditKnowledgeAlignment(targetPath: string): Promise<KnowledgeAlignmentAudit> {
  const resolvedPath = path.resolve(targetPath);
  const manifest = await loadManifest(resolvedPath);
  const target = manifest.type === 'dkb'
    ? await packageTarget(resolvedPath)
    : manifest.type === 'collection'
      ? await collectionTarget(resolvedPath)
      : await libraryTarget(resolvedPath);
  const sourceIndex = await readSourceIndex(resolvedPath).catch(() => ({ assets: [], units: [], edges: [] }));
  const chunks = sourceIndex.units.map((unit): KnowledgeAlignmentAuditChunk => {
    const issues = [
      unit.text.trim().length === 0 ? 'missing_text' : null,
      unit.hash.length === 0 ? 'missing_chunk_hash' : null,
      Object.keys(unit.locator).length === 0 ? 'missing_locator' : null,
      unit.assetId.length === 0 ? 'missing_asset_id' : null,
    ].filter((issue): issue is string => Boolean(issue));

    return {
      sourceId: unit.id,
      dkbId: unit.dkbId,
      assetId: unit.assetId,
      title: unit.title,
      searchEligible: issues.length === 0,
      issues,
      sourceContentHash: unit.hash,
      updatedAt: unit.updatedAt,
    };
  }).sort((left, right) => left.dkbId.localeCompare(right.dkbId) || left.sourceId.localeCompare(right.sourceId));

  return buildAudit(target, chunks);
}

async function packageTarget(resolvedPath: string): Promise<KnowledgeAlignmentAudit['target']> {
  const dkb = await loadDkb(resolvedPath);

  return {
    path: resolvedPath,
    type: 'dkb',
    id: dkb.manifest.id,
    name: dkb.manifest.name,
    version: dkb.manifest.version,
  };
}

async function collectionTarget(resolvedPath: string): Promise<KnowledgeAlignmentAudit['target']> {
  const collection = await loadCollection(resolvedPath);

  return {
    path: resolvedPath,
    type: 'collection',
    id: collection.manifest.id,
    name: collection.manifest.name,
    version: collection.manifest.version,
  };
}

async function libraryTarget(resolvedPath: string): Promise<KnowledgeAlignmentAudit['target']> {
  const library = await loadLibrary(resolvedPath);

  return {
    path: resolvedPath,
    type: 'library',
    id: library.manifest.id,
    name: library.manifest.name,
    version: library.manifest.version,
  };
}

function buildAudit(
  target: KnowledgeAlignmentAudit['target'],
  chunks: KnowledgeAlignmentAuditChunk[],
): KnowledgeAlignmentAudit {
  const ignoredChunks = chunks.filter((chunk) => !chunk.searchEligible);
  const totals = {
    chunks: chunks.length,
    searchEligible: chunks.length - ignoredChunks.length,
    ignored: ignoredChunks.length,
    issueCounts: issueCounts(chunks),
  };

  return {
    target,
    status: ignoredChunks.length === 0 ? 'aligned' : 'issues',
    totals,
    dkbSummaries: summarizeDkbs(chunks),
    ignoredChunks,
    chunks,
    metadata: {},
  };
}

function summarizeDkbs(chunks: KnowledgeAlignmentAuditChunk[]): KnowledgeAlignmentAuditDkbSummary[] {
  const groups = new Map<string, KnowledgeAlignmentAuditChunk[]>();

  for (const chunk of chunks) {
    groups.set(chunk.dkbId, [...(groups.get(chunk.dkbId) ?? []), chunk]);
  }

  return [...groups.entries()]
    .map(([dkbId, group]) => {
      const ignored = group.filter((chunk) => !chunk.searchEligible).length;

      return {
        collectionId: null,
        dkbId,
        totalChunks: group.length,
        searchEligible: group.length - ignored,
        ignored,
        issueCounts: issueCounts(group),
      };
    })
    .sort((a, b) => a.dkbId.localeCompare(b.dkbId));
}

function issueCounts(chunks: KnowledgeAlignmentAuditChunk[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const chunk of chunks) {
    for (const issue of chunk.issues) {
      counts[issue] = (counts[issue] ?? 0) + 1;
    }
  }

  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}
