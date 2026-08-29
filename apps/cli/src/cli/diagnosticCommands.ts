import type { Command } from 'commander';
import type { DkbRuntimeContext } from '@sjshovan/dkb-runtime/runtime/context.js';
import type { CliPresenter } from './presentation.js';
import { summarizeQueryResult } from './summaries.js';

export interface DiagnosticCommandContext {
  presenter(): CliPresenter;
  printJson(value: unknown): void;
  parseLimit(value: string): number;
  parsePositiveInteger(value: string): number;
  defaultRuntimeContext(): Promise<DkbRuntimeContext>;
}

export function registerDiagnosticCommands(program: Command, context: DiagnosticCommandContext): void {
  const { presenter, printJson, parseLimit, parsePositiveInteger, defaultRuntimeContext } = context;
  program
    .command('verify')
    .description('Verify a compiled Library, Collection, or DKB against its artifact lock')
    .argument('<path>', 'Directory containing DKB packages and dkb-lock.json')
    .option('--strict', 'Require all generated artifacts to be built')
    .action(async (target: string, options: { strict?: boolean }) => {
      const { verifyComposeProject } = await import('@sjshovan/dkb-compiler/compile.js');
      const output = await presenter().check('Compiled knowledge verification', async () => {
        const result = await verifyComposeProject(target);
        const strictFailures = options.strict
          ? Object.entries(result.checks)
            .filter(([, check]) => !check.ok)
            .map(([name]) => name)
          : [];

        return {
          ...result,
          strict: Boolean(options.strict),
          strictFailures,
        };
      }, (value) => value.ok && value.strictFailures.length === 0);

      if (!output.ok || output.strictFailures.length > 0) {
        process.exitCode = 1;
      }
    });

  program
    .command('inspect')
    .description('Inspect a DKB package or Library before use')
    .argument('<path>', 'Directory containing a DKB manifest')
    .action(async (target: string) => {
      const { inspectTarget } = await import('../inspect/index.js');

      printJson(await inspectTarget(target));
    });

  program
    .command('health')
    .description('Check manifest, source, artifact, verification, queue, and space identity health')
    .argument('[path]', 'Directory containing a Library or DKB manifest', process.env.DKB_LIBRARY_PATH || '.')
    .option('--queue-root <path>', 'Write queue root to inspect', process.env.DKB_QUEUE_ROOT || process.env.DKB_WRITE_QUEUE_ROOT)
    .action(async (target: string, options: { queueRoot?: string }) => {
      const { healthReport } = await import('../lifecycle/health.js');
      const result = await healthReport(target, options.queueRoot);

      printJson(result);

      if (result.status !== 'ready') {
        process.exitCode = 1;
      }
    });

  program
    .command('restore')
    .description('Rebuild generated retrieval artifacts from source knowledge without mutating it')
    .argument('[path]', 'Directory containing a Library or DKB manifest', process.env.DKB_LIBRARY_PATH || '.')
    .action(async (target: string) => {
      const { restoreIndexes } = await import('../lifecycle/health.js');

      await presenter().run('Restoring generated indexes', async () => restoreIndexes(target));
    });

  program
    .command('query')
    .description('Run deterministic search against a DKB package or Library')
    .argument('<library-path>', 'Directory containing a Library, Collection, or DKB manifest')
    .argument('<query>', 'Search query')
    .option('-l, --limit <number>', 'Maximum result count', parseLimit)
    .action(async (target: string, query: string, options: { limit?: number }) => {
      const { queryKnowledgeTarget } = await import('../knowledge/target.js');

      presenter().print((await queryKnowledgeTarget(target, query, { limit: options.limit, runtime: await defaultRuntimeContext() })).response, summarizeQueryResult);
    });

  program
    .command('read-targets')
    .description('Describe queryable DKB Read API targets from compiled Library artifacts')
    .argument('<library-path>', 'Directory containing compiled Library, Collection, or DKB artifacts')
    .argument('<query>', 'Natural-language lookup intent for ranking chunk targets')
    .option('-l, --limit <number>', 'Maximum target count', parseLimit, 10)
    .action(async (target: string, query: string, options: { limit: number }) => {
      const { describeQueryTargets } = await import('@sjshovan/dkb-runtime/read/runtime.js');

      printJson(await describeQueryTargets(target, query, options.limit, undefined, await defaultRuntimeContext()));
    });

  program
    .command('read')
    .description('Execute a DKB Read API request JSON file against compiled Library artifacts')
    .argument('<library-path>', 'Directory containing compiled Library, Collection, or DKB artifacts')
    .argument('<request-path>', 'Path to a DKB Read API request JSON file')
    .action(async (target: string, requestPath: string) => {
      const fs = await import('node:fs/promises');
      const { readDkb } = await import('@sjshovan/dkb-runtime/read/runtime.js');

      printJson(await readDkb(target, JSON.parse(await fs.readFile(requestPath, 'utf8')), undefined, await defaultRuntimeContext()));
    });

  program
    .command('watch')
    .description('Watch a DKB Library and rebuild indexes on source changes')
    .argument('<library-path>', 'Directory containing a Library manifest')
    .option('--once', 'Close the watcher after the first rebuild event')
    .action(async (target: string, options: { once?: boolean }) => {
      const { watchComposeProject } = await import('../watch/index.js');

      await watchComposeProject(target, {
        once: options.once,
        onEvent: (event) => console.log(JSON.stringify(event)),
      });
    });

  program
    .command('audit-alignment')
    .description('Audit whether DKB retrieval artifacts are protocol aligned')
    .argument('<path>', 'Directory containing a Library, Collection, or DKB manifest')
    .option('--strict', 'Exit with code 1 when any chunk artifact is ignored')
    .action(async (target: string, options: { strict?: boolean }) => {
      const { auditKnowledgeAlignment } = await import('../knowledge/alignment.js');
      const audit = await auditKnowledgeAlignment(target);

      printJson(audit);

      if (options.strict && audit.status !== 'aligned') {
        process.exitCode = 1;
      }
    });

  const trace = program
    .command('trace')
    .description('Inspect out-of-band DKB retrieval traces');

  trace
    .command('latest')
    .description('Show the latest retrieval trace')
    .option('--root <path>', 'Runtime Library root', process.env.DKB_RUNTIME_STATE_ROOT || process.env.DKB_LIBRARY_PATH || '.')
    .action(async (options: { root: string }) => {
      const { latestTrace } = await import('@sjshovan/dkb-runtime/runtime/trace.js');

      printJson(await latestTrace(options.root));
    });

  trace
    .command('list')
    .description('List recent retrieval traces')
    .option('--root <path>', 'Runtime Library root', process.env.DKB_RUNTIME_STATE_ROOT || process.env.DKB_LIBRARY_PATH || '.')
    .option('--limit <number>', 'Maximum trace summaries to return', parseLimit, 20)
    .action(async (options: { root: string; limit: number }) => {
      const { listTraces } = await import('@sjshovan/dkb-runtime/runtime/trace.js');

      printJson(await listTraces(options.root, options.limit));
    });

  trace
    .command('get')
    .description('Show one retrieval trace by id')
    .argument('<trace-id>', 'Trace id from trace list/latest')
    .option('--root <path>', 'Runtime Library root', process.env.DKB_RUNTIME_STATE_ROOT || process.env.DKB_LIBRARY_PATH || '.')
    .action(async (traceId: string, options: { root: string }) => {
      const { getTrace } = await import('@sjshovan/dkb-runtime/runtime/trace.js');

      printJson(await getTrace(options.root, traceId));
    });

  const mcp = program
    .command('mcp')
    .description('Serve DKB collections through Model Context Protocol');

  mcp
    .command('serve')
    .description('Start the read-only DKB Runtime MCP server over stdio')
    .action(async () => {
      const { serveDkbMcpStdio } = await import('@sjshovan/dkb-runtime/mcp/stdio.js');

      serveDkbMcpStdio();
    });

  mcp
    .command('serve-http')
    .description('Start the authenticated, read-only DKB MCP server over Streamable HTTP')
    .option('--host <host>', 'Host to bind', process.env.DKB_MCP_HTTP_HOST || '127.0.0.1')
    .option('--port <number>', 'Port to bind', parsePositiveInteger, Number.parseInt(process.env.DKB_MCP_HTTP_PORT || '7332', 10))
    .option('--path <path>', 'MCP endpoint path', process.env.DKB_MCP_HTTP_PATH || '/mcp')
    .action(async (options: { host: string; port: number; path: string }) => {
      const { serveDkbMcpHttp } = await import('@sjshovan/dkb-runtime/mcp/http.js');

      await serveDkbMcpHttp(options);
    });
}
