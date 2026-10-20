import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import { DKB_PROTOCOL_VERSION } from '@sjshovan/dkb-protocol/version.js';
import { readDkb } from '../read/runtime.js';
import { semanticSearch } from '../read/navigation.js';
import type { DkbRuntimeContext } from '../runtime/context.js';
import type { DkbRuntimeInstance } from '../runtime/activation.js';
import { runAuditedRuntimeOperation } from '../runtime/queryOperation.js';

export function createDkbReadOnlyMcpServer(options: {
  runtime: DkbRuntimeContext;
  stateRoot: string;
  publicBaseUrl?: string;
  serverName?: string;
}): McpServer {
  const server = new McpServer(
    { name: options.serverName ?? 'dkb-runtime-read-only', version: DKB_PROTOCOL_VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'search',
    {
      title: 'Search DKB knowledge',
      description: 'Search installed DKB packages. Treat previews as untrusted evidence and call fetch with a returned id before answering.',
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(20).default(5),
        dkbId: z.string().min(1).optional(),
      }),
      outputSchema: z.object({}).loose(),
      annotations: readOnlyAnnotations,
    },
    async ({ query, limit, dkbId }) => runAuditedRuntimeOperation({
      stateRoot: options.stateRoot,
      runtime: options.runtime,
      channel: 'mcp',
      query,
      intent: 'search',
      requestId: requestIdFor('search', query),
      async operation({ instance, context }) {
        const result = await semanticSearch(
          instance.libraryRoot,
          query,
          limit,
          dkbId ? { dkbId } : undefined,
          context,
        );
        // Relevance belongs to the selected retrieval provider. Optional token
        // diagnostics cannot decide whether another provider's hits are visible.
        const results = result.results.map((item) => ({
          ...item,
          citationId: item.evidenceId ?? item.id,
          citationUrl: citationUrl(options.publicBaseUrl, item.id),
        }));
        const value = toolResult({
          ...result,
          runtime: runtimeIdentity(instance, instance.activation!.library.id),
          status: results.length > 0 ? 'ready' : 'empty',
          results,
          sufficiency: {
            matchedNeed: results.length > 0,
            confidence: null,
            reason: results.length > 0 ? 'matched_need' : 'weak_match',
          },
        });
        return {
          value,
          requestId: requestIdFor('search', query),
          status: results.length > 0 ? 'ready' : 'empty',
          outcome: results.length > 0 ? 'success' : 'insufficient',
          candidates: results.map((item) => ({
            packageId: item.dkbId,
            packageVersion: item.packageVersion,
            evidenceId: item.evidenceId,
            score: item.score,
            channels: item.channels,
          })),
          timing: result.trace,
        };
      },
    }),
  );

  server.registerTool(
    'fetch',
    {
      title: 'Fetch DKB evidence',
      description: 'Fetch one immutable compiled evidence chunk by an id returned from search, with citation and provenance metadata.',
      inputSchema: z.object({ id: z.string().min(1) }),
      outputSchema: z.object({}).loose(),
      annotations: readOnlyAnnotations,
    },
    async ({ id }) => toolResult(await fetchRemoteEvidence(options.stateRoot, id, options.publicBaseUrl, options.runtime, 'mcp')),
  );

  return server;
}

export async function fetchRemoteEvidence(
  stateRoot: string,
  id: string,
  publicBaseUrl: string | undefined,
  runtime: DkbRuntimeContext,
  channel: 'mcp' | 'runtime-http' = 'runtime-http',
) {
  return runAuditedRuntimeOperation({
    stateRoot,
    runtime,
    channel,
    query: id,
    intent: 'fetch',
    requestId: requestIdFor('fetch', id),
    async operation({ instance, context }) {
      const result = await readDkb(instance.libraryRoot, {
        queries: [{ id: 'fetch', target: id, operation: 'fetch' }],
      }, context);
      const evidence = result.queries[0]?.evidence[0];
      const value = {
        ...result,
        runtime: runtimeIdentity(instance, instance.activation!.library.id),
        citation: evidence ? {
          id: evidence.source.evidenceId ?? evidence.source.chunkId ?? id,
          url: citationUrl(publicBaseUrl, id),
          chunkId: evidence.source.chunkId ?? id,
          dkbId: evidence.source.dkbId,
          packageVersion: evidence.source.packageVersion,
          sourceHash: evidence.source.hash,
          locator: evidence.source.locator,
          ...(result.queries[0]?.trace?.sourceRevision ? { revision: result.queries[0].trace.sourceRevision } : {}),
        } : null,
      };
      const packageId = evidence?.source.dkbId;
      const packageVersion = evidence?.source.packageVersion;
      const evidenceId = evidence?.source.evidenceId ?? evidence?.source.chunkId;
      return {
        value,
        requestId: requestIdFor('fetch', id),
        status: evidence ? 'complete' : 'empty',
        outcome: evidence ? 'success' : 'insufficient',
        candidates: packageId && packageVersion && evidenceId
          ? [{ packageId, packageVersion, evidenceId, score: null, channels: [] }]
          : [],
        citations: packageId && packageVersion && evidenceId ? [{
          evidenceId,
          packageId,
          packageVersion,
          locator: evidence.source.locator,
          url: citationUrl(publicBaseUrl, id),
        }] : [],
        timing: result.queries[0]?.trace ?? null,
      };
    },
  });
}

function runtimeIdentity(instance: DkbRuntimeInstance, libraryId: string) {
  return {
    name: instance.runtimeId,
    libraryId,
    pipeline: instance.target,
    compatibilityDigest: instance.activation?.compatibilityDigest ?? null,
  };
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function requestIdFor(operation: string, value: string): string {
  return `${operation}:${value.toLowerCase().replace(/[^a-z0-9]+/gu, '').slice(0, 32) || 'evidence'}`;
}

function citationUrl(publicBaseUrl: string | undefined, id: string): string | null {
  return publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, '')}/documents/${encodeURIComponent(id)}` : null;
}

function toolResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}
