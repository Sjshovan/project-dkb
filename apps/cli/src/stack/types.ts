import type { DkbDistributionService } from '@sjshovan/dkb-pipeline/host.js';

export type DkbStackTarget = string;

export interface DkbStackContext {
  name: string;
  projectName: string;
  target: DkbStackTarget;
  root: string;
  composeFile: string;
  envFile: string;
  registryUrl: string;
  runtimeUrl: string;
  registryPort: number;
  runtimePort: number;
  requiredServices: DkbDistributionService[];
  profiles: string[];
  allProfiles: string[];
  servicePorts: Record<string, number>;
  version?: string;
}

export interface DkbStackStatus {
  name: string;
  target: DkbStackTarget;
  stateRoot: string;
  composeFile: string;
  registryUrl: string;
  runtimeUrl: string;
  version?: string;
  services: Array<{ name: string; status: string; health: string }>;
  checks?: Array<{ component: string; status: 'ok' | 'failed'; message: string }>;
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
