#!/usr/bin/env node
import { serveDkbRuntime } from './runtime/server.js';

const runtime = await serveDkbRuntime();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    runtime.close(() => process.exit(0));
  });
}
