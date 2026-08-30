import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import type { CliPresenter } from './presentation.js';

export function registerConsoleCommands(program: Command, presenter: () => CliPresenter): void {
  const consoleCommand = program
    .command('console')
    .description('Open the loopback DKB host management Console')
    .option('--no-open', 'Start the Console without opening a browser')
    .action(async (options: { open?: boolean }) => {
      const { launchDkbConsole } = await import('@sjshovan/dkb-console/launcher.js');
      await presenter().run('Starting DKB Console', async () => launchDkbConsole({
        cliEntrypoint: fileURLToPath(new URL('./index.js', import.meta.url)),
        openBrowser: options.open !== false,
      }));
    });

  consoleCommand
    .command('status')
    .description('Show the local DKB Console process status')
    .action(async () => {
      const { consoleStatus } = await import('@sjshovan/dkb-console/launcher.js');
      presenter().print(await consoleStatus());
    });

  consoleCommand
    .command('stop')
    .description('Stop the local DKB Console without changing managed resources')
    .action(async () => {
      const { stopDkbConsole } = await import('@sjshovan/dkb-console/launcher.js');
      await presenter().run('Stopping DKB Console', stopDkbConsole);
    });
}
