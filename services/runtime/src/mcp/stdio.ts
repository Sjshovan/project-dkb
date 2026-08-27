import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { defaultRuntimeStateRoot } from '../runtime/state.js';
import { createDkbReadOnlyMcpServer } from './readOnly.js';

export function serveDkbMcpStdio(options: { libraryPath?: string; publicBaseUrl?: string } = {}): void {
  const libraryPath = options.libraryPath ?? process.env.DKB_LIBRARY_PATH ?? defaultRuntimeStateRoot();
  const publicBaseUrl = options.publicBaseUrl ?? process.env.DKB_MCP_PUBLIC_BASE_URL;

  serveStdio(() => createDkbReadOnlyMcpServer({ libraryPath, publicBaseUrl }), {
    onerror: (error) => console.error(error.message),
  });
}
