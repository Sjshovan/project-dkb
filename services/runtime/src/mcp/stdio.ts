import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { defaultRuntimeStateRoot } from '../runtime/state.js';
import { createDkbReadOnlyMcpServer } from './readOnly.js';
import { DEFAULT_DKB_RUNTIME_CONTEXT } from '../defaultComposition.js';
import type { DkbRuntimeContext } from '../runtime/context.js';

export function serveDkbMcpStdio(options: { runtime?: DkbRuntimeContext; libraryPath?: string; publicBaseUrl?: string } = {}): void {
  const libraryPath = options.libraryPath ?? process.env.DKB_LIBRARY_PATH ?? defaultRuntimeStateRoot();
  const publicBaseUrl = options.publicBaseUrl ?? process.env.DKB_MCP_PUBLIC_BASE_URL;

  serveStdio(() => createDkbReadOnlyMcpServer({ runtime: options.runtime ?? DEFAULT_DKB_RUNTIME_CONTEXT, libraryPath, publicBaseUrl }), {
    onerror: (error) => console.error(error.message),
  });
}
