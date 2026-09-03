import { retrieveKnowledge, type DkbRetrieveKnowledgeRequest } from '../read/runtime.js';
import { renderModelEvidence } from '../read/modelEvidence.js';
import { recordRetrievalTrace, retrievalTraceEnabled } from './trace.js';
import type { DkbRuntimeContext } from './context.js';
import { runAuditedRuntimeOperation } from './queryOperation.js';

export async function retrieveFromRuntime(
  request: DkbRetrieveKnowledgeRequest,
  stateRoot: string | undefined,
  runtime: DkbRuntimeContext,
) {
  const query = [request.need, ...(request.phrases ?? [])].filter(Boolean).join(' ').trim();
  return runAuditedRuntimeOperation({
    stateRoot,
    runtime,
    channel: 'runtime-http',
    query,
    intent: request.intent ?? 'evidence',
    requestId: `retrieve:${query.toLowerCase().replace(/[^a-z0-9]+/gu, '').slice(0, 24) || 'knowledge'}`,
    async operation({ instance, context }) {
      const response = await retrieveKnowledge(instance.libraryRoot, request, context, runtime);
      if (retrievalTraceEnabled()) {
        await recordRetrievalTrace({
          root: instance.stateRoot,
          request,
          response,
          modelText: renderModelEvidence(response),
        });
      }
      return {
        value: response,
        requestId: response.metadata.requestId,
        status: response.status,
        outcome: response.evidence.length > 0 ? 'success' : 'insufficient',
        candidates: response.metadata.sourceUnitMatches.map((match) => ({
          packageId: match.dkbId,
          packageVersion: match.packageVersion ?? instance.activation!.packages[match.dkbId]?.version ?? '',
          evidenceId: match.sourceId,
          score: match.score,
          channels: match.channels,
        })),
        citations: response.evidence.flatMap((evidence) => {
          const evidenceId = evidence.source.evidenceId ?? evidence.source.chunkId ?? evidence.source.hash;
          return evidence.source.dkbId && evidence.source.packageVersion && evidenceId
            ? [{
                evidenceId,
                packageId: evidence.source.dkbId,
                packageVersion: evidence.source.packageVersion,
                locator: evidence.source.locator,
              }]
            : [];
        }),
        timing: response.metadata.retrievalProfile ?? null,
      };
    },
  });
}
