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
