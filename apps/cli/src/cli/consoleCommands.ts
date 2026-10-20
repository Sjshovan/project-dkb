import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import type { CliPresenter } from './presentation.js';

export function registerConsoleCommands(program: Command, presenter: () => CliPresenter): void {
  const cliEntrypoint = () => fileURLToPath(new URL('./index.js', import.meta.url));
  const consoleCommand = program
    .command('console')
    .description('Open the loopback DKB host management Console')
    .option('--no-open', 'Start the Console without opening a browser')
    .action(async (options: { open?: boolean }) => {
      const { launchDkbConsole } = await import('@sjshovan/dkb-console/launcher.js');
      await presenter().run('Starting DKB Console', async () => launchDkbConsole({
        cliEntrypoint: cliEntrypoint(),
        openBrowser: options.open !== false,
      }));
    });

  consoleCommand
    .command('enable')
    .description('Start the Console at user login and keep it available in the background')
    .option('--no-open', 'Enable and start the Console without opening a browser')
    .action(async (options: { open?: boolean }) => {
      const [{ enableConsoleAutostart, disableConsoleAutostart, startConsoleAutostart, consoleAutostartStatus }, { consoleStatus, launchDkbConsole, stopDkbConsole, waitForDkbConsole }] = await Promise.all([
        import('@sjshovan/dkb-console/autostart.js'),
        import('@sjshovan/dkb-console/launcher.js'),
      ]);
      await presenter().run('Enabling DKB Console automatic startup', async () => {
        const previous = await consoleStatus();
        const registration = await enableConsoleAutostart(cliEntrypoint());
        try {
          if (previous.status === 'running') await stopDkbConsole();
          await startConsoleAutostart();
          await waitForDkbConsole();
          const launch = await launchDkbConsole({ cliEntrypoint: cliEntrypoint(), openBrowser: options.open !== false });
          const autostart = await consoleAutostartStatus(cliEntrypoint());
          return consoleLifecycleResult(launch, autostart, registration.changed);
        } catch (error) {
          await disableConsoleAutostart().catch(() => undefined);
          if (previous.status === 'running') await launchDkbConsole({ cliEntrypoint: cliEntrypoint(), openBrowser: false }).catch(() => undefined);
          throw error;
        }
      }, consoleLifecycleSummary);
    });

  consoleCommand
    .command('disable')
    .description('Disable user-login startup without stopping the current Console')
    .action(async () => {
      const [{ disableConsoleAutostart, consoleAutostartStatus }, { consoleStatus, launchDkbConsole }] = await Promise.all([
        import('@sjshovan/dkb-console/autostart.js'),
        import('@sjshovan/dkb-console/launcher.js'),
      ]);
      await presenter().run('Disabling DKB Console automatic startup', async () => {
        const before = await consoleStatus();
        const registration = await disableConsoleAutostart();
        let processStatus = await consoleStatus();
        if (before.status === 'running' && processStatus.status !== 'running') {
          processStatus = await launchDkbConsole({ cliEntrypoint: cliEntrypoint(), openBrowser: false });
        }
        const autostart = await consoleAutostartStatus(cliEntrypoint());
        return consoleLifecycleResult(processStatus, autostart, registration.changed);
      }, consoleLifecycleSummary);
    });

  consoleCommand
    .command('restart')
    .description('Restart the local Console and create a fresh browser session')
    .option('--no-open', 'Restart the Console without opening a browser')
    .action(async (options: { open?: boolean }) => {
      const [{ consoleAutostartStatus, startConsoleAutostart }, { launchDkbConsole, stopDkbConsole, waitForDkbConsole }] = await Promise.all([
        import('@sjshovan/dkb-console/autostart.js'),
        import('@sjshovan/dkb-console/launcher.js'),
      ]);
      await presenter().run('Restarting DKB Console', async () => {
        const autostart = await consoleAutostartStatus(cliEntrypoint());
        await stopDkbConsole();
        if (autostart.enabled) {
          await startConsoleAutostart();
          await waitForDkbConsole();
        }
        const launch = await launchDkbConsole({ cliEntrypoint: cliEntrypoint(), openBrowser: options.open !== false });
        return consoleLifecycleResult(launch, await consoleAutostartStatus(cliEntrypoint()), false);
      }, consoleLifecycleSummary);
    });

  consoleCommand
    .command('status')
    .description('Show the local Console process and user-login startup status')
    .action(async () => {
      const [{ consoleAutostartStatus }, { consoleStatus }] = await Promise.all([
        import('@sjshovan/dkb-console/autostart.js'),
        import('@sjshovan/dkb-console/launcher.js'),
      ]);
      presenter().print(consoleLifecycleResult(await consoleStatus(), await consoleAutostartStatus(cliEntrypoint()), false), consoleLifecycleSummary);
    });

  consoleCommand
    .command('stop')
    .description('Stop the local DKB Console without changing managed resources')
    .action(async () => {
      const { stopDkbConsole } = await import('@sjshovan/dkb-console/launcher.js');
      await presenter().run('Stopping DKB Console', stopDkbConsole);
    });
}

interface ConsoleLifecycleStatus {
  status: string;
  url?: string;
  pid?: number;
  startedAt?: string;
  autostart: 'enabled' | 'disabled';
  autostartProvider: string;
  autostartConfiguration: string;
  registration: string;
  launcher?: string;
  launcherAvailable: boolean;
  changed: boolean;
  opened?: boolean;
  launchUrl?: string;
}

function consoleLifecycleResult(
  processStatus: { status: string; url?: string; pid?: number; startedAt?: string; opened?: boolean; launchUrl?: string },
  autostart: { enabled: boolean; provider: string; configuration: string; registration: string; launcher?: string; launcherAvailable: boolean },
  changed: boolean,
): ConsoleLifecycleStatus {
  return {
    ...processStatus,
    autostart: autostart.enabled ? 'enabled' : 'disabled',
    autostartProvider: autostart.provider,
    autostartConfiguration: autostart.configuration,
    registration: autostart.registration,
    launcher: autostart.launcher,
    launcherAvailable: autostart.launcherAvailable,
    changed,
  };
}

function consoleLifecycleSummary(value: unknown): string[] {
  const status = value as ConsoleLifecycleStatus;
  return [
    `Process: ${status.status}`,
    ...(status.url ? [`URL: ${status.url}`] : []),
    ...(status.pid ? [`PID: ${status.pid}`] : []),
    `Automatic startup: ${status.autostart}`,
    `Provider: ${status.autostartProvider}`,
    `Configuration: ${status.autostartConfiguration}`,
    `Registration: ${status.registration}`,
    ...(status.launcher ? [`Launcher: ${status.launcher}`] : []),
    ...(status.launcher ? [`Launcher available: ${status.launcherAvailable ? 'yes' : 'no'}`] : []),
    ...(status.opened !== undefined ? [`Opened: ${status.opened}`] : []),
  ];
}
