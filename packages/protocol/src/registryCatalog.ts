import { Buffer } from 'node:buffer';
import { DkbError } from './errors.js';
import type { DkbRegistryCollectionRevision } from './registryCollections.js';

export const DKB_SOURCE_INVENTORY_FORMAT = 'dkb.source-inventory.v1' as const;
export const DKB_SOURCE_INVENTORY_MEDIA_TYPE = 'application/vnd.dkb.source-inventory+json' as const;

export interface DkbSourceInventoryEntry {
  path: string;
  bytes: number;
  hash: string;
}

export interface DkbSourceInventory {
  format: typeof DKB_SOURCE_INVENTORY_FORMAT;
  package: {
    id: string;
    version: string;
  };
  entries: DkbSourceInventoryEntry[];
}

export interface DkbSourceInventoryBinding {
  format: typeof DKB_SOURCE_INVENTORY_FORMAT;
  mediaType: typeof DKB_SOURCE_INVENTORY_MEDIA_TYPE;
  hash: string;
  count: number;
  bytes: number;
}

export interface DkbRegistryPageMeta {
  currentPage: number;
  perPage: number;
  lastPage: number;
  total: number;
}

export interface DkbRegistryCatalogEntry {
  type: 'dkb' | 'collection';
  id: string;
  namespace: string;
  name: string;
  slug: string;
  description?: string | null;
  visibility: 'public' | 'private' | 'unlisted';
  latestVersion?: string | null;
  latestRevision?: number | null;
  publishedAt?: string | null;
}

export interface DkbRegistryCatalogPage {
  entries: DkbRegistryCatalogEntry[];
  pages: {
    dkbs?: DkbRegistryPageMeta;
    collections?: DkbRegistryPageMeta;
  };
}

export interface DkbRegistrySourceInventoryPage {
  packageId: string;
  version: string;
  sourceInventory: DkbSourceInventoryBinding;
  entries: DkbSourceInventoryEntry[];
  nextCursor: string | null;
}

export interface DkbRegistryBuildSummary {
  target: string;
  evidenceProfileDigest: string;
  evidenceDigest: string;
  retrievalProfileDigest: string;
  compatibilityDigest: string;
  retrievalBuildDigest: string;
  status: string;
  evidenceSize?: number;
  retrievalSize?: number;
  evidenceBuiltAt?: string | null;
  retrievalBuiltAt?: string | null;
  evidenceProviders: unknown[];
  retrievalProviders: unknown[];
}

export interface DkbRegistryPackageVersionDetail {
  packageId: string;
  version: string;
  status: string;
  sourceHash?: string | null;
  archiveHash?: string | null;
  receiptHash?: string | null;
  payloadHash?: string | null;
  packageTreeHash?: string | null;
  recordCount?: number | null;
  defaultTarget?: string | null;
  sourceReceipt?: Record<string, unknown> | null;
  builds: DkbRegistryBuildSummary[];
  queuedAt?: string | null;
  startedAt?: string | null;
  compiledAt?: string | null;
  publishedAt?: string | null;
}

export interface DkbRegistryPackageDetail {
  type: 'dkb';
  entry: DkbRegistryCatalogEntry;
  versions: Array<{ version: string; status: string; packageTreeHash?: string | null }>;
  selectedVersion: DkbRegistryPackageVersionDetail;
}

export interface DkbRegistryCollectionDetail {
  type: 'collection';
  entry: DkbRegistryCatalogEntry & {
    revisions: Array<{
      revision: number;
      digest: string;
      publishedAt?: string | null;
    }>;
  };
  selectedRevision: DkbRegistryCollectionRevision;
}

export function validateSourceInventory(value: unknown, source: string): DkbSourceInventory {
  if (!isRecord(value)
    || value.format !== DKB_SOURCE_INVENTORY_FORMAT
    || !isRecord(value.package)
    || typeof value.package.id !== 'string'
    || typeof value.package.version !== 'string'
    || !Array.isArray(value.entries)) {
    throw new DkbError(`Invalid source inventory at ${source}`);
  }

  let previous = '';
  const entries = value.entries.map((candidate, index) => {
    if (!isRecord(candidate)
      || typeof candidate.path !== 'string'
      || !isPortableSourcePath(candidate.path)
      || !Number.isSafeInteger(candidate.bytes)
      || (candidate.bytes as number) < 0
      || typeof candidate.hash !== 'string'
      || !/^sha256:[a-f0-9]{64}$/u.test(candidate.hash)) {
      throw new DkbError(`Invalid source inventory entry ${index} at ${source}`);
    }
    if (index > 0 && Buffer.compare(Buffer.from(previous, 'utf8'), Buffer.from(candidate.path, 'utf8')) >= 0) {
      throw new DkbError(`Source inventory entries are not strictly sorted at ${source}`);
    }
    previous = candidate.path;
    return { path: candidate.path, bytes: candidate.bytes as number, hash: candidate.hash };
  });

  return {
    format: DKB_SOURCE_INVENTORY_FORMAT,
    package: { id: value.package.id, version: value.package.version },
    entries,
  };
}

function isPortableSourcePath(value: string): boolean {
  if (!value || value.startsWith('/') || value.startsWith('\\') || /^[a-z]:/iu.test(value) || value.includes('\\')) {
    return false;
  }
  const parts = value.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..' && part !== '.dkb');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
