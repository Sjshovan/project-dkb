import { stableHash } from './contracts/hash.js';
import type { DkbOwner, DkbSpaceFields } from './types.js';

export interface KnowledgeSpaceInput extends DkbSpaceFields {
  owner?: DkbOwner;
  registryId?: string | null;
  collectionId?: string | null;
  dkbId?: string | null;
}

export interface KnowledgeSpaceIdentity {
  ownerId: string;
  namespace: string;
  appId: string;
  registryId: string | null;
  collectionId: string | null;
  dkbId: string | null;
  spaceId: string;
}

const DEFAULT_OWNER = 'local';
const DEFAULT_NAMESPACE = 'default';
const DEFAULT_APP_ID = 'dkp';

export function deriveKnowledgeSpace(input: KnowledgeSpaceInput): KnowledgeSpaceIdentity {
  const ownerId = input.owner?.id ?? DEFAULT_OWNER;
  const namespace = input.namespace ?? DEFAULT_NAMESPACE;
  const appId = input.appId ?? DEFAULT_APP_ID;
  const registryId = input.registryId ?? null;
  const collectionId = input.collectionId ?? null;
  const dkbId = input.dkbId ?? null;

  return {
    ownerId,
    namespace,
    appId,
    registryId,
    collectionId,
    dkbId,
    spaceId: `ksp_${stableHash({
      ownerId,
      namespace,
      appId,
      registryId,
      collectionId,
      dkbId,
    }).slice(7, 23)}`,
  };
}

export function inheritSpace<T extends DkbSpaceFields>(
  child: T,
  parent: DkbSpaceFields | undefined,
): T {
  return {
    ...child,
    namespace: child.namespace ?? parent?.namespace,
    appId: child.appId ?? parent?.appId,
  };
}
