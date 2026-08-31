import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { defaultRuntimeStateRoot } from '../runtime/state.js';
import { createDkbReadOnlyMcpServer } from './readOnly.js';
import { DEFAULT_DKB_RUNTIME_CONTEXT } from '../defaultComposition.js';
import type { DkbRuntimeContext } from '../runtime/context.js';

export function serveDkbMcpStdio(options: { runtime?: DkbRuntimeContext; stateRoot?: string; publicBaseUrl?: string } = {}): void {
  const stateRoot = options.stateRoot ?? process.env.DKB_RUNTIME_STATE_ROOT ?? defaultRuntimeStateRoot();
  const publicBaseUrl = options.publicBaseUrl ?? process.env.DKB_MCP_PUBLIC_BASE_URL;

  serveStdio(() => createDkbReadOnlyMcpServer({ runtime: options.runtime ?? DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot, publicBaseUrl }), {
    onerror: (error) => console.error(error.message),
  });
}
