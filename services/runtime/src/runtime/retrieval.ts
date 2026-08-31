import { loadLibrary } from '@sjshovan/dkb-protocol/manifest.js';
import { retrieveKnowledge, type DkbRetrieveKnowledgeRequest } from '../read/runtime.js';
import { renderModelEvidence } from '../read/modelEvidence.js';
import { recordRetrievalTrace, retrievalTraceEnabled } from './trace.js';
import { enqueueQueryAudit } from './queryAudit.js';
import { withRuntimeQuery } from './mutation.js';
import type { DkbRuntimeContext } from './context.js';
import { ensureRuntimeState } from './activation.js';
import { getOrOpenRuntimeQueryContext } from './querySnapshot.js';

export async function retrieveFromRuntime(
  request: DkbRetrieveKnowledgeRequest,
  stateRoot: string | undefined,
  runtime: DkbRuntimeContext,
) {
  const paths = await ensureRuntimeState(stateRoot);
  return withRuntimeQuery(paths.stateRoot, async () => {
    const library = await loadLibrary(paths.libraryRoot);
    const queryContext = await getOrOpenRuntimeQueryContext(paths, library.manifest.id, runtime);
    const response = await retrieveKnowledge(paths.libraryRoot, request, queryContext, runtime);
    const audit = enqueueQueryAudit({
      root: paths.stateRoot,
      channel: 'runtime-http',
      request,
      response,
    });
    if (audit.mode === 'synchronous_fallback') await audit.flushed;

    if (retrievalTraceEnabled()) {
      await recordRetrievalTrace({
        root: paths.stateRoot,
        request,
        response,
        modelText: renderModelEvidence(response),
      });
    }

    return response;
  });
}
