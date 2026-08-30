#!/usr/bin/env node
import { startDkbConsoleServer } from './server.js';

const bootstrapSecret = process.env.DKB_CONSOLE_BOOTSTRAP_SECRET;
const cliEntrypoint = process.env.DKB_CONSOLE_CLI_ENTRYPOINT;
if (!bootstrapSecret || !cliEntrypoint) throw new Error('DKB Console must be launched through dkb console.');

const server = await startDkbConsoleServer({ bootstrapSecret, cliEntrypoint });
process.once('SIGINT', () => void server.close());
process.once('SIGTERM', () => void server.close());
