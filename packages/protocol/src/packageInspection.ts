export const DKB_INSTALLED_ENTRY_DETAIL_FORMAT = 'dkb.installed-entry-detail.v2';
export const DKB_PACKAGE_CONTENTS_FORMAT = 'dkb.package-contents.v1';
export const DKB_PACKAGE_PREVIEW_FORMAT = 'dkb.package-preview.v1';
export const DKB_PACKAGE_VERIFICATION_FORMAT = 'dkb.package-verification.v1';

export type DkbInspectionStatus = 'passed' | 'warning' | 'failed' | 'not_applicable';

export interface DkbInspectionCheck {
  id: string;
  label: string;
  status: DkbInspectionStatus;
  message: string;
  recovery?: string;
}

export type DkbInstalledBuildFileRole =
  | 'evidence_ir'
  | 'evidence_catalog'
  | 'build_lock'
  | 'profile_lock'
  | 'artifact_manifest'
  | 'retrieval_artifact';

export interface DkbInstalledBuildFile {
  path: string;
  bytes: number;
  role: DkbInstalledBuildFileRole;
  hash?: string;
}

export interface DkbInstalledBuildSummary {
  kind: 'evidence' | 'retrieval';
  profileDigest: string;
  buildDigest: string;
  bytes: number;
  generatedAt?: string;
  recordCount?: number;
  chunkCount?: number;
  compatibilityDigest?: string;
  evidenceDigest?: string;
  target?: string;
  providers: Array<{
    id: string;
    version: string;
    kind: 'evidence' | 'parser' | 'chunker' | 'embedding' | 'index' | 'retrieval';
  }>;
  processors: Array<{
    id: string;
    version: string;
    stage: 'document' | 'chunk' | 'record';
  }>;
  embedding?: {
    provider: string;
    space: string;
    modelRevision?: string;
    dimensions: number;
    metric: string;
    normalized: boolean;
    queryMode: string;
    documentMode: string;
  };
  index?: {
    provider: string;
    mode: 'packaged' | 'managed';
    format: string;
  };
  retrieval?: {
    provider: string;
    protocol: string;
  };
  files: DkbInstalledBuildFile[];
}

export interface DkbInstalledEntryDetail {
  format: typeof DKB_INSTALLED_ENTRY_DETAIL_FORMAT;
  libraryRoot: string;
  identity: string;
  kind: 'dkb' | 'collection';
  source: 'local' | 'registry';
  status: 'installed' | 'broken';
  path: string;
  version?: string;
  revision?: number;
  digest?: string;
  registryUrl?: string;
  installedAt: string;
  requiredBy: string[];
  manifest: {
    name: string;
    displayName?: string;
    description?: string;
    version?: string;
    publisher?: string;
    license?: string;
    permissions?: { read?: boolean; write?: boolean };
  } | null;
  sourceSummary: {
    files: number;
    bytes: number;
    searchableSources: number;
    evidenceRecords: number;
  };
  builds: DkbInstalledBuildSummary[];
  provenance: {
    packageTreeHash?: string;
    payloadHash?: string;
    sourceDigest?: string;
    publisher?: DkbReceiptSignerSummary;
    registry?: DkbReceiptSignerSummary;
    receiptStatus: 'present' | 'missing' | 'invalid' | 'not_applicable';
    installChainStatus: 'present' | 'missing' | 'invalid' | 'not_applicable';
  };
  members: Array<{
    identity: string;
    requested: string;
    resolved?: string;
    source?: 'local' | 'registry';
    status: 'installed' | 'broken' | 'missing';
    direct: boolean;
  }>;
  integrity: {
    status: DkbInspectionStatus;
    checks: DkbInspectionCheck[];
    recovery: string[];
  };
}

export interface DkbReceiptSignerSummary {
  subjectId: string;
  keyId: string;
  publicKeyFingerprint: string;
  algorithm: 'ed25519';
  signedAt: string;
}

export interface DkbPackageContents {
  format: typeof DKB_PACKAGE_CONTENTS_FORMAT;
  libraryRoot: string;
  identity: string;
  directory: string;
  entries: Array<{
    name: string;
    path: string;
    kind: 'directory' | 'file';
    bytes?: number;
    contentKind?: 'text' | 'code' | 'config' | 'image' | 'binary' | 'other';
    previewable: boolean;
    searchable: boolean;
    sourceId?: string;
    sourceHash?: string;
    evidenceRecords: number;
  }>;
  nextCursor?: string;
}

export interface DkbPackagePreview {
  format: typeof DKB_PACKAGE_PREVIEW_FORMAT;
  libraryRoot: string;
  identity: string;
  path: string;
  bytes: number;
  sha256: string;
  mediaType: string;
  previewable: boolean;
  truncated: boolean;
  bytesRead: number;
  content?: string;
  sourceId?: string;
  sourceHash?: string;
  evidenceRecords: number;
}

export interface DkbPackageVerification {
  format: typeof DKB_PACKAGE_VERIFICATION_FORMAT;
  libraryRoot: string;
  identity: string;
  status: 'passed' | 'warnings' | 'failed';
  checkedAt: string;
  checks: DkbInspectionCheck[];
  recovery: string[];
}
