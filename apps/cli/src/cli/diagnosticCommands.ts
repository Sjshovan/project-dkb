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
    .description('Verify the active immutable Evidence and Retrieval Build graph')
    .argument('<path>', 'Directory containing a Library, Collection, or DKB manifest')
    .action(async (target: string) => {
      const { verifyKnowledgeBuilds } = await import('@sjshovan/dkb-library/builds.js');
      const output = await presenter().check(
        'Knowledge Build verification',
        async () => verifyKnowledgeBuilds(target),
        (value) => value.ok,
      );

      if (!output.ok) {
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
    .description('Check manifest, source, artifact, verification, and space identity health')
    .argument('[path]', 'Directory containing a Library or DKB manifest', process.env.DKB_LIBRARY_PATH || '.')
    .action(async (target: string) => {
      const { healthReport } = await import('../lifecycle/health.js');
      const result = await healthReport(target);

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
    .description('Search the selected Runtime activation')
    .argument('<query>', 'Search query')
    .option('-l, --limit <number>', 'Maximum result count', parseLimit)
    .option('--runtime <name>', 'Registered Runtime; defaults to the selected Runtime')
    .action(async (query: string, options: { limit?: number; runtime?: string }) => {
      const target = await diagnosticRuntime(options.runtime);
      const runtime = await defaultRuntimeContext();
      const response = target.stateRoot
        ? await import('@sjshovan/dkb-runtime/runtime/queryAccess.js').then(({ searchRuntime }) => searchRuntime({
          stateRoot: target.stateRoot,
          runtime,
          query,
          limit: options.limit,
          channel: 'cli',
        }))
        : await target.client.search({ query, limit: options.limit });
      presenter().print(response, summarizeQueryResult);
    });

  program
    .command('read-targets')
    .description('Describe queryable DKB Read API targets from the selected Runtime activation')
    .argument('<query>', 'Natural-language lookup intent for ranking chunk targets')
    .option('-l, --limit <number>', 'Maximum target count', parseLimit, 10)
    .option('--runtime <name>', 'Registered Runtime; defaults to the selected Runtime')
    .action(async (query: string, options: { limit: number; runtime?: string }) => {
      const target = await diagnosticRuntime(options.runtime);
      const runtime = await defaultRuntimeContext();
      printJson(target.stateRoot
        ? await import('@sjshovan/dkb-runtime/runtime/queryAccess.js').then(({ describeRuntimeTargets }) => describeRuntimeTargets({
          stateRoot: target.stateRoot,
          runtime,
          query,
          limit: options.limit,
          channel: 'cli',
        }))
        : await target.client.readTargets({ query, limit: options.limit }));
    });

  program
    .command('read')
    .description('Execute a DKB Read API request against the selected Runtime activation')
    .argument('<request-path>', 'Path to a DKB Read API request JSON file')
    .option('--runtime <name>', 'Registered Runtime; defaults to the selected Runtime')
    .action(async (requestPath: string, options: { runtime?: string }) => {
      const fs = await import('node:fs/promises');
      const { validateDkbReadRequest } = await import('@sjshovan/dkb-protocol/validation.js');
      const request = validateDkbReadRequest(JSON.parse(await fs.readFile(requestPath, 'utf8')), 'DKB read request');
      const target = await diagnosticRuntime(options.runtime);
      const runtime = await defaultRuntimeContext();
      printJson(target.stateRoot
        ? await import('@sjshovan/dkb-runtime/runtime/queryAccess.js').then(({ readRuntime }) => readRuntime({
          stateRoot: target.stateRoot,
          runtime,
          request,
          channel: 'cli',
        }))
        : await target.client.read(request));
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

async function diagnosticRuntime(name?: string): Promise<{
  stateRoot?: string;
  client: import('@sjshovan/dkb-runtime/runtime/client.js').DkbRuntimeClient;
}> {
  const [{ registeredHostRuntime, selectedHostRuntime }, { runtimeClientForUrl }] = await Promise.all([
    import('../host/inventory.js'),
    import('../host/runtimeClient.js'),
  ]);
  const selected = name ? await registeredHostRuntime(name) : await selectedHostRuntime();
  if (!selected) {
    const detail = name ? `Unknown host Runtime: ${name}.` : 'This host has no selected Runtime.';
    throw new (await import('@sjshovan/dkb-protocol/errors.js')).DkbError(`${detail} Run: dkb runtime list`);
  }
  return {
    ...(selected.runtime.stateRoot ? { stateRoot: selected.runtime.stateRoot } : {}),
    client: await runtimeClientForUrl(selected.runtime.url),
  };
}
