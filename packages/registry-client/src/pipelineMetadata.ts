import type { DkbCapabilityIntegrityReceipt, DkbCapabilityServiceRequirement, DkbCompilerTargetCapability, DkbInstalledCompilerIdentity } from '@sjshovan/dkb-protocol/compilerCapabilities.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DkbError('Registry Pipeline metadata must be an object.');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\0\r\n]/u.test(value)) throw new DkbError('Registry Pipeline metadata contains invalid text.');
  return value;
}
export function pipelineDigest(value: unknown): string {
  const result = text(value);
  if (!/^sha256:[a-f0-9]{64}$/u.test(result)) throw new DkbError('Registry Pipeline metadata contains an invalid digest.');
  return result;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 128) throw new DkbError('Registry Pipeline metadata contains an invalid list.');
  return value.map(text);
}
export function compilerIdentity(value: unknown): DkbInstalledCompilerIdentity {
  const input = record(value);
  if (input.kind !== 'observed-installed') throw new DkbError('Registry reported an unsupported compiler identity.');
  return { kind: input.kind, packageName: text(input.packageName), packageVersion: text(input.packageVersion), filesDigest: pipelineDigest(input.filesDigest), dependencyDigest: pipelineDigest(input.dependencyDigest), buildDigest: pipelineDigest(input.buildDigest) };
}
export function providerIntegrity(value: unknown, id: string, version: string): DkbCapabilityIntegrityReceipt {
  const input = record(value);
  if (input.apiVersion !== 3 || input.id !== id || input.version !== version) throw new DkbError('Registry provider integrity does not match its declared identity.');
  const external = Object.entries(record(input.externalDigests));
  if (external.length > 128) throw new DkbError('Registry provider integrity has too many external identities.');
  return {
    apiVersion: 3, id, version, filesDigest: pipelineDigest(input.filesDigest), dependencyDigest: pipelineDigest(input.dependencyDigest),
    externalDigests: Object.fromEntries(external.map(([name, digest]) => [text(name), pipelineDigest(digest)])),
    protocols: strings(input.protocols), artifactFormats: strings(input.artifactFormats),
  };
}
export function pipelineChains(value: unknown): DkbCompilerTargetCapability['chains'] {
  const input = record(value);
  const processors = record(input.processors);
  return { evidence: strings(input.evidence), embedding: input.embedding === null ? null : text(input.embedding), index: text(input.index), retrieval: text(input.retrieval),
    processors: { document: strings(processors.document), chunk: strings(processors.chunk), record: strings(processors.record) } };
}
export function pipelineServices(value: unknown): DkbCapabilityServiceRequirement[] {
  if (!Array.isArray(value) || value.length > 128) throw new DkbError('Registry Pipeline service requirements are invalid.');
  return value.map((raw) => {
    const input = record(raw);
    if (!['process', 'docker', 'remote'].includes(String(input.kind))
      || !['local', 'global', 'bundled'].includes(String(input.source))
      || !['evidence', 'parser', 'chunker', 'embedding', 'index', 'retrieval', 'processor'].includes(String(input.providerKind))) throw new DkbError('Registry Pipeline service requirement has an invalid kind or origin.');
    return { id: text(input.id), providerId: text(input.providerId), kind: input.kind, source: input.source, providerKind: input.providerKind } as DkbCapabilityServiceRequirement;
  });
}

export function pipelineHealth(value: unknown): DkbCompilerTargetCapability['health'] {
  if (!Array.isArray(value) || value.length > 128) throw new DkbError('Registry Pipeline health must be a bounded list.');
  return value.map((raw) => {
    const input = record(raw);
    if (typeof input.ok !== 'boolean') throw new DkbError('Registry Pipeline health requires an explicit boolean status.');
    return { id: text(input.id), kind: text(input.kind), ok: input.ok, ...(input.detail === undefined ? {} : { detail: text(input.detail) }) };
  });
}
