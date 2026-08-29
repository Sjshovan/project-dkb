import type {
  DkbEvidenceCatalogAsset,
  DkbEvidenceCatalogRecord,
} from '@sjshovan/dkb-protocol/evidence/catalog.js';
import type { DkbReadQuery } from '@sjshovan/dkb-protocol/types.js';

export type RuntimeEvidenceUnit = {
  id: string;
  evidenceId: string;
  sourceId: string;
  assetId: string;
  dkbId: string;
  packageVersion: string;
  storeId: string;
  type: DkbEvidenceCatalogRecord['sourceType'];
  locator: Record<string, unknown>;
  assetLocator: Record<string, unknown>;
  title: string;
  text: string;
  keywords: string[];
  capabilities: DkbEvidenceCatalogRecord['capabilities'];
  queryable?: DkbEvidenceCatalogRecord['queryable'];
  hash: string;
  sourceHash: string;
  provenance: Record<string, unknown>;
  updatedAt: string;
  chunkOrdinal: number;
  chunkStart: number;
  chunkEnd: number;
  heading?: string;
};

export type RuntimeEvidenceAsset = {
  id: string;
  dkbId: string;
  storeId: string;
  type: DkbEvidenceCatalogAsset['type'];
  locator: Record<string, unknown>;
  title: string;
  hash: string;
  updatedAt: string;
};

export type SourceUnitQueryEvidence = { tokens: string[]; phrases: string[]; identifiers: string[] };

export type SourceUnitMatch = {
  unit: RuntimeEvidenceUnit;
  evidence: { phrases: string[]; identifiers: string[]; keywords: string[]; tokens: string[] };
};

export function runtimeEvidenceUnit(record: DkbEvidenceCatalogRecord): RuntimeEvidenceUnit {
  return {
    id: record.evidenceId,
    evidenceId: record.evidenceId,
    sourceId: record.sourceId,
    assetId: record.assetId,
    dkbId: record.packageId,
    packageVersion: record.packageVersion,
    storeId: record.storeId,
    type: record.sourceType,
    locator: record.locator,
    assetLocator: record.assetLocator,
    title: record.title,
    text: record.text,
    keywords: record.keywords,
    capabilities: record.capabilities,
    ...(record.queryable ? { queryable: record.queryable } : {}),
    hash: record.textHash,
    sourceHash: record.sourceHash,
    provenance: record.provenance,
    updatedAt: record.updatedAt,
    chunkOrdinal: record.chunkOrdinal,
    chunkStart: record.chunkStart,
    chunkEnd: record.chunkEnd,
    ...(record.heading ? { heading: record.heading } : {}),
  };
}

export function runtimeEvidenceAsset(asset: DkbEvidenceCatalogAsset): RuntimeEvidenceAsset {
  return {
    id: asset.id,
    dkbId: asset.packageId,
    storeId: asset.storeId,
    type: asset.type,
    locator: asset.locator,
    title: asset.title,
    hash: asset.sourceHash,
    updatedAt: asset.updatedAt,
  };
}

export function queryEvidenceForRequest(query: DkbReadQuery): SourceUnitQueryEvidence {
  const phrases = (query.filters ?? [])
    .filter((filter) => filter.field === 'content' && filter.op === 'contains' && typeof filter.value === 'string')
    .map((filter) => String(filter.value).toLowerCase().replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const tokens = [...new Set(tokenize(phrases.join(' ')))];
  const identifiers = [...new Set(phrases.flatMap((phrase) => phrase.match(/\b[A-Za-z0-9][A-Za-z0-9_-]*\d[A-Za-z0-9_-]*\b/g) ?? []))]
    .map((value) => value.toLowerCase());
  return { phrases, tokens, identifiers };
}

export function matchForUnit(unit: RuntimeEvidenceUnit, query: SourceUnitQueryEvidence, matchedTokens: string[]): SourceUnitMatch {
  const normalized = `${unit.title}\n${unit.text}\n${unit.keywords.join(' ')}`.toLowerCase();
  const tokens = [...new Set(matchedTokens.filter(Boolean).map((token) => token.toLowerCase()))];
  return {
    unit,
    evidence: {
      phrases: query.phrases.filter((phrase) => normalized.includes(phrase)),
      identifiers: query.identifiers.filter((identifier) => normalized.includes(identifier)),
      keywords: unit.keywords.filter((keyword) => tokens.includes(keyword.toLowerCase())),
      tokens,
    },
  };
}

export function registryIdForSourceUnit(unit: RuntimeEvidenceUnit): string | undefined {
  return unit.dkbId.endsWith('.local') || /\.local-[a-f0-9]{8}$/.test(unit.dkbId)
    ? unit.dkbId.replace(/\.local(?:-[a-f0-9]{8})?$/, '')
    : undefined;
}

export function sourceOriginForSourceUnit(unit: RuntimeEvidenceUnit): string | undefined {
  return registryIdForSourceUnit(unit) ? 'registry-local' : undefined;
}

export function compactPathLabel(value: string): string {
  return value.split(/[\\/]+/g).filter(Boolean).at(-1) ?? value;
}

export function normalizeIdentifierText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function tokenize(value: string): string[] {
  return (value.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/gu) ?? [])
    .flatMap((token) => token.includes('-') ? [token, ...token.split('-')] : [token]);
}
