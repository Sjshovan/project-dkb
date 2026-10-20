import { DkbError } from './errors.js';
import { assertJsonData, type DkbJsonValue } from './json.js';
import type { DkbRetrievalProfileLock } from './retrievalProfile.js';

export type DkbExecutionProviderKind = 'evidence' | 'parser' | 'chunker' | 'processor' | 'embedding' | 'index' | 'retrieval';

/** Semantic output only. Timing, cache, and host diagnostics are not build identity. */
export interface DkbProviderExecutionReceipt {
  kind: DkbExecutionProviderKind;
  providerId: string;
  providerVersion: string;
  providerIntegrityDigest: string;
  stage?: 'document' | 'chunk' | 'record';
  build: Record<string, DkbJsonValue>;
  compatibility?: Record<string, DkbJsonValue>;
}

export function validateProviderExecutionReceipts(value: unknown, label: string): DkbProviderExecutionReceipt[] {
  assertJsonData(value, label);
  if (!Array.isArray(value)) throw new DkbError(`${label} must be an array`);
  const allowed = new Set(['kind', 'providerId', 'providerVersion', 'providerIntegrityDigest', 'stage', 'build', 'compatibility']);
  for (const [index, item] of value.entries()) {
    if (!isObject(item) || Object.keys(item).some((key) => !allowed.has(key))
      || !['evidence', 'parser', 'chunker', 'processor', 'embedding', 'index', 'retrieval'].includes(String(item.kind))
      || typeof item.providerId !== 'string' || !/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/u.test(item.providerId)
      || typeof item.providerVersion !== 'string' || !item.providerVersion.trim()
      || typeof item.providerIntegrityDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(item.providerIntegrityDigest)
      || !isObject(item.build) || (item.compatibility !== undefined && !isObject(item.compatibility))
      || (item.kind === 'processor' ? !['document', 'chunk', 'record'].includes(String(item.stage)) : item.stage !== undefined)) {
      throw new DkbError(`${label}[${index}] is not a valid DKB-owned provider execution receipt`);
    }
  }
  return structuredClone(value) as unknown as DkbProviderExecutionReceipt[];
}

export function assertProviderExecutionIdentities(
  receipts: readonly DkbProviderExecutionReceipt[],
  profile: DkbRetrievalProfileLock,
  layer: 'evidence' | 'retrieval',
): void {
  const expected = layer === 'evidence'
    ? [
        ...profile.profile.evidence.providers.map((provider) => ({ ...provider, stage: undefined })),
        ...profile.profile.evidence.processors.map((processor) => ({ ...processor, kind: 'processor' })),
      ]
    : profile.profile.retrieval.providers.map((provider) => ({ ...provider, stage: undefined }));
  if (receipts.length !== expected.length || receipts.some((receipt, index) => {
    const provider = expected[index]!;
    return receipt.kind !== provider.kind || receipt.providerId !== provider.id
      || receipt.providerVersion !== provider.version || receipt.providerIntegrityDigest !== provider.integrityDigest
      || receipt.stage !== provider.stage;
  })) {
    throw new DkbError(`${layer} provider execution receipts do not match the exact resolved provider chain`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
