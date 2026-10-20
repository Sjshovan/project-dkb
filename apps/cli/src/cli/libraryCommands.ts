import path from 'node:path';
import type { Command } from 'commander';
import type { DkbRuntimeContext } from '@sjshovan/dkb-runtime/runtime/context.js';
import type { DkbRuntimeClient } from '@sjshovan/dkb-runtime/runtime/client.js';
import type { CliPresenter } from './presentation.js';
import { executeCliLibraryOperation } from './libraryOperation.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import {
  summarizeCollectionInstall,
  summarizeCollectionMutation,
  summarizeCollectionOverview,
  summarizeCollectionRevision,
  summarizeCollectionUninstall,
  summarizeHostLibraries,
  summarizeHostMutation,
  summarizeLibraryOverview,
  summarizeLibraryRecovery,
  summarizeLibraryStorage,
  summarizeLibrarySync,
} from './summaries.js';

export interface LibraryCommandContext {
  presenter(): CliPresenter;
  currentLibraryRoot(explicit?: string, cwd?: string): Promise<string>;
  defaultRuntimeContext(): Promise<DkbRuntimeContext>;
  currentRuntimeAdminClient(explicit?: string): Promise<DkbRuntimeClient>;
  parsePositiveInteger(value: string): number;
}

export function registerLibraryCommands(program: Command, context: LibraryCommandContext): void {
  const library = program
    .command('library')
    .description('Inspect and manage the current local DKB Library');

  library
    .command('list')
    .description('List Libraries registered to this host')
    .option('--check', 'Check Docker-owned Library availability once; local paths are always checked')
    .action(async (options: { check?: boolean }) => {
      const { inspectHostLibraries } = await import('../host/inspection.js');
      context.presenter().print(await inspectHostLibraries(options), summarizeHostLibraries);
    });

  library
    .command('storage')
    .description('Show source and generated disk usage for installed knowledge')
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .action(async (options: { library?: string }) => {
      const { inspectLibraryStorage } = await import('@sjshovan/dkb-library/storage.js');
      context.presenter().print(await executeCliLibraryOperation({ library: options.library, command: 'library.storage' }, inspectLibraryStorage), summarizeLibraryStorage);
    });

  library
    .command('register')
    .description('Register an existing Library with this host')
    .argument('[path]', 'Local DKB Library path; omit when registering a Docker volume')
    .option('--name <name>', 'Host-local Library name')
    .option('--docker-volume <volume>', 'Existing Linux-local Library volume; never creates or migrates one')
    .option('--docker-context <context>', 'Explicit local Docker context')
    .option('--owner-image <digest>', 'Installed matching CLI image ID (sha256:...)')
    .action(async (target: string | undefined, options: { name?: string; dockerVolume?: string; dockerContext?: string; ownerImage?: string }) => {
      const { hostInventoryPath, registerHostLibrary, registerDockerHostLibrary } = await import('../host/inventory.js');
      const docker = options.dockerVolume !== undefined || options.dockerContext !== undefined || options.ownerImage !== undefined;
      if (docker ? target !== undefined || !options.dockerVolume || !options.dockerContext || !options.ownerImage : !target) {
        throw new DkbError('Provide either a local Library path or all of --docker-volume, --docker-context, and --owner-image. No Library was created or moved.');
      }
      await context.presenter().run('Registering Library', async (progress) => {
        let result;
        if (docker) {
          const { readDockerLibraryCommand } = await import('../host/libraryOwnerResult.js');
          const { validateDockerLibraryStorage, hostLibraryLocation } = await import('../host/libraryLocation.js');
          const storage = validateDockerLibraryStorage({ kind: 'docker', context: options.dockerContext, volume: options.dockerVolume, image: options.ownerImage });
          const { kind: _kind, ...owner } = storage;
          const overview = await readDockerLibraryCommand<{ name: string; registryUrl: string | null }>(owner, 'library.status', {}, { progress });
          result = await registerDockerHostLibrary(storage, { name: options.name, displayName: overview.name, registryUrl: overview.registryUrl ?? undefined });
          return { status: 'registered', ...result, location: hostLibraryLocation(result.library), inventoryPath: hostInventoryPath() };
        }
        result = await registerHostLibrary(target!, { name: options.name });
        return { status: 'registered', ...result, inventoryPath: hostInventoryPath() };
      }, summarizeHostMutation);
    });

  library
    .command('unregister')
    .description('Forget a host Library without deleting its files')
    .argument('<name-or-path>', 'Registered Library name or path')
    .action(async (target: string) => {
      const { hostInventoryPath, unregisterHostLibrary } = await import('../host/inventory.js');
      await context.presenter().run('Unregistering Library', async () => ({
        status: 'unregistered',
        ...await unregisterHostLibrary(target),
        inventoryPath: hostInventoryPath(),
      }), summarizeHostMutation);
    });

  library
    .command('use')
    .description('Select the default Library for commands run outside a Library')
    .argument('<name-or-path>', 'Registered Library name or path')
    .action(async (target: string) => {
      const { hostInventoryPath, selectHostLibrary } = await import('../host/inventory.js');
      await context.presenter().run('Selecting Library', async () => ({
        status: 'selected',
        ...await selectHostLibrary(target),
        inventoryPath: hostInventoryPath(),
      }), summarizeHostMutation);
    });

  library
    .command('status')
    .description('Show active, inactive, broken, and untracked Library entries')
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .action(async (options: { library?: string }) => {
      const { inspectLibraryOverview } = await import('@sjshovan/dkb-library/overview.js');
      context.presenter().print(await executeCliLibraryOperation({ library: options.library, command: 'library.status' }, inspectLibraryOverview), summarizeLibraryOverview);
    });

  library
    .command('recover')
    .description('Recover an interrupted Library mutation without recompiling knowledge')
    .option('--library <library>', 'Library name or root path; works even when its manifest is unavailable')
    .action(async (options: { library?: string }) => {
      const { recoverLibraryMutation } = await import('@sjshovan/dkb-library/mutation.js');
      await context.presenter().run('Recovering Library', progress => executeCliLibraryOperation({
        library: options.library, command: 'library.recover', progress, runtimeClient: context.currentRuntimeAdminClient,
      }, recoverLibraryMutation), summarizeLibraryRecovery);
    });

  library
    .command('sync')
    .description('Resolve the Library manifest into its exact lock and applied-state ledger')
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .action(async (options: { library?: string }) => {
      const { syncLibrary } = await import('@sjshovan/dkb-library/resolver.js');
      await context.presenter().run('Synchronizing Library', progress => executeCliLibraryOperation({
        library: options.library, command: 'library.sync', progress, runtimeClient: context.currentRuntimeAdminClient,
      }, syncLibrary), summarizeLibrarySync);
    });

  library
    .command('add')
    .description('Activate a local or already-downloaded DKB or Collection')
    .argument('<identity>', 'Scoped @namespace/name identity')
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .action(async (identity: string, options: { library?: string }) => {
      const { addLibraryRoot } = await import('@sjshovan/dkb-library/resolver.js');
      await context.presenter().run(`Activating ${identity}`, progress => executeCliLibraryOperation({
        library: options.library, command: 'library.add', input: { identity }, progress, runtimeClient: context.currentRuntimeAdminClient,
      }, root => addLibraryRoot(root, identity)), summarizeLibrarySync);
    });

  library
    .command('remove')
    .description('Deactivate a Library root without deleting its local source')
    .argument('<identity>', 'Scoped @namespace/name identity')
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .action(async (identity: string, options: { library?: string }) => {
      const { removeLibraryRoot } = await import('@sjshovan/dkb-library/resolver.js');
      await context.presenter().run(`Deactivating ${identity}`, progress => executeCliLibraryOperation({
        library: options.library, command: 'library.remove', input: { identity }, progress, runtimeClient: context.currentRuntimeAdminClient,
      }, root => removeLibraryRoot(root, identity)), summarizeLibrarySync);
    });

  const collection = program
    .command('collection')
    .description('Create and edit first-class DKB Collections');

  collection
    .command('create')
    .description('Create and activate an editable local Collection')
    .argument('<identity>', 'Scoped @namespace/name Collection identity')
    .option('--display-name <name>', 'Human-readable Collection name')
    .option('--dir-name <name>', 'Local folder label; defaults to the identity name')
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .action(async (identity: string, options: { displayName?: string; dirName?: string; library?: string }) => {
      const { createLocalCollection } = await import('@sjshovan/dkb-library/collections.js');
      await context.presenter().run(`Creating Collection ${identity}`, progress => executeCliLibraryOperation({
        library: options.library, command: 'collection.create',
        input: { identity, ...(options.displayName === undefined ? {} : { displayName: options.displayName }), ...(options.dirName === undefined ? {} : { directoryName: options.dirName }) },
        progress, runtimeClient: context.currentRuntimeAdminClient,
      }, root => createLocalCollection({
        libraryRoot: root,
        identity,
        displayName: options.displayName,
        directoryName: options.dirName,
      })), summarizeCollectionMutation);
    });

  collection
    .command('add')
    .description('Add or update a DKB member in an editable Collection')
    .argument('<collection>', 'Scoped Collection identity')
    .argument('<dkb>', 'Scoped DKB identity')
    .option('--version <version>', 'latest or an exact DKB version', 'latest')
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .action(async (collectionIdentity: string, dkbIdentity: string, options: { version: string; library?: string }) => {
      const { setCollectionMember } = await import('@sjshovan/dkb-library/collections.js');
      await context.presenter().run(`Adding ${dkbIdentity}`, progress => executeCliLibraryOperation({
        library: options.library, command: 'collection.add', input: { identity: collectionIdentity, member: dkbIdentity, version: options.version },
        progress, runtimeClient: context.currentRuntimeAdminClient,
      }, root => setCollectionMember({
        libraryRoot: root,
        collectionIdentity,
        dkbIdentity,
        selector: options.version,
      })), summarizeCollectionMutation);
    });

  collection
    .command('remove')
    .description('Remove a DKB member from an editable Collection')
    .argument('<collection>', 'Scoped Collection identity')
    .argument('<dkb>', 'Scoped DKB identity')
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .action(async (collectionIdentity: string, dkbIdentity: string, options: { library?: string }) => {
      const { removeCollectionMember } = await import('@sjshovan/dkb-library/collections.js');
      await context.presenter().run(`Removing ${dkbIdentity}`, progress => executeCliLibraryOperation({
        library: options.library, command: 'collection.remove', input: { identity: collectionIdentity, member: dkbIdentity },
        progress, runtimeClient: context.currentRuntimeAdminClient,
      }, root => removeCollectionMember({
        libraryRoot: root,
        collectionIdentity,
        dkbIdentity,
      })), summarizeCollectionMutation);
    });

  collection
    .command('show')
    .description('Show a Collection and its version selectors')
    .argument('<identity>', 'Scoped Collection identity')
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .action(async (identity: string, options: { library?: string }) => {
      const { collectionOverview } = await import('@sjshovan/dkb-library/collections.js');
      context.presenter().print(await executeCliLibraryOperation({ library: options.library, command: 'collection.show', input: { identity } },
        root => collectionOverview(root, identity)), summarizeCollectionOverview);
    });

  collection
    .command('publish')
    .description('Publish an immutable Collection revision and any missing owned DKBs')
    .argument('[path]', 'Editable Collection folder', '.')
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .option('--url <url>', 'Registry API URL')
    .option('--public', 'Publish the Collection and owned missing DKBs publicly')
    .action(async (target: string, options: { library?: string; url?: string; public?: boolean }) => {
      const { configuredRegistry } = await import('./registryConfig.js');
      const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
      const { publishCollectionFromLibrary } = await import('@sjshovan/dkb-registry-client/collections.js');
      const collectionPath = path.resolve(target);
      const root = await context.currentLibraryRoot(options.library, collectionPath);
      const registryConfig = await configuredRegistry({ url: options.url, root });
      await context.presenter().run('Publishing Collection', async () => publishCollectionFromLibrary({
        collectionPath,
        libraryRoot: root,
        client: new DkbRegistryClient({ baseUrl: registryConfig.url }),
        visibility: options.public ? 'public' : 'private',
      }), summarizeCollectionRevision);
    });

  collection
    .command('install')
    .description('Install an exact Registry Collection revision into the Library')
    .argument('<identity>', 'Scoped Collection identity')
    .option('--revision <revision>', 'Immutable Collection revision', context.parsePositiveInteger)
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .option('--url <url>', 'Registry API URL')
    .option('--runtime-url <url>', 'Refresh this Runtime after installation; never changes the destination Library')
    .action(async (identity: string, options: { revision?: number; library?: string; url?: string; runtimeUrl?: string }) => {
      const { resolveCliLibraryReference } = await import('./context.js');
      const { installCliCollection } = await import('./packageInstallation.js');
      const reference = await resolveCliLibraryReference({ explicit: options.library });
      await context.presenter().run(`Installing Collection ${identity}`, progress => installCliCollection(reference, {
        ...options, identity, progress, runtimeClient: context.currentRuntimeAdminClient,
      }), summarizeCollectionInstall);
    });

  collection
    .command('update')
    .description('Atomically update an installed Registry Collection to another revision')
    .argument('<identity>', 'Scoped Collection identity')
    .option('--revision <revision>', 'Target immutable revision; defaults to latest', context.parsePositiveInteger)
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .option('--url <url>', 'Registry API URL')
    .action(async (identity: string, options: { revision?: number; library?: string; url?: string }) => {
      const { resolveCliLibraryReference } = await import('./context.js');
      const { installCliCollection } = await import('./packageInstallation.js');
      const reference = await resolveCliLibraryReference({ explicit: options.library });
      await context.presenter().run(`Updating Collection ${identity}`, progress => installCliCollection(reference, {
        ...options, identity, update: true, progress, runtimeClient: context.currentRuntimeAdminClient,
      }), summarizeCollectionInstall);
    });

  collection
    .command('uninstall')
    .description('Uninstall a Registry Collection and prune only its unused vendor DKBs')
    .argument('<identity>', 'Scoped Collection identity')
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .option('--runtime-url <url>', 'Refresh this Runtime after removal; never changes the destination Library')
    .action(async (identity: string, options: { library?: string; runtimeUrl?: string }) => {
      const { removeCliKnowledge } = await import('./packageRemoval.js');
      await context.presenter().run(`Uninstalling Collection ${identity}`, progress => removeCliKnowledge({
        identity, library: options.library, collectionOnly: true, runtimeUrl: options.runtimeUrl,
        progress, runtimeClient: context.currentRuntimeAdminClient,
      }), summarizeCollectionUninstall);
    });
}
