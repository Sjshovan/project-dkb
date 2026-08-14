import fs from 'node:fs/promises';
import path from 'node:path';
import { describeQueryTargets, readDkb, retrieveKnowledge, type DkbRetrieveKnowledgeRequest } from '../read/runtime.js';
import { renderModelEvidence } from '../read/modelEvidence.js';
import { getQueryContext } from '../indexes/queryContext.js';
import { getTrace, latestTrace, listTraces, recordRetrievalTrace } from '../runtime/trace.js';
import { auditKnowledgeAlignment } from '../knowledge/alignment.js';
import { queryKnowledgeTarget } from '../knowledge/target.js';
import { DkbError } from '../protocol/errors.js';
import { loadDkb, loadRegistry } from '../protocol/manifest.js';
import { resolveDkbCapabilities } from '../protocol/capabilities.js';
import { evaluateDkbWrite, evaluateDkbWriteIntent, type DkbWriteIntent } from '../protocol/writeGate.js';
import type { DkbWriteOperation, DkbReadRequest } from '../protocol/types.js';
import { manifestPath } from '../protocol/paths.js';
import { buildRegistryRegions, describeRegistry } from '../registry/index.js';
import { enqueueWrite, listQueuedWrites, loadQueuedWrite } from '../writes/queue.js';
import { processWriteQueue } from '../writes/processor.js';
import type { ProcessWriteQueueInput, QueuedWriteStatus, WriteTarget } from '../writes/types.js';
import { describeCollection } from './catalog.js';
import { configuredRegistryPath, debugMcp } from './config.js';
import { modelSafeToolResult } from '../security/sourceContent.js';
import { discoverRemoteDkb } from '../remote/discovery.js';
import {
  attachRemoteSession,
  detachRemoteSession,
  listRemoteSessions,
  retrieveFromRemoteSession,
} from '../remote/sessions.js';
import type { DkbRemoteAttachInput } from '../remote/types.js';

export async function describeCollectionTool(collectionId?: string) {
  const collection = await resolveCollectionTarget(collectionId);

  return describeCollection(collection.root, collection.id);
}

export async function describeRegistryTool() {
  return describeRegistry(configuredRegistryPath());
}

export async function describeRegistryRegionsTool() {
  return buildRegistryRegions(configuredRegistryPath());
}

export async function auditAlignmentTool(targetId?: string) {
  return auditKnowledgeAlignment(await resolveTargetPath(targetId));
}

export async function searchCollectionTool(targetId: string | undefined, query: string, limit: number) {
  const targetPath = await resolveTargetPath(targetId);
  const queryContext = await maybeQueryContext(targetPath, targetId ?? 'configured-root');

  debugMcp('dkb.search', { targetId, targetPath, query, limit, cacheKey: queryContext?.cacheKey ?? null });

  return modelSafeToolResult((await queryKnowledgeTarget(targetPath, query, { limit, queryContext, profile: Boolean(queryContext) })).response);
}

export const searchCollectiveTool = searchCollectionTool;

export async function describeQueryTargetsTool(targetId: string | undefined, query: string, limit: number) {
  const composePath = await resolveTargetPath(targetId);

  return modelSafeToolResult(await describeQueryTargets(composePath, query, limit, await maybeQueryContext(composePath)));
}

export async function readDkbTool(targetId: string | undefined, request: DkbReadRequest) {
  const composePath = await resolveTargetPath(targetId);

  return modelSafeToolResult(await readDkb(composePath, request, await maybeQueryContext(composePath)));
}

export async function retrieveKnowledgeTool(targetId: string | undefined, request: DkbRetrieveKnowledgeRequest): Promise<{ modelText: string }> {
  const composePath = await resolveTargetPath(targetId);
  const response = await retrieveKnowledge(composePath, {
    ...request,
    profile: true,
  }, await maybeQueryContext(composePath));
  const modelText = renderModelEvidence(response);

  if (process.env.DKB_TRACE_ENABLED !== 'false') {
    await recordRetrievalTrace({
      root: composePath,
      request,
      response,
      modelText,
    });
  }

  return { modelText };
}

export async function remoteDiscoverTool(url: string) {
  return modelSafeToolResult(await discoverRemoteDkb(url));
}

export async function remoteAttachSessionTool(input: DkbRemoteAttachInput) {
  return modelSafeToolResult(await attachRemoteSession(input));
}

export async function remoteSessionsTool() {
  return modelSafeToolResult({
    sessions: listRemoteSessions(),
  });
}

export async function remoteDetachSessionTool(sessionId: string) {
  return modelSafeToolResult(detachRemoteSession(sessionId));
}

export async function remoteRetrieveTool(sessionId: string, request: DkbRetrieveKnowledgeRequest) {
  return modelSafeToolResult(await retrieveFromRemoteSession(sessionId, request));
}

export async function traceQueryTool(targetId: string | undefined, query: string, limit: number) {
  const response = await searchCollectionTool(targetId, query, limit);

  return modelSafeToolResult({
      query: response.query,
      collectionId: response.collectionId,
      trace: response.trace,
      selected: response.results.map((result) => ({
      dkbId: result.dkbId,
      recordId: result.id,
      score: result.score,
      source: result.source,
    })),
  });
}

export async function traceLatestTool(targetId?: string) {
  const targetPath = await resolveTargetPath(targetId);

  return modelSafeToolResult(await latestTrace(targetPath));
}

export async function traceListTool(targetId: string | undefined, limit: number) {
  const targetPath = await resolveTargetPath(targetId);

  return modelSafeToolResult(await listTraces(targetPath, limit));
}

export async function traceGetTool(targetId: string | undefined, traceId: string) {
  const targetPath = await resolveTargetPath(targetId);

  return modelSafeToolResult(await getTrace(targetPath, traceId));
}

export async function healthTool(targetId?: string) {
  const { healthReport } = await import('../lifecycle/health.js');

  return healthReport(await resolveTargetPath(targetId));
}

export async function restoreIndexesTool(targetId?: string) {
  const { restoreIndexes } = await import('../lifecycle/health.js');

  return restoreIndexes(await resolveTargetPath(targetId));
}

async function maybeQueryContext(root: string, collectionId = 'compose-index') {
  try {
    return await getQueryContext(root, collectionId);
  } catch {
    return undefined;
  }
}

export async function checkWriteTool(dkbId: string, operation: DkbWriteOperation) {
  return evaluateDkbWrite(await loadDkb(await resolveDkbPath(dkbId)), operation);
}

export async function describeWriteProtocolTool(dkbId: string) {
  const dkb = await loadDkb(await resolveDkbPath(dkbId));
  const capabilities = resolveDkbCapabilities(dkb.manifest);
  const declaredOperations = dkb.manifest.write?.operations ?? [];

  return {
    dkbId: dkb.manifest.id,
    roles: dkb.manifest.roles ?? [],
    write: {
      operations: declaredOperations.filter((operation) => operation === 'append'),
      mode: dkb.manifest.write?.mode ?? capabilities.writePolicy.mode,
      accepts: {
        lanes: dkb.manifest.write?.accepts?.lanes ?? [],
        subjects: dkb.manifest.write?.accepts?.subjects ?? [],
        intents: dkb.manifest.write?.accepts?.intents ?? [],
        recordTypes: dkb.manifest.write?.accepts?.recordTypes ?? [],
      },
      dedupe: dkb.manifest.write?.dedupe ?? 'required',
      schema: dkb.manifest.write?.schema ?? null,
      confirmationRequired: dkb.manifest.write?.confirmationRequired ?? capabilities.writePolicy.confirmationRequired,
    },
    unsupportedDeclaredOperations: declaredOperations.filter((operation) => operation !== 'append'),
    capabilities,
  };
}

export async function proposeWriteTool(dkbId: string, intent: DkbWriteIntent) {
  const dkb = await loadDkb(await resolveDkbPath(dkbId));
  const gate = evaluateDkbWriteIntent(dkb, intent);
  const status = gate.status === 'blocked'
    ? 'blocked'
    : gate.status === 'accepted'
      ? 'accepted'
      : 'queued';
  const warnings = writeProtocolWarnings(dkb.manifest.write?.schema);

  return {
    header: {
      writeId: gate.writeId,
      dkbId: dkb.manifest.id,
      status,
      createdAt: new Date().toISOString(),
    },
    modelPayload: {
      status,
      message: status === 'blocked'
        ? `Write blocked: ${gate.reason ?? 'unknown'}`
        : status === 'accepted'
          ? 'Write accepted by the direct write gate.'
          : 'Write accepted for queueing.',
    },
    metadataPayload: {
      gate,
      intent,
      warnings,
    },
  };
}

export async function enqueueWriteTool(input: {
  dkbId: string;
  intent: DkbWriteIntent;
  target?: Partial<WriteTarget>;
  selection?: unknown;
}) {
  const dkb = await loadDkb(await resolveDkbPath(input.dkbId));
  const gate = evaluateDkbWriteIntent(dkb, input.intent);
  const result = await enqueueWrite({
    target: {
      registryId: input.target?.registryId,
      collectionId: input.target?.collectionId ?? null,
      dkbId: input.target?.dkbId ?? dkb.manifest.id,
      dkbRoot: dkb.root,
    },
    intent: input.intent,
    gate,
    selection: input.selection,
  });

  return {
    header: {
      writeId: result.item.writeId,
      status: result.item.status,
      duplicateOf: result.duplicateOf,
      persisted: result.persisted,
      createdAt: result.item.createdAt,
    },
    modelPayload: {
      status: result.item.status,
      message: result.duplicateOf
        ? `Duplicate write matched existing queue item ${result.duplicateOf}.`
        : result.item.status === 'blocked'
          ? `Write blocked: ${result.item.failureReason ?? 'blocked'}`
          : 'Write persisted to the durable queue.',
    },
    metadataPayload: {
      item: result.item,
      warnings: writeProtocolWarnings(dkb.manifest.write?.schema),
    },
  };
}

async function resolveTargetPath(targetId?: string): Promise<string> {
  const configuredRoot = path.resolve(configuredRegistryPath());
  const catalog = await configuredTargets(configuredRoot);

  if (!targetId || targetId === catalog.rootId) {
    return configuredRoot;
  }

  const matches = catalog.targets.filter((target) => target.id === targetId);

  if (matches.length === 0) {
    throw new DkbError(`Unknown DKB target id: ${targetId}`);
  }

  const roots = [...new Set(matches.map((match) => path.resolve(match.root)))];

  if (roots.length > 1) {
    throw new DkbError(`Ambiguous DKB target id: ${targetId}`);
  }

  return roots[0];
}

async function resolveCollectionTarget(collectionId?: string): Promise<{ root: string; id?: string }> {
  const configuredRoot = path.resolve(configuredRegistryPath());
  const catalog = await configuredTargets(configuredRoot);
  const collections = catalog.targets.filter((target) => target.type === 'collection');

  if (!collectionId) {
    if (collections.length === 1) {
      return {
        root: configuredRoot,
        id: collections[0].id,
      };
    }

    throw new DkbError('collectionId is required when the configured registry has multiple or zero collections');
  }

  const match = collections.find((collection) => collection.id === collectionId);

  if (!match) {
    throw new DkbError(`Unknown DKB collection id: ${collectionId}`);
  }

  return {
    root: configuredRoot,
    id: match.id,
  };
}

async function resolveDkbPath(dkbId: string): Promise<string> {
  const catalog = await configuredTargets(path.resolve(configuredRegistryPath()));
  const matches = catalog.targets.filter((target) => target.type === 'dkb' && target.id === dkbId);

  if (matches.length === 0) {
    throw new DkbError(`Unknown DKB id: ${dkbId}`);
  }

  const roots = [...new Set(matches.map((match) => path.resolve(match.root)))];

  if (roots.length > 1) {
    throw new DkbError(`Ambiguous DKB id: ${dkbId}`);
  }

  return roots[0];
}

async function configuredTargets(root: string): Promise<{
  rootId: string;
  rootType: 'registry' | 'collection' | 'dkb';
  targets: Array<{ id: string; root: string; type: 'registry' | 'collection' | 'dkb' }>;
}> {
  if (!(await exists(manifestPath(root, 'dkb.json')))) {
    try {
      const registry = await loadRegistry(root);

      return {
        rootId: registry.manifest.id,
        rootType: 'registry',
        targets: [
          { id: registry.manifest.id, root: registry.root, type: 'registry' },
          ...(await Promise.all(registry.collections.map(async (collection) => ({
            id: collection.manifest.id,
            root: collection.root,
            type: 'collection' as const,
          })))),
          ...registry.dkbs.map((dkb) => ({ id: dkb.manifest.id, root: dkb.root, type: 'dkb' as const })),
          ...registry.collections.flatMap((collection) => collection.dkbs.map((dkb) => ({ id: dkb.manifest.id, root: dkb.root, type: 'dkb' as const }))),
        ],
      };
    } catch {
      return {
        rootId: safeTargetId(path.basename(root) || 'runtime'),
        rootType: 'registry',
        targets: [
          { id: safeTargetId(path.basename(root) || 'runtime'), root, type: 'registry' },
        ],
      };
    }
  }

  const dkb = await loadDkb(root);

  return {
    rootId: dkb.manifest.id,
    rootType: 'dkb',
    targets: [
      { id: dkb.manifest.id, root: dkb.root, type: 'dkb' },
    ],
  };
}

function safeTargetId(value: string): string {
  const id = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

  return id || 'runtime';
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);

    return true;
  } catch {
    return false;
  }
}

function writeProtocolWarnings(schema: string | undefined): Array<{ code: string; detail: string }> {
  return schema
    ? [{
        code: 'schema_not_enforced',
        detail: `Schema ${schema} is declared by the DKB manifest but runtime payload validation is not implemented yet.`,
      }]
    : [];
}

export async function listWritesTool(status?: QueuedWriteStatus) {
  return {
    writes: await listQueuedWrites(undefined, status),
  };
}

export async function processWriteQueueTool(status?: ProcessWriteQueueInput['status'], limit?: number) {
  return processWriteQueue({ status, limit });
}

export async function traceWriteTool(writeId: string) {
  return loadQueuedWrite(writeId);
}
