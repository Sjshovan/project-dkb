import type { DkbAccess, DkbManifest, DkbState, DkbWritePolicy } from './types.js';

export interface DkbCapabilities {
  access: DkbAccess;
  writePolicy: DkbWritePolicy;
  state: DkbState;
}

export function resolveDkbCapabilities(manifest: DkbManifest): DkbCapabilities {
  const operations = manifest.write?.operations ?? [];
  const writeAllowed = manifest.permissions?.write ?? operations.length > 0;
  const access: DkbAccess = {
    read: manifest.permissions?.read ?? true,
    write: writeAllowed && operations.some((operation) => operation === 'create' || operation === 'write' || operation === 'update' || operation === 'supersede'),
    append: writeAllowed && operations.includes('append'),
    delete: writeAllowed && operations.includes('delete'),
  };
  const mode = writeAllowed ? manifest.write?.mode ?? 'read_only' : 'read_only';

  return {
    access,
    writePolicy: {
      mode,
      queueRequired: mode !== 'direct',
      confirmationRequired: manifest.write?.confirmationRequired ?? false,
    },
    state: {
      availability: 'ready',
      indexFreshness: 'unknown',
      lastIndexedAt: null,
    },
  };
}
