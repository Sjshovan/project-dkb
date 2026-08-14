import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';
import { DKB_PROTOCOL_VERSION } from '../protocol/version.js';
import {
  describeCollectionTool,
  describeRegistryTool,
  healthTool,
  retrieveKnowledgeTool,
  traceGetTool,
  traceLatestTool,
  traceListTool,
  traceQueryTool,
} from './tools.js';

/**
 * DKB 1.0 deliberately exposes one normal retrieval path. Advanced reference
 * runtime operations stay out of the interoperable MCP surface until specified.
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
    'dkb.retrieve_knowledge',
    {
      title: 'Retrieve DKB Knowledge',
      description: 'Retrieve bounded, provenance-preserving source evidence through compiled DKB indexes and safe adapters.',
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
