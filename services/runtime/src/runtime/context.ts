import type { DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';

export interface DkbRuntimeContext {
  distribution: DkbDistribution;
}

export function createDkbRuntimeContext(distribution: DkbDistribution): DkbRuntimeContext {
  return { distribution };
}
