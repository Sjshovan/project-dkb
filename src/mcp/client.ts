import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import path from 'node:path';
import { DkbError } from '../protocol/errors.js';
import { DKB_PROTOCOL_VERSION } from '../protocol/version.js';
import type { QueryResponse } from '../protocol/types.js';
import type { KnowledgeAlignmentAudit } from '../knowledge/alignment.js';
import type { DkbWriteGateResult } from '../protocol/writeGate.js';
import type { DkbWriteIntent } from '../protocol/writeGate.js';
import type { DkbReadRequest, DkbReadResult, DkbWriteOperation } from '../protocol/types.js';
import type { DkbQueryTargetResponse, DkbRetrieveKnowledgeRequest, DkbRetrieveKnowledgeResponse } from '../read/runtime.js';
import type { DkbTraceRun, DkbTraceSummary } from '../runtime/trace.js';
import type { DkbRemoteAttachInput, DkbRemoteDiscoveryResult, DkbRemoteRetrieveResult, DkbRemoteSession } from '../remote/types.js';
import type { RegistryCatalog, RegistryRegionIndex } from '../registry/index.js';
import type { QueuedWrite, QueuedWriteStatus } from '../writes/types.js';
import type { CollectionCatalog } from './catalog.js';
import type { DkbHealthReport, RestoreIndexesResult } from '../lifecycle/health.js';

export interface DkbMcpClientHandle {
  listTools(): Promise<string[]>;
  health(input?: { targetId?: string }): Promise<DkbHealthReport>;
  restoreIndexes(input?: { targetId?: string }): Promise<RestoreIndexesResult>;
  describeRegistry(): Promise<RegistryCatalog>;
  describeRegistryRegions(): Promise<RegistryRegionIndex>;
  describeCollection(collectionId?: string): Promise<CollectionCatalog>;
  auditAlignment(targetId?: string): Promise<KnowledgeAlignmentAudit>;
  search(targetId: string | undefined, query: string, limit: number): Promise<QueryResponse>;
  traceQuery(targetId: string | undefined, query: string, limit: number): Promise<Record<string, unknown>>;
  describeQueryTargets(targetId: string | undefined, query: string, limit: number): Promise<DkbQueryTargetResponse>;
  read(targetId: string | undefined, request: DkbReadRequest): Promise<DkbReadResult>;
  retrieveKnowledge(targetId: string | undefined, request: DkbRetrieveKnowledgeRequest): Promise<DkbRetrieveKnowledgeResponse>;
  retrieveKnowledgeText(targetId: string | undefined, request: DkbRetrieveKnowledgeRequest): Promise<string>;
  traceLatest(targetId?: string): Promise<DkbTraceRun | null>;
  traceList(input?: { targetId?: string; limit?: number }): Promise<{ traces: DkbTraceSummary[] }>;
  traceGet(input: { targetId?: string; traceId: string }): Promise<DkbTraceRun | null>;
  remoteDiscover(url: string): Promise<DkbRemoteDiscoveryResult>;
  remoteAttachSession(input: DkbRemoteAttachInput): Promise<DkbRemoteSession>;
  remoteSessions(): Promise<{ sessions: DkbRemoteSession[] }>;
  remoteDetachSession(sessionId: string): Promise<{ status: 'detached'; sessionId: string }>;
  remoteRetrieve(sessionId: string, request: DkbRetrieveKnowledgeRequest): Promise<DkbRemoteRetrieveResult>;
  checkWrite(dkbId: string, operation: DkbWriteOperation): Promise<DkbWriteGateResult>;
  describeWriteProtocol(dkbId: string): Promise<Record<string, unknown>>;
  proposeWrite(dkbId: string, intent: DkbWriteIntent): Promise<Record<string, unknown>>;
  enqueueWrite(input: { dkbId: string; intent: DkbWriteIntent; target?: Record<string, unknown>; selection?: unknown }): Promise<Record<string, unknown>>;
  listWrites(input?: { status?: QueuedWriteStatus }): Promise<{ writes: QueuedWrite[] }>;
  processWriteQueue(input?: { status?: QueuedWriteStatus; limit?: number }): Promise<Record<string, unknown>>;
  traceWrite(writeId: string): Promise<QueuedWrite>;
  close(): Promise<void>;
}

export async function connectDkbMcpClient(options: { registryPath?: string } = {}): Promise<DkbMcpClientHandle> {
  const env = {
    ...process.env,
    ...(options.registryPath ? { DKB_REGISTRY_PATH: path.resolve(options.registryPath) } : {}),
  } as Record<string, string>;
  const client = new Client(
    {
      name: 'codename-dkb-cli',
      version: DKB_PROTOCOL_VERSION,
    },
    {
      defaultCacheTtlMs: 0,
    },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve('dist/src/cli/index.js'), 'mcp', 'serve'],
    cwd: process.cwd(),
    env,
    stderr: 'pipe',
  });

  await client.connect(transport);

  return {
    async listTools(): Promise<string[]> {
      const result = await client.listTools();

      return result.tools.map((tool) => tool.name);
    },
    async health(input = {}): Promise<DkbHealthReport> {
      return callStructuredTool<DkbHealthReport>(client, 'dkb.health', input);
    },
    async restoreIndexes(input = {}): Promise<RestoreIndexesResult> {
      return callStructuredTool<RestoreIndexesResult>(client, 'dkb.restore_indexes', input);
    },
    async describeRegistry(): Promise<RegistryCatalog> {
      return callStructuredTool<RegistryCatalog>(client, 'dkb.describe_registry', {});
    },
    async describeRegistryRegions(): Promise<RegistryRegionIndex> {
      return callStructuredTool<RegistryRegionIndex>(client, 'dkb.describe_registry_regions', {});
    },
    async describeCollection(collectionId?: string): Promise<CollectionCatalog> {
      return callStructuredTool<CollectionCatalog>(client, 'dkb.describe_collection', { collectionId });
    },
    async auditAlignment(targetId?: string): Promise<KnowledgeAlignmentAudit> {
      return callStructuredTool<KnowledgeAlignmentAudit>(client, 'dkb.audit_alignment', { targetId });
    },
    async search(targetId: string | undefined, query: string, limit: number): Promise<QueryResponse> {
      return callStructuredTool<QueryResponse>(client, 'dkb.search', { targetId, query, limit });
    },
    async traceQuery(targetId: string | undefined, query: string, limit: number): Promise<Record<string, unknown>> {
      return callStructuredTool<Record<string, unknown>>(client, 'dkb.trace_query', { targetId, query, limit });
    },
    async describeQueryTargets(targetId: string | undefined, query: string, limit: number): Promise<DkbQueryTargetResponse> {
      return callStructuredTool<DkbQueryTargetResponse>(client, 'dkb.describe_query_targets', { targetId, query, limit });
    },
    async read(targetId: string | undefined, request: DkbReadRequest): Promise<DkbReadResult> {
      return callStructuredTool<DkbReadResult>(client, 'dkb.read', { targetId, request });
    },
    async retrieveKnowledge(targetId: string | undefined, request: DkbRetrieveKnowledgeRequest): Promise<DkbRetrieveKnowledgeResponse> {
      await callTextTool(client, 'dkb.retrieve_knowledge', { targetId, request });
      const trace = await callStructuredTool<DkbTraceRun | null>(client, 'dkb.trace_latest', { targetId });

      if (!trace) {
        throw new DkbError('MCP retrieve_knowledge did not persist a trace');
      }

      return trace.response;
    },
    async retrieveKnowledgeText(targetId: string | undefined, request: DkbRetrieveKnowledgeRequest): Promise<string> {
      return callTextTool(client, 'dkb.retrieve_knowledge', { targetId, request });
    },
    async traceLatest(targetId?: string): Promise<DkbTraceRun | null> {
      return callStructuredTool<DkbTraceRun | null>(client, 'dkb.trace_latest', { targetId });
    },
    async traceList(input = {}): Promise<{ traces: DkbTraceSummary[] }> {
      return callStructuredTool<{ traces: DkbTraceSummary[] }>(client, 'dkb.trace_list', input);
    },
    async traceGet(input): Promise<DkbTraceRun | null> {
      return callStructuredTool<DkbTraceRun | null>(client, 'dkb.trace_get', input);
    },
    async remoteDiscover(url: string): Promise<DkbRemoteDiscoveryResult> {
      return callStructuredTool<DkbRemoteDiscoveryResult>(client, 'dkb.remote_discover', { url });
    },
    async remoteAttachSession(input: DkbRemoteAttachInput): Promise<DkbRemoteSession> {
      return callStructuredTool<DkbRemoteSession>(client, 'dkb.remote_attach_session', { ...input });
    },
    async remoteSessions(): Promise<{ sessions: DkbRemoteSession[] }> {
      return callStructuredTool<{ sessions: DkbRemoteSession[] }>(client, 'dkb.remote_sessions', {});
    },
    async remoteDetachSession(sessionId: string): Promise<{ status: 'detached'; sessionId: string }> {
      return callStructuredTool<{ status: 'detached'; sessionId: string }>(client, 'dkb.remote_detach_session', { sessionId });
    },
    async remoteRetrieve(sessionId: string, request: DkbRetrieveKnowledgeRequest): Promise<DkbRemoteRetrieveResult> {
      return callStructuredTool<DkbRemoteRetrieveResult>(client, 'dkb.remote_retrieve', { sessionId, request });
    },
    async checkWrite(dkbId: string, operation: DkbWriteOperation): Promise<DkbWriteGateResult> {
      return callStructuredTool<DkbWriteGateResult>(client, 'dkb.check_write', { dkbId, operation });
    },
    async describeWriteProtocol(dkbId: string): Promise<Record<string, unknown>> {
      return callStructuredTool<Record<string, unknown>>(client, 'dkb.describe_write_protocol', { dkbId });
    },
    async proposeWrite(dkbId: string, intent: DkbWriteIntent): Promise<Record<string, unknown>> {
      return callStructuredTool<Record<string, unknown>>(client, 'dkb.propose_write', { dkbId, intent });
    },
    async enqueueWrite(input): Promise<Record<string, unknown>> {
      return callStructuredTool<Record<string, unknown>>(client, 'dkb.enqueue_write', input);
    },
    async listWrites(input = {}): Promise<{ writes: QueuedWrite[] }> {
      return callStructuredTool<{ writes: QueuedWrite[] }>(client, 'dkb.list_writes', input);
    },
    async processWriteQueue(input = {}): Promise<Record<string, unknown>> {
      return callStructuredTool<Record<string, unknown>>(client, 'dkb.process_write_queue', input);
    },
    async traceWrite(writeId: string): Promise<QueuedWrite> {
      return callStructuredTool<QueuedWrite>(client, 'dkb.trace_write', { writeId });
    },
    async close(): Promise<void> {
      await client.close();
    },
  };
}

async function callStructuredTool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({
    name,
    arguments: args,
  });

  if (result.isError) {
    throw new DkbError(`MCP tool ${name} returned an error: ${JSON.stringify(result.content)}`);
  }

  if (result.structuredContent !== undefined) {
    return result.structuredContent as T;
  }

  const text = result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');

  if (!text) {
    throw new DkbError(`MCP tool ${name} returned no structured or text content`);
  }

  return JSON.parse(text) as T;
}

async function callTextTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await client.callTool({
    name,
    arguments: args,
  });

  if (result.isError) {
    throw new DkbError(`MCP tool ${name} returned an error: ${JSON.stringify(result.content)}`);
  }

  return result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}
