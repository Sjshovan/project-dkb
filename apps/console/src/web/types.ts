export type ResourceKind = 'libraries' | 'runtimes' | 'registries' | 'stacks';

export interface ResourceCheck {
  name?: string;
  component?: string;
  ok?: boolean;
  status?: string | number;
  required?: boolean;
  message?: string;
}

export interface ResourceRow {
  name: string;
  selected?: boolean;
  default?: boolean;
  status?: string;
  displayName?: string;
  path?: string;
  url?: string;
  kind?: string;
  library?: string;
  registry?: string;
  runtime?: string;
  target?: string;
  stale?: boolean;
  packageCount?: number;
  libraryId?: string;
  activationGeneration?: number;
  compatibilityDigest?: string;
  stateRoot?: string;
  usedBy?: string[];
  message?: string;
  checks?: ResourceCheck[];
  authenticated?: boolean;
  credential?: {
    user?: string;
    team?: string;
    abilities?: string[];
    savedAt: string;
    expiresAt?: string | null;
  };
}

export interface RuntimeStatus {
  ok: boolean;
  version: string;
  runtimeId: string;
  target: string;
  stale: boolean;
  packageCount: number;
  dkbIds: string[];
  library: { id: string; generation: number; stateDigest: string };
  activation: null | {
    generation: number;
    compatibilityDigest: string;
    evidenceProfileDigest: string;
    retrievalProfileDigest: string;
    packages: Record<string, unknown>;
  };
  observerHealth?: {
    status: 'available' | 'unavailable';
    detail?: string;
    entries: Array<{
      id: string;
      version: string;
      source: 'local' | 'global' | 'bundled';
      integrityDigest: string;
      activationDigest: string;
      target: string;
      status: 'healthy' | 'degraded';
      successCount: number;
      failureCount: number;
      lastEventId: string;
      lastObservedAt: string;
      detail?: string;
    }>;
  };
}

export interface RuntimeDetail {
  inventory: ResourceRow;
  runtime: RuntimeStatus;
}

export interface PipelineTarget {
  name: string;
  active: boolean;
  origin: 'runtime' | 'library' | 'global' | 'bundled';
  providers: string[];
  dimensions: number | null;
  metric: string | null;
  requiredServices: string[];
  health: 'ready' | 'unavailable';
  healthDetails: Array<{ id: string; kind: string; ok: boolean; detail?: string }>;
  coverage: { ready: number; total: number };
  evidenceProfileDigest: string | null;
  retrievalProfileDigest: string | null;
  compatibilityDigest: string | null;
}

export interface PipelineListing {
  root: string;
  activeTarget: string;
  targets: PipelineTarget[];
}

export interface RegistryPipelineProvider {
  id: string;
  version: string;
  kind: string;
  integrityDigest: string;
  integrity: import('@sjshovan/dkb-protocol/compilerCapabilities.js').DkbCapabilityIntegrityReceipt;
  source: 'local' | 'global' | 'bundled';
  sourceDigest: string;
}

export interface ResolvedRegistryPipeline {
  name: string;
  default: boolean;
  available: boolean;
  providers: RegistryPipelineProvider[];
  processors: Array<{ id: string; version: string; stage: string; order: number; integrityDigest: string; integrity: import('@sjshovan/dkb-protocol/compilerCapabilities.js').DkbCapabilityIntegrityReceipt }>;
  buildDigest: string;
  evidenceProfileDigest: string;
  retrievalProfileDigest: string;
  compatibilityDigest: string;
  requiredServices: string[];
  health: import('@sjshovan/dkb-protocol/compilerCapabilities.js').DkbCompilerTargetCapability['health'];
  compilerBuildDigest: string;
  chains: import('@sjshovan/dkb-protocol/compilerCapabilities.js').DkbCompilerTargetCapability['chains'];
  serviceRequirements: import('@sjshovan/dkb-protocol/compilerCapabilities.js').DkbCapabilityServiceRequirement[];
  resolutionError?: never;
}

export type RegistryPipeline = ResolvedRegistryPipeline | (Omit<import('@sjshovan/dkb-protocol/compilerCapabilities.js').DkbUnresolvedCompilerTargetCapability, 'compatibility'> & { default: boolean; compilerBuildDigest: string });

export interface RegistryPipelineCatalog {
  default: string;
  compiler: import('@sjshovan/dkb-protocol/compilerCapabilities.js').DkbInstalledCompilerIdentity;
  pipelines: RegistryPipeline[];
}

interface RuntimeAuditEventBase {
  type: 'dkb.query_audit.v2';
  id: number;
  eventId: string;
  recordedAt: string;
  channel: 'cli' | 'runtime-http' | 'mcp';
  client: { id?: string; sessionId?: string; address?: string; userAgent?: string };
  packages: Array<{ id: string; version: string; evidenceDigest: string; retrievalBuildDigest: string }>;
  requestId: string;
  query: string;
  intent: string;
  resultCount: number;
  status: string;
  outcome: 'success' | 'insufficient' | 'cancelled' | 'failed';
  candidates: Array<{ packageId: string; packageVersion: string; evidenceDigest: string; retrievalBuildDigest: string; evidenceId: string; score: number | null; channels: string[] }>;
  citations: Array<{ evidenceId: string; packageId: string; packageVersion: string; locator?: Record<string, unknown>; url?: string | null }>;
  timing: unknown;
  error?: { code?: string; message: string };
}

export type RuntimeAuditEvent = RuntimeAuditEventBase & ({
  admission: 'admitted';
  runtime: { id: string; activationDigest: string };
  library: { id: string; generation: number; stateDigest: string };
  pipeline: { target: string; evidenceProfileDigest: string; retrievalProfileDigest: string; compatibilityDigest: string };
} | {
  admission: 'rejected_before_admission';
  runtime: { id: string | null; activationDigest: null };
  library: null;
  pipeline: null;
});

export interface RuntimeAuditListing { events: RuntimeAuditEvent[]; limit: number }

export interface ResourceListing {
  selected?: string;
  default?: string;
  checked?: boolean;
  libraries?: ResourceRow[];
  runtimes?: ResourceRow[];
  registries?: ResourceRow[];
  stacks?: ResourceRow[];
}

export interface ActivityRecord {
  id: string;
  commandId: string;
  resourceKey: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  summary?: string;
}

export interface ActivityPage {
  activities: ActivityRecord[];
  pagination: {
    page: number;
    perPage: number;
    total: number;
    totalPages: number;
    retainedLimit: number;
  };
}
