import { DEFAULT_DKB_DISTRIBUTION } from '@sjshovan/dkb-distribution-default';
import { createDkbRuntimeContext } from './runtime/context.js';

export const DEFAULT_DKB_RUNTIME_CONTEXT = createDkbRuntimeContext(DEFAULT_DKB_DISTRIBUTION);
