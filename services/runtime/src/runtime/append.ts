import { appendLocalDkb, type DkbAppendRequest, type PrepareDkbAppend } from '@sjshovan/dkb-library/append.js';
import { withDkbFileLock } from '@sjshovan/dkb-library/locks.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { readRuntimeState } from './activation.js';
import type { DkbRuntimeContext } from './context.js';
import { withRuntimeMutation } from './mutation.js';
import { refreshRuntimeActivation } from './pipelineSwitch.js';
import { readRuntime } from './queryAccess.js';

/** Local operator composition supplies preparation; Runtime never imports a compiler. */
export async function appendRuntime(options: {
  runtime: DkbRuntimeContext;
  stateRoot: string;
  request: DkbAppendRequest;
  prepare: PrepareDkbAppend;
}) {
  return withRuntimeMutation(options.stateRoot, async () => {
    const instance = await readRuntimeState(options.stateRoot);
    if (instance.binding.library.kind !== 'local') {
      throw new DkbError('Native append requires a local Runtime Library binding.', 'append_target_unavailable');
    }
    const selection = instance.activation?.packages[options.request.dkbId];
    if (!selection) throw new DkbError('The requested DKB is not in this Runtime activation.', 'append_target_unavailable');
    return withDkbFileLock(instance.libraryRoot, 'library-mutation', async () => {
      const { receipt, selection: appendedSelection } = await appendLocalDkb({
        libraryRoot: instance.libraryRoot, target: instance.target,
        previousSelection: selection, expectedGeneration: instance.activation!.library.generation, request: options.request, prepare: options.prepare,
      });
      try {
        const activation = await refreshRuntimeActivation({
          runtime: options.runtime, stateRoot: options.stateRoot,
          localBuildSelections: { ...instance.activation!.packages, [receipt.dkbId]: appendedSelection },
        });
        const readback = await readRuntime({
          runtime: options.runtime, stateRoot: options.stateRoot, channel: 'mcp',
          request: { queries: receipt.evidenceIds.map((id, index) => ({ id: `append-${index}`, target: id, operation: 'fetch' as const })) },
        });
        if (readback.status !== 'complete' || readback.queries.some(query => !query.evidence.length
          || query.evidence.some(item => item.source.hash !== receipt.sourceHash))) {
          throw new DkbError('The appended evidence was not immediately readable with its expected source hash.', 'append_readback_failed');
        }
        return { status: 'appended' as const, committed: true, receipt,
          activationGeneration: activation.activationGeneration, readback };
      } catch (error) {
        return {
          status: 'committed_refresh_required' as const, committed: true, receipt,
          error: { code: error instanceof DkbError ? error.code : 'append_refresh_failed',
            message: error instanceof Error ? error.message : String(error),
            recovery: 'Source was committed once. Restore the Pipeline service, then retry the identical append requestId and text to refresh and verify; do not append a duplicate or erase prior records.' },
        };
      }
    });
  });
}
