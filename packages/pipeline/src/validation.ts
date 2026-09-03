import path from 'node:path';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { assertJsonData } from '@sjshovan/dkb-protocol/json.js';
import type { DkbEvidenceCatalogRecord } from '@sjshovan/dkb-protocol/evidence/catalog.js';
import { DkbSdkError } from './sdk.js';
import { assertNoInlineSecrets } from './optionsSecurity.js';
import type {
  DkbIndexRuntime,
  DkbIndexMutationResult,
  DkbPluginIdentity,
  DkbProviderIdentity,
  DkbJsonValue,
  DkbPipelineChunk,
  DkbPipelineDocument,
  DkbPipelineProvenance,
  DkbPipelineRecord,
  DkbParsedDocument,
  DkbLocatedChunk,
  DkbPipelineSourceProvenance,
  DkbPipelineChunkProvenance,
  DkbProviderOptions,
  DkbProviderOptionsSchema,
  DkbProviderHealth,
  DkbProviderOutputReceipt,
  DkbRetrievalHit,
  DkbRetrievalRuntime,
  DkbRetrievalScope,
} from './types.js';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;

export function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

export function validateProviderHealth(value: unknown, providerId: string): DkbProviderHealth {
  if (!isPlainObject(value) || typeof value.ok !== 'boolean'
    || (value.detail !== undefined && (typeof value.detail !== 'string' || !value.detail.trim()))) {
    throw new DkbSdkError('invalid_provider_health', `Plugin ${providerId} health() must return a boolean ok and optional non-empty detail. Repair the selected plugin before retrying.`);
  }
  // Identity belongs to the host, never to a provider-owned health payload.
  return { ok: value.ok, ...(value.detail === undefined ? {} : { detail: value.detail as string }) };
}

export function validateEmbeddingCompatibility(value: unknown, providerId: string): Record<string, DkbJsonValue> & {
  embeddingSpace: string;
  dimensions: number;
  metric: string;
  normalized: boolean;
} {
  const label = `Plugin ${providerId} embedding compatibility`;
  assertJsonValue(value, label);
  if (!isPlainObject(value) || typeof value.embeddingSpace !== 'string' || !value.embeddingSpace.trim()
    || !Number.isInteger(value.dimensions) || Number(value.dimensions) <= 0
    || typeof value.metric !== 'string' || !value.metric.trim() || typeof value.normalized !== 'boolean') {
    throw new DkbSdkError('invalid_compatibility', `${label} must declare a non-empty embeddingSpace, positive integer dimensions, non-empty metric, and boolean normalized`);
  }
  return deepFreeze(structuredClone(value)) as ReturnType<typeof validateEmbeddingCompatibility>;
}

export function validateProviderReceipt(value: unknown, providerId: string): DkbProviderOutputReceipt {
  const label = `Plugin ${providerId} receipt`;
  try {
    assertJsonValue(value, label);
    if (!isPlainObject(value) || !isPlainObject(value.build)
      || (value.compatibility !== undefined && !isPlainObject(value.compatibility))
      || (value.diagnostics !== undefined && !isPlainObject(value.diagnostics))) {
      throw new Error(`${label} must contain a build object and optional compatibility and diagnostics objects`);
    }
    if (Object.keys(value).some((key) => !['build', 'compatibility', 'diagnostics'].includes(key))) {
      throw new Error(`${label} may contain only provider-owned build, compatibility, and diagnostics data; DKB supplies provider identity`);
    }
    return deepFreeze(structuredClone(value)) as unknown as DkbProviderOutputReceipt;
  } catch (error) {
    throw new DkbSdkError('invalid_provider_receipt', error instanceof Error ? error.message : `${label} is invalid`);
  }
}

export async function validateProviderOptions(schema: DkbProviderOptionsSchema, value: unknown, label: string): Promise<DkbProviderOptions> {
  if (!schema || schema['~standard']?.version !== 1 || typeof schema['~standard'].validate !== 'function') {
    throw new DkbSdkError('invalid_options_schema', `${label} must export a Standard Schema V1 optionsSchema`);
  }
  const result = await schema['~standard'].validate(value);
  if (result.issues) {
    const issues = result.issues.map((issue) => ({
      message: issue.message,
      ...(issue.path ? { path: issue.path.map((segment) => typeof segment === 'object' ? segment.key : segment) } : {}),
    }));
    throw new DkbSdkError('invalid_plugin_options', `${label} options are invalid: ${issues.map(formatIssue).join('; ')}`, issues);
  }
  assertJsonValue(result.value, `${label} options`);
  if (!isPlainObject(result.value)) throw new DkbSdkError('invalid_plugin_options', `${label} options must resolve to an object`);
  assertNoInlineSecrets(result.value, `${label} options`);
  return deepFreeze(structuredClone(result.value));
}

export function resolvePluginIdentity(
  identity: DkbPluginIdentity | undefined,
  options: DkbProviderOptions,
  label: string,
): { externalDigests: Record<string, string>; profileOptions: DkbProviderOptions } {
  const declaration = identity === undefined
    ? {}
    : typeof identity === 'function' ? identity({ options }) : identity;
  const resolved = validateIdentityDeclaration(declaration, label, true);
  const profileOptions = resolved.profileOptions === undefined ? options : validateProfileOptions(resolved.profileOptions, options, label);
  return deepFreeze({ externalDigests: resolved.externalDigests, profileOptions });
}

export function resolveProviderIdentity(
  identity: DkbProviderIdentity | undefined,
  options: DkbProviderOptions,
  label: string,
): Record<string, string> {
  if (identity === undefined) return Object.freeze({});
  const declaration = typeof identity === 'function' ? identity({ options }) : identity;
  return validateIdentityDeclaration(declaration, label, false).externalDigests;
}

export function mergeExternalIdentityDigests(
  label: string,
  ...collections: readonly Record<string, string>[]
): Record<string, string> {
  const merged = new Map<string, string>();
  for (const collection of collections) {
    for (const [name, digest] of Object.entries(collection)) {
      const existing = merged.get(name);
      if (existing !== undefined && existing !== digest) {
        throw new DkbSdkError('invalid_external_identity', `${label} declares conflicting digests for ${name}`);
      }
      merged.set(name, digest);
    }
  }
  return Object.freeze(Object.fromEntries([...merged.entries()].sort(([left], [right]) => left.localeCompare(right))));
}

export function validatePipelineDocuments(value: unknown, providerId: string): DkbPipelineDocument[] {
  if (!isDenseArray(value)) throw malformed(providerId, 'documents must be a dense array');
  const ids = new Set<string>();
  return value.map((document, index) => {
    if (!isPlainObject(document)) throw malformed(providerId, `document ${index} must be an object`);
    const id = nonemptyString(document.id, `${providerId} document ${index}.id`);
    if (ids.has(id)) throw malformed(providerId, `document id ${id} is duplicated`);
    ids.add(id);
    return {
      id,
      path: portablePath(document.path, `${providerId} document ${id}.path`),
      ...(document.mediaType === undefined ? {} : { mediaType: nonemptyString(document.mediaType, `${providerId} document ${id}.mediaType`) }),
      ...(document.text === undefined ? {} : { text: nonemptyString(document.text, `${providerId} document ${id}.text`) }),
      ...(document.provenance === undefined ? {} : { provenance: validateSourceProvenance(document.provenance, `${providerId} document ${id}.provenance`) }),
      metadata: jsonObject(document.metadata, `${providerId} document ${id}.metadata`),
    };
  });
}

export function validatePipelineChunks(value: unknown, providerId: string, documents?: readonly DkbPipelineDocument[]): DkbPipelineChunk[] {
  if (!isDenseArray(value)) throw malformed(providerId, 'chunks must be a dense array');
  const documentIds = documents ? new Set(documents.map((document) => document.id)) : null;
  const ids = new Set<string>();
  return value.map((chunk, index) => {
    if (!isPlainObject(chunk)) throw malformed(providerId, `chunk ${index} must be an object`);
    const id = nonemptyString(chunk.id, `${providerId} chunk ${index}.id`);
    const documentId = nonemptyString(chunk.documentId, `${providerId} chunk ${id}.documentId`);
    if (ids.has(id)) throw malformed(providerId, `chunk id ${id} is duplicated`);
    if (documentIds && !documentIds.has(documentId)) throw malformed(providerId, `chunk ${id} references unknown document ${documentId}`);
    ids.add(id);
    return { id, documentId, text: nonemptyString(chunk.text, `${providerId} chunk ${id}.text`),
      ...(chunk.provenance === undefined ? {} : { provenance: validateChunkProvenance(chunk.provenance, `${providerId} chunk ${id}.provenance`) }),
      metadata: jsonObject(chunk.metadata, `${providerId} chunk ${id}.metadata`) };
  });
}

export function validateParsedDocuments(value: unknown, providerId: string): DkbParsedDocument[] {
  return validatePipelineDocuments(value, providerId).map((document) => {
    if (!document.provenance) throw new DkbSdkError('invalid_provenance', `Parser ${providerId} document ${document.id} requires explicit source provenance; metadata is not a provenance contract`);
    return { ...document, provenance: document.provenance };
  });
}

export function validateLocatedChunks(value: unknown, providerId: string, documents?: readonly DkbPipelineDocument[]): DkbLocatedChunk[] {
  return validatePipelineChunks(value, providerId, documents).map((chunk) => {
    if (!chunk.provenance) throw new DkbSdkError('invalid_provenance', `Chunker ${providerId} chunk ${chunk.id} requires explicit locator and span provenance; metadata is not a provenance contract`);
    return { ...chunk, provenance: chunk.provenance };
  });
}

export function validatePipelineRecords(value: unknown, providerId: string, chunkIds?: ReadonlySet<string>): DkbPipelineRecord[] {
  if (!isDenseArray(value)) throw malformed(providerId, 'records must be a dense array');
  const ids = new Set<string>();
  return value.map((record, index) => {
    if (!isPlainObject(record)) throw malformed(providerId, `record ${index} must be an object`);
    const id = nonemptyString(record.id, `${providerId} record ${index}.id`);
    const chunkId = nonemptyString(record.chunkId, `${providerId} record ${id}.chunkId`);
    if (ids.has(id)) throw malformed(providerId, `record id ${id} is duplicated`);
    if (chunkIds && !chunkIds.has(chunkId)) throw malformed(providerId, `record ${id} references unknown chunk ${chunkId}`);
    ids.add(id);
    return {
      id,
      chunkId,
      text: nonemptyString(record.text, `${providerId} record ${id}.text`),
      provenance: validateProvenance(record.provenance, `${providerId} record ${id}.provenance`),
      metadata: jsonObject(record.metadata, `${providerId} record ${id}.metadata`),
    };
  });
}

export function assertProtectedProvenance(before: DkbPipelineRecord, after: DkbPipelineRecord, processorId: string): void {
  if (stableHash(before.provenance) !== stableHash(after.provenance)) {
    throw new DkbSdkError('protected_provenance_mutation', `Processor ${processorId} changed protected provenance for record ${before.id}`);
  }
}

export function assertProtectedProcessorIdentity(
  stage: 'document' | 'chunk' | 'record',
  before: DkbPipelineDocument | DkbPipelineChunk | DkbPipelineRecord,
  after: DkbPipelineDocument | DkbPipelineChunk | DkbPipelineRecord,
  processorId: string,
): void {
  if (stage === 'document') {
    const original = before as DkbPipelineDocument;
    const mutated = after as DkbPipelineDocument;
    if (original.id !== mutated.id || original.path !== mutated.path
      || stableHash(original.provenance ?? null) !== stableHash(mutated.provenance ?? null)
      || stableHash(reservedMetadata(original.metadata)) !== stableHash(reservedMetadata(mutated.metadata))) {
      throw new DkbSdkError('protected_identity_mutation', `Processor ${processorId} changed protected document identity for ${original.id}`);
    }
    return;
  }
  if (stage === 'chunk') {
    const original = before as DkbPipelineChunk;
    const mutated = after as DkbPipelineChunk;
    if (original.id !== mutated.id || original.documentId !== mutated.documentId
      || stableHash(original.provenance ?? null) !== stableHash(mutated.provenance ?? null)
      || stableHash(reservedMetadata(original.metadata)) !== stableHash(reservedMetadata(mutated.metadata))) {
      throw new DkbSdkError('protected_identity_mutation', `Processor ${processorId} changed protected chunk identity for ${original.id}`);
    }
    return;
  }
  const original = before as DkbPipelineRecord;
  const mutated = after as DkbPipelineRecord;
  if (original.id !== mutated.id || original.chunkId !== mutated.chunkId
    || stableHash(reservedMetadata(original.metadata)) !== stableHash(reservedMetadata(mutated.metadata))) {
    throw new DkbSdkError('protected_identity_mutation', `Processor ${processorId} changed protected record identity for ${original.id}`);
  }
  assertProtectedProvenance(original, mutated, processorId);
}

export function validateProcessorStageValues<TValue>(
  stage: 'document' | 'chunk' | 'record',
  values: readonly TValue[],
  processorId: string,
): TValue[] {
  if (stage === 'document') return validatePipelineDocuments(values, processorId) as TValue[];
  if (stage === 'chunk') return validatePipelineChunks(values, processorId) as TValue[];
  return validatePipelineRecords(values, processorId) as TValue[];
}

export function validateVectors(value: unknown, count: number, dimensions: number | undefined, label: string): number[][] {
  if (!isDenseArray(value) || value.length !== count) {
    throw new DkbSdkError('invalid_vectors', `${label} must return a dense array of ${count} vectors; received ${Array.isArray(value) ? value.length : 'non-array'}`);
  }
  return value.map((vector, index) => validateVector(vector, dimensions, `${label} vector ${index}`));
}

export function validateVector(value: unknown, dimensions: number | undefined, label: string): number[] {
  if (!isDenseArray(value) || value.length === 0 || (dimensions !== undefined && value.length !== dimensions)
    || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    throw new DkbSdkError('invalid_vector', `${label} must contain ${dimensions ?? 'a non-zero number of'} finite dimensions`);
  }
  return [...value] as number[];
}

export function validateIndexRuntime(value: unknown, providerId: string): DkbIndexRuntime | null {
  if (value === null) return null;
  if (!isPlainObject(value) || value.providerId !== providerId || !['packaged', 'managed'].includes(String(value.mode))
    || typeof value.format !== 'string' || !Array.isArray(value.packages)
    || typeof value.search !== 'function' || typeof value.close !== 'function') {
    throw malformed(providerId, 'opened an invalid index Runtime');
  }
  return value as unknown as DkbIndexRuntime;
}

export function validateIndexHits(
  hits: unknown,
  knownEvidenceIds: ReadonlySet<string>,
  limit: number,
  providerId: string,
): Array<{ id: string; score: number }> {
  if (!isDenseArray(hits) || hits.length > limit) throw malformed(providerId, `must return a dense array of at most ${limit} index hits`);
  const seen = new Set<string>();
  return hits.map((hit, index) => {
    if (!isPlainObject(hit)) throw malformed(providerId, `index hit ${index} must be an object`);
    const id = nonemptyString(hit.id, `${providerId} index hit ${index}.id`);
    if (!knownEvidenceIds.has(id)) throw malformed(providerId, `index hit references unknown Evidence ID ${id}`);
    if (seen.has(id)) throw malformed(providerId, `index hit duplicates Evidence ID ${id}`);
    if (typeof hit.score !== 'number' || !Number.isFinite(hit.score)) throw malformed(providerId, `index hit ${id} has an invalid score`);
    seen.add(id);
    return { id, score: hit.score };
  });
}

export function validateIndexMutationResult(value: unknown, providerId: string): DkbIndexMutationResult {
  if (!isPlainObject(value)) throw malformed(providerId, 'returned an invalid index lifecycle result');
  const status = value.status;
  if (!['ready', 'removed', 'orphaned'].includes(String(status))) throw malformed(providerId, 'returned an invalid index lifecycle status');
  const documentCount = value.documentCount;
  if (!Number.isInteger(documentCount) || Number(documentCount) < 0) throw malformed(providerId, 'returned an invalid index document count');
  if (value.created !== undefined && typeof value.created !== 'boolean') throw malformed(providerId, 'returned an invalid index created flag');
  if (value.warning !== undefined && (typeof value.warning !== 'string' || !value.warning.trim())) throw malformed(providerId, 'returned an invalid index warning');
  return {
    indexId: nonemptyString(value.indexId, `${providerId} indexId`),
    documentCount: Number(documentCount),
    status: status as DkbIndexMutationResult['status'],
    ...(value.created === undefined ? {} : { created: value.created }),
    ...(value.warning === undefined ? {} : { warning: value.warning }),
  };
}

export function validateRetrievalRuntime(value: unknown, providerId: string, protocol: string): DkbRetrievalRuntime {
  if (!isPlainObject(value) || value.providerId !== providerId || value.protocol !== protocol
    || typeof value.search !== 'function' || typeof value.close !== 'function') {
    throw malformed(providerId, 'opened an invalid retrieval Runtime');
  }
  return value as unknown as DkbRetrievalRuntime;
}

export function evidenceMatchesRetrievalScope(
  record: Pick<DkbEvidenceCatalogRecord, 'packageId' | 'packageVersion' | 'assetId' | 'sourceType'>,
  scope?: DkbRetrievalScope,
): boolean {
  return !scope
    || ((!scope.dkbId || scope.dkbId === record.packageId)
      && (!scope.packageVersion || scope.packageVersion === record.packageVersion)
      && (!scope.assetId || scope.assetId === record.assetId)
      && (!scope.sourceType || scope.sourceType === record.sourceType));
}

export function evidenceIdsForRetrievalScope(
  records: readonly DkbEvidenceCatalogRecord[],
  scope?: DkbRetrievalScope,
): ReadonlySet<string> {
  return new Set(records
    .filter((record) => evidenceMatchesRetrievalScope(record, scope))
    .map((record) => record.evidenceId));
}

export function validateRetrievalHits(
  hits: unknown,
  knownEvidenceIds: ReadonlySet<string>,
  limit: number,
  providerId: string,
  allowedEvidenceIds: ReadonlySet<string> = knownEvidenceIds,
): DkbRetrievalHit[] {
  if (!isDenseArray(hits) || hits.length > limit) throw malformed(providerId, `must return a dense array of at most ${limit} retrieval hits`);
  const seen = new Set<string>();
  return hits.map((hit, index) => {
    if (!isPlainObject(hit)) throw malformed(providerId, `retrieval hit ${index} must be an object`);
    const evidenceId = nonemptyString(hit.evidenceId, `${providerId} retrieval hit ${index}.evidenceId`);
    if (!knownEvidenceIds.has(evidenceId)) throw malformed(providerId, `retrieval hit references unknown Evidence ID ${evidenceId}`);
    if (!allowedEvidenceIds.has(evidenceId)) throw malformed(providerId, `retrieval hit ${evidenceId} is outside the requested Evidence scope`);
    if (seen.has(evidenceId)) throw malformed(providerId, `retrieval hit duplicates Evidence ID ${evidenceId}`);
    seen.add(evidenceId);
    if (typeof hit.score !== 'number' || !Number.isFinite(hit.score)) throw malformed(providerId, `retrieval hit ${evidenceId} has an invalid score`);
    if (!isDenseArray(hit.channels) || hit.channels.length === 0 || hit.channels.length > 16
      || hit.channels.some((channel) => typeof channel !== 'string' || !channel.trim())) {
      throw malformed(providerId, `retrieval hit ${evidenceId} has invalid channels`);
    }
    return hit as unknown as DkbRetrievalHit;
  });
}

function validateIdentityDeclaration(
  value: unknown,
  label: string,
  allowProfileOptions: boolean,
): { externalDigests: Record<string, string>; profileOptions?: DkbProviderOptions } {
  if (!isPlainObject(value)) {
    throw new DkbSdkError('invalid_external_identity', `${label} identity must resolve to an object`);
  }
  const allowed = new Set(allowProfileOptions ? ['external', 'profileOptions'] : ['external']);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new DkbSdkError('invalid_external_identity', `${label} identity contains unsupported fields: ${unknown.join(', ')}`);
  }
  const external = value.external ?? [];
  if (!Array.isArray(external)) {
    throw new DkbSdkError('invalid_external_identity', `${label} identity external declarations must be an array`);
  }
  const entries = new Map<string, string>();
  for (const [index, item] of external.entries()) {
    if (!isPlainObject(item) || !['service', 'image', 'model'].includes(String(item.kind))) {
      throw new DkbSdkError('invalid_external_identity', `${label} external identity ${index} must declare kind service, image, or model`);
    }
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!/^[a-z0-9][a-z0-9._/-]{0,127}$/u.test(name) || SENSITIVE_IDENTITY_NAME.test(name)) {
      throw new DkbSdkError('invalid_external_identity', `${label} external identity ${index} has an invalid or secret-bearing name`);
    }
    if (typeof item.digest !== 'string' || !SHA256.test(item.digest)) {
      throw new DkbSdkError('invalid_external_identity', `${label} external identity ${item.kind}:${name || index} must be a lowercase sha256 digest; raw service, image, model, or secret values are not accepted`);
    }
    const key = `${String(item.kind)}:${name}`;
    if (entries.has(key)) throw new DkbSdkError('invalid_external_identity', `${label} duplicates external identity ${key}`);
    entries.set(key, item.digest);
  }
  const externalDigests = Object.freeze(Object.fromEntries([...entries.entries()].sort(([left], [right]) => left.localeCompare(right))));
  return {
    externalDigests,
    ...(allowProfileOptions && value.profileOptions !== undefined ? { profileOptions: value.profileOptions as DkbProviderOptions } : {}),
  };
}

function validateProfileOptions(value: unknown, options: DkbProviderOptions, label: string): DkbProviderOptions {
  assertJsonValue(value, `${label} identity profileOptions`);
  if (!isPlainObject(value)) {
    throw new DkbSdkError('invalid_external_identity', `${label} identity profileOptions must be an object`);
  }
  assertNoSensitiveIdentityFields(value, `${label} identity profileOptions`);
  for (const [key, item] of Object.entries(value)) {
    if (!Object.hasOwn(options, key) || stableHash(options[key]) !== stableHash(item)) {
      throw new DkbSdkError('invalid_external_identity', `${label} identity profileOptions.${key} must be an unchanged subset of validated options`);
    }
  }
  return deepFreeze(structuredClone(value)) as DkbProviderOptions;
}

function assertNoSensitiveIdentityFields(value: Record<string, unknown>, label: string, prefix = ''): void {
  for (const [key, item] of Object.entries(value)) {
    const field = prefix ? `${prefix}.${key}` : key;
    if (SENSITIVE_IDENTITY_NAME.test(key)) {
      throw new DkbSdkError('invalid_external_identity', `${label}.${field} cannot contain a credential or secret`);
    }
    if (isPlainObject(item)) assertNoSensitiveIdentityFields(item, label, field);
  }
}

const SENSITIVE_IDENTITY_NAME = /(secret|password|credential|bearer|private[-_]?key|api[-_]?(key|token)|access[-_]?token|^token$)/iu;

function validateProvenance(value: unknown, label: string): DkbPipelineProvenance {
  return { ...validateSourceProvenance(value, label), ...validateChunkProvenance(value, label) };
}

function validateSourceProvenance(value: unknown, label: string): DkbPipelineSourceProvenance {
  if (!isPlainObject(value)) throw new DkbSdkError('invalid_provenance', `${label} must be an object`);
  const sourceType = value.sourceType;
  if (sourceType !== 'filesystem' && sourceType !== 'sqlite' && sourceType !== 'database') {
    throw new DkbSdkError('invalid_provenance', `${label}.sourceType must be filesystem, sqlite, or database`);
  }
  const sourceHash = nonemptyString(value.sourceHash, `${label}.sourceHash`);
  if (!SHA256.test(sourceHash)) throw new DkbSdkError('invalid_provenance', `${label}.sourceHash must be a sha256 digest`);
  const updatedAt = nonemptyString(value.updatedAt, `${label}.updatedAt`);
  if (!Number.isFinite(Date.parse(updatedAt))) throw new DkbSdkError('invalid_provenance', `${label}.updatedAt must be an ISO timestamp`);
  const assetLocator = jsonObject(value.assetLocator, `${label}.assetLocator`);
  if (sourceType === 'filesystem' || assetLocator.path !== undefined) portablePath(assetLocator.path, `${label}.assetLocator.path`);
  return {
    assetId: nonemptyString(value.assetId, `${label}.assetId`),
    storeId: nonemptyString(value.storeId, `${label}.storeId`),
    sourceType,
    assetLocator,
    title: nonemptyString(value.title, `${label}.title`),
    sourceHash,
    updatedAt,
  };
}

function validateChunkProvenance(value: unknown, label: string): DkbPipelineChunkProvenance {
  if (!isPlainObject(value)) throw new DkbSdkError('invalid_provenance', `${label} must be an object`);
  const chunkOrdinal = nonnegativeInteger(value.chunkOrdinal, `${label}.chunkOrdinal`);
  const chunkStart = nonnegativeInteger(value.chunkStart, `${label}.chunkStart`);
  const chunkEnd = nonnegativeInteger(value.chunkEnd, `${label}.chunkEnd`);
  if (chunkEnd < chunkStart) throw new DkbSdkError('invalid_provenance', `${label}.chunkEnd must not precede chunkStart`);
  const locator = jsonObject(value.locator, `${label}.locator`);
  if (locator.path !== undefined) portablePath(locator.path, `${label}.locator.path`);
  return { locator, chunkOrdinal, chunkStart, chunkEnd };
}

function jsonObject(value: unknown, label: string): Record<string, DkbJsonValue> {
  assertJsonValue(value, label);
  if (!isPlainObject(value)) throw new DkbSdkError('invalid_json', `${label} must be an object`);
  return structuredClone(value);
}

function reservedMetadata(metadata: Record<string, DkbJsonValue>): Record<string, DkbJsonValue> {
  return Object.fromEntries(Object.entries(metadata)
    .filter(([key]) => key.startsWith('dkb_'))
    .sort(([left], [right]) => left.localeCompare(right)));
}

export function assertJsonValue(value: unknown, label: string): asserts value is DkbJsonValue {
  try {
    assertJsonData(value, label);
  } catch (error) {
    throw new DkbSdkError('invalid_json', error instanceof Error ? error.message : `${label} is not JSON-safe`);
  }
}

function portablePath(value: unknown, label: string): string {
  const input = nonemptyString(value, label).replace(/\\/gu, '/');
  if (path.posix.isAbsolute(input) || /^[a-z]:\//iu.test(input) || input.split('/').includes('..')) {
    throw new DkbSdkError('invalid_source_path', `${label} must be a contained portable path`);
  }
  return input;
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new DkbSdkError('invalid_provider_output', `${label} must be a non-empty string`);
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new DkbSdkError('invalid_provider_output', `${label} must be a non-negative integer`);
  return Number(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
  }
  return value;
}

function malformed(providerId: string, detail: string): DkbSdkError {
  return new DkbSdkError('invalid_provider_output', `Plugin ${providerId} ${detail}`);
}

function formatIssue(issue: { message: string; path?: readonly PropertyKey[] }): string {
  return issue.path?.length ? `${issue.path.map(String).join('.')}: ${issue.message}` : issue.message;
}
