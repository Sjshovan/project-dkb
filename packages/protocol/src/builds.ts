import { stableHash } from './contracts/hash.js';
import { DkbError } from './errors.js';
import type { DkbPublisherReleaseSignature, DkbRegistryReleaseSignature } from './types.js';
import { validateProviderExecutionReceipts, type DkbProviderExecutionReceipt } from './providerReceipts.js';

export const DKB_EVIDENCE_BUILD_LOCK_FORMAT = 'dkb.evidence-build.v2';
export const DKB_RETRIEVAL_BUILD_LOCK_FORMAT = 'dkb.retrieval-build.v2';
export const DKB_INSTALL_PLAN_FORMAT = 'dkb.install-plan.v1';
export const DKB_RETRIEVAL_BUILD_GRANT_FORMAT = 'dkb.retrieval-build-grant.v1';

export interface DkbEvidenceBuildLock {
  format: typeof DKB_EVIDENCE_BUILD_LOCK_FORMAT;
  package: { id: string; version: string; sourceDigest: string };
  evidenceProfileDigest: string;
  evidenceDigest: string;
  recordCount: number;
  chunkCount: number;
  providerReceipts: DkbProviderExecutionReceipt[];
  generatedAt: string;
}

export interface DkbRetrievalBuildLock {
  format: typeof DKB_RETRIEVAL_BUILD_LOCK_FORMAT;
  package: { id: string; version: string };
  evidenceProfileDigest: string;
  evidenceDigest: string;
  evidenceReceiptDigest: string;
  retrievalProfileDigest: string;
  compatibilityDigest: string;
  artifactTreeDigest: string;
  providerReceipts: DkbProviderExecutionReceipt[];
  retrievalBuildDigest: string;
  generatedAt: string;
}

export interface DkbInstallPlanArtifact {
  kind: 'source' | 'evidence' | 'retrieval';
  digest: string;
  mediaType: string;
  bytes: number;
  url: string;
  receiptHash: string;
  receipt: DkbLayerReceipt;
}

export type DkbLayerReceiptType = 'dkb.evidence.receipt' | 'dkb.retrieval.receipt' | 'dkb.install-plan.receipt';

export interface DkbLayerReceipt {
  type: DkbLayerReceiptType;
  version: 1;
  package: { id: string; version: string; sourceHash: string };
  parentReceiptHash?: string;
  payloadHash: string;
  payload: Record<string, unknown>;
  publisher: DkbPublisherReleaseSignature;
  registry: DkbRegistryReleaseSignature;
}

export interface DkbInstallPlan {
  format: typeof DKB_INSTALL_PLAN_FORMAT;
  package: { id: string; version: string; sourceDigest: string };
  target: string;
  evidenceProfileDigest: string;
  evidenceDigest: string;
  retrievalProfileDigest: string;
  compatibilityDigest: string;
  retrievalBuildDigest: string;
  artifacts: [DkbInstallPlanArtifact, DkbInstallPlanArtifact, DkbInstallPlanArtifact];
  receipt: DkbLayerReceipt;
}

export interface DkbRetrievalBuildGrant {
  format: typeof DKB_RETRIEVAL_BUILD_GRANT_FORMAT;
  package: { id: string; version: string; sourceDigest: string };
  target: string;
  evidenceProfileDigest: string;
  evidenceDigest: string;
  retrievalProfileDigest: string;
  compatibilityDigest: string;
  retrievalBuildDigest: string;
  artifact: Omit<DkbInstallPlanArtifact, 'kind'> & { kind: 'retrieval' };
}

export function evidenceBuildLock(input: Omit<DkbEvidenceBuildLock, 'format'>): DkbEvidenceBuildLock {
  const lock = { format: DKB_EVIDENCE_BUILD_LOCK_FORMAT, ...input };
  return validateEvidenceBuildLock(lock);
}

export function evidenceBuildReceiptDigest(lock: DkbEvidenceBuildLock): string {
  const { format: _format, generatedAt: _generatedAt, ...receipt } = validateEvidenceBuildLock(lock);
  return stableHash(receipt);
}

export function retrievalBuildLock(
  input: Omit<DkbRetrievalBuildLock, 'format' | 'retrievalBuildDigest'>,
): DkbRetrievalBuildLock {
  const identity = {
    package: input.package,
    evidenceProfileDigest: input.evidenceProfileDigest,
    evidenceDigest: input.evidenceDigest,
    evidenceReceiptDigest: input.evidenceReceiptDigest,
    retrievalProfileDigest: input.retrievalProfileDigest,
    compatibilityDigest: input.compatibilityDigest,
    artifactTreeDigest: input.artifactTreeDigest,
    providerReceipts: input.providerReceipts,
  };
  return validateRetrievalBuildLock({
    format: DKB_RETRIEVAL_BUILD_LOCK_FORMAT,
    ...input,
    retrievalBuildDigest: stableHash(identity),
  });
}

export function validateEvidenceBuildLock(value: unknown, source = 'Evidence Build lock'): DkbEvidenceBuildLock {
  if (!isRecord(value) || value.format !== DKB_EVIDENCE_BUILD_LOCK_FORMAT || !isRecord(value.package)) {
    throw new DkbError(`Invalid ${source}: expected ${DKB_EVIDENCE_BUILD_LOCK_FORMAT}`);
  }
  const candidate = value as unknown as DkbEvidenceBuildLock;
  assertPackage(candidate.package, source, true);
  assertDigest(candidate.evidenceProfileDigest, `${source} evidenceProfileDigest`);
  assertDigest(candidate.evidenceDigest, `${source} evidenceDigest`);
  assertNonNegativeInteger(candidate.recordCount, `${source} recordCount`);
  assertNonNegativeInteger(candidate.chunkCount, `${source} chunkCount`);
  candidate.providerReceipts = validateProviderExecutionReceipts(candidate.providerReceipts, `${source} providerReceipts`);
  return candidate;
}

export function validateRetrievalBuildLock(value: unknown, source = 'Retrieval Build lock'): DkbRetrievalBuildLock {
  if (!isRecord(value) || value.format !== DKB_RETRIEVAL_BUILD_LOCK_FORMAT || !isRecord(value.package)) {
    throw new DkbError(`Invalid ${source}: expected ${DKB_RETRIEVAL_BUILD_LOCK_FORMAT}`);
  }
  const candidate = value as unknown as DkbRetrievalBuildLock;
  candidate.providerReceipts = validateProviderExecutionReceipts(candidate.providerReceipts, `${source} providerReceipts`);
  assertPackage(candidate.package, source, false);
  for (const [label, digest] of Object.entries({
    evidenceProfileDigest: candidate.evidenceProfileDigest,
    evidenceDigest: candidate.evidenceDigest,
    evidenceReceiptDigest: candidate.evidenceReceiptDigest,
    retrievalProfileDigest: candidate.retrievalProfileDigest,
    compatibilityDigest: candidate.compatibilityDigest,
    artifactTreeDigest: candidate.artifactTreeDigest,
    retrievalBuildDigest: candidate.retrievalBuildDigest,
  })) {
    assertDigest(digest, `${source} ${label}`);
  }
  const expected = stableHash({
    package: candidate.package,
    evidenceProfileDigest: candidate.evidenceProfileDigest,
    evidenceDigest: candidate.evidenceDigest,
    evidenceReceiptDigest: candidate.evidenceReceiptDigest,
    retrievalProfileDigest: candidate.retrievalProfileDigest,
    compatibilityDigest: candidate.compatibilityDigest,
    artifactTreeDigest: candidate.artifactTreeDigest,
    providerReceipts: candidate.providerReceipts,
  });
  if (candidate.retrievalBuildDigest !== expected) {
    throw new DkbError(`Invalid ${source}: expected Retrieval Build digest ${expected}, got ${candidate.retrievalBuildDigest}`);
  }
  return candidate;
}

export function validateInstallPlan(value: unknown, source = 'Install plan'): DkbInstallPlan {
  if (!isRecord(value) || value.format !== DKB_INSTALL_PLAN_FORMAT || !isRecord(value.package) || !Array.isArray(value.artifacts)) {
    throw new DkbError(`Invalid ${source}: expected ${DKB_INSTALL_PLAN_FORMAT}`);
  }
  const candidate = value as unknown as DkbInstallPlan;
  assertPackage(candidate.package, source, true);
  for (const [label, digest] of Object.entries({
    evidenceProfileDigest: candidate.evidenceProfileDigest,
    evidenceDigest: candidate.evidenceDigest,
    retrievalProfileDigest: candidate.retrievalProfileDigest,
    compatibilityDigest: candidate.compatibilityDigest,
    retrievalBuildDigest: candidate.retrievalBuildDigest,
  })) assertDigest(digest, `${source} ${label}`);
  if (typeof candidate.target !== 'string' || candidate.target.length === 0 || candidate.artifacts.length !== 3) {
    throw new DkbError(`Invalid ${source}: target and exactly three layers are required`);
  }
  const kinds = candidate.artifacts.map((artifact) => artifact.kind);
  if (kinds.join(',') !== 'source,evidence,retrieval') throw new DkbError(`Invalid ${source}: layers must be ordered source, evidence, retrieval`);
  for (const artifact of candidate.artifacts) {
    if (!isRecord(artifact)) throw new DkbError(`Invalid ${source}: layer entry must be an object`);
    assertDigest(artifact.digest, `${source} ${artifact.kind} digest`);
    assertDigest(artifact.receiptHash, `${source} ${artifact.kind} receiptHash`);
    assertNonNegativeInteger(artifact.bytes, `${source} ${artifact.kind} bytes`);
    if (typeof artifact.mediaType !== 'string'
      || typeof artifact.url !== 'string'
      || !artifact.url.startsWith('/')
      || artifact.url.startsWith('//')
      || artifact.url.includes('\\')) {
      throw new DkbError(`Invalid ${source}: layer URLs must be Registry-relative and media types are required`);
    }
  }
  candidate.receipt = validateLayerReceipt(candidate.receipt, `${source} receipt`);
  if (candidate.receipt.type !== 'dkb.install-plan.receipt') throw new DkbError(`Invalid ${source}: wrong receipt type`);
  return candidate;
}

export function validateRetrievalBuildGrant(value: unknown, source = 'Retrieval Build grant'): DkbRetrievalBuildGrant {
  if (!isRecord(value) || value.format !== DKB_RETRIEVAL_BUILD_GRANT_FORMAT || !isRecord(value.package) || !isRecord(value.artifact)) {
    throw new DkbError(`Invalid ${source}: expected ${DKB_RETRIEVAL_BUILD_GRANT_FORMAT}`);
  }
  const candidate = value as unknown as DkbRetrievalBuildGrant;
  assertPackage(candidate.package, source, true);
  for (const [label, digest] of Object.entries({
    evidenceProfileDigest: candidate.evidenceProfileDigest,
    evidenceDigest: candidate.evidenceDigest,
    retrievalProfileDigest: candidate.retrievalProfileDigest,
    compatibilityDigest: candidate.compatibilityDigest,
    retrievalBuildDigest: candidate.retrievalBuildDigest,
  })) assertDigest(digest, `${source} ${label}`);
  if (typeof candidate.target !== 'string' || candidate.target.length === 0 || candidate.artifact.kind !== 'retrieval') {
    throw new DkbError(`Invalid ${source}: target and one Retrieval layer are required`);
  }
  assertDigest(candidate.artifact.digest, `${source} retrieval digest`);
  assertDigest(candidate.artifact.receiptHash, `${source} retrieval receiptHash`);
  assertNonNegativeInteger(candidate.artifact.bytes, `${source} retrieval bytes`);
  if (typeof candidate.artifact.mediaType !== 'string'
    || typeof candidate.artifact.url !== 'string'
    || !candidate.artifact.url.startsWith('/')
    || candidate.artifact.url.startsWith('//')
    || candidate.artifact.url.includes('\\')) {
    throw new DkbError(`Invalid ${source}: Retrieval layer URL must be Registry-relative and its media type is required`);
  }
  candidate.artifact.receipt = validateLayerReceipt(candidate.artifact.receipt, `${source} receipt`);
  if (candidate.artifact.receipt.type !== 'dkb.retrieval.receipt') throw new DkbError(`Invalid ${source}: wrong receipt type`);
  return candidate;
}

export function validateLayerReceipt(value: unknown, source = 'Layer receipt'): DkbLayerReceipt {
  if (!isRecord(value) || !['dkb.evidence.receipt', 'dkb.retrieval.receipt', 'dkb.install-plan.receipt'].includes(String(value.type))
    || value.version !== 1 || !isRecord(value.package) || !isRecord(value.payload)
    || !isRecord(value.publisher) || !isRecord(value.registry)) {
    throw new DkbError(`Invalid ${source}: unsupported signed receipt`);
  }
  const candidate = value as unknown as DkbLayerReceipt;
  assertLayerPackage(candidate.package, source);
  assertDigest(candidate.payloadHash, `${source} payloadHash`);
  if (candidate.parentReceiptHash !== undefined) assertDigest(candidate.parentReceiptHash, `${source} parentReceiptHash`);
  assertSignature(candidate.publisher, `${source} publisher`, 'accountId');
  assertSignature(candidate.registry, `${source} registry`, 'registryId');
  return candidate;
}

function assertPackage(value: { id?: unknown; version?: unknown; sourceDigest?: unknown }, source: string, sourceRequired: boolean): void {
  if (typeof value.id !== 'string' || value.id.length === 0 || typeof value.version !== 'string' || value.version.length === 0) {
    throw new DkbError(`Invalid ${source}: package identity and version are required`);
  }
  if (sourceRequired) {
    assertDigest(value.sourceDigest, `${source} package sourceDigest`);
  }
}

function assertLayerPackage(value: { id?: unknown; version?: unknown; sourceHash?: unknown }, source: string): void {
  if (typeof value.id !== 'string' || value.id.length === 0 || typeof value.version !== 'string' || value.version.length === 0) {
    throw new DkbError(`Invalid ${source}: package identity and version are required`);
  }
  assertDigest(value.sourceHash, `${source} package sourceHash`);
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/iu.test(value)) {
    throw new DkbError(`${label} must be a sha256 digest`);
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new DkbError(`${label} must be a non-negative integer`);
  }
}

function assertSignature(value: unknown, label: string, subject: 'accountId' | 'registryId'): void {
  if (!isRecord(value)) throw new DkbError(`Invalid ${label}`);
  if (typeof value[subject] !== 'string' || typeof value.keyId !== 'string' || typeof value.publicKeyFingerprint !== 'string'
    || value.algorithm !== 'ed25519' || typeof value.value !== 'string' || typeof value.signedAt !== 'string') {
    throw new DkbError(`Invalid ${label}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
