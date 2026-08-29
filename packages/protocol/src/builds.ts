import { stableHash } from './contracts/hash.js';
import { DkbError } from './errors.js';
import type { DkbPublisherReleaseSignature, DkbRegistryReleaseSignature } from './types.js';

export const DKB_EVIDENCE_BUILD_LOCK_FORMAT = 'dkb.evidence-build.v1';
export const DKB_RETRIEVAL_BUILD_LOCK_FORMAT = 'dkb.retrieval-build.v1';
export const DKB_RUNTIME_LOCK_FORMAT = 'dkb.runtime-lock.v2';
export const DKB_INSTALL_PLAN_FORMAT = 'dkb.install-plan.v1';

export interface DkbEvidenceBuildLock {
  format: typeof DKB_EVIDENCE_BUILD_LOCK_FORMAT;
  package: { id: string; version: string; sourceDigest: string };
  evidenceProfileDigest: string;
  evidenceDigest: string;
  recordCount: number;
  chunkCount: number;
  generatedAt: string;
}

export interface DkbRetrievalBuildLock {
  format: typeof DKB_RETRIEVAL_BUILD_LOCK_FORMAT;
  package: { id: string; version: string };
  evidenceProfileDigest: string;
  evidenceDigest: string;
  retrievalProfileDigest: string;
  compatibilityDigest: string;
  artifactTreeDigest: string;
  retrievalBuildDigest: string;
  generatedAt: string;
}

export interface DkbRuntimeLockEntry {
  version: string;
  evidenceProfileDigest: string;
  evidenceDigest: string;
  retrievalProfileDigest: string;
  retrievalBuildDigest: string;
}

export interface DkbRuntimeLock {
  format: typeof DKB_RUNTIME_LOCK_FORMAT;
  target: string;
  evidenceProfileDigest: string;
  retrievalProfileDigest: string;
  compatibilityDigest: string;
  packages: Record<string, DkbRuntimeLockEntry>;
  generation: number;
  generatedAt: string;
}

export interface DkbInstallPlanArtifact {
  kind: 'source' | 'evidence' | 'retrieval';
  digest: string;
  mediaType: string;
  bytes: number;
  url: string;
  receiptHash: string;
  receipt: Record<string, unknown>;
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

export function evidenceBuildLock(input: Omit<DkbEvidenceBuildLock, 'format'>): DkbEvidenceBuildLock {
  const lock = { format: DKB_EVIDENCE_BUILD_LOCK_FORMAT, ...input };
  return validateEvidenceBuildLock(lock);
}

export function retrievalBuildLock(
  input: Omit<DkbRetrievalBuildLock, 'format' | 'retrievalBuildDigest'>,
): DkbRetrievalBuildLock {
  const identity = {
    package: input.package,
    evidenceProfileDigest: input.evidenceProfileDigest,
    evidenceDigest: input.evidenceDigest,
    retrievalProfileDigest: input.retrievalProfileDigest,
    compatibilityDigest: input.compatibilityDigest,
    artifactTreeDigest: input.artifactTreeDigest,
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
  return candidate;
}

export function validateRetrievalBuildLock(value: unknown, source = 'Retrieval Build lock'): DkbRetrievalBuildLock {
  if (!isRecord(value) || value.format !== DKB_RETRIEVAL_BUILD_LOCK_FORMAT || !isRecord(value.package)) {
    throw new DkbError(`Invalid ${source}: expected ${DKB_RETRIEVAL_BUILD_LOCK_FORMAT}`);
  }
  const candidate = value as unknown as DkbRetrievalBuildLock;
  assertPackage(candidate.package, source, false);
  for (const [label, digest] of Object.entries({
    evidenceProfileDigest: candidate.evidenceProfileDigest,
    evidenceDigest: candidate.evidenceDigest,
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
    retrievalProfileDigest: candidate.retrievalProfileDigest,
    compatibilityDigest: candidate.compatibilityDigest,
    artifactTreeDigest: candidate.artifactTreeDigest,
  });
  if (candidate.retrievalBuildDigest !== expected) {
    throw new DkbError(`Invalid ${source}: expected Retrieval Build digest ${expected}, got ${candidate.retrievalBuildDigest}`);
  }
  return candidate;
}

export function validateRuntimeLock(value: unknown, source = 'Runtime lock'): DkbRuntimeLock {
  if (!isRecord(value) || value.format !== DKB_RUNTIME_LOCK_FORMAT || !isRecord(value.packages)) {
    throw new DkbError(`Invalid ${source}: expected ${DKB_RUNTIME_LOCK_FORMAT}`);
  }
  const candidate = value as unknown as DkbRuntimeLock;
  for (const digest of [candidate.evidenceProfileDigest, candidate.retrievalProfileDigest, candidate.compatibilityDigest]) {
    assertDigest(digest, source);
  }
  assertNonNegativeInteger(candidate.generation, `${source} generation`);
  for (const [id, entry] of Object.entries(candidate.packages)) {
    if (!isRecord(entry) || typeof entry.version !== 'string' || entry.version.length === 0) {
      throw new DkbError(`Invalid ${source}: package ${id} is incomplete`);
    }
    for (const digest of [entry.evidenceProfileDigest, entry.evidenceDigest, entry.retrievalProfileDigest, entry.retrievalBuildDigest]) {
      assertDigest(digest, `${source} package ${id}`);
    }
    if (entry.evidenceProfileDigest !== candidate.evidenceProfileDigest || entry.retrievalProfileDigest !== candidate.retrievalProfileDigest) {
      throw new DkbError(`Invalid ${source}: package ${id} does not match the active build profiles`);
    }
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
    if (typeof artifact.mediaType !== 'string' || typeof artifact.url !== 'string' || !artifact.url.startsWith('/')) {
      throw new DkbError(`Invalid ${source}: layer URLs must be Registry-relative and media types are required`);
    }
  }
  candidate.receipt = validateLayerReceipt(candidate.receipt, `${source} receipt`);
  if (candidate.receipt.type !== 'dkb.install-plan.receipt') throw new DkbError(`Invalid ${source}: wrong receipt type`);
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
