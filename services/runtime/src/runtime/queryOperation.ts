import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import path from 'node:path';
import { captureFileSnapshot, assertFileSnapshotCurrent } from '@sjshovan/dkb-protocol/fileSnapshot.js';
import type { DkbJsonValue, DkbQueryObserverResult } from '@sjshovan/dkb-pipeline/types.js';
import { assertQueryContextCurrent, type QueryContext } from '../indexes/queryContext.js';
import type { DkbRuntimeContext } from './context.js';
import { currentRuntimeClient } from './clientContext.js';
import { readRuntimeState, maybeReadRuntimeBinding, DKB_RUNTIME_SELECTION_TRANSACTION, type DkbRuntimeInstance } from './activation.js';
import { getOrOpenRuntimeQueryContext, assertRuntimeLibraryCurrent } from './querySnapshot.js';
import { runtimePaths } from './paths.js';
import { withRuntimeQuery } from './mutation.js';
import {
  recordQueryObserverHealth,
  finalizeQueryAudit,
  type DkbQueryAuditCandidate,
  type DkbQueryAuditChannel,
  type DkbQueryAuditCitation,
  type DkbQueryAuditEvent,
  type DkbQueryAuditOutcome,
  type QueryAuditWriteOptions,
} from './queryAudit.js';

export interface DkbAuditedCandidate {
  packageId: string;
  packageVersion: string;
  evidenceId: string;
  score: number | null;
  channels: string[];
}

export interface DkbAuditedCitation {
  evidenceId: string;
  packageId: string;
  packageVersion: string;
  locator?: Record<string, unknown>;
  url?: string | null;
}

export interface DkbAuditedOperationResult<T> {
  value: T;
  requestId: string;
  status: string;
  outcome: DkbQueryAuditOutcome;
  candidates?: DkbAuditedCandidate[];
  citations?: DkbAuditedCitation[];
  timing?: unknown;
}

export interface DkbAuditedRuntimeOperationContext {
  instance: DkbRuntimeInstance;
  context: QueryContext;
}

export async function runAuditedRuntimeOperation<T>(options: {
  stateRoot: string | undefined;
  runtime: DkbRuntimeContext;
  channel: DkbQueryAuditChannel;
  query: string;
  intent: string;
  requestId: string;
  client?: DkbQueryAuditEvent['client'];
  operation(context: DkbAuditedRuntimeOperationContext): Promise<DkbAuditedOperationResult<T>>;
}): Promise<T> {
  const client = options.client ?? currentRuntimeClient();
  const paths = runtimePaths(options.stateRoot);
  return withRuntimeQuery(paths.stateRoot, async () => {
    const startedAt = performance.now();
    let runtimeId: string | null = null;
    let instance: DkbRuntimeInstance | undefined;
    let context: QueryContext | undefined;
    let selectionInputs: Awaited<ReturnType<typeof captureFileSnapshot>> | undefined;
    let result: DkbAuditedOperationResult<T> | undefined;
    let candidates: DkbQueryAuditCandidate[] = [];
    let citations: DkbQueryAuditCitation[] = [];
    let failure: unknown;
    let failed = false;
    try {
      selectionInputs = await captureFileSnapshot([
        paths.bindingPath, paths.activationPath, path.join(paths.stateRoot, DKB_RUNTIME_SELECTION_TRANSACTION),
      ]);
      runtimeId = (await maybeReadRuntimeBinding(paths.bindingPath))?.runtimeId ?? null;
      instance = await readRuntimeState(paths.stateRoot);
      if (!instance.activation) {
        throw new DkbError(`Runtime ${instance.runtimeId} has no validated activation. Run dkb runtime refresh ${instance.runtimeId}.`, 'runtime_activation_required');
      }
      await assertFileSnapshotCurrent(selectionInputs);
      context = await getOrOpenRuntimeQueryContext(instance, instance.activation.library.id, options.runtime);
      if (!context) {
        throw new DkbError(`Runtime ${instance.runtimeId} cannot open its activated build graph. Run dkb runtime refresh ${instance.runtimeId}.`, 'runtime_activation_required');
      }
      result = detachedResult(await options.operation({ instance, context }));
      candidates = bindCandidates(instance, context, result.candidates ?? []);
      citations = bindCitations(instance, context, result.citations ?? []);
    } catch (error) {
      failure = error;
      failed = true;
    }

    const event = await finalizeQueryAudit(paths.stateRoot, async (): Promise<QueryAuditWriteOptions> => {
      if (!failed && instance && context && selectionInputs) {
        try {
          await Promise.all([
            assertFileSnapshotCurrent(selectionInputs),
            assertRuntimeLibraryCurrent(instance),
            assertQueryContextCurrent(context),
          ]);
        } catch (error) { failure = error; failed = true; }
      }
      return {
        root: paths.stateRoot,
        channel: options.channel,
        runtimeId,
        activation: context ? instance?.activation ?? null : null,
        requestId: result?.requestId ?? options.requestId,
        query: options.query,
        intent: options.intent,
        status: failed ? isAbortError(failure) ? 'cancelled' : 'failed' : result!.status,
        outcome: failed ? isAbortError(failure) ? 'cancelled' : 'failed' : result!.outcome,
        candidates: failed ? [] : candidates,
        citations: failed ? [] : citations,
        timing: { elapsedMs: roundMs(performance.now() - startedAt), operation: result?.timing ?? null },
        ...(client ? { client } : {}),
        ...(failed ? { error: {
          ...(failure instanceof DkbError && failure.code ? { code: failure.code } : {}),
          message: failure instanceof Error ? failure.message : String(failure),
        } } : {}),
      };
    });

    // This successful commit is the point-in-time response boundary. Later telemetry
    // cannot revise it; subsequent requests independently reject any later drift.
    if (context) {
      try { await notifyObservers(paths.stateRoot, context, event); }
      catch (error) { console.error(JSON.stringify({ event: 'dkb.query_observer.failed', auditEventId: event.eventId, message: error instanceof Error ? error.message : String(error) })); }
    }
    if (failed) throw failure;
    return result!.value;
  });
}

function detachedResult<T>(result: DkbAuditedOperationResult<T>): DkbAuditedOperationResult<T> {
  try { return deepFreeze(structuredClone(result)); }
  catch { throw new DkbError('Runtime returned a response that cannot be detached for immutable audit finalization.', 'runtime_result_invalid'); }
}

function bindCandidates(
  instance: DkbRuntimeInstance,
  context: QueryContext,
  candidates: DkbAuditedCandidate[],
): DkbQueryAuditCandidate[] {
  const activation = instance.activation!;
  return candidates.map((candidate) => {
    const installed = activation.packages[candidate.packageId];
    const evidence = context.evidenceById.get(candidate.evidenceId);
    if (!installed || installed.version !== candidate.packageVersion
      || !evidence || evidence.packageId !== candidate.packageId || evidence.packageVersion !== candidate.packageVersion) {
      throw new DkbError(
        `Runtime ${instance.runtimeId} produced an audit candidate outside its validated activation: ${candidate.packageId}@${candidate.packageVersion}.`,
        'runtime_candidate_invalid',
      );
    }
    if (candidate.score !== null && !Number.isFinite(candidate.score)) {
      throw new DkbError(
        `Runtime ${instance.runtimeId} produced an audit candidate with an invalid score for ${candidate.evidenceId}.`,
        'runtime_candidate_invalid',
      );
    }
    if (!Array.isArray(candidate.channels)
      || candidate.channels.length > 16
      || candidate.channels.some((channel) => typeof channel !== 'string' || !channel.trim())
      || (candidate.score === null ? candidate.channels.length > 0 : candidate.channels.length === 0)) {
      throw new DkbError(
        `Runtime ${instance.runtimeId} produced inconsistent audit ranking metadata for ${candidate.evidenceId}.`,
        'runtime_candidate_invalid',
      );
    }
    return {
      ...candidate,
      channels: [...candidate.channels],
      evidenceDigest: installed.evidenceDigest,
      retrievalBuildDigest: installed.retrievalBuildDigest,
    };
  });
}

function bindCitations(
  instance: DkbRuntimeInstance,
  context: QueryContext,
  citations: DkbAuditedCitation[],
): DkbQueryAuditCitation[] {
  const activation = instance.activation!;
  return citations.map((citation) => {
    const evidence = context.evidenceById.get(citation.evidenceId);
    if (activation.packages[citation.packageId]?.version !== citation.packageVersion
      || !evidence || evidence.packageId !== citation.packageId || evidence.packageVersion !== citation.packageVersion) {
      throw new DkbError(
        `Runtime ${instance.runtimeId} produced an audit citation outside its validated activation: ${citation.packageId}@${citation.packageVersion}.`,
        'runtime_citation_invalid',
      );
    }
    return citation;
  });
}

async function notifyObservers(root: string, context: QueryContext, event: DkbQueryAuditEvent): Promise<void> {
  if (event.admission !== 'admitted') return;
  const channel: 'cli' | 'http' | 'mcp' = event.channel === 'runtime-http' ? 'http' : event.channel;
  const observation = deepFreeze({
    eventId: event.eventId,
    recordedAt: event.recordedAt,
    runtimeId: event.runtime.id,
    channel,
    status: event.outcome,
    data: JSON.parse(JSON.stringify({
      library: event.library,
      pipeline: event.pipeline,
      packages: event.packages,
      requestId: event.requestId,
      query: event.query,
      intent: event.intent,
      resultCount: event.resultCount,
      candidates: event.candidates,
      citations: event.citations,
      timing: event.timing,
      ...(event.error ? { error: event.error } : {}),
    })) as Record<string, DkbJsonValue>,
  });
  let results: DkbQueryObserverResult[];
  try {
    results = await context.providerHost.observeQuery(observation);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'dkb.query_observer.failed',
      auditEventId: event.eventId,
      message: error instanceof Error ? error.message : String(error),
    }));
    return;
  }
  for (const result of results.filter((item) => !item.ok)) {
    console.error(JSON.stringify({
      event: 'dkb.query_observer.failed',
      auditEventId: event.eventId,
      observerId: result.id,
      message: result.detail ?? 'Observer execution failed',
    }));
  }
  try {
    await recordQueryObserverHealth(root, event, results);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'dkb.query_observer.health_persist_failed',
      auditEventId: event.eventId,
      message: error instanceof Error ? error.message : String(error),
    }));
  }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /cancelled|canceled/iu.test(error.message));
}

function roundMs(value: number): number { return Math.round(value * 100) / 100; }
