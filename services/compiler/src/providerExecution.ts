import type { DkbExecutionContext } from '@sjshovan/dkb-pipeline/execution.js';
import type { DkbProviderHost } from '@sjshovan/dkb-pipeline/host.js';
import { DkbProviderHost as ProviderHost, type DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import type { DkbEvidenceProvider } from '@sjshovan/dkb-pipeline/types.js';
import type { DkbJsonValue } from '@sjshovan/dkb-protocol/json.js';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

/** The compiler binds recovery state to the host-selected implementation, not provider assertions. */
export interface ProviderExecutionFactory {
  (host: DkbProviderHost, kind: 'evidence'): DkbExecutionContext;
  hasPending(): Promise<boolean>;
  registerWorkspace(root: string): Promise<void>;
}

/** No result is deliverable while worker ownership is pending or unreadable. */
export async function assertProviderExecutionsSettled(execution?: ProviderExecutionFactory): Promise<void> {
  if (execution && await execution.hasPending().catch(() => true) !== false) {
    throw new DkbError(
      'Compilation still has unconfirmed provider work. Restore the worker connection and retry cancellation for the same execution.',
      'compile_termination_unconfirmed',
    );
  }
}

export interface PendingProviderExecution {
  target: string;
  kind: 'evidence';
  providerId: string;
  providerIntegrityDigest: string;
  providerBuildDigest: string;
  optionsDigest: string;
  state: Record<string, DkbJsonValue>;
}

export function bindProviderExecution(host: DkbProviderHost, kind: 'evidence'): Omit<PendingProviderExecution, 'state'> {
  const description = host.describe();
  const provider = description.providers.find((entry) => entry.kind === kind);
  if (!provider) throw new DkbError('Selected execution provider is missing.', 'compile_provider_missing');
  return {
    target: description.target, kind, providerId: provider.id,
    providerIntegrityDigest: provider.integrityDigest,
    providerBuildDigest: description.buildDigest,
    optionsDigest: stableHash(host.optionsFor(provider.id)),
  };
}

export function pendingExecutionReconciler(distribution: DkbDistribution, contextRoot: string) {
  return async (pending: PendingProviderExecution): Promise<boolean> => {
    const host = await ProviderHost.create({ distribution, root: contextRoot, target: pending.target });
    try {
      const resolved = bindProviderExecution(host, pending.kind);
      const { state: _state, ...expected } = pending;
      if (stableHash(resolved) !== stableHash(expected)) {
        throw new DkbError('Pending worker belongs to another provider or configuration. Restore the exact compiler configuration before retrying cancellation.', 'compile_termination_unconfirmed');
      }
      const provider = host.provider<DkbEvidenceProvider>('evidence');
      if (!provider.cancelPending) return false;
      const result = await provider.cancelPending({
        state: pending.state, options: host.optionsFor(pending.providerId), signal: AbortSignal.timeout(35_000),
      });
      return result?.safeToCleanup === true;
    } finally {
      await host.dispose();
    }
  };
}
