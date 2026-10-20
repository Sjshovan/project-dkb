import type { DkbReadRequest, DkbReadResult } from '@sjshovan/dkb-protocol/types.js';
import type { DkbRetrievalScope } from '@sjshovan/dkb-pipeline/types.js';
import { describeQueryTargets, type DkbQueryTargetResponse } from '../read/retrieval.js';
import { readDkb } from '../read/read.js';
import { semanticSearch, type DkbSemanticSearchResponse } from '../read/navigation.js';
import type { DkbRuntimeContext } from './context.js';
import { runAuditedRuntimeOperation } from './queryOperation.js';

export async function searchRuntime(options: {
  stateRoot?: string;
  runtime: DkbRuntimeContext;
  query: string;
  limit?: number;
  scope?: DkbRetrievalScope;
  channel?: 'cli' | 'runtime-http' | 'mcp';
}): Promise<DkbSemanticSearchResponse> {
  return runAuditedRuntimeOperation({
    stateRoot: options.stateRoot,
    runtime: options.runtime,
    channel: options.channel ?? 'cli',
    query: options.query,
    intent: 'search',
    requestId: requestIdFor('search', options.query),
    async operation({ instance, context }) {
      const result = await semanticSearch(
        instance.libraryRoot,
        options.query,
        options.limit ?? 10,
        options.scope,
        context,
      );
      return {
        value: result,
        requestId: requestIdFor('search', options.query),
        status: result.status,
        outcome: result.results.length > 0 ? 'success' : 'insufficient',
        candidates: result.results.map((item) => ({
          packageId: item.dkbId,
          packageVersion: item.packageVersion,
          evidenceId: item.evidenceId,
          score: item.score,
          channels: item.channels,
        })),
        timing: result.trace,
      };
    },
  });
}

export async function describeRuntimeTargets(options: {
  stateRoot?: string;
  runtime: DkbRuntimeContext;
  query: string;
  limit?: number;
  channel?: 'cli' | 'runtime-http' | 'mcp';
}): Promise<DkbQueryTargetResponse> {
  return runAuditedRuntimeOperation({
    stateRoot: options.stateRoot,
    runtime: options.runtime,
    channel: options.channel ?? 'cli',
    query: options.query,
    intent: 'read-targets',
    requestId: requestIdFor('read-targets', options.query),
    async operation({ instance, context }) {
      const result = await describeQueryTargets(
        instance.libraryRoot,
        options.query,
        options.limit ?? 10,
        context,
      );
      return {
        value: result,
        requestId: requestIdFor('read-targets', options.query),
        status: result.status,
        outcome: result.targets.length > 0 ? 'success' : 'insufficient',
        candidates: result.targets.map((target) => ({
          packageId: target.dkbId,
          packageVersion: instance.activation!.packages[target.dkbId]?.version ?? '',
          evidenceId: target.sourceId,
          score: target.score,
          channels: target.channels,
        })),
        timing: result.trace,
      };
    },
  });
}

export async function readRuntime(options: {
  stateRoot?: string;
  runtime: DkbRuntimeContext;
  request: DkbReadRequest;
  channel?: 'cli' | 'runtime-http' | 'mcp';
}): Promise<DkbReadResult> {
  const targets = options.request.queries.map((query) => query.target);
  const query = targets.join(' ').trim() || 'read';
  return runAuditedRuntimeOperation({
    stateRoot: options.stateRoot,
    runtime: options.runtime,
    channel: options.channel ?? 'cli',
    query,
    intent: 'read',
    requestId: requestIdFor('read', query),
    async operation({ instance, context }) {
      const result = await readDkb(instance.libraryRoot, options.request, context);
      const evidence = result.queries.flatMap((item) => item.evidence);
      const citations = evidence.flatMap((item) => {
        const packageId = item.source.dkbId;
        const packageVersion = item.source.packageVersion;
        const evidenceId = item.source.evidenceId ?? item.source.chunkId;
        return packageId && packageVersion && evidenceId ? [{
          evidenceId,
          packageId,
          packageVersion,
          locator: item.source.locator,
        }] : [];
      });
      return {
        value: result,
        requestId: requestIdFor('read', query),
        status: result.status,
        outcome: evidence.length > 0 ? 'success' : 'insufficient',
        candidates: citations.map((citation) => ({
          packageId: citation.packageId,
          packageVersion: citation.packageVersion,
          evidenceId: citation.evidenceId,
          score: null,
          channels: [],
        })),
        citations,
        timing: result.queries.map((item) => item.trace),
      };
    },
  });
}

function requestIdFor(operation: string, value: string): string {
  return `${operation}:${value.toLowerCase().replace(/[^a-z0-9]+/gu, '').slice(0, 32) || 'knowledge'}`;
}
