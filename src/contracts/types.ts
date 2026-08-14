export type Freshness = 'fresh' | 'stale' | 'unknown';

export interface RegionIntegrity {
  method: 'hash';
  hash: string;
  verified: boolean;
  reason?: string;
}

export interface RegionAuthenticity {
  method: 'none' | 'signature';
  verified: boolean;
  signer: string | null;
  signature: string | null;
  reason?: string;
}

export interface RegionTrust {
  score: number;
  source: 'none' | 'local' | 'publisher' | 'registry' | 'policy';
  reason?: string;
}

export interface RegionFetchPlan {
  type: string;
  dkbId?: string;
  regionId?: string;
  recordId?: string;
  queryHint?: string;
}

export interface RegionProtocolAlignment {
  searchEligible: boolean;
  issues: string[];
}

export interface KnowledgeRegionDescriptor {
  id: string;
  origin?: {
    registryId?: string;
    collectionId?: string | null;
    dkbId: string;
    regionId?: string;
    recordId: string;
  };
  title: string;
  summary: string;
  domains: string[];
  topics: string[];
  keywords?: string[];
  entities: string[];
  aliases: string[];
  updatedAt: string;
  tokenEstimate: number;
  contentHash: string;
  indexHash: string;
  fetch: RegionFetchPlan;
  relations?: string[];
  freshness?: Freshness;
  authority?: number;
  sourceContentHash?: string;
  indexBuildHash?: string;
  descriptorHash: string;
  collectionHash?: string;
  integrity?: RegionIntegrity;
  authenticity?: RegionAuthenticity;
  trust?: RegionTrust;
  fetchPlan?: RegionFetchPlan;
  protocolAlignment?: RegionProtocolAlignment;
  metadata?: Record<string, unknown>;
}
