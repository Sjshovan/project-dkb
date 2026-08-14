import { adapterFor } from '../adapters/index.js';
import { stableHash } from '../contracts/hash.js';
import type { KnowledgeRegionDescriptor } from '../contracts/types.js';
import { krIndexExists, readKrIndex, type IndexedKnowledgeRegion } from '../indexes/knowledgeIndex.js';
import type { DkbAdapter, DkbReadOperation, KnowledgeRegion, LoadedCollection, LoadedDkb } from '../protocol/types.js';
import { renderUntrustedMetadataValue } from '../security/sourceContent.js';
import { resolveKnowledgeTarget, type KnowledgeTargetResolution } from './target.js';

export interface KnowledgeRegionDescriptorBuild {
  collectionId: string;
  collectionHash: string;
  regions: KnowledgeRegionDescriptor[];
}

export async function buildKnowledgeRegionDescriptors(targetPath: string): Promise<KnowledgeRegionDescriptorBuild> {
  return buildKnowledgeRegionDescriptorsFromTarget(await resolveKnowledgeTarget(targetPath));
}

export async function buildKnowledgeRegionDescriptorsFromTarget(target: KnowledgeTargetResolution): Promise<KnowledgeRegionDescriptorBuild> {
  if (await krIndexExists(target.path)) {
    const includedDkbs = new Set(target.includedDkbs.map((dkb) => dkb.dkbId));
    const records = (await readKrIndex(target.path)).filter((record) => includedDkbs.has(record.dkbId));
    const regions = buildKnowledgeRegionDescriptorsFromRecords(target, records);

    return {
      collectionId: target.id,
      collectionHash: target.targetHash,
      regions: regions.sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  const regions: KnowledgeRegionDescriptor[] = [];

  for (const unit of target.units) {
    const build = await buildKnowledgeRegionDescriptorsFromCollection(unit.collection);

    regions.push(...build.regions);
  }

  return {
    collectionId: target.id,
    collectionHash: target.targetHash,
    regions: regions.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function buildKnowledgeRegionDescriptorsFromRecords(
  target: KnowledgeTargetResolution,
  records: IndexedKnowledgeRegion[],
): KnowledgeRegionDescriptor[] {
  const manifestByDkb = new Map(target.units.flatMap((unit) => unit.collection.dkbs.map((dkb) => [dkb.manifest.id, dkb.manifest] as const)));

  return records.map((record) => buildIndexedRegionDescriptor(
    target.targetHash,
    record,
    manifestByDkb.get(record.dkbId)?.adapter ?? 'compose',
    manifestByDkb.get(record.dkbId)?.domains ?? [],
  ));
}

export async function buildKnowledgeRegionDescriptorsFromCollection(collection: LoadedCollection): Promise<KnowledgeRegionDescriptorBuild> {
  const collectionHash = stableHash({
    id: collection.manifest.id,
    version: collection.manifest.version,
    dkbs: collection.dkbs.map((dkb) => ({
      id: dkb.manifest.id,
      version: dkb.manifest.version,
      adapter: dkb.manifest.adapter,
    })),
  });
  const regions: KnowledgeRegionDescriptor[] = [];

  for (const dkb of collection.dkbs) {
    regions.push(...await buildKnowledgeRegionDescriptorsFromDkb(dkb, collectionHash));
  }

  return {
    collectionId: collection.manifest.id,
    collectionHash,
    regions: regions.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export async function buildKnowledgeRegionDescriptorsFromDkb(dkb: LoadedDkb, collectionHash: string): Promise<KnowledgeRegionDescriptor[]> {
  const adapter = await adapterFor(dkb.manifest.adapter);
  const records = await adapter.readRecords(dkb);

  return records.map((record) => buildRecordRegionDescriptor(collectionHash, dkb, record));
}

export function buildRecordRegionDescriptor(collectionHash: string, dkb: LoadedDkb, record: KnowledgeRegion): KnowledgeRegionDescriptor {
  return buildKnowledgeRegionDescriptor({
    collectionHash,
    dkbId: dkb.manifest.id,
    adapter: dkb.manifest.adapter,
    domains: dkb.manifest.domains,
    record,
  });
}

function buildIndexedRegionDescriptor(
  collectionHash: string,
  record: IndexedKnowledgeRegion,
  adapter: DkbAdapter,
  domains: string[],
): KnowledgeRegionDescriptor {
  return buildKnowledgeRegionDescriptor({
    collectionHash,
    dkbId: record.dkbId,
    adapter,
    domains,
    record,
  });
}

function buildKnowledgeRegionDescriptor(input: {
  collectionHash: string;
  dkbId: string;
  adapter: DkbAdapter;
  domains: string[];
  record: KnowledgeRegion;
}): KnowledgeRegionDescriptor {
  const { collectionHash, dkbId, adapter, domains: dkbDomains, record } = input;
  const contentHash = stableHash({
    dkbId,
    record,
  });
  const indexHash = stableHash({
    type: 'knowledge-region-descriptor',
    dkbId,
    regionId: record.id,
    contentHash,
    version: 1,
  });
  const domains = unique(dkbDomains);
  const base = {
    id: `knowledge/${dkbId}/${record.id}`,
    origin: {
      dkbId,
      regionId: record.id,
      recordId: record.id,
    },
    title: record.title,
    summary: summaryFor(record),
    domains,
    topics: unique(record.topics),
    keywords: unique(record.keywords ?? []),
    entities: unique(record.entities),
    aliases: unique(record.aliases ?? []),
    updatedAt: record.updatedAt,
    tokenEstimate: estimateTokens(record.title, record.content),
    contentHash,
    indexHash,
    sourceContentHash: contentHash,
    indexBuildHash: indexHash,
    collectionHash,
    integrity: {
      method: 'hash' as const,
      hash: contentHash,
      verified: true,
      reason: 'content_hash_matches_indexed_region',
    },
    authenticity: {
      method: 'none' as const,
      verified: false,
      signer: null,
      signature: null,
      reason: 'no_publisher_signature_available',
    },
    trust: {
      score: 0,
      source: 'none' as const,
      reason: 'integrity_hash_only_no_authenticated_publisher',
    },
    fetchPlan: fetchPlanFor(dkbId, record),
    fetch: fetchPlanFor(dkbId, record),
    protocolAlignment: {
      searchEligible: true,
      issues: [],
    },
    metadata: {
      dkbId,
      adapter,
      regionId: record.id,
      regionType: record.regionType ?? null,
      ancestry: record.ancestry ?? [],
      relationships: record.relationships ?? [],
      grouping: record.grouping ?? null,
    },
  };

  return {
    ...base,
    descriptorHash: stableHash(base),
  };
}

function fetchPlanFor(dkbId: string, record: KnowledgeRegion) {
  return {
    type: 'dkb.fetch_region',
    dkbId,
    regionId: record.id,
    recordId: record.id,
    queryHint: renderUntrustedMetadataValue(record.title),
  };
}

function defaultOperationsFor(record: KnowledgeRegion): DkbReadOperation[] {
  return record.regionType === 'table' || record.regionType === 'view' || record.regionType === 'table_group'
    ? ['search', 'lookup', 'aggregate']
    : ['fetch', 'search'];
}

function summaryFor(record: KnowledgeRegion): string {
  const keywords = (record.keywords ?? []).length > 0 ? ` Keywords: ${(record.keywords ?? []).slice(0, 6).join(', ')}.` : '';
  const topics = keywords || (record.topics.length > 0 ? ` Topics: ${record.topics.slice(0, 6).join(', ')}.` : '');
  const entities = record.entities.length > 0 ? ` Entities: ${record.entities.slice(0, 6).join(', ')}.` : '';
  const operations = (record.queryable?.operations ?? defaultOperationsFor(record)).join(', ');

  return `Knowledge Region for ${renderUntrustedMetadataValue(record.title)}.${topics}${entities} Operations: ${operations}.`;
}

function estimateTokens(...values: string[]): number {
  return Math.ceil(values.join(' ').length / 4);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
