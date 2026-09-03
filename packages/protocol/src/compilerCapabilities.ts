import type { DkbProcessorReceipt, DkbProviderReceipt, DkbRetrievalCompatibilityReceipt } from './retrievalProfile.js';

export const DKB_COMPILER_CAPABILITIES_FORMAT = 'dkb.compiler-capabilities.v1';
export const DKB_PIPELINE_RESOLUTION_MESSAGE = 'Recipe identity could not be resolved. The Registry operator must verify its trusted plugins, options and pinned service identities, then retry.';

/** Observed installed bytes, not a signature or remote image attestation. */
export interface DkbInstalledCompilerIdentity {
  kind: 'observed-installed';
  packageName: string;
  packageVersion: string;
  filesDigest: string;
  dependencyDigest: string;
  buildDigest: string;
}

export interface DkbCapabilityIntegrityReceipt {
  apiVersion: 3;
  id: string;
  version: string;
  filesDigest: string;
  dependencyDigest: string;
  externalDigests: Record<string, string>;
  protocols: string[];
  artifactFormats: string[];
}

export interface DkbCapabilityServiceRequirement {
  id: string;
  kind: 'process' | 'docker' | 'remote';
  providerId: string;
  providerKind: DkbProviderReceipt['kind'] | 'processor';
  source: DkbProviderReceipt['source'];
}

export interface DkbResolvedCompilerTargetCapability {
  name: string;
  providers: Array<Omit<DkbProviderReceipt, 'sourcePath'> & { integrity: DkbCapabilityIntegrityReceipt }>;
  processors: Array<Omit<DkbProcessorReceipt, 'sourcePath'> & { order: number; integrity: DkbCapabilityIntegrityReceipt }>;
  chains: {
    evidence: string[];
    embedding: string | null;
    index: string;
    retrieval: string;
    processors: { document: string[]; chunk: string[]; record: string[] };
  };
  buildDigest: string;
  evidenceProfileDigest: string;
  retrievalProfileDigest: string;
  compatibility: DkbRetrievalCompatibilityReceipt;
  compatibilityDigest: string;
  requiredServices: string[];
  serviceRequirements: DkbCapabilityServiceRequirement[];
  available: boolean;
  health: Array<{ id: string; kind: string; ok: boolean; detail?: string }>;
  resolutionError?: never;
}

/** A configured recipe is visible even when its exact identity cannot be established. */
export interface DkbUnresolvedCompilerTargetCapability {
  name: string;
  available: false;
  providers: [];
  processors: [];
  chains: null;
  buildDigest: null;
  evidenceProfileDigest: null;
  retrievalProfileDigest: null;
  compatibility: null;
  compatibilityDigest: null;
  requiredServices: [];
  serviceRequirements: [];
  health: DkbResolvedCompilerTargetCapability['health'];
  resolutionError: { code: 'pipeline_resolution_failed'; message: string };
}

export type DkbCompilerTargetCapability = DkbResolvedCompilerTargetCapability | DkbUnresolvedCompilerTargetCapability;

export interface DkbCompilerCapabilities {
  format: typeof DKB_COMPILER_CAPABILITIES_FORMAT;
  service: 'dkb.registry.compiler';
  version: string;
  compiler: DkbInstalledCompilerIdentity;
  activeTarget: string;
  defaultTarget: string;
  allowedTargets: DkbCompilerTargetCapability[];
}
