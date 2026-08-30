import type { Command } from 'commander';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbRuntimeClient } from '@sjshovan/dkb-runtime/runtime/client.js';
import type { CliPresenter } from './presentation.js';
import { summarizePackageListing } from './packagePresentation.js';
import { summarizeRetrievalResult } from './summaries.js';

export interface RemoteCommandContext {
  presenter(): CliPresenter;
  printJson(value: unknown): void;
  currentRuntimeAdminClient(explicit?: string, timeoutMs?: number): Promise<DkbRuntimeClient>;
  parsePositiveInteger(value: string): number;
  parseLimit(value: string): number;
}

export function registerRemoteCommands(program: Command, context: RemoteCommandContext): void {
  const { presenter, printJson, currentRuntimeAdminClient, parsePositiveInteger, parseLimit } = context;
  const remote = program
    .command('remote')
    .description('Discover and temporarily query public remote DKB runtimes');

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
    .description('List persistent remote DKB runtimes and install offers')
    .action(async () => {
      const { listRegisteredRemotes } = await import('../remote/manager.js');

      printJson(await listRegisteredRemotes({ presentOffers: true }));
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
    .description('Remove a persistent remote DKB from this runtime')
    .argument('<remote-id>', 'Persistent remote id')
    .action(async (id: string) => {
      const { removeRegisteredRemote } = await import('../remote/manager.js');

      await presenter().run('Removing remote', async () => {
        await removeRegisteredRemote(id);

        return { status: 'removed', remoteId: id };
      });
    });

  remote
    .command('discover')
    .description('Read a site /.well-known/dkb.json discovery document through the runtime')
    .argument('<url>', 'Site URL or direct /.well-known/dkb.json URL')
    .option('--url <url>', 'Runtime API URL; defaults to the selected Runtime')
    .action(async (targetUrl: string, options: { url?: string }) => {
      printJson(await (await currentRuntimeAdminClient(options.url)).remoteDiscover(targetUrl));
    });

  remote
    .command('attach')
    .description('Create a temporary session to a public remote DKB endpoint')
    .argument('<url>', 'Site URL or direct /.well-known/dkb.json URL')
    .option('--ttl <seconds>', 'Session lifetime in seconds', parsePositiveInteger)
    .option('--url <url>', 'Runtime API URL; defaults to the selected Runtime')
    .action(async (targetUrl: string, options: { ttl?: number; url?: string }) => {
      const runtime = await currentRuntimeAdminClient(options.url);
      await presenter().run('Attaching remote', async () => runtime.remoteAttach({
        url: targetUrl,
        ttlSeconds: options.ttl,
      }));
    });

  remote
    .command('sessions')
    .description('List temporary remote DKB sessions held by the runtime process')
    .option('--url <url>', 'Runtime API URL; defaults to the selected Runtime')
    .action(async (options: { url?: string }) => {
      printJson(await (await currentRuntimeAdminClient(options.url)).remoteSessions());
    });

  remote
    .command('detach')
    .description('Remove a temporary remote DKB session from the runtime process')
    .argument('<session-id>', 'Remote session id returned by dkb remote attach')
    .option('--url <url>', 'Runtime API URL; defaults to the selected Runtime')
    .action(async (sessionId: string, options: { url?: string }) => {
      const runtime = await currentRuntimeAdminClient(options.url);
      await presenter().run('Detaching remote', async () => runtime.remoteDetach(sessionId));
    });

  remote
    .command('query')
    .description('Query a persistent verified remote, or a temporary remote session')
    .argument('<remote-or-session-id>', 'Persistent remote id or session id')
    .argument('<need>', 'Knowledge need')
    .option('--intent <intent>', 'Retrieval intent: evidence, records, count, summary, compare', 'evidence')
    .option('-l, --limit <number>', 'Maximum retrieved evidence count', parseLimit, 8)
    .option('--profile', 'Include retrieval profile metadata')
    .option('--url <url>', 'Runtime API URL; defaults to the selected Runtime')
    .action(async (
      sessionId: string,
      need: string,
      options: { intent: 'evidence' | 'records' | 'count' | 'summary' | 'compare'; limit: number; profile?: boolean; url?: string },
    ) => {
      const { listRegisteredRemotes, queryRegisteredRemote } = await import('../remote/manager.js');
      const persistent = (await listRegisteredRemotes()).remotes.find((remote) => remote.id === sessionId);

      if (persistent) {
        presenter().print(await queryRegisteredRemote({
          id: sessionId,
          request: {
            need,
            intent: options.intent,
            limit: options.limit,
            profile: Boolean(options.profile),
          },
        }), summarizeRetrievalResult);

        return;
      }

      presenter().print(await (await currentRuntimeAdminClient(options.url)).remoteRetrieve(sessionId, {
        need,
        intent: options.intent,
        limit: options.limit,
        profile: Boolean(options.profile),
      }), summarizeRetrievalResult);
    });
}
