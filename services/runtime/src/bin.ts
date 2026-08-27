#!/usr/bin/env node
import { serveDkbMcpHttp } from './mcp/http.js';
import { serveDkbRuntime } from './runtime/server.js';

const runtime = await serveDkbRuntime();
const mcp = process.env.DKB_MCP_HTTP_ENABLED === 'true'
  ? await serveDkbMcpHttp({ libraryPath: process.env.DKB_RUNTIME_STATE_ROOT })
  : null;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    let pending = mcp ? 2 : 1;
    const closed = () => {
      pending -= 1;
      if (pending === 0) process.exit(0);
    };

    runtime.close(closed);
    mcp?.close(closed);
  });
}
