import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { libraryStateIdentity } from '@sjshovan/dkb-library/state.js';
import { withLibraryReadSnapshot } from '@sjshovan/dkb-library/mutation.js';
import type { DkbResolvedRetrievalProfile } from '@sjshovan/dkb-pipeline/profile.js';
import { readRuntimeState, type DkbRuntimeInstance } from './activation.js';
import { withRuntimeQuery } from './mutation.js';
import { runtimePipelineCatalog } from './pipelineCatalog.js';
import type { DkbRuntimeContext } from './context.js';

const FORMAT = 'dkb.runtime-pipeline-preparation.v1';
/** Optimistic concurrency receipt, not a signature or permission to activate. */
export interface DkbRuntimePipelinePreparation {
  format: typeof FORMAT;
  runtimeId: string;
  selectionDigest: string;
  libraryDigest: string;
  target: string;
  configDigest: string;
  evidenceProfileDigest: string;
  retrievalProfileDigest: string;
  compatibilityDigest: string;
}

/** Read actual owner state without initialization, repair, or host-side paths. */
export async function inspectRuntimePipelines(stateRoot: string, runtime: DkbRuntimeContext) {
  return withRuntimeQuery(stateRoot, () => withLibraryReadSnapshot(async () => {
    const instance = await readRuntimeState(stateRoot);
    const libraryDigest = stableHash(await libraryStateIdentity(instance.libraryRoot));
    const catalog = await runtimePipelineCatalog({ distribution: runtime.distribution,
      root: stateRoot, libraryRoot: instance.libraryRoot, activeTarget: instance.target });
    if (libraryDigest !== stableHash(await libraryStateIdentity(instance.libraryRoot))) conflict();
    return { ...catalog, targets: catalog.targets.map(target => ({ ...target,
      ...(target.health === 'ready' && target.configDigest && target.evidenceProfileDigest && target.retrievalProfileDigest && target.compatibilityDigest
        ? { preparation: { format: FORMAT, runtimeId: instance.runtimeId, selectionDigest: selectionDigest(instance), libraryDigest,
          target: target.name, configDigest: target.configDigest, evidenceProfileDigest: target.evidenceProfileDigest,
          retrievalProfileDigest: target.retrievalProfileDigest, compatibilityDigest: target.compatibilityDigest } satisfies DkbRuntimePipelinePreparation }
        : {}),
    })) };
  }));
}

export function validateRuntimePipelinePreparation(value: unknown): DkbRuntimePipelinePreparation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  const digests = ['selectionDigest', 'libraryDigest', 'configDigest', 'evidenceProfileDigest', 'retrievalProfileDigest', 'compatibilityDigest'];
  if (Object.keys(record).length !== 9 || record.format !== FORMAT
    || typeof record.runtimeId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(record.runtimeId)
    || typeof record.target !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(record.target)
    || digests.some(key => typeof record[key] !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(record[key] as string))) invalid();
  return { ...record } as unknown as DkbRuntimePipelinePreparation;
}

/** Called within the activation service's Runtime and Library mutation leases. */
export async function assertRuntimePipelinePreparation(value: unknown, instance: DkbRuntimeInstance,
  libraryRoot: string, target: string, profile?: DkbResolvedRetrievalProfile): Promise<void> {
  const expected = validateRuntimePipelinePreparation(value);
  if (expected.runtimeId !== instance.runtimeId || expected.target !== target
    || expected.selectionDigest !== selectionDigest(instance)
    || expected.libraryDigest !== stableHash(await libraryStateIdentity(libraryRoot))) conflict();
  if (profile && (expected.configDigest !== profile.configDigest
    || expected.evidenceProfileDigest !== profile.evidenceProfileDigest
    || expected.retrievalProfileDigest !== profile.retrievalProfileDigest
    || expected.compatibilityDigest !== stableHash(profile.compatibility))) conflict();
}

function selectionDigest(instance: DkbRuntimeInstance): string {
  return stableHash({ binding: instance.binding, activation: instance.activation });
}
function invalid(): never {
  throw new DkbError('Runtime Pipeline preparation is invalid or outdated. Refresh the Pipeline catalog with a matching Runtime and CLI.', 'runtime_pipeline_preparation_invalid');
}
function conflict(): never {
  throw new DkbError('Runtime, Library or Pipeline changed during preparation. No activation was replaced. Refresh the Pipeline catalog and retry.', 'runtime_pipeline_conflict');
}
