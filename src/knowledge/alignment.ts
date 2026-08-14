import path from 'node:path';
import fs from 'node:fs/promises';
import { stableHash } from '../contracts/hash.js';
import type { KnowledgeRegionDescriptor } from '../contracts/types.js';
import { DkbError } from '../protocol/errors.js';
import { loadDkb, loadRegistry } from '../protocol/manifest.js';
import { manifestPath } from '../protocol/paths.js';
import type { LoadedDkb } from '../protocol/types.js';
import { buildRegistryRegions, type RegistryRegion } from '../registry/index.js';
import { buildKnowledgeRegionDescriptorsFromDkb } from './regionDescriptors.js';

export type AlignmentTargetType = 'dkr' | 'dkc' | 'dkb';
export type AlignmentAuditStatus = 'aligned' | 'issues';

export interface KnowledgeAlignmentAuditRegion {
  regionDescriptorId: string;
  collectionId: string | null;
  dkbId: string;
  recordId: string;
  title: string;
  searchEligible: boolean;
  issues: string[];
  sourceContentHash: string;
  indexBuildHash: string;
  descriptorHash: string;
  updatedAt: string;
  integrity: NonNullable<KnowledgeRegionDescriptor['integrity']>;
  authenticity: NonNullable<KnowledgeRegionDescriptor['authenticity']>;
  trust: NonNullable<KnowledgeRegionDescriptor['trust']>;
}

export interface KnowledgeAlignmentAuditDkbSummary {
  collectionId: string | null;
  dkbId: string;
  totalRegions: number;
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
    regions: number;
    searchEligible: number;
    ignored: number;
    issueCounts: Record<string, number>;
  };
  dkbSummaries: KnowledgeAlignmentAuditDkbSummary[];
  ignoredRegions: KnowledgeAlignmentAuditRegion[];
  regions: KnowledgeAlignmentAuditRegion[];
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

  if (!(await exists(manifestPath(resolvedPath, 'dkb.json')))) {
    const registry = await loadRegistry(resolvedPath);
    const index = await buildRegistryRegions(resolvedPath);
    const regions = index.regions.map((region) => auditRegionFromRegistryRegion(region));

    return buildAudit({
      target: {
        path: resolvedPath,
        type: 'dkr',
        id: registry.manifest.id,
        name: registry.manifest.name,
        version: registry.manifest.version,
      },
      regions,
      metadata: {
        duplicateDkbRoots: index.metadata.duplicateDkbRoots,
      },
    });
  }

  const dkb = await loadDkb(resolvedPath);
  const regions = (await buildKnowledgeRegionDescriptorsFromDkb(dkb, standaloneCollectionHash(dkb)))
    .map((region) => auditRegionFromDescriptor(region, null));

  return buildAudit({
    target: {
      path: resolvedPath,
      type: 'dkb',
      id: dkb.manifest.id,
      name: dkb.manifest.name,
      version: dkb.manifest.version,
    },
    regions,
    metadata: {},
  });
}

function buildAudit(input: {
  target: KnowledgeAlignmentAudit['target'];
  regions: KnowledgeAlignmentAuditRegion[];
  metadata: KnowledgeAlignmentAudit['metadata'];
}): KnowledgeAlignmentAudit {
  const regions = input.regions.sort((a, b) => {
    const collection = String(a.collectionId).localeCompare(String(b.collectionId));

    if (collection !== 0) {
      return collection;
    }

    const dkb = a.dkbId.localeCompare(b.dkbId);

    return dkb !== 0 ? dkb : a.recordId.localeCompare(b.recordId);
  });
  const ignoredRegions = regions.filter((region) => !region.searchEligible);
  const totals = {
    regions: regions.length,
    searchEligible: regions.length - ignoredRegions.length,
    ignored: ignoredRegions.length,
    issueCounts: issueCounts(regions),
  };

  return {
    target: input.target,
    status: ignoredRegions.length === 0 ? 'aligned' : 'issues',
    totals,
    dkbSummaries: summarizeDkbs(regions),
    ignoredRegions,
    regions,
    metadata: input.metadata,
  };
}

function auditRegionFromRegistryRegion(region: RegistryRegion): KnowledgeAlignmentAuditRegion {
  return auditRegionFromDescriptor(region, region.origin.collectionId, region.origin.dkbId, region.origin.recordId);
}

function auditRegionFromDescriptor(
  region: KnowledgeRegionDescriptor,
  collectionId: string | null,
  dkbId = region.origin?.dkbId ?? region.fetch.dkbId ?? region.fetchPlan?.dkbId,
  recordId = region.origin?.recordId ?? region.fetch.recordId ?? region.fetchPlan?.recordId,
): KnowledgeAlignmentAuditRegion {
  if (!dkbId) {
    throw new DkbError(`Region descriptor ${region.id} does not expose a DKB id`);
  }

  if (!recordId) {
    throw new DkbError(`Region descriptor ${region.id} does not expose a record id`);
  }

  const issues = [
    region.domains.length === 0 ? 'missing_domains' : null,
    region.topics.length === 0 ? 'missing_topics' : null,
    region.entities.length === 0 ? 'missing_entities' : null,
    !region.updatedAt ? 'missing_updated_at' : null,
  ].filter((issue): issue is string => issue !== null);

  return {
    regionDescriptorId: region.id,
    collectionId,
    dkbId,
    recordId,
    title: region.title,
    searchEligible: issues.length === 0,
    issues,
    sourceContentHash: region.contentHash,
    indexBuildHash: region.indexHash,
    descriptorHash: region.descriptorHash,
    updatedAt: region.updatedAt,
    integrity: region.integrity ?? {
      method: 'hash',
      hash: region.contentHash,
      verified: true,
      reason: 'content_hash_available',
    },
    authenticity: region.authenticity ?? {
      method: 'none',
      verified: false,
      signer: null,
      signature: null,
      reason: 'no_publisher_signature_available',
    },
    trust: region.trust ?? {
      score: 0,
      source: 'none',
      reason: 'not_trusted_by_policy',
    },
  };
}

function summarizeDkbs(regions: KnowledgeAlignmentAuditRegion[]): KnowledgeAlignmentAuditDkbSummary[] {
  const groups = new Map<string, KnowledgeAlignmentAuditRegion[]>();

  for (const region of regions) {
    const key = `${region.collectionId ?? ''}\u0000${region.dkbId}`;

    groups.set(key, [...(groups.get(key) ?? []), region]);
  }

  return [...groups.values()]
    .map((group) => {
      const first = group[0];

      if (!first) {
        throw new DkbError('Unable to summarize empty region group');
      }

      const ignored = group.filter((region) => !region.searchEligible).length;

      return {
        collectionId: first.collectionId,
        dkbId: first.dkbId,
        totalRegions: group.length,
        searchEligible: group.length - ignored,
        ignored,
        issueCounts: issueCounts(group),
      };
    })
    .sort((a, b) => {
      const collection = String(a.collectionId).localeCompare(String(b.collectionId));

      return collection !== 0 ? collection : a.dkbId.localeCompare(b.dkbId);
    });
}

function issueCounts(regions: KnowledgeAlignmentAuditRegion[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const region of regions) {
    for (const issue of region.issues) {
      counts[issue] = (counts[issue] ?? 0) + 1;
    }
  }

  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function standaloneCollectionHash(dkb: LoadedDkb): string {
  return stableHash({
    type: 'standalone-dkb',
    dkbId: dkb.manifest.id,
    version: dkb.manifest.version,
  });
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);

    return true;
  } catch {
    return false;
  }
}
