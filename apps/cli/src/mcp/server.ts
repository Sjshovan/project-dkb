import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';
import { DKB_PROTOCOL_VERSION } from '@dkb/protocol/version.js';
import {
  describeCollectionTool,
  describeRegistryChunksTool,
  describeRegistryTool,
  healthTool,
  lexicalSearchTool,
  readDkbTool,
  retrieveKnowledgeTool,
  installPackageTool,
  remoteAddTool,
  remoteDescribeTool,
  remoteListTool,
  remoteQueryTool,
  semanticSearchTool,
  sourcesTool,
  traceGetTool,
  traceLatestTool,
  traceListTool,
  traceQueryTool,
} from './tools.js';

/**
 * DKB exposes small navigation primitives over the same compiled runtime
 * snapshot; answer-oriented retrieval remains available for compatibility.
 */
export function createDkbMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'codename-dkb', version: DKB_PROTOCOL_VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'dkb.health',
    {
      title: 'DKB Health',
      description: 'Check manifest, source, artifact, and integrity health for a configured DKB target.',
      inputSchema: z.object({ targetId: z.string().min(1).optional() }).optional(),
      outputSchema: z.object({}).loose(),
    },
    async (input) => toolResult(await healthTool(input?.targetId)),
  );

  server.registerTool(
    'dkb.describe_registry',
    {
      title: 'Describe DKB Registry',
      description: 'Return the configured registry catalog and its portable DKB package identities.',
      inputSchema: z.object({}).optional(),
      outputSchema: z.object({}).loose(),
    },
    async () => toolResult(await describeRegistryTool()),
  );

  server.registerTool(
    'dkb.describe_registry_chunks',
    {
      title: 'Describe DKB Registry Chunks',
      description: 'Return the configured registry direct compiled chunk catalog with package and source provenance.',
      inputSchema: z.object({}).optional(),
      outputSchema: z.object({}).loose(),
    },
    async () => toolResult(await describeRegistryChunksTool()),
  );

  server.registerTool(
    'dkb.describe_collection',
    {
      title: 'Describe DKB Collection',
      description: 'Return a compact catalog of packages and topics in a DKB collection.',
      inputSchema: z.object({ collectionId: z.string().min(1).optional() }),
      outputSchema: z.object({}).loose(),
    },
    async ({ collectionId }) => toolResult(await describeCollectionTool(collectionId)),
  );

  server.registerTool(
    'dkb.semantic_search',
    {
      title: 'Semantic DKB Search',
      description: 'Find conceptually related compiled chunks and return stable references for follow-up reads.',
      inputSchema: z.object({
        targetId: z.string().min(1).optional(),
        query: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(10),
        scope: z.object({
          dkbId: z.string().min(1).optional(),
          packageVersion: z.string().min(1).optional(),
          assetId: z.string().min(1).optional(),
          sourceType: z.string().min(1).optional(),
        }).optional(),
      }),
      outputSchema: z.object({}).loose(),
    },
    async ({ targetId, query, limit, scope }) => toolResult(await semanticSearchTool(targetId, query, limit, scope)),
  );

  server.registerTool(
    'dkb.find',
    {
      title: 'Exact DKB Search',
      description: 'Find literal terms, identifiers, filenames, and error strings in compiled chunk catalogs.',
      inputSchema: z.object({
        targetId: z.string().min(1).optional(),
        query: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(10),
        scope: z.object({
          dkbId: z.string().min(1).optional(),
          packageVersion: z.string().min(1).optional(),
          assetId: z.string().min(1).optional(),
          sourceType: z.string().min(1).optional(),
        }).optional(),
      }),
      outputSchema: z.object({}).loose(),
    },
    async ({ targetId, query, limit, scope }) => toolResult(await lexicalSearchTool(targetId, query, limit, scope)),
  );

  server.registerTool(
    'dkb.read',
    {
      title: 'Read DKB Chunks',
      description: 'Read selected compiled chunks by stable reference, including evidence and provenance.',
      inputSchema: z.object({
        targetId: z.string().min(1).optional(),
        request: z.object({
          queries: z.array(z.object({
            id: z.string().min(1),
            target: z.string().min(1),
            operation: z.enum(['fetch', 'search', 'lookup', 'aggregate']),
            metric: z.enum(['count']).optional(),
            filters: z.array(z.object({
              field: z.string().min(1),
              op: z.enum(['equals', 'contains', 'gt', 'lt', 'gte', 'lte', 'between']),
              value: z.unknown(),
            })).max(25).optional(),
            return: z.array(z.string().min(1)).max(20).optional(),
            limit: z.number().int().min(1).max(1000).optional(),
          })).min(1).max(50),
        }),
      }),
      outputSchema: z.object({}).loose(),
    },
    async ({ targetId, request }) => toolResult(await readDkbTool(targetId, request)),
  );

  server.registerTool(
    'dkb.sources',
    {
      title: 'List DKB Sources',
      description: 'List active compiled source assets and their chunk counts without reading their content.',
      inputSchema: z.object({ targetId: z.string().min(1).optional() }),
      outputSchema: z.object({}).loose(),
    },
    async ({ targetId }) => toolResult(await sourcesTool(targetId)),
  );

  server.registerTool(
    'dkb.retrieve_knowledge',
    {
      title: 'Retrieve DKB Knowledge',
      description: 'Retrieve bounded, provenance-preserving source evidence from compiled DKB chunks.',
      inputSchema: z.object({
        targetId: z.string().min(1).optional(),
        request: z.object({
          need: z.string().min(1),
          intent: z.enum(['evidence', 'records', 'count', 'summary', 'compare']).optional(),
          phrases: z.array(z.string().min(1)).optional(),
          limit: z.number().int().min(1).max(100).optional(),
          profile: z.boolean().optional(),
        }),
      }),
    },
    async ({ targetId, request }) => textToolResult((await retrieveKnowledgeTool(targetId, request)).modelText),
  );

  server.registerTool(
    'dkb.remote_list',
    {
      title: 'List Verified Remote DKBs',
      description: 'List persistent remote DKB runtimes and one-time local installation offers.',
      inputSchema: z.object({}).optional(),
      outputSchema: z.object({}).loose(),
    },
    async () => toolResult(await remoteListTool()),
  );

  server.registerTool(
    'dkb.remote_describe',
    {
      title: 'Describe Remote DKB',
      description: 'Return the verified identity, endpoint, lease, and installation state for one remote DKB.',
      inputSchema: z.object({ remoteId: z.string().min(1) }),
      outputSchema: z.object({}).loose(),
    },
    async ({ remoteId }) => toolResult(await remoteDescribeTool(remoteId)),
  );

  server.registerTool(
    'dkb.remote_query',
    {
      title: 'Query Verified Remote DKB',
      description: 'Query a registry-verified remote runtime after lease and provenance checks.',
      inputSchema: z.object({
        remoteId: z.string().min(1),
        request: z.object({
          need: z.string().min(1),
          intent: z.enum(['evidence', 'records', 'count', 'summary', 'compare']).optional(),
          phrases: z.array(z.string().min(1)).optional(),
          limit: z.number().int().min(1).max(100).optional(),
          profile: z.boolean().optional(),
        }),
      }),
      outputSchema: z.object({}).loose(),
    },
    async ({ remoteId, request }) => toolResult(await remoteQueryTool(remoteId, request)),
  );

  server.registerTool(
    'dkb.install_package',
    {
      title: 'Install Remote DKB Package',
      description: 'Explicitly install the signed package associated with a verified remote runtime.',
      inputSchema: z.object({
        remoteId: z.string().min(1),
        confirm: z.literal(true),
        runtimeRoot: z.string().min(1).optional(),
      }),
      outputSchema: z.object({}).loose(),
    },
    async ({ remoteId, confirm, runtimeRoot }) => toolResult(await installPackageTool({ remoteId, confirm, runtimeRoot })),
  );

  server.registerTool(
    'dkb.trace_query',
    {
      title: 'Trace DKB Query',
      description: 'Return the deterministic retrieval trace and selected citation-safe evidence metadata.',
      inputSchema: z.object({
        targetId: z.string().min(1).optional(),
        query: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(10),
      }),
      outputSchema: z.object({}).loose(),
    },
    async ({ targetId, query, limit }) => toolResult(await traceQueryTool(targetId, query, limit)),
  );

  server.registerTool(
    'dkb.trace_latest',
    {
      title: 'Latest DKB Trace',
      description: 'Return the latest out-of-band retrieval trace for debugging and observability.',
      inputSchema: z.object({ targetId: z.string().min(1).optional() }).optional(),
      outputSchema: z.object({}).loose(),
    },
    async (input) => toolResult(await traceLatestTool(input?.targetId)),
  );

  server.registerTool(
    'dkb.trace_list',
    {
      title: 'List DKB Traces',
      description: 'List recent out-of-band retrieval traces without returning model evidence again.',
      inputSchema: z.object({
        targetId: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      outputSchema: z.object({}).loose(),
    },
    async ({ targetId, limit }) => toolResult(await traceListTool(targetId, limit)),
  );

  server.registerTool(
    'dkb.trace_get',
    {
      title: 'Get DKB Trace',
      description: 'Return one out-of-band retrieval trace by id.',
      inputSchema: z.object({
        targetId: z.string().min(1).optional(),
        traceId: z.string().min(1),
      }),
      outputSchema: z.object({}).loose(),
    },
    async ({ targetId, traceId }) => toolResult(await traceGetTool(targetId, traceId)),
  );

  return server;
}

export function serveDkbMcpServer(): void {
  serveStdio(() => createDkbMcpServer(), {
    onerror: (error) => console.error(error.message),
  });
}

function toolResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function textToolResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
  };
}
