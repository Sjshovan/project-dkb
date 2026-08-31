import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import { DKB_PROTOCOL_VERSION } from '@sjshovan/dkb-protocol/version.js';
import { loadLibrary } from '@sjshovan/dkb-protocol/manifest.js';
import { readDkb } from '../read/runtime.js';
import { semanticSearch } from '../read/navigation.js';
import { withRuntimeQuery } from '../runtime/mutation.js';
import type { DkbRuntimeContext } from '../runtime/context.js';
import { ensureRuntimeState, type DkbRuntimeInstance } from '../runtime/activation.js';
import { getOrOpenRuntimeQueryContext } from '../runtime/querySnapshot.js';

export function createDkbReadOnlyMcpServer(options: {
  runtime: DkbRuntimeContext;
  stateRoot: string;
  publicBaseUrl?: string;
}): McpServer {
  const server = new McpServer(
    { name: 'dkb-runtime-read-only', version: DKB_PROTOCOL_VERSION },
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
    async ({ query, limit, dkbId }) => withRuntimeQuery(options.stateRoot, async () => {
      const { instance, library, context } = await queryContext(options.stateRoot, options.runtime);
      const result = await semanticSearch(
        instance.libraryRoot,
        query,
        limit,
        dkbId ? { dkbId } : undefined,
        context,
      );
      const coverage = searchEvidenceCoverage(query, result.results);
      const visibleResults = hasSufficientSearchCoverage(query, result.results) ? result.results : [];
      const results = visibleResults.map((item) => ({
        ...item,
        citationId: item.evidenceId ?? item.id,
        citationUrl: citationUrl(options.publicBaseUrl, item.id),
      }));

      return toolResult({
        ...result,
        runtime: runtimeIdentity(instance, library.manifest.id),
        status: results.length > 0 ? 'ready' : 'empty',
        results,
        sufficiency: {
          matchedNeed: results.length > 0,
          confidence: coverage,
          reason: results.length > 0 ? 'matched_need' : 'weak_match',
        },
      });
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
    async ({ id }) => withRuntimeQuery(
      options.stateRoot,
      async () => toolResult(await fetchRemoteEvidence(options.stateRoot, id, options.publicBaseUrl, options.runtime)),
    ),
  );

  return server;
}

export async function fetchRemoteEvidence(stateRoot: string, id: string, publicBaseUrl: string | undefined, runtime: DkbRuntimeContext) {
  const { instance, library, context } = await queryContext(stateRoot, runtime);
  const result = await readDkb(instance.libraryRoot, {
    queries: [{ id: 'fetch', target: id, operation: 'fetch' }],
  }, context);
  const evidence = result.queries[0]?.evidence[0];

  return {
    ...result,
    runtime: runtimeIdentity(instance, library.manifest.id),
    citation: evidence ? {
      id: evidence.source.evidenceId ?? evidence.source.chunkId ?? id,
      url: citationUrl(publicBaseUrl, id),
      chunkId: evidence.source.chunkId ?? id,
      dkbId: evidence.source.dkbId,
      packageVersion: evidence.source.packageVersion,
      sourceHash: evidence.source.hash,
      locator: evidence.source.locator,
    } : null,
  };
}

async function queryContext(stateRoot: string, runtime: DkbRuntimeContext) {
  const instance = await ensureRuntimeState(stateRoot);
  const library = await loadLibrary(instance.libraryRoot);
  const context = await getOrOpenRuntimeQueryContext(instance, library.manifest.id, runtime);
  return { instance, library, context };
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

export function searchEvidenceCoverage(query: string, results: Array<{ matchedTokens?: string[] }>): number {
  const queryTokens = [...new Set(tokenize(query)
    .filter((token) => token.length > 2 && !REMOTE_SEARCH_STOPWORDS.has(token)))];

  if (queryTokens.length === 0) return results.length > 0 ? 1 : 0;
  const matchedTokens = new Set(results.flatMap((result) => result.matchedTokens ?? []));

  return Math.round((queryTokens.filter((token) => matchedTokens.has(token)).length / queryTokens.length) * 10_000) / 10_000;
}

export function hasSufficientSearchCoverage(query: string, results: Array<{ matchedTokens?: string[] }>): boolean {
  return searchEvidenceCoverage(query, results) > 0.5;
}

function tokenize(value: string): string[] {
  return (value.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [])
    .flatMap((token) => token.includes('-') ? [token, ...token.split('-')] : [token]);
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

const REMOTE_SEARCH_STOPWORDS = new Set([
  'what', 'which', 'where', 'when', 'who', 'how', 'does', 'are', 'for',
  'explain', 'especially', 'find', 'show', 'tell', 'about', 'that', 'this',
  'with', 'from', 'the', 'and', 'project',
]);
