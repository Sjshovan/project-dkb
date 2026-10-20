import { z } from 'zod/v4';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbAppendRequest, PrepareDkbAppend } from '@sjshovan/dkb-library/append.js';
import { appendRuntime, runtimeWriteTargets } from '../runtime/append.js';
import type { DkbRuntimeContext } from '../runtime/context.js';
import { createDkbReadOnlyMcpServer } from './readOnly.js';

/** Local stdio only. HTTP deliberately retains the read-only server factory. */
export function createDkbLocalMcpServer(options: {
  runtime: DkbRuntimeContext;
  stateRoot: string;
  publicBaseUrl?: string;
  prepareAppend: PrepareDkbAppend;
}) {
  const server = createDkbReadOnlyMcpServer({ ...options, serverName: 'dkb-runtime-local' });
  const fields = { dkbId: z.string(), requestId: z.string(), text: z.string(), evidenceRefs: z.array(z.string()), confirmed: z.boolean().optional() };
  const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const write = async (request: DkbAppendRequest) => {
    try {
      const result = await appendRuntime({ ...options, request, prepare: options.prepareAppend });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: result, ...(result.status !== 'appended' ? { isError: true } : {}) };
    } catch (error) { return blocked(error); }
  };
  server.registerTool('append', {
    title: 'Append local DKB text',
    description: 'Append exact text to an allowed existing .md/.txt source, preserving its bytes as a prefix. First use write_targets; provide path and expectedSourceHash together. Reuse identical requestId/input on retry. Without path, legacy manifests without write.paths create append-<requestId>.md. Requires manifest permission, evidence references and confirmation when configured.',
    inputSchema: z.object({ ...fields, path: z.string().optional(), expectedSourceHash: z.string().optional() }).strict(),
    outputSchema: z.object({}).loose(), annotations,
  }, request => write({ ...request, operation: 'append' }));
  server.registerTool('create', {
    title: 'Create a local DKB source',
    description: 'Create exact UTF-8 text in a new package-relative .md/.txt source permitted by write.paths.create. Never overwrites. Use write_targets for creation patterns even in an empty package. Reuse identical requestId/input on retry. Exclusions and reserved paths always win.',
    inputSchema: z.object({ ...fields, path: z.string() }).strict(),
    outputSchema: z.object({}).loose(), annotations,
  }, request => write({ ...request, operation: 'create' }));
  server.registerTool('write_targets', {
    title: 'Discover local DKB write destinations',
    description: 'List eligible existing append targets with source hashes and permitted creation patterns/formats, including empty packages. Optional dkbId restricts discovery. Use after from nextCursor to page existing targets. Discovery never grants permission; the server validates the selected operation again.',
    inputSchema: z.object({ dkbId: z.string().optional(), after: z.string().optional() }).strict(),
    outputSchema: z.object({}).loose(),
    annotations: { ...annotations, readOnlyHint: true },
  }, async request => {
    try {
      const result = await runtimeWriteTargets({ stateRoot: options.stateRoot, ...request });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) { return blocked(error); }
  });
  return server;
}
function blocked(error: unknown) {
  const uncertain = error instanceof DkbError && error.code === 'library_recovery_required';
  const result = { status: uncertain ? 'recovery_required' : 'blocked', committed: uncertain ? null : false,
    error: { code: error instanceof DkbError ? error.code : 'append_failed', message: error instanceof Error ? error.message : String(error) } };
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result, isError: true as const };
}
