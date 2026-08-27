import { DkbError } from '@dkb/protocol/errors.js';

export function defaultLibraryPath(): string | null {
  return process.env.DKB_LIBRARY_PATH || process.env.DKB_RUNTIME_STATE_ROOT || null;
}

export function configuredLibraryPath(): string {
  const configured = defaultLibraryPath();

  if (configured) {
    return configured;
  }

  throw new DkbError('DKB_LIBRARY_PATH is required for agent-facing MCP ID tools');
}

export function requirePath(value: string | undefined, label: string): string {
  if (value && value.length > 0) {
    return value;
  }

  const configured = defaultLibraryPath();

  if (configured) {
    return configured;
  }

  throw new DkbError(`${label} is required unless DKB_LIBRARY_PATH is configured`);
}

export function debugMcp(event: string, payload: Record<string, unknown>): void {
  if (process.env.DKB_MCP_DEBUG !== '1') {
    return;
  }

  console.error(JSON.stringify({
    event,
    at: new Date().toISOString(),
    ...payload,
  }));
}
