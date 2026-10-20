import type { PrepareDkbAppend } from '@sjshovan/dkb-library/append.js';
import { createDkbLocalMcpServer } from './local.js';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { defaultRuntimeStateRoot } from '../runtime/state.js';
import { createDkbReadOnlyMcpServer } from './readOnly.js';
import { DEFAULT_DKB_RUNTIME_CONTEXT } from '../defaultComposition.js';
import type { DkbRuntimeContext } from '../runtime/context.js';

export function serveDkbMcpStdio(options: { runtime?: DkbRuntimeContext; stateRoot?: string; publicBaseUrl?: string; prepareAppend?: PrepareDkbAppend } = {}): void {
  const stateRoot = options.stateRoot ?? process.env.DKB_RUNTIME_STATE_ROOT ?? defaultRuntimeStateRoot();
  const publicBaseUrl = options.publicBaseUrl ?? process.env.DKB_MCP_PUBLIC_BASE_URL;

  const serverOptions = { runtime: options.runtime ?? DEFAULT_DKB_RUNTIME_CONTEXT, stateRoot, publicBaseUrl };
  serveStdio(() => options.prepareAppend
    ? createDkbLocalMcpServer({ ...serverOptions, prepareAppend: options.prepareAppend })
    : createDkbReadOnlyMcpServer(serverOptions), {
    onerror: (error) => console.error(error.message),
  });
}
