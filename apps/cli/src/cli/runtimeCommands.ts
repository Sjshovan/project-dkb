import path from 'node:path';
import type { Command } from 'commander';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { CliPresenter } from './presentation.js';
import { formatBytes } from './presentation.js';
import type { DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import {
  summarizeHostMutation,
  summarizeHostRuntimes,
  summarizeStackListing,
  summarizeStackStatus,
} from './summaries.js';
import type { DkbStackTarget } from '../stack/manager.js';

export interface RuntimeCommandContext {
  presenter(): CliPresenter;
  printJson(value: unknown): void;
  currentRuntimeUrl(explicit?: string): Promise<string>;
  parsePositiveInteger(value: string): number;
  parseRuntimeKind(value: string): 'process' | 'docker' | 'remote';
  defaultDistribution(): Promise<DkbDistribution>;
  runtimeCatalogUrl(host: string, port: number): string;
  runDockerCompose(composeFile: string, args: string[]): void;
  jsonRequested: boolean;
}

export function registerRuntimeCommands(program: Command, context: RuntimeCommandContext): Command {
  const runtime = program
    .command('runtime')
    .description('Manage the container-first DKB Runtime');

  runtime
    .command('list')
    .description('List Runtime endpoints registered to this host')
    .option('--check', 'Probe each Runtime endpoint')
    .action(async (options: { check?: boolean }) => {
      const { inspectHostRuntimes } = await import('../host/inspection.js');
      context.presenter().print(await inspectHostRuntimes({ check: Boolean(options.check) }), summarizeHostRuntimes);
    });

  runtime
    .command('register')
    .description('Register a known Runtime endpoint with this host')
    .argument('<name>', 'Host-local Runtime name')
    .argument('<url>', 'Runtime API URL')
    .option('--library <library>', 'Associated registered Library name or path')
    .option('--kind <kind>', 'Runtime kind: process, docker, or remote', 'remote')
    .option('--state-root <path>', 'Local Runtime state root')
    .option('--compose-file <path>', 'Docker compose file for a Docker Runtime')
    .option('--no-verify', 'Register without probing the endpoint')
    .action(async (name: string, url: string, options: {
      library?: string;
      kind: string;
      stateRoot?: string;
      composeFile?: string;
      verify?: boolean;
    }) => {
      const { hostInventoryPath, registerHostLibrary, registerHostRuntime, registeredHostLibrary } = await import('../host/inventory.js');
      const kind = context.parseRuntimeKind(options.kind);
      let libraryName: string | undefined;
      if (options.library) {
        const known = await registeredHostLibrary(options.library);
        libraryName = known?.name ?? (await registerHostLibrary(options.library)).name;
      }

      await context.presenter().run('Registering Runtime', async () => {
        let warning: string | undefined;
        if (options.verify !== false) {
          const { DkbRuntimeClient } = await import('@sjshovan/dkb-runtime/runtime/client.js');
          try {
            await new DkbRuntimeClient({ baseUrl: url, timeoutMs: 5_000 }).status();
          } catch {
            warning = `Runtime ${url} was registered, but it could not be reached.`;
          }
        }
        const result = await registerHostRuntime(name, url, {
          kind,
          library: libraryName,
          stateRoot: options.stateRoot,
          composeFile: options.composeFile,
          select: 'if-empty',
        });
        return {
          status: 'registered',
          ...result,
          inventoryPath: hostInventoryPath(),
          ...(warning ? { warning, retryCommand: 'dkb runtime list --check' } : {}),
          ...(options.verify === false
            ? { warning: `Runtime ${result.runtime.url} was registered without verification.`, retryCommand: 'dkb runtime list --check' }
            : {}),
        };
      }, summarizeHostMutation);
    });

  runtime
    .command('unregister')
    .description('Forget a Runtime without stopping or deleting it')
    .argument('<name>', 'Registered Runtime name')
    .action(async (name: string) => {
      const { hostInventoryPath, unregisterHostRuntime } = await import('../host/inventory.js');
      await context.presenter().run('Unregistering Runtime', async () => ({
        status: 'unregistered',
        ...await unregisterHostRuntime(name),
        inventoryPath: hostInventoryPath(),
      }), summarizeHostMutation);
    });

  runtime
    .command('use')
    .description('Select the default Runtime endpoint')
    .argument('<name>', 'Registered Runtime name')
    .action(async (name: string) => {
      const { hostInventoryPath, selectHostRuntime } = await import('../host/inventory.js');
      await context.presenter().run('Selecting Runtime', async () => ({
        status: 'selected',
        ...await selectHostRuntime(name),
        inventoryPath: hostInventoryPath(),
      }), summarizeHostMutation);
    });

  runtime
    .command('serve')
    .description('Start the DKB Runtime HTTP API in the current process')
    .option('--host <host>', 'Host to bind', process.env.DKB_RUNTIME_HOST || '127.0.0.1')
    .option('--port <number>', 'Port to bind', context.parsePositiveInteger, Number.parseInt(process.env.DKB_RUNTIME_PORT || '7331', 10))
    .option('--state-root <path>', 'Runtime state root', process.env.DKB_RUNTIME_STATE_ROOT)
    .option('--name <name>', 'Host-local Runtime name', 'codename-dkb')
    .action(async (options: { host: string; port: number; stateRoot?: string; name: string }) => {
      const { serveDkbRuntime } = await import('@sjshovan/dkb-runtime/runtime/server.js');
      const { defaultRuntimeStateRoot } = await import('@sjshovan/dkb-runtime/runtime/state.js');
      const { registerHostLibrary, registerHostRuntime } = await import('../host/inventory.js');
      const stateRoot = path.resolve(options.stateRoot ?? defaultRuntimeStateRoot());

      const server = await serveDkbRuntime({ host: options.host, port: options.port, stateRoot });
      try {
        const hostLibrary = await registerHostLibrary(stateRoot);
        await registerHostRuntime(options.name, context.runtimeCatalogUrl(options.host, options.port), {
          kind: 'process',
          stateRoot,
          library: hostLibrary.name,
          select: 'if-empty',
        });
      } catch (error) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        throw error;
      }
    });

  runtime
    .command('start')
    .description('Start the local Docker-backed DKB Runtime')
    .option('-f, --file <path>', 'Docker compose file', process.env.DKB_RUNTIME_COMPOSE_FILE || 'docker-compose.yml')
    .option('--name <name>', 'Host-local Runtime name', 'codename-dkb')
    .option('--url <url>', 'Runtime API URL', 'http://127.0.0.1:7331')
    .action(async (options: { file: string; name: string; url: string }) => {
      context.runDockerCompose(options.file, ['up', '-d', 'dkb-runtime']);
      const { hostInventoryPath, registerHostRuntime } = await import('../host/inventory.js');
      const result = await registerHostRuntime(options.name, options.url, {
        kind: 'docker',
        composeFile: options.file,
        select: 'if-empty',
      });
      context.presenter().print({
        status: 'started',
        service: 'dkb-runtime',
        composeFile: path.resolve(options.file),
        ...result,
        inventoryPath: hostInventoryPath(),
      }, summarizeHostMutation);
    });

  runtime
    .command('stop')
    .description('Stop the local Docker-backed DKB Runtime')
    .option('-f, --file <path>', 'Docker compose file', process.env.DKB_RUNTIME_COMPOSE_FILE || 'docker-compose.yml')
    .action((options: { file: string }) => {
      context.runDockerCompose(options.file, ['stop', 'dkb-runtime']);
      context.printJson({ status: 'stopped', service: 'dkb-runtime', composeFile: path.resolve(options.file) });
    });

  runtime
    .command('status')
    .description('Show DKB Runtime status')
    .option('--url <url>', 'Runtime API URL; defaults to the selected Runtime')
    .action(async (options: { url?: string }) => {
      const { DkbRuntimeClient } = await import('@sjshovan/dkb-runtime/runtime/client.js');
      context.printJson(await new DkbRuntimeClient({ baseUrl: await context.currentRuntimeUrl(options.url) }).status());
    });

  runtime
    .command('library')
    .description('Show the single Library served by the DKB Runtime')
    .option('--url <url>', 'Runtime API URL; defaults to the selected Runtime')
    .action(async (options: { url?: string }) => {
      const { DkbRuntimeClient } = await import('@sjshovan/dkb-runtime/runtime/client.js');
      context.printJson(await new DkbRuntimeClient({ baseUrl: await context.currentRuntimeUrl(options.url) }).library());
    });

  registerStackCommands(program, context);

  return runtime;
}

function registerStackCommands(program: Command, context: RuntimeCommandContext): void {
  const stack = program
    .command('stack')
    .description('Operate a complete local DKB developer-preview stack');

  stack
    .command('list')
    .description('List local DKB stacks registered to this host')
    .option('--check', 'Probe the services for every known Stack')
    .action(async (options: { check?: boolean }) => {
      const { listDkbStacks } = await import('../stack/manager.js');
      context.presenter().print(await listDkbStacks(await context.defaultDistribution(), Boolean(options.check)), summarizeStackListing);
    });

  stack
    .command('up')
    .description('Start or update a named local DKB stack')
    .argument('[name]', 'Stack name', 'local')
    .option('--target <target>', 'Pipeline target from the active DKB distribution')
    .action(async (name: string, options: { target?: DkbStackTarget }) => {
      const { upDkbStack } = await import('../stack/manager.js');
      const distribution = await context.defaultDistribution();
      await context.presenter().run('Starting DKB stack', async () => upDkbStack(distribution, name, options.target), summarizeStackStatus);
    });

  stack
    .command('use')
    .description('Select a Stack and its associated Library, Registry, and Runtime as host defaults')
    .argument('<name>', 'Registered Stack name')
    .action(async (name: string) => {
      const { selectHostStack } = await import('../host/inventory.js');
      const result = await selectHostStack(name);
      context.presenter().print(result, (value) => {
        const selected = value as typeof result;
        return [
          `Default Stack: ${selected.name}`,
          ...(selected.stack.library ? [`Default Library: ${selected.stack.library}`] : []),
          ...(selected.stack.registry ? [`Default Registry: ${selected.stack.registry}`] : []),
          ...(selected.stack.runtime ? [`Default Runtime: ${selected.stack.runtime}`] : []),
        ];
      });
    });

  stack
    .command('down')
    .description('Stop a named stack while preserving its state')
    .argument('[name]', 'Stack name', 'local')
    .action(async (name: string) => {
      const { downDkbStack } = await import('../stack/manager.js');
      await context.presenter().run('Stopping DKB stack', async () => downDkbStack(await context.defaultDistribution(), name));
    });

  stack
    .command('status')
    .description('Show services in a named local stack')
    .argument('[name]', 'Stack name', 'local')
    .option('--check', 'Probe Registry, Runtime, and selected managed-index endpoints')
    .action(async (name: string, options: { check?: boolean }) => {
      const { statusDkbStack } = await import('../stack/manager.js');
      context.presenter().print(await statusDkbStack(await context.defaultDistribution(), name, Boolean(options.check)), summarizeStackStatus);
    });

  stack
    .command('logs')
    .description('Show logs for a named stack or one service')
    .argument('[name]', 'Stack name', 'local')
    .argument('[service]', 'Compose service name')
    .option('--follow', 'Continue streaming new log output')
    .action(async (name: string, service: string | undefined, options: { follow?: boolean }) => {
      if (context.jsonRequested) throw new DkbError('dkb stack logs is a streaming command and does not support --json.');
      const { logsDkbStack } = await import('../stack/manager.js');
      await logsDkbStack(await context.defaultDistribution(), name, service, Boolean(options.follow));
    });

  stack
    .command('doctor')
    .description('Diagnose local stack configuration and service health')
    .argument('[name]', 'Stack name', 'local')
    .action(async (name: string) => {
      const { doctorDkbStack } = await import('../stack/manager.js');
      const result = await context.presenter().check('Stack diagnostics', async () => doctorDkbStack(await context.defaultDistribution(), name), (value) => value.ok, summarizeStackStatus);
      if (!result.ok) process.exitCode = 1;
    });

  stack
    .command('backup')
    .description('Create a verified backup of a stopped local stack')
    .argument('[name]', 'Stack name', 'local')
    .option('--output <path>', 'Backup .tar.gz path')
    .action(async (name: string, options: { output?: string }) => {
      const { backupDkbStack } = await import('../stack/manager.js');
      await context.presenter().run('Backing up DKB stack', async () => backupDkbStack(await context.defaultDistribution(), name, options.output), (value) => {
        const result = value as { archive: string; sha256: string; bytes: number };
        return [
          `Archive: ${result.archive}`,
          `Size: ${formatBytes(result.bytes)}`,
          `SHA-256: ${result.sha256}`,
          'Contains secrets: yes; store it securely',
        ];
      });
    });

  stack
    .command('restore')
    .description('Restore a verified stack backup while the stack is stopped')
    .argument('<archive>', 'Backup .tar.gz path')
    .option('--replace', 'Atomically replace existing stopped stack state')
    .action(async (archive: string, options: { replace?: boolean }) => {
      const { restoreDkbStack } = await import('../stack/manager.js');
      await context.presenter().run('Restoring DKB stack', async () => restoreDkbStack(await context.defaultDistribution(), archive, Boolean(options.replace)));
    });

  stack
    .command('upgrade')
    .description('Upgrade a stopped stack from a digest-pinned release lock')
    .argument('[name]', 'Stack name', 'local')
    .requiredOption('--lock <path>', 'Digest-pinned dkb.stack-lock.v2 file')
    .action(async (name: string, options: { lock: string }) => {
      const { upgradeDkbStack } = await import('../stack/manager.js');
      await context.presenter().run('Upgrading DKB stack', async () => upgradeDkbStack(await context.defaultDistribution(), name, options.lock));
    });
}
