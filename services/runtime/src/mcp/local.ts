import { z } from 'zod/v4';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { PrepareDkbAppend } from '@sjshovan/dkb-library/append.js';
import { appendRuntime } from '../runtime/append.js';
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
  server.registerTool('append', {
    title: 'Append a local DKB fact',
    description: 'Append exact text as a new source asset in an installed editable local DKB. Requires its manifest write permission and append policy, caller evidence references, and explicit user confirmation when required. Reuse requestId with identical input for retries. Does not modify existing facts or accept filesystem paths.',
    inputSchema: z.object({
      dkbId: z.string(),
      requestId: z.string(),
      text: z.string(),
      evidenceRefs: z.array(z.string()),
      confirmed: z.boolean().optional(),
    }).strict(),
    outputSchema: z.object({}).loose(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async request => {
    try {
      const result = await appendRuntime({ ...options, request, prepare: options.prepareAppend });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: result, ...(result.status !== 'appended' ? { isError: true } : {}) };
    } catch (error) {
      const uncertain = error instanceof DkbError && error.code === 'library_recovery_required';
      const result = { status: uncertain ? 'recovery_required' : 'blocked', committed: uncertain ? null : false,
        error: { code: error instanceof DkbError ? error.code : 'append_failed', message: error instanceof Error ? error.message : String(error) } };
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result, isError: true };
    }
  });
  return server;
}
