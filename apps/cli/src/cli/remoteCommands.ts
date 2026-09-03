import type { Command } from 'commander';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { CliPresenter } from './presentation.js';
import { summarizePackageListing } from './packagePresentation.js';

export interface RemoteCommandContext {
  presenter(): CliPresenter;
  printJson(value: unknown): void;
}

export function registerRemoteCommands(program: Command, context: RemoteCommandContext): void {
  const { presenter, printJson } = context;
  const remote = program
    .command('remote')
    .description('Discover Registry-verified remote DKB Runtime endpoints');

  remote
    .command('search')
    .description('Search packages that may have verified hosted runtimes')
    .argument('[query]', 'Package search query')
    .option('--registry-url <url>', 'Registry API URL')
    .action(async (query: string | undefined, options: { registryUrl?: string }) => {
      const { configuredRegistry } = await import('./registryConfig.js');
      const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
      const registryConfig = await configuredRegistry({ url: options.registryUrl });

      presenter().print(await new DkbRegistryClient({ baseUrl: registryConfig.url }).searchPackages(query), summarizePackageListing);
    });

  remote
    .command('add')
    .description('Persist a verified registry remote, or label a direct URL as unverified')
    .argument('<package-or-url>', 'Package id or runtime URL')
    .option('--version <version>', 'Package version')
    .option('--endpoint <url>', 'Specific verified endpoint URL')
    .option('--registry-url <url>', 'Registry API URL')
    .action(async (target: string, options: { version?: string; endpoint?: string; registryUrl?: string }) => {
      const { addDirectRemote, addRegisteredRemote } = await import('../remote/manager.js');
      await presenter().run('Adding remote', async () => /^https?:\/\//i.test(target)
        ? addDirectRemote({ url: target })
        : addRegisteredRemote({
          packageId: target,
          version: options.version,
          endpointUrl: options.endpoint,
          registryUrl: options.registryUrl,
        }));
    });

  remote
    .command('list')
    .description('List persistent remote DKB Runtime endpoints')
    .action(async () => {
      const { listRegisteredRemotes } = await import('../remote/manager.js');

      printJson(await listRegisteredRemotes());
    });

  remote
    .command('status')
    .description('Show the stored verification and health state for a remote DKB')
    .argument('<remote-id>', 'Persistent remote id')
    .action(async (id: string) => {
      const { listRegisteredRemotes } = await import('../remote/manager.js');
      const remote = (await listRegisteredRemotes()).remotes.find((candidate) => candidate.id === id);

      if (!remote) {
        throw new DkbError('Unknown remote DKB: ' + id);
      }

      printJson({ remote });
    });

  remote
    .command('remove')
    .description('Remove a persistent endpoint from the local remote catalog')
    .argument('<remote-id>', 'Persistent remote id')
    .action(async (id: string) => {
      const { removeRegisteredRemote } = await import('../remote/manager.js');

      await presenter().run('Removing remote', async () => {
        await removeRegisteredRemote(id);

        return { status: 'removed', remoteId: id };
      });
    });

}
