#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { startDkbConsoleServer } from './server.js';

const cliEntrypoint = process.argv[2];
if (!cliEntrypoint) throw new Error('DKB Console background service requires the bundled CLI entrypoint.');

const server = await startDkbConsoleServer({
  bootstrapSecret: randomBytes(32).toString('base64url'),
  cliEntrypoint: path.resolve(cliEntrypoint),
});

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await server.close();
}

process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());

