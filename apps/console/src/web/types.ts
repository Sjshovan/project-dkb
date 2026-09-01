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
  dimensions: number;
  metric: string;
  requiredServices: string[];
  health: 'ready' | 'unavailable';
  healthDetails: Array<{ id: string; kind: string; ok: boolean; detail?: string }>;
  coverage: { ready: number; total: number };
  compatibilityDigest: string;
}

export interface PipelineListing {
  root: string;
  activeTarget: string;
  targets: PipelineTarget[];
}

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
