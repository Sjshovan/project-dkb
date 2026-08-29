import type { DkbStoreType, KnowledgeCapabilityProfile, KnowledgeQueryable } from '../types.js';

export const DKB_EVIDENCE_CATALOG_FORMAT = 'dkb.evidence.catalog.v1';
export const DKB_EVIDENCE_CATALOG_FILENAME = 'evidence.catalog.sqlite';

export interface DkbEvidenceCatalogAsset {
  id: string;
  packageId: string;
  storeId: string;
  type: DkbStoreType;
  locator: Record<string, unknown>;
  title: string;
  sourceHash: string;
  updatedAt: string;
}

export interface DkbEvidenceCatalogRecord {
  evidenceId: string;
  sourceId: string;
  packageId: string;
  packageVersion: string;
  assetId: string;
  storeId: string;
  sourceType: DkbStoreType;
  locator: Record<string, unknown>;
  assetLocator: Record<string, unknown>;
  title: string;
  text: string;
  textHash: string;
  sourceHash: string;
  provenance: Record<string, unknown>;
  keywords: string[];
  capabilities: KnowledgeCapabilityProfile;
  queryable?: KnowledgeQueryable;
  chunkOrdinal: number;
  chunkStart: number;
  chunkEnd: number;
  heading?: string;
  updatedAt: string;
}

export interface DkbEvidenceCatalogSnapshot {
  format: typeof DKB_EVIDENCE_CATALOG_FORMAT;
  evidenceProfileDigest: string;
  evidenceDigest: string;
  assets: DkbEvidenceCatalogAsset[];
  records: DkbEvidenceCatalogRecord[];
}
