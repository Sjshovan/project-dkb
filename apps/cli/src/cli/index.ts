#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { Command, CommanderError } from 'commander';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { DKB_PROTOCOL_VERSION } from '@sjshovan/dkb-protocol/version.js';
import { DKB_PROTOCOL_COMPATIBILITY } from '@sjshovan/dkb-protocol/version.js';
import { DKB_CLI_VERSION } from '../version.js';
import {
  createCliPresenter,
  failureLine,
  printJson as printJsonValue,
  terminalText,
  type CliPresenter,
} from './presentation.js';
import { registerArtifactCommands } from './artifactCommands.js';
import { registerCoreCommands } from './coreCommands.js';
import { configureDkbHelp } from './help.js';
import { registerDiagnosticCommands } from './diagnosticCommands.js';
import { registerKnowledgeCommands } from './knowledgeCommands.js';
import { registerLibraryCommands } from './libraryCommands.js';
import { registerPipelineCommands } from './pipelineCommands.js';
import { registerRegistryCommands } from './registryCommands.js';
import { registerRuntimeCommands } from './runtimeCommands.js';

installWarningFilter();

const program = new Command();
const jsonRequested = process.argv.includes('--json');

program
  .name('dkb')
  .description('Package, verify, install, and serve durable knowledgebases')
  .version(DKB_CLI_VERSION, '-V, --version')
  .enablePositionalOptions()
  .option('--json', 'Emit one machine-readable JSON document')
  .option('--no-progress', 'Keep human output but disable spinners and progress bars')
  .showSuggestionAfterError(true)
  .showHelpAfterError("Run 'dkb --help' for usage.")
  .configureOutput({
    writeErr: (message) => {
      if (!jsonRequested) {
        process.stderr.write(message);
      }
    },
  })
  .addHelpText('after', `
Examples:
  dkb init
  dkb init @my-team/my-knowledge
  dkb install @my-team/my-knowledge --version 1.0.0
  dkb retrieve "What does this knowledgebase say?"
  dkb --json registry packages

Run 'dkb <command> --help' for command-specific usage.`);

program
  .command('version')
  .description('Show independently versioned DKB components and compatibility')
  .action(async () => {
    const [{ DKB_COMPILER_VERSION }, { DKB_RUNTIME_VERSION }, { DEFAULT_DKB_DISTRIBUTION }] = await Promise.all([
      import('@sjshovan/dkb-compiler/version.js'),
      import('@sjshovan/dkb-runtime/version.js'),
      import('@sjshovan/dkb-distribution-default'),
    ]);
    const result = {
      cli: DKB_CLI_VERSION,
      protocol: DKB_PROTOCOL_VERSION,
      runtime: DKB_RUNTIME_VERSION,
      compiler: DKB_COMPILER_VERSION,
      distribution: `${DEFAULT_DKB_DISTRIBUTION.id}@${DEFAULT_DKB_DISTRIBUTION.version}`,
      providers: DEFAULT_DKB_DISTRIBUTION.plugins.map((plugin) => `${plugin.id}@${plugin.version}`),
      buildCommit: process.env.DKB_BUILD_COMMIT ?? 'development',
      compatibility: DKB_PROTOCOL_COMPATIBILITY,
    };

    presenter().print(result, (value) => {
      const versions = value as typeof result;
      return [
        `CLI: ${versions.cli}`,
        `protocol: ${versions.protocol} (${versions.compatibility})`,
        `Runtime: ${versions.runtime}`,
        `compiler: ${versions.compiler}`,
        `distribution: ${versions.distribution}`,
        `providers: ${versions.providers.join(', ')}`,
        `build: ${versions.buildCommit}`,
      ];
    });
  });

registerCoreCommands(program, {
  presenter,
  parsePositiveInteger,
  runtimeCatalogUrl,
});

registerLibraryCommands(program, {
  presenter,
  currentLibraryRoot,
  defaultRuntimeContext,
  parsePositiveInteger,
});
const runtime = registerRuntimeCommands(program, {
  presenter,
  printJson,
  currentRuntimeUrl,
  parsePositiveInteger,
  parseRuntimeKind,
  parseStackTarget,
  runtimeCatalogUrl,
  runDockerCompose,
  jsonRequested,
});
registerRegistryCommands(program, {
  presenter,
  currentLibraryRoot,
  parsePositiveInteger,
});
registerKnowledgeCommands(program, runtime, {
  presenter,
  printJson,
  currentLibraryRoot,
  currentRuntimeUrl,
  currentRuntimeAdminClient,
  defaultRuntimeContext,
  parsePositiveInteger,
  parseLimit,
});

registerArtifactCommands(program, {
  presenter,
  printJson,
  currentLibraryRoot,
  defaultRuntimeContext,
});

registerPipelineCommands(program, {
  presenter,
  currentRuntimeAdminClient,
  defaultDistribution,
});

registerDiagnosticCommands(program, {
  presenter,
  printJson,
  parseLimit,
  parsePositiveInteger,
  defaultRuntimeContext,
});

configureCommandTree(program);

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError && (error.code === 'commander.helpDisplayed' || error.code === 'commander.version')) {
    process.exitCode = error.exitCode;
  } else if (error instanceof CommanderError) {
    if (jsonRequested) {
      printJsonValue({
        ok: false,
        error: {
          code: error.code,
          message: error.message.replace(/^error:\s*/i, ''),
        },
      });
    }
    process.exitCode = error.exitCode || 1;
  } else {
    const message = error instanceof DkbError || error instanceof Error ? error.message : String(error);

    if (jsonRequested) {
      printJsonValue({ ok: false, error: { code: error instanceof DkbError ? error.code : 'DKB_ERROR', message } });
    } else {
      console.error(`${failureLine('Error:')} ${message}`);
    }
    process.exitCode = 1;
  }
}

function presenter(): CliPresenter {
  const options = program.opts<{ json?: boolean; progress?: boolean }>();

  return createCliPresenter({
    json: Boolean(options.json),
    progress: options.progress,
  });
}

async function currentLibraryRoot(explicit?: string, cwd = process.cwd()): Promise<string> {
  const { resolveCliLibraryRoot } = await import('./context.js');

  return resolveCliLibraryRoot({ explicit, cwd });
}

async function currentRuntimeUrl(explicit?: string): Promise<string> {
  const { resolveCliRuntimeUrl } = await import('./context.js');

  return resolveCliRuntimeUrl(explicit);
}

async function currentRuntimeAdminClient(explicit?: string, timeoutMs?: number) {
  const [{ DkbRuntimeClient }, { runtimeAdminTokenForUrl }] = await Promise.all([
    import('@sjshovan/dkb-runtime/runtime/client.js'),
    import('../stack/manager.js'),
  ]);
  const baseUrl = await currentRuntimeUrl(explicit);

  return new DkbRuntimeClient({
    baseUrl,
    adminToken: await runtimeAdminTokenForUrl(baseUrl),
    ...(timeoutMs ? { timeoutMs } : {}),
  });
}

function parseRuntimeKind(value: string): 'process' | 'docker' | 'remote' {
  if (value === 'process' || value === 'docker' || value === 'remote') {
    return value;
  }

  throw new DkbError('Runtime kind must be process, docker, or remote.');
}

function parseStackTarget(value: string): import('../stack/manager.js').DkbStackTarget {
  if (['default', 'meilisearch', 'fastembed-faiss', 'tei-faiss', 'tei-faiss-768', 'tei-meilisearch'].includes(value)) {
    return value as import('../stack/manager.js').DkbStackTarget;
  }
  throw new DkbError('Stack target must be default, fastembed-faiss, tei-faiss, tei-faiss-768, or tei-meilisearch.');
}

function runtimeCatalogUrl(host: string, port: number): string {
  const catalogHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;

  return `http://${catalogHost}:${port}`;
}

function printJson(value: unknown): void {
  presenter().print(value);
}

function installWarningFilter(): void {
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    if (warning.name === 'ExperimentalWarning' && /SQLite is an experimental feature/i.test(warning.message)) {
      return;
    }

    console.error(warning.stack ?? `${warning.name}: ${warning.message}`);
  });
}

function configureCommandTree(command: Command): void {
  const usagePath = commandPath(command);

  configureDkbHelp(command);

  command
    .exitOverride()
    .showSuggestionAfterError(true)
    .showHelpAfterError(`\nRun '${usagePath} --help' for usage.`)
    .configureOutput({
      writeErr: (message) => {
        if (!jsonRequested) {
          process.stderr.write(message.replace(/^error:/m, terminalText(['bold', 'red'], 'dkb:', process.stderr)));
        }
      },
    });

  for (const child of command.commands) {
    configureCommandTree(child);
  }
}

function commandPath(command: Command): string {
  const names: string[] = [];
  let current: Command | null = command;

  while (current) {
    names.unshift(current.name());
    current = current.parent;
  }

  return names.join(' ');
}


function parseLimit(value: string): number {
  const limit = Number.parseInt(value, 10);

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new DkbError('Limit must be an integer between 1 and 100');
  }

  return limit;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new DkbError('Value must be a positive integer');
  }

  return parsed;
}

function runDockerCompose(composeFile: string, args: string[]): void {
  const humanOutput = presenter().interactive;
  const result = spawnSync('docker', ['compose', '-f', composeFile, ...args], {
    stdio: humanOutput ? 'inherit' : 'pipe',
    encoding: 'utf8',
  });

  if (result.error) {
    throw new DkbError(`Unable to run docker compose: ${result.error.message}`);
  }

  if (result.status && result.status !== 0) {
    const detail = !humanOutput && typeof result.stderr === 'string' ? result.stderr.trim() : '';
    throw new DkbError(`docker compose exited with code ${result.status}${detail ? `: ${detail}` : ''}`);
  }
}

async function defaultRuntimeContext() {
  return import('@sjshovan/dkb-runtime/defaultComposition.js')
    .then((module) => module.DEFAULT_DKB_RUNTIME_CONTEXT);
}

async function defaultDistribution() {
  return import('@sjshovan/dkb-distribution-default')
    .then((module) => module.DEFAULT_DKB_DISTRIBUTION);
}
