import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbProviderExecutionReceipt } from '@sjshovan/dkb-protocol/providerReceipts.js';
import type { DkbProviderHost } from '@sjshovan/dkb-pipeline/host.js';
import type { DkbProviderBuildReceipt, DkbProviderKind } from '@sjshovan/dkb-pipeline/types.js';
import { validateProviderReceipt } from '@sjshovan/dkb-pipeline/validation.js';

export function providerReceipt(host: DkbProviderHost, kind: DkbProviderKind, value: unknown): DkbProviderBuildReceipt {
  const provider = host.describe().providers.find((item) => item.kind === kind);
  if (!provider) throw new DkbError(`Selected ${kind} provider did not produce a DKB-owned receipt identity`);
  const receipt = validateProviderReceipt(value, provider.id);
  return {
    kind,
    providerId: provider.id,
    providerVersion: provider.version,
    providerIntegrityDigest: provider.integrityDigest,
    ...receipt,
  };
}

export function semanticProviderReceipts(
  receipts: readonly DkbProviderBuildReceipt[],
  layer: 'evidence' | 'retrieval',
): DkbProviderExecutionReceipt[] {
  const kinds = layer === 'evidence'
    ? new Set(['evidence', 'parser', 'chunker', 'processor'])
    : new Set(['embedding', 'index', 'retrieval']);
  return receipts.filter((receipt) => kinds.has(receipt.kind)).map(({ diagnostics: _diagnostics, ...receipt }) => receipt);
}
