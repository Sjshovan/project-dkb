import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { loadDkb } from '@sjshovan/dkb-protocol/manifest.js';
import type { LoadedDkb } from '@sjshovan/dkb-protocol/types.js';
import type { DkbIndexRuntime, DkbLocatedChunk, DkbParsedDocument, DkbPipelineRecord, DkbProcessor, DkbProvider, DkbProviderOptions, DkbQueryObserver } from './types.js';
import { DkbSdkError } from './sdk.js';
import { validateManagedStorageIdentity } from './validation.js';
import { normalizePluginModule } from './pluginModule.js';
import { RegistrationDisposer } from './registrationLifecycle.js';
import { validateServiceRequirements } from './capabilities.js';
import { assertProtectedProcessorIdentity, evidenceIdsForRetrievalScope, mergeExternalIdentityDigests, resolvePluginIdentity, resolveProviderIdentity, validateEmbeddingCompatibility, validateIndexHits, validateIndexMutationResult, validateIndexRuntime, validatePipelineChunks, validatePipelineDocuments, validateParsedDocuments, validateLocatedChunks, validatePipelineRecords, validateProviderHealth, validateProviderOptions, validateProviderReceipt, validateRetrievalHits, validateRetrievalRuntime, validateVector, validateVectors } from './validation.js';

export type DkbConformanceStatus = 'passed' | 'skipped' | 'failed';

export interface DkbConformanceCheck {
  name: string;
  status: DkbConformanceStatus;
  detail?: string;
}

export interface DkbPluginVerification {
  apiVersion: number;
  id: string;
  version: string;
  options: DkbProviderOptions;
  profileOptions: DkbProviderOptions;
  externalDigests: Record<string, string>;
  providers: DkbProvider[];
  processors: DkbProcessor[];
  observers: DkbQueryObserver[];
}

export interface DkbPluginConformanceFixture {
  dkb?: LoadedDkb;
  root?: string;
  options?: unknown;
}

export interface DkbPluginConformanceReport {
  ok: boolean;
  plugin: { apiVersion: number; id: string; version: string };
  registrations: { providers: string[]; processors: string[]; observers: string[] };
  checks: DkbConformanceCheck[];
}

/** Inspect trusted module/schema code without setup, registration, or provider execution. */
export async function inspectPluginDefinition(definition: unknown, input: { options?: unknown } = {}) {
  const plugin = normalizePluginModule(definition);
  const options = await validateProviderOptions(plugin.optionsSchema, input.options ?? {}, `Plugin ${plugin.id}`);
  const identity = resolvePluginIdentity(plugin.identity, options, `Plugin ${plugin.id}`);
  return {
    apiVersion: plugin.apiVersion, id: plugin.id, version: plugin.version,
    options, profileOptions: identity.profileOptions, externalDigests: identity.externalDigests,
  };
}

export async function verifyPluginModule(definition: unknown, input: { root?: string; options?: unknown } = {}): Promise<DkbPluginVerification> {
  const plugin = normalizePluginModule(definition);
  const identity = await inspectPluginDefinition(plugin, input);
  const { options } = identity;
  const providers: DkbProvider[] = [];
  const processors: DkbProcessor[] = [];
  const observers: DkbQueryObserver[] = [];
  try {
    await plugin.setup({
      root: path.resolve(input.root ?? process.cwd()),
      pluginId: plugin.id,
      pluginVersion: plugin.version,
      options,
      registerProvider(provider) { providers.push(provider); validateProviderShape(provider, plugin.id!); },
      registerProcessor(processor) { processors.push(processor); validateProcessorShape(processor, plugin.id!); },
      registerQueryObserver(observer) { observers.push(observer); validateObserverShape(observer, plugin.id!); },
    });

    if (providers.length + processors.length + observers.length === 0) {
      throw new DkbSdkError('empty_plugin', `Plugin ${plugin.id} did not register a provider, processor, or query observer`);
    }
    const providerKinds = new Set<string>();
    for (const provider of providers) {
      validateProviderShape(provider, plugin.id);
      if (providerKinds.has(provider.kind)) throw new DkbSdkError('duplicate_provider', `Plugin ${plugin.id} registered more than one ${provider.kind} provider`);
      providerKinds.add(provider.kind);
      mergeExternalIdentityDigests(
        `Plugin ${plugin.id} ${provider.kind} provider`,
        identity.externalDigests,
        resolveProviderIdentity(provider.identity, options, `Plugin ${plugin.id} ${provider.kind} provider`),
      );
    }
    for (const processor of processors) validateProcessorShape(processor, plugin.id);
    for (const observer of observers) validateObserverShape(observer, plugin.id);
  } catch (error) {
    await new RegistrationDisposer().disposeAll([...providers, ...processors, ...observers]);
    throw error;
  }

  return {
    apiVersion: plugin.apiVersion,
    id: plugin.id,
    version: plugin.version,
    options,
    profileOptions: identity.profileOptions,
    externalDigests: identity.externalDigests,
    providers,
    processors,
    observers,
  };
}

export async function runPluginConformance(plugin: unknown, fixture: DkbPluginConformanceFixture = {}): Promise<DkbPluginConformanceReport> {
  const checks: DkbConformanceCheck[] = [];
  let identity = { apiVersion: 0, id: 'unknown', version: 'unknown' };
  let verified: DkbPluginVerification;
  try {
    const definition = normalizePluginModule(plugin);
    identity = { apiVersion: definition.apiVersion, id: definition.id, version: definition.version };
    verified = await verifyPluginModule(definition, fixture);
    checks.push({ name: 'plugin definition', status: 'passed' }, { name: 'options validation and freezing', status: 'passed' });
  } catch (error) {
    checks.push({ name: 'plugin definition', status: 'failed', detail: message(error) });
    return {
      ok: false,
      plugin: identity,
      registrations: { providers: [], processors: [], observers: [] },
      checks,
    };
  }

  let workRoot: string | undefined;
  try {
    workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-plugin-conformance-'));
    const dkb = fixture.dkb ?? await createSourceFixture(path.join(workRoot, 'source'));
    for (const provider of verified.providers) await exerciseProvider(provider, verified, dkb, workRoot, checks);
    for (const processor of verified.processors) await exerciseProcessor(processor, verified, checks);
    for (const observer of verified.observers) await exerciseObserver(observer, verified, checks);
  } finally {
    const disposer = new RegistrationDisposer();
    const resources = new Map<object, string>();
    for (const provider of verified.providers) resources.set(provider, `${provider.kind} provider`);
    for (const processor of verified.processors) resources.set(processor, `${processor.stage} processor`);
    for (const observer of verified.observers) resources.set(observer, 'query observer');
    for (const [resource, label] of resources) await exerciseDisposal(label, resource, disposer, checks);
    if (workRoot) await fs.rm(workRoot, { recursive: true, force: true });
  }

  return {
    ok: checks.every((check) => check.status !== 'failed'),
    plugin: { apiVersion: verified.apiVersion, id: verified.id, version: verified.version },
    registrations: {
      providers: verified.providers.map((provider) => provider.kind),
      processors: verified.processors.map((processor) => `${processor.stage}:${processor.id}`),
      observers: verified.observers.map((observer) => observer.id),
    },
    checks,
  };
}

async function exerciseProvider(provider: DkbProvider, verified: DkbPluginVerification, dkb: LoadedDkb, workRoot: string, checks: DkbConformanceCheck[]): Promise<void> {
  await check(checks, `${provider.kind} health`, async () => {
    if (!provider.health) return skip('Provider has no health probe');
    const result = validateProviderHealth(await provider.health(), verified.id);
    if (!result.ok) throw new DkbSdkError('unhealthy_provider', result.detail ?? 'Provider health check failed');
  });

  await check(checks, `${provider.kind} cancellation`, () => exerciseCancellation(provider, verified, dkb, workRoot));

  if (provider.kind === 'evidence') {
    let firstDigest: string | undefined;
    await check(checks, 'Evidence output and provenance', async () => {
      firstDigest = evidenceOutputDigest(await provider.compile({ dkb: structuredClone(dkb), options: verified.options }), verified.id);
    });
    await check(checks, 'Evidence deterministic output', async () => {
      if (!firstDigest) throw new DkbSdkError('invalid_evidence_baseline', 'Evidence output must pass validation before determinism can be proven');
      const repeatedDigest = evidenceOutputDigest(await provider.compile({ dkb: structuredClone(dkb), options: verified.options }), verified.id);
      if (repeatedDigest !== firstDigest) throw new DkbSdkError('nondeterministic_evidence', `Plugin ${verified.id} produced different Evidence records, relationships, or semantic receipt data for identical source and options`);
    });
    return;
  }

  if (provider.kind === 'parser') {
    await check(checks, 'Parser output', async () => {
      const documents = validateParsedDocuments(await provider.parse({ dkb, options: verified.options }), verified.id);
      assertNonemptyFixtureOutput(documents, 'documents', verified.id);
    });
    return;
  }

  if (provider.kind === 'chunker') {
    await check(checks, 'Chunk relationships', async () => {
      const documents = [sampleDocument()];
      const chunks = validateLocatedChunks(await provider.chunk({ documents, options: verified.options }), verified.id, documents);
      assertNonemptyFixtureOutput(chunks, 'chunks', verified.id);
    });
    return;
  }

  if (provider.kind === 'embedding') {
    await check(checks, 'Document and query vector compatibility', async () => {
      const { dimensions } = validateEmbeddingCompatibility(await provider.compatibility(verified.options), verified.id);
      validateVectors(
        await provider.embedDocuments({ texts: ['alpha', 'embedding input longer than the configured dimensions'], options: verified.options }),
        2,
        dimensions,
        verified.id,
      );
      validateVector(
        await provider.embedQuery({ text: 'query input longer than the configured dimensions', options: verified.options }),
        dimensions,
        `${verified.id} query`,
      );
    });
    return;
  }

  if (provider.kind === 'index') {
    await check(checks, `${provider.mode} index lifecycle`, async () => {
      const loadedDkb = dkb;
      const artifactsRoot = path.join(workRoot, 'artifacts');
      await fs.mkdir(artifactsRoot, { recursive: true });
      const record = sampleRecord();
      const vectors = provider.capabilities.vectors === 'none' ? [] : [{ evidenceId: record.id, values: [1] }];
      const compatibility = {
        embeddingSpace: '@dkb/conformance-space',
        dimensions: 1,
        metric: 'cosine',
        normalized: true,
        protocol: 'dkb.embedding.v1',
      };
      const receipt = await provider.compilePackage({ artifactsRoot, dkb: loadedDkb, compiled: { documents: [sampleDocument()], chunks: [sampleChunk()], records: [record], vectors, receipts: [] }, compatibility, options: verified.options });
      if (receipt !== null) validateProviderReceipt(receipt, verified.id);
      const validation = await provider.validatePackage({ dkb: loadedDkb, artifactsRoot, compatibility, options: verified.options });
      if (!validation || typeof validation !== 'object' || Array.isArray(validation)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(validation)) || validation.documentCount !== 1) {
        throw new DkbSdkError('invalid_index_validation', `${verified.id} package validation count must equal the one canonical Evidence record in the fixture`);
      }
      const packages = [{ dkb: loadedDkb, evidenceRoot: workRoot, retrievalRoot: workRoot, artifactsRoot }];
      const installInput = { libraryRoot: workRoot, libraryId: '@dkb/conformance-library', dkb: loadedDkb, artifactsRoot, compatibility, options: verified.options };
      let createdIndexId: string | undefined;
      let cleanupAttempted = false;
      let completed = false;
      const discardCreatedIndex = async () => {
        if (provider.mode !== 'managed' || !createdIndexId) return;
        cleanupAttempted = true;
        try {
          const result = validateIndexMutationResult(await provider.discardPackage({ ...installInput, indexId: createdIndexId }), verified.id);
          if (result.indexId !== createdIndexId || result.status !== 'removed') {
            throw new DkbSdkError('invalid_index_rollback', `${verified.id} must discard only the exact newly-created index.`);
          }
        } catch (error) {
          throw new DkbSdkError('index_cleanup_failed', `${verified.id} could not confirm cleanup of conformance index ${createdIndexId}: ${message(error)}. Inspect this exact index before retrying; no broad package uninstall was attempted.`);
        }
      };
      try {
        if (provider.mode === 'managed') {
          const identity = validateManagedStorageIdentity(await provider.storageIdentity({ options: verified.options }));
          if (identity !== validateManagedStorageIdentity(await provider.storageIdentity({ options: verified.options }))) {
            throw new DkbSdkError('invalid_storage_identity', 'Managed storage identity must remain stable for the same backing store.');
          }
        }
        const installed = provider.mode === 'managed' ? validateIndexMutationResult(await provider.installPackage(installInput), verified.id) : undefined;
        if (installed?.created && installed.status === 'ready') createdIndexId = installed.indexId;
        if (installed && (installed.status !== 'ready' || installed.documentCount !== 1 || typeof installed.created !== 'boolean')) throw new DkbSdkError('invalid_index_install', `${verified.id} must report ready status, the exact Evidence count, and explicit index ownership.`);
        const runtimeVerification = validateIndexMutationResult(await provider.verifyRuntime({ libraryRoot: workRoot, libraryId: '@dkb/conformance-library', packages, compatibility, options: verified.options }), verified.id);
        if (runtimeVerification.status !== 'ready' || runtimeVerification.documentCount !== 1) throw new DkbSdkError('invalid_index_verification', `${verified.id} Runtime verification must report ready status and the exact Evidence count.`);
        const runtime = validateIndexRuntime(await provider.openRuntime({
          libraryRoot: workRoot,
          libraryId: '@dkb/conformance-library',
          packages,
          compatibility,
          options: verified.options,
          ...(provider.capabilities.vectors === 'none' ? {} : { embedQuery: async () => [1] }),
        }), verified.id);
        if (!runtime) throw new DkbSdkError('missing_index_runtime', `${verified.id} must open a queryable Runtime for the nonempty conformance index.`);
        {
          let searchCompleted = false;
          try {
            const result = await runtime.search('alpha', 5);
            validateIndexHits(result.hits, new Set([record.id]), 5, verified.id);
            if (result.hits.length !== 1 || result.hits[0]?.id !== record.id) {
              throw new DkbSdkError('unqueryable_index', `${verified.id} did not retrieve the indexed alpha Evidence record.`);
            }
            searchCompleted = true;
          } finally {
            if (searchCompleted) await runtime.close();
            else await check(checks, 'index Runtime failure disposal', () => Promise.resolve(runtime.close()));
          }
        }
        if (provider.mode === 'managed') {
          await discardCreatedIndex();
          const removed = validateIndexMutationResult(await provider.uninstallPackage({ libraryRoot: workRoot, libraryId: '@dkb/conformance-library', packageId: loadedDkb.manifest.id, packageVersion: loadedDkb.manifest.version, options: verified.options }), verified.id);
          if (removed.status !== 'removed' && removed.status !== 'orphaned') throw new DkbSdkError('invalid_index_uninstall', `${verified.id} did not remove or report an orphaned managed index`);
        }
        completed = true;
      } finally {
        if (!completed && createdIndexId && !cleanupAttempted) {
          // Report cleanup separately so it cannot hide the primary contract failure.
          await check(checks, 'managed index failure cleanup', discardCreatedIndex);
        }
      }
    });
    return;
  }

  await check(checks, 'Retrieval Runtime and result validation', async () => {
    const evidence = sampleEvidenceCatalog();
    const index = syntheticIndexRuntime();
    const runtime = validateRetrievalRuntime(await provider.openRuntime({ index, evidence, options: verified.options }), verified.id, provider.protocol);
    try {
      const scope = { dkbId: '@dkb/conformance' };
      const result = await runtime.search({ query: 'alpha', limit: 5, scope });
      validateRetrievalHits(
        result.hits,
        new Set(evidence.records.map((record) => record.evidenceId)),
        5,
        verified.id,
        evidenceIdsForRetrievalScope(evidence.records, scope),
      );
      if (!result.hits.some((hit) => hit.evidenceId === 'evidence-1')) {
        throw new DkbSdkError('unqueryable_retrieval', `${verified.id} did not retrieve the relevant in-scope alpha Evidence record.`);
      }
    } finally {
      await runtime.close();
    }
  });
}

async function exerciseCancellation(provider: DkbProvider, verified: DkbPluginVerification, dkb: LoadedDkb, workRoot: string): Promise<void> {
  const controller = new AbortController();
  controller.abort(new DkbSdkError('conformance_cancelled', 'DKB conformance cancellation'));
  const signal = controller.signal;
  const record = sampleRecord();
  const loadedDkb = dkb;
  const artifactsRoot = path.join(workRoot, 'cancellation-artifacts');
  const compatibility = {
    embeddingSpace: '@dkb/conformance-space',
    dimensions: 1,
    metric: 'cosine',
    normalized: true,
    protocol: 'dkb.embedding.v1',
  };

  await expectCancellation(provider.kind, signal, async () => {
    if (provider.kind === 'evidence') {
      await provider.compile({ dkb: loadedDkb, options: verified.options, signal });
      return;
    }
    if (provider.kind === 'parser') {
      await provider.parse({ dkb: loadedDkb, options: verified.options, signal });
      return;
    }
    if (provider.kind === 'chunker') {
      await provider.chunk({ documents: [sampleDocument()], options: verified.options, signal });
      return;
    }
    if (provider.kind === 'embedding') {
      await provider.embedQuery({ text: 'alpha', options: verified.options, signal });
      return;
    }
    if (provider.kind === 'index') {
      await fs.mkdir(artifactsRoot, { recursive: true });
      await provider.compilePackage({
        artifactsRoot,
        dkb: loadedDkb,
        compiled: { documents: [sampleDocument()], chunks: [sampleChunk()], records: [record], vectors: provider.capabilities.vectors === 'none' ? [] : [{ evidenceId: record.id, values: [1] }], receipts: [] },
        compatibility,
        options: verified.options,
        signal,
      });
      return;
    }

    const runtime = validateRetrievalRuntime(await provider.openRuntime({ index: syntheticIndexRuntime(), evidence: sampleEvidenceCatalog(), options: verified.options }), verified.id, provider.protocol);
    try {
      await runtime.search({ query: 'alpha', limit: 5, signal });
    } finally {
      await runtime.close();
    }
  });
}

async function expectCancellation(label: string, signal: AbortSignal, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (signal.aborted && (error === signal.reason || isCancellation(error))) return;
    throw error;
  }
  throw new DkbSdkError('cancellation_ignored', `${label} provider ignored an already-aborted signal`);
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /abort|cancel/iu.test(error.message));
}

async function exerciseProcessor(processor: DkbProcessor, verified: DkbPluginVerification, checks: DkbConformanceCheck[]): Promise<void> {
  await check(checks, `${processor.stage} processor mutation`, async () => {
    const input = processor.stage === 'document' ? sampleDocument() : processor.stage === 'chunk' ? sampleChunk() : sampleRecord();
    const before = structuredClone(input);
    const output = await processor.mutate(input, { root: process.cwd(), options: verified.options });
    if (output === null) return;
    if (processor.stage === 'document') {
      const document = validatePipelineDocuments([output], verified.id)[0]!;
      assertProtectedProcessorIdentity('document', before, document, processor.id);
    } else if (processor.stage === 'chunk') {
      const chunk = validatePipelineChunks([output], verified.id, [sampleDocument()])[0]!;
      assertProtectedProcessorIdentity('chunk', before, chunk, processor.id);
    }
    else {
      const record = validatePipelineRecords([output], verified.id)[0]!;
      assertProtectedProcessorIdentity('record', before, record, processor.id);
    }
  });
}

async function exerciseObserver(observer: DkbQueryObserver, verified: DkbPluginVerification, checks: DkbConformanceCheck[]): Promise<void> {
  await check(checks, 'Query observer receives immutable finalized events', async () => {
    const event = deepFreeze({ eventId: 'conformance-event', recordedAt: '2026-01-01T00:00:00.000Z', runtimeId: 'conformance-runtime', channel: 'cli' as const, status: 'success' as const, data: { query: 'alpha' } });
    const digest = stableHash(event);
    await observer.observe(event, { root: process.cwd(), options: verified.options });
    if (stableHash(event) !== digest) throw new DkbSdkError('observer_mutation', `Observer ${observer.id} mutated the finalized event`);
  });
}

async function exerciseDisposal(label: string, resource: object, disposer: RegistrationDisposer, checks: DkbConformanceCheck[]): Promise<void> {
  await check(checks, `${label} disposal`, async () => {
    if (typeof (resource as { dispose?: unknown }).dispose !== 'function') return skip('Registration has no disposal hook');
    await disposer.dispose(resource);
  });
}

function validateProviderShape(provider: DkbProvider, pluginId: string): void {
  if (!provider || !['evidence', 'parser', 'chunker', 'embedding', 'index', 'retrieval'].includes(provider.kind)) throw new DkbSdkError('invalid_provider', `Plugin ${pluginId} registered an invalid provider`);
  validateServiceRequirements(provider.serviceRequirements, pluginId);
  if (provider.kind === 'evidence' && typeof provider.compile !== 'function') throw missing(pluginId, 'Evidence compile()');
  if (provider.kind === 'parser' && typeof provider.parse !== 'function') throw missing(pluginId, 'parser parse()');
  if (provider.kind === 'chunker' && typeof provider.chunk !== 'function') throw missing(pluginId, 'chunker chunk()');
  if (provider.kind === 'embedding' && (typeof provider.embedDocuments !== 'function' || typeof provider.embedQuery !== 'function' || typeof provider.compatibility !== 'function')) throw missing(pluginId, 'embedding document/query methods and compatibility()');
  if (provider.kind === 'index') {
    if (!['packaged', 'managed'].includes(provider.mode) || !provider.format || !provider.capabilities || !['required', 'optional', 'none'].includes(provider.capabilities.vectors)
      || typeof provider.compilePackage !== 'function' || typeof provider.validatePackage !== 'function' || typeof provider.verifyRuntime !== 'function' || typeof provider.openRuntime !== 'function'
      || (provider.mode === 'managed' && (typeof provider.storageIdentity !== 'function' || typeof provider.installPackage !== 'function' || typeof provider.discardPackage !== 'function' || typeof provider.uninstallPackage !== 'function'))) throw missing(pluginId, `complete ${provider.mode} index contract (including storageIdentity and exact discardPackage rollback)`);
  }
  if (provider.kind === 'retrieval' && (!provider.protocol || !provider.capabilities || !['required', 'optional', 'none'].includes(provider.capabilities.vectors) || typeof provider.openRuntime !== 'function')) throw missing(pluginId, 'retrieval protocol, capabilities, and openRuntime()');
}

function validateProcessorShape(processor: DkbProcessor, pluginId: string): void {
  if (!processor || processor.id !== pluginId || !processor.version || !['document', 'chunk', 'record'].includes(processor.stage) || typeof processor.mutate !== 'function') throw new DkbSdkError('invalid_processor', `Plugin ${pluginId} registered an invalid processor`);
  validateServiceRequirements(processor.serviceRequirements, pluginId);
}

function validateObserverShape(observer: DkbQueryObserver, pluginId: string): void {
  if (!observer || observer.id !== pluginId || !observer.version || typeof observer.observe !== 'function') throw new DkbSdkError('invalid_observer', `Plugin ${pluginId} registered an invalid query observer`);
}

function evidenceOutputDigest(result: Awaited<ReturnType<Extract<DkbProvider, { kind: 'evidence' }>['compile']>>, providerId: string): string {
  const documents = validatePipelineDocuments(result.documents ?? [], providerId);
  const chunks = validatePipelineChunks(result.chunks ?? [], providerId, documents);
  const records = validatePipelineRecords(result.records, providerId, result.chunks === undefined ? undefined : new Set(chunks.map((chunk) => chunk.id)));
  const receipt = validateProviderReceipt(result.receipt, providerId);
  assertNonemptyFixtureOutput(records, 'Evidence records', providerId);
  // Operational diagnostics are not semantic build output and may differ on
  // repeated runs. Stable build and compatibility receipt fields must agree.
  const byId = <T extends { id: string }>(values: T[]) => [...values].sort((left, right) => left.id.localeCompare(right.id));
  return stableHash({ documents: byId(documents), chunks: byId(chunks), records: byId(records), receipt: { build: receipt.build, ...(receipt.compatibility ? { compatibility: receipt.compatibility } : {}) } });
}

function assertNonemptyFixtureOutput(values: readonly unknown[], kind: string, providerId: string): void {
  if (values.length === 0) throw new DkbSdkError('empty_conformance_output', `Plugin ${providerId} produced no ${kind}. Pass --fixture <editable-dkb> containing source supported by this provider; empty output cannot prove conformance.`);
}

async function check(checks: DkbConformanceCheck[], name: string, action: () => Promise<void | { skipped: string }>): Promise<void> {
  try {
    const result = await action();
    checks.push(result && 'skipped' in result ? { name, status: 'skipped', detail: result.skipped } : { name, status: 'passed' });
  } catch (error) {
    checks.push({ name, status: 'failed', detail: message(error) });
  }
}

function skip(detail: string): { skipped: string } { return { skipped: detail }; }
function missing(pluginId: string, contract: string): DkbSdkError { return new DkbSdkError('invalid_provider', `Plugin ${pluginId} must implement ${contract}`); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function sampleDocument(): DkbParsedDocument {
  const { locator: _locator, chunkOrdinal: _ordinal, chunkStart: _start, chunkEnd: _end, ...provenance } = sampleRecord().provenance;
  return { id: 'document-1', path: 'knowledge.txt', mediaType: 'text/plain', text: 'alpha beta', provenance, metadata: {} };
}
function sampleChunk(): DkbLocatedChunk {
  const { locator, chunkOrdinal, chunkStart, chunkEnd } = sampleRecord().provenance;
  return { id: 'chunk-1', documentId: 'document-1', text: 'alpha beta', provenance: { locator, chunkOrdinal, chunkStart, chunkEnd }, metadata: {} };
}
function sampleRecord(): DkbPipelineRecord {
  return {
    id: 'evidence-1', chunkId: 'chunk-1', text: 'alpha beta',
    provenance: { assetId: 'asset-1', storeId: 'filesystem', sourceType: 'filesystem', locator: { path: 'knowledge.txt', chunk: 0 }, assetLocator: { path: 'knowledge.txt' }, title: 'knowledge.txt', sourceHash: `sha256:${'a'.repeat(64)}`, updatedAt: '2026-01-01T00:00:00.000Z', chunkOrdinal: 0, chunkStart: 0, chunkEnd: 10 },
    metadata: {},
  };
}

async function createSourceFixture(root: string): Promise<LoadedDkb> {
  await fs.mkdir(root, { recursive: true });
  const manifest = { manifestVersion: 1, type: 'dkb', name: '@dkb/conformance', version: '1.0.0', permissions: { read: true, write: false } };
  await fs.writeFile(path.join(root, 'dkb.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(root, 'knowledge.txt'), 'alpha beta\nThe support code is DKB-CONFORMANCE-73.\n');
  await fs.writeFile(path.join(root, 'reference.md'), '# Reference\n\nThis second source exercises independent document and chunk identities.\n');
  const timestamp = new Date('2026-01-01T00:00:00.000Z');
  await Promise.all(['dkb.json', 'knowledge.txt', 'reference.md'].map((file) => fs.utimes(path.join(root, file), timestamp, timestamp)));
  return loadDkb(root);
}

function sampleEvidenceCatalog() {
  return {
    assets: [
      { id: 'asset-1', packageId: '@dkb/conformance', storeId: 'filesystem', type: 'filesystem' as const, locator: { path: 'knowledge.txt' }, title: 'knowledge.txt', sourceHash: `sha256:${'a'.repeat(64)}`, updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'asset-out-of-scope', packageId: '@dkb/out-of-scope', storeId: 'filesystem', type: 'filesystem' as const, locator: { path: 'other.txt' }, title: 'other.txt', sourceHash: `sha256:${'c'.repeat(64)}`, updatedAt: '2026-01-01T00:00:00.000Z' },
    ],
    records: [
      { evidenceId: 'evidence-1', sourceId: 'source-1', packageId: '@dkb/conformance', packageVersion: '1.0.0', assetId: 'asset-1', storeId: 'filesystem', sourceType: 'filesystem' as const, locator: { path: 'knowledge.txt', chunk: 0 }, assetLocator: { path: 'knowledge.txt' }, title: 'knowledge.txt', text: 'alpha beta', textHash: `sha256:${'b'.repeat(64)}`, sourceHash: `sha256:${'a'.repeat(64)}`, provenance: {}, keywords: ['alpha', 'beta'], capabilities: { evidence: 'full' as const, records: 'none' as const, exactCount: 'none' as const, approximateCount: 'partial' as const, structuredFilter: 'none' as const, operations: ['fetch' as const, 'search' as const] }, chunkOrdinal: 0, chunkStart: 0, chunkEnd: 10, updatedAt: '2026-01-01T00:00:00.000Z' },
      { evidenceId: 'evidence-out-of-scope', sourceId: 'source-out-of-scope', packageId: '@dkb/out-of-scope', packageVersion: '2.0.0', assetId: 'asset-out-of-scope', storeId: 'filesystem', sourceType: 'filesystem' as const, locator: { path: 'other.txt', chunk: 0 }, assetLocator: { path: 'other.txt' }, title: 'other.txt', text: 'alpha from another package', textHash: `sha256:${'d'.repeat(64)}`, sourceHash: `sha256:${'c'.repeat(64)}`, provenance: {}, keywords: ['alpha', 'other'], capabilities: { evidence: 'full' as const, records: 'none' as const, exactCount: 'none' as const, approximateCount: 'partial' as const, structuredFilter: 'none' as const, operations: ['fetch' as const, 'search' as const] }, chunkOrdinal: 0, chunkStart: 0, chunkEnd: 26, updatedAt: '2026-01-01T00:00:00.000Z' },
    ],
  };
}

function syntheticIndexRuntime(): DkbIndexRuntime {
  return { providerId: '@dkb/conformance-index', mode: 'packaged', format: 'dkb.conformance.v1', packages: [], async search() { return { hits: [{ id: 'evidence-1', score: 1 }, { id: 'evidence-out-of-scope', score: 0.5 }], trace: {} }; }, async close() {} };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
  }
  return value;
}
