import type { DkbDistributionService } from '@sjshovan/dkb-pipeline/host.js';

export type DkbStackTarget = string;

export interface DkbStackControlContext {
  name: string;
  projectName: string;
  root: string;
  composeFile: string;
  envFile: string;
  allProfiles: string[];
  dockerContext?: string;
}

export interface DkbStackServiceContext extends DkbStackControlContext {
  target: DkbStackTarget;
  runtimeTarget: DkbStackTarget;
  compilerTargets: string[];
  recipeDigest: string;
  registryUrl: string;
  runtimeUrl: string;
  registryPort: number;
  runtimePort: number;
  requiredServices: DkbDistributionService[];
  profiles: string[];
  inactiveComposeServices: string[];
  servicePorts: Record<string, number>;
  version?: string;
}

/** Native contexts remain limited to explicit host-state recovery tooling. */
export interface DkbStackContext extends DkbStackServiceContext {
  libraryRoot: string;
  runtimeStateRoot: string;
}

export interface DkbStackStatus {
  name: string;
  target: DkbStackTarget;
  runtimeTarget: DkbStackTarget;
  stateRoot: string;
  composeFile: string;
  registryUrl: string;
  runtimeUrl: string;
  version?: string;
  services: Array<{ name: string; status: string; health: string }>;
  checks?: Array<{ component: string; status: 'ok' | 'failed'; message: string }>;
}

export interface DkbStackListing {
  checked: boolean;
  default?: string;
  stacks: Array<{
    name: string;
    default: boolean;
    stateRoot: string;
    library?: string;
    registry?: string;
    runtime?: string;
    target?: string;
    status: 'known' | 'online' | 'offline' | 'missing' | 'invalid';
    message?: string;
  }>;
}

export interface DkbStackBackup {
  status: 'backed_up';
  name: string;
  archive: string;
  checksumFile: string;
  sha256: string;
  bytes: number;
  containsSecrets: true;
}

export interface DkbStackRestore {
  status: 'restored';
  name: string;
  archive: string;
  stateRoot: string;
  sha256: string;
  replaced: boolean;
}

export interface DkbStackUpgrade {
  status: 'upgraded';
  name: string;
  fromVersion: string;
  toVersion: string;
  lockFile: string;
  backup: DkbStackBackup;
  services: DkbStackStatus['services'];
}
