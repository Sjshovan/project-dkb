#!/usr/bin/env node
import { serveDkbRegistryCompiler } from './server.js';

const host = process.env.DKB_COMPILER_HOST ?? '0.0.0.0';
const port = positivePort(process.env.DKB_COMPILER_PORT, 7341);
const server = await serveDkbRegistryCompiler({ host, port });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}

function positivePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}
