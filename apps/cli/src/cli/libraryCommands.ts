import path from 'node:path';
import type { Command } from 'commander';
import type { DkbRuntimeContext } from '@sjshovan/dkb-runtime/runtime/context.js';
import type { CliPresenter } from './presentation.js';
import {
  summarizeCollectionInstall,
  summarizeCollectionMutation,
  summarizeCollectionOverview,
  summarizeCollectionRevision,
  summarizeCollectionUninstall,
  summarizeHostLibraries,
  summarizeHostMutation,
  summarizeLibraryOverview,
  summarizeLibraryStorage,
  summarizeLibrarySync,
} from './summaries.js';

export interface LibraryCommandContext {
  presenter(): CliPresenter;
  currentLibraryRoot(explicit?: string, cwd?: string): Promise<string>;
  defaultRuntimeContext(): Promise<DkbRuntimeContext>;
  parsePositiveInteger(value: string): number;
}

export function registerLibraryCommands(program: Command, context: LibraryCommandContext): void {
  const library = program
    .command('library')
    .description('Inspect and manage the current local DKB Library');

  library
    .command('list')
    .description('List Libraries registered to this host')
    .action(async () => {
      const { inspectHostLibraries } = await import('../host/inspection.js');
      context.presenter().print(await inspectHostLibraries(), summarizeHostLibraries);
    });

  library
    .command('storage')
    .description('Show source and generated disk usage for installed knowledge')
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .action(async (options: { library?: string }) => {
      const { inspectLibraryStorage } = await import('@sjshovan/dkb-library/storage.js');
      const libraryRoot = await context.currentLibraryRoot(options.library);
      context.presenter().print(await inspectLibraryStorage(libraryRoot), summarizeLibraryStorage);
    });

  library
    .command('register')
    .description('Register an existing Library with this host')
    .argument('<path>', 'Local DKB Library path')
    .option('--name <name>', 'Host-local Library name')
    .action(async (target: string, options: { name?: string }) => {
      const { hostInventoryPath, registerHostLibrary } = await import('../host/inventory.js');
      await context.presenter().run('Registering Library', async () => {
        const result = await registerHostLibrary(target, { name: options.name });
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
      const root = await context.currentLibraryRoot(options.library);
      context.presenter().print(await inspectLibraryOverview(root), summarizeLibraryOverview);
    });

  library
    .command('sync')
    .description('Resolve the Library manifest into its exact lock and applied-state ledger')
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .action(async (options: { library?: string }) => {
      const { syncLibrary } = await import('@sjshovan/dkb-library/resolver.js');
      const root = await context.currentLibraryRoot(options.library);
      await context.presenter().run('Synchronizing Library', async () => syncLibrary(root), summarizeLibrarySync);
    });

  library
    .command('add')
    .description('Activate a local or already-downloaded DKB or Collection')
    .argument('<identity>', 'Scoped @namespace/name identity')
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .action(async (identity: string, options: { library?: string }) => {
      const { addLibraryRoot } = await import('@sjshovan/dkb-library/resolver.js');
      const root = await context.currentLibraryRoot(options.library);
      await context.presenter().run(`Activating ${identity}`, async () => addLibraryRoot(root, identity), summarizeLibrarySync);
    });

  library
    .command('remove')
    .description('Deactivate a Library root without deleting its local source')
    .argument('<identity>', 'Scoped @namespace/name identity')
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .action(async (identity: string, options: { library?: string }) => {
      const { removeLibraryRoot } = await import('@sjshovan/dkb-library/resolver.js');
      const root = await context.currentLibraryRoot(options.library);
      await context.presenter().run(`Deactivating ${identity}`, async () => removeLibraryRoot(root, identity), summarizeLibrarySync);
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
      const root = await context.currentLibraryRoot(options.library);
      await context.presenter().run(`Creating Collection ${identity}`, async () => createLocalCollection({
        libraryRoot: root,
        identity,
        displayName: options.displayName,
        directoryName: options.dirName,
      }), summarizeCollectionMutation);
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
      const root = await context.currentLibraryRoot(options.library);
      await context.presenter().run(`Adding ${dkbIdentity}`, async () => setCollectionMember({
        libraryRoot: root,
        collectionIdentity,
        dkbIdentity,
        selector: options.version,
      }), summarizeCollectionMutation);
    });

  collection
    .command('remove')
    .description('Remove a DKB member from an editable Collection')
    .argument('<collection>', 'Scoped Collection identity')
    .argument('<dkb>', 'Scoped DKB identity')
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .action(async (collectionIdentity: string, dkbIdentity: string, options: { library?: string }) => {
      const { removeCollectionMember } = await import('@sjshovan/dkb-library/collections.js');
      const root = await context.currentLibraryRoot(options.library);
      await context.presenter().run(`Removing ${dkbIdentity}`, async () => removeCollectionMember({
        libraryRoot: root,
        collectionIdentity,
        dkbIdentity,
      }), summarizeCollectionMutation);
    });

  collection
    .command('show')
    .description('Show a Collection and its version selectors')
    .argument('<identity>', 'Scoped Collection identity')
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .action(async (identity: string, options: { library?: string }) => {
      const { collectionOverview } = await import('@sjshovan/dkb-library/collections.js');
      const root = await context.currentLibraryRoot(options.library);
      context.presenter().print(await collectionOverview(root, identity), summarizeCollectionOverview);
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
    .action(async (identity: string, options: { revision?: number; library?: string; url?: string }) => {
      const { configuredRegistry } = await import('./registryConfig.js');
      const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
      const { installRegistryCollection } = await import('@sjshovan/dkb-runtime/runtime/collections.js');
      const root = await context.currentLibraryRoot(options.library);
      const registryConfig = await configuredRegistry({ url: options.url, root });
      await context.presenter().run(`Installing Collection ${identity}`, async (progress) => installRegistryCollection({
        runtime: await context.defaultRuntimeContext(),
        client: new DkbRegistryClient({ baseUrl: registryConfig.url }),
        collectionId: identity,
        revision: options.revision,
        libraryRoot: root,
        progress,
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
      const { configuredRegistry } = await import('./registryConfig.js');
      const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
      const { installRegistryCollection } = await import('@sjshovan/dkb-runtime/runtime/collections.js');
      const root = await context.currentLibraryRoot(options.library);
      const registryConfig = await configuredRegistry({ url: options.url, root });
      await context.presenter().run(`Updating Collection ${identity}`, async (progress) => installRegistryCollection({
        runtime: await context.defaultRuntimeContext(),
        client: new DkbRegistryClient({ baseUrl: registryConfig.url }),
        collectionId: identity,
        revision: options.revision,
        libraryRoot: root,
        update: true,
        progress,
      }), summarizeCollectionInstall);
    });

  collection
    .command('uninstall')
    .description('Uninstall a Registry Collection and prune only its unused vendor DKBs')
    .argument('<identity>', 'Scoped Collection identity')
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .action(async (identity: string, options: { library?: string }) => {
      const { uninstallRegistryCollection } = await import('@sjshovan/dkb-runtime/runtime/collections.js');
      const root = await context.currentLibraryRoot(options.library);
      await context.presenter().run(`Uninstalling Collection ${identity}`, async () => uninstallRegistryCollection({
        collectionId: identity,
        libraryRoot: root,
      }), summarizeCollectionUninstall);
    });
}
