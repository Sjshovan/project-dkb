import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import type { QueryContext } from '../indexes/queryContext.js';
import { validateDkbReadRequest } from '@sjshovan/dkb-protocol/validation.js';
import type {
  DkbEvidence,
  DkbReadRequest,
  DkbReadResult,
} from '@sjshovan/dkb-protocol/types.js';
import { SOURCE_DATA_POLICY_LINE } from '@sjshovan/dkb-protocol/security/sourceContent.js';
import { readNavigationChunks } from './navigation.js';
import type { DkbRuntimeContext } from '../runtime/context.js';

export async function readDkb(root: string, request: DkbReadRequest, queryContext?: QueryContext, runtime?: DkbRuntimeContext): Promise<DkbReadResult> {
  const validatedRequest = validateDkbReadRequest(request, 'DKB read request');
  const fetchQueries = validatedRequest.queries.filter((query) => query.operation === 'fetch');
  const direct = await readNavigationChunks(root, fetchQueries.map((query) => query.target), queryContext, runtime);

  const queries = validatedRequest.queries.map((query) => {
    if (query.operation !== 'fetch') {
      return {
        id: query.id,
        target: query.target,
        status: 'blocked' as const,
        reason: 'unsupported_operation' as const,
        message: 'Use dkb.semantic_search or dkb.find to discover chunk references, then fetch them with operation fetch.',
        evidence: [],
        trace: { navigation: true },
      };
    }

    if (query.filters && query.filters.length > 0) {
      return {
        id: query.id,
        target: query.target,
        status: 'blocked' as const,
        reason: 'unsupported_field' as const,
        message: 'Direct chunk fetch does not apply filters; search first and fetch the returned reference.',
        evidence: [],
        trace: { navigation: true },
      };
    }

    const chunk = direct.chunks.find((candidate) => candidate.reference.id === query.target
      || `${candidate.reference.dkbId}/${candidate.reference.id}` === query.target);

    if (!chunk) {
      return {
        id: query.id,
        target: query.target,
        status: 'partial' as const,
        reason: 'no_results' as const,
        message: 'Compiled chunk reference was not found in the active runtime.',
        evidence: [],
        trace: { navigation: true, retrievalMode: 'compiled_chunk_direct' },
      };
    }

    return {
      id: query.id,
      target: query.target,
      status: 'complete' as const,
      reason: null,
      message: 'Compiled source chunk read directly from the active runtime catalog.',
        evidence: [{
        type: 'text' as const,
        label: `[${chunk.reference.dkbId}] ${chunk.reference.title}`,
        text: chunk.text,
        source: {
          storeId: chunk.reference.storeId,
          type: chunk.reference.sourceType as DkbEvidence['source']['type'],
          locator: chunk.reference.locator,
          hash: chunk.reference.sourceHash,
          evidenceId: chunk.reference.evidenceId,
          chunkId: chunk.reference.id,
          dkbId: chunk.reference.dkbId,
          packageVersion: chunk.reference.packageVersion,
        },
      }],
      trace: {
        navigation: true,
        retrievalMode: 'compiled_chunk_direct',
        dkbId: chunk.reference.dkbId,
        packageVersion: chunk.reference.packageVersion,
        sourceId: chunk.reference.sourceId,
        evidenceId: chunk.reference.evidenceId,
        assetId: chunk.reference.assetId,
        storeId: chunk.reference.storeId,
        sourceType: chunk.reference.sourceType,
        locator: chunk.reference.locator,
        assetLocator: chunk.reference.assetLocator,
        sourceHash: chunk.reference.sourceHash,
        chunkOrdinal: chunk.reference.chunkOrdinal,
        chunkStart: chunk.reference.chunkStart,
        chunkEnd: chunk.reference.chunkEnd,
      },
    };
  });

  return sanitizeReadResult({
    status: queries.every((query) => query.status === 'complete')
      ? 'complete'
      : queries.some((query) => query.status === 'complete')
        ? 'partial'
        : 'blocked',
    sourcePolicy: SOURCE_DATA_POLICY_LINE,
    queries,
  });
}

function sanitizeReadResult(result: DkbReadResult): DkbReadResult {
  return {
    ...result,
    queries: result.queries.map((query) => ({
      ...query,
      evidence: query.evidence.map(redactEvidenceSource),
    })),
  };
}

export function redactEvidenceSource(evidence: DkbEvidence): DkbEvidence {
  return {
    ...evidence,
    source: {
      storeId: evidence.source.storeId,
      type: evidence.source.type,
      locator: {
        ref: stableHash({
          storeId: evidence.source.storeId,
          type: evidence.source.type,
          locator: evidence.source.locator,
          hash: evidence.source.hash ?? null,
        }).slice(7, 23),
      },
      hash: evidence.source.hash,
      evidenceId: evidence.source.evidenceId,
      chunkId: evidence.source.chunkId,
      dkbId: evidence.source.dkbId,
      packageVersion: evidence.source.packageVersion,
    },
  };
}
