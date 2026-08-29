#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Command, CommanderError } from 'commander';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { identityDisplayName, parseDkbIdentity } from '@sjshovan/dkb-protocol/identity.js';
import { loadCollection, loadDkb, loadManifest } from '@sjshovan/dkb-protocol/manifest.js';
import { DKB_ARTIFACTS_DIR } from '@sjshovan/dkb-protocol/paths.js';
import { DKB_PROTOCOL_VERSION } from '@sjshovan/dkb-protocol/version.js';
import { DKB_PROTOCOL_COMPATIBILITY } from '@sjshovan/dkb-protocol/version.js';
import { DKB_CLI_VERSION } from '../version.js';
import {
  countLabel,
  createCliPresenter,
  failureLine,
  formatBytes,
  humanSummary,
  milliseconds,
  printJson as printJsonValue,
  terminalText,
  type CliPresenter,
} from './presentation.js';
import { configureDkbHelp } from './help.js';
import { registerPackageLifecycleCommands } from './packageCommands.js';
import { summarizePackageListing } from './packagePresentation.js';

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

program
  .command('init')
  .description('Initialize this directory as a Library, or create a namespaced DKB')
  .argument('[identity]', 'Scoped @namespace/name DKB identity; omit to initialize a Library')
  .option('--dir <path>', 'Target Library directory, or parent directory for a DKB')
  .option('--display-name <name>', 'Human-readable DKB or Library name')
  .option('--registry-url <url>', 'Upstream Registry URL for this Library')
  .option('--no-verify', 'Save the registry URL without validating it first')
  .option('--yes', 'Use defaults without prompting when possible')
  .option('--owner <id>', 'Owner id to write into dkb.json')
  .option('--email <email>', 'Owner email to write into dkb.json')
  .action(async (identity: string | undefined, options: { dir?: string; displayName?: string; registryUrl?: string; verify?: boolean; yes?: boolean; owner?: string; email?: string }) => {
    const initializeLibrary = !identity?.trim();

    if (initializeLibrary) {
      const { nearestLibraryRoot, libraryManifestForFolder, resolveRegistryInitializationConfiguration } = await import('./serve.js');
      const { writeConfiguredRegistryUrl } = await import('./registryConfig.js');
      const root = path.resolve(options.dir ?? '.');
      const manifestPath = path.join(root, 'dkb.json');
      const manifestPresent = await exists(manifestPath);
      const alreadyInitialized = await nearestLibraryRoot(root) === root;

      if (manifestPresent && !alreadyInitialized) {
        throw new DkbError(`Cannot initialize a Library because ${manifestPath} already belongs to another entry or is invalid.`);
      }

      const selectedRegistry = await resolveRegistryInitializationConfiguration({
        root,
        registryUrl: options.registryUrl,
        yes: Boolean(options.yes),
        verify: options.verify !== false,
      });
      const manifest = {
        ...libraryManifestForFolder(root),
        registry: { url: selectedRegistry.url },
        ...(options.displayName ? { name: options.displayName } : {}),
        ...(options.owner || options.email
          ? {
              owner: {
                id: options.owner ?? 'local',
                email: options.email,
              },
            }
          : {}),
      };
      await presenter().run('Initializing Library', async () => {
        let createdManifest = false;

        try {
          if (!alreadyInitialized) {
            if (await exists(manifestPath)) {
              throw new DkbError(`dkb.json already exists at ${manifestPath}`);
            }

            await fs.mkdir(root, { recursive: true });
            await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
            createdManifest = true;
          }

          const configured = selectedRegistry.configured ?? await writeConfiguredRegistryUrl(selectedRegistry.url, { root });
          const { hostInventoryPath, registerHostLibrary } = await import('../host/inventory.js');
          const host = await registerHostLibrary(root, {
            registryUrl: configured.url,
            select: 'if-empty',
          });

          return {
            status: alreadyInitialized ? 'already initialized' : 'initialized',
            type: 'library',
            root,
            manifest: manifestPath,
            registry: configured,
            host: {
              library: host.name,
              inventoryPath: hostInventoryPath(),
            },
            ...(selectedRegistry.verification ? { verification: selectedRegistry.verification } : {}),
            ...(selectedRegistry.warning
              ? {
                  warning: selectedRegistry.warning,
                  retryCommand: selectedRegistry.retryCommand,
                }
              : {}),
          };
        } catch (error) {
          if (createdManifest) {
            await fs.rm(manifestPath, { force: true });
          }

          throw error;
        }
      }, summarizeInitResult);

      return;
    }

    if (options.registryUrl || options.verify === false) {
      throw new DkbError('--registry-url and --no-verify are only valid when initializing a Library with bare `dkb init`.');
    }

    const parsedIdentity = parseDkbIdentity(identity!, 'DKB identity');
    const displayName = options.displayName ?? identityDisplayName(parsedIdentity.identity);
    const root = path.resolve(options.dir ?? '.', parsedIdentity.name);

    const manifestPath = path.join(root, 'dkb.json');

    await presenter().run('Initializing DKB', async () => {
      if (await exists(manifestPath)) {
        throw new DkbError(`dkb.json already exists at ${manifestPath}`);
      }

      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(manifestPath, `${JSON.stringify({
        type: 'dkb',
        name: parsedIdentity.identity,
        displayName,
        version: '0.1.0',
        description: '',
        author: options.owner || options.email
          ? {
              id: options.owner ?? 'local',
              email: options.email,
            }
          : undefined,
      }, null, 2)}\n`, 'utf8');

      return {
        status: 'initialized',
        type: 'dkb',
        root,
        manifest: manifestPath,
      };
    }, summarizeInitResult);
  });

const library = program
  .command('library')
  .description('Inspect and manage the current local DKB Library');

library
  .command('list')
  .description('List Libraries registered to this host')
  .action(async () => {
    const { inspectHostLibraries } = await import('../host/inspection.js');

    presenter().print(await inspectHostLibraries(), summarizeHostLibraries);
  });

library
  .command('storage')
  .description('Show source and generated disk usage for installed knowledge')
  .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
  .action(async (options: { library?: string }) => {
    const { inspectLibraryStorage } = await import('@sjshovan/dkb-library/storage.js');
    const libraryRoot = await currentLibraryRoot(options.library);

    presenter().print(await inspectLibraryStorage(libraryRoot), summarizeLibraryStorage);
  });

library
  .command('register')
  .description('Register an existing Library with this host')
  .argument('<path>', 'Local DKB Library path')
  .option('--name <name>', 'Host-local Library name')
  .action(async (target: string, options: { name?: string }) => {
    const { hostInventoryPath, registerHostLibrary } = await import('../host/inventory.js');

    await presenter().run('Registering Library', async () => {
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

    await presenter().run('Unregistering Library', async () => ({
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

    await presenter().run('Selecting Library', async () => ({
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
    const root = await currentLibraryRoot(options.library);
    presenter().print(await inspectLibraryOverview(root), summarizeLibraryOverview);
  });

library
  .command('sync')
  .description('Resolve the Library manifest into its exact lock and applied-state ledger')
  .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
  .action(async (options: { library?: string }) => {
    const { syncLibrary } = await import('@sjshovan/dkb-library/resolver.js');
    const root = await currentLibraryRoot(options.library);
    await presenter().run('Synchronizing Library', async () => syncLibrary(root), summarizeLibrarySync);
  });

library
  .command('add')
  .description('Activate a local or already-downloaded DKB or Collection')
  .argument('<identity>', 'Scoped @namespace/name identity')
  .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
  .action(async (identity: string, options: { library?: string }) => {
    const { addLibraryRoot } = await import('@sjshovan/dkb-library/resolver.js');
    const root = await currentLibraryRoot(options.library);
    await presenter().run(`Activating ${identity}`, async () => addLibraryRoot(root, identity), summarizeLibrarySync);
  });

library
  .command('remove')
  .description('Deactivate a Library root without deleting its local source')
  .argument('<identity>', 'Scoped @namespace/name identity')
  .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
  .action(async (identity: string, options: { library?: string }) => {
    const { removeLibraryRoot } = await import('@sjshovan/dkb-library/resolver.js');
    const root = await currentLibraryRoot(options.library);
    await presenter().run(`Deactivating ${identity}`, async () => removeLibraryRoot(root, identity), summarizeLibrarySync);
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
    const root = await currentLibraryRoot(options.library);
    await presenter().run(`Creating Collection ${identity}`, async () => createLocalCollection({
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
    const root = await currentLibraryRoot(options.library);
    await presenter().run(`Adding ${dkbIdentity}`, async () => setCollectionMember({
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
    const root = await currentLibraryRoot(options.library);
    await presenter().run(`Removing ${dkbIdentity}`, async () => removeCollectionMember({
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
    const root = await currentLibraryRoot(options.library);
    presenter().print(await collectionOverview(root, identity), summarizeCollectionOverview);
  });

collection
  .command('publish')
  .description('Publish an immutable Collection revision and any missing owned DKBs')
  .argument('[path]', 'Editable Collection folder', '.')
  .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
  .option('--url <url>', 'Registry API URL')
  .option('--public', 'Publish the Collection and owned missing DKBs publicly')
  .option('--token <token>', 'Registry API bearer token', process.env.DKB_REGISTRY_TOKEN)
  .action(async (target: string, options: { library?: string; url?: string; public?: boolean; token?: string }) => {
    const { configuredRegistry } = await import('./registryConfig.js');
    const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
    const { publishCollectionFromLibrary } = await import('@sjshovan/dkb-registry-client/collections.js');
    const collectionPath = path.resolve(target);
    const root = await currentLibraryRoot(options.library, collectionPath);
    const registryConfig = await configuredRegistry({ url: options.url, root });

    await presenter().run('Publishing Collection', async () => publishCollectionFromLibrary({
      collectionPath,
      libraryRoot: root,
      client: new DkbRegistryClient({ baseUrl: registryConfig.url, token: options.token }),
      visibility: options.public ? 'public' : 'private',
    }), summarizeCollectionRevision);
  });

collection
  .command('install')
  .description('Install an exact Registry Collection revision into the Library')
  .argument('<identity>', 'Scoped Collection identity')
  .option('--revision <revision>', 'Immutable Collection revision', parsePositiveInteger)
  .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
  .option('--url <url>', 'Registry API URL')
  .option('--token <token>', 'Registry API bearer token', process.env.DKB_REGISTRY_TOKEN)
  .action(async (identity: string, options: { revision?: number; library?: string; url?: string; token?: string }) => {
    const { configuredRegistry } = await import('./registryConfig.js');
    const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
    const { installRegistryCollection } = await import('@sjshovan/dkb-runtime/runtime/collections.js');
    const root = await currentLibraryRoot(options.library);
    const registryConfig = await configuredRegistry({ url: options.url, root });

    await presenter().run(`Installing Collection ${identity}`, async (progress) => installRegistryCollection({
      client: new DkbRegistryClient({ baseUrl: registryConfig.url, token: options.token }),
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
  .option('--revision <revision>', 'Target immutable revision; defaults to latest', parsePositiveInteger)
  .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
  .option('--url <url>', 'Registry API URL')
  .option('--token <token>', 'Registry API bearer token', process.env.DKB_REGISTRY_TOKEN)
  .action(async (identity: string, options: { revision?: number; library?: string; url?: string; token?: string }) => {
    const { configuredRegistry } = await import('./registryConfig.js');
    const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
    const { installRegistryCollection } = await import('@sjshovan/dkb-runtime/runtime/collections.js');
    const root = await currentLibraryRoot(options.library);
    const registryConfig = await configuredRegistry({ url: options.url, root });

    await presenter().run(`Updating Collection ${identity}`, async (progress) => installRegistryCollection({
      client: new DkbRegistryClient({ baseUrl: registryConfig.url, token: options.token }),
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
    const root = await currentLibraryRoot(options.library);

    await presenter().run(`Uninstalling Collection ${identity}`, async () => uninstallRegistryCollection({
      collectionId: identity,
      libraryRoot: root,
    }), summarizeCollectionUninstall);
  });

program
  .command('serve')
  .description('Serve the nearest DKB Library from the current folder')
  .option('--root <path>', 'Library root to serve instead of discovering from the current folder')
  .option('--registry-url <url>', 'Upstream Registry URL when initializing a new Library')
  .option('--no-verify', 'Save the registry URL without validating it first')
  .option('--yes', 'Initialize a missing Library without prompting')
  .option('--host <host>', 'Host to bind', process.env.DKB_RUNTIME_HOST || '127.0.0.1')
  .option('--port <number>', 'Port to bind', parsePositiveInteger, Number.parseInt(process.env.DKB_RUNTIME_PORT || '7331', 10))
  .option('--name <name>', 'Host-local Runtime name', 'codename-dkb')
  .action(async (options: { root?: string; registryUrl?: string; verify?: boolean; yes?: boolean; host: string; port: number; name: string }) => {
    const { prepareServeLibrary } = await import('./serve.js');
    const { serveDkbRuntime } = await import('@sjshovan/dkb-runtime/runtime/server.js');
    const { registerHostLibrary, registerHostRuntime } = await import('../host/inventory.js');
    const prepared = await prepareServeLibrary({
      root: options.root,
      registryUrl: options.registryUrl,
      verifyRegistry: options.verify !== false,
      yes: Boolean(options.yes),
    });

    presenter().print({
      status: 'serving',
      root: prepared.root,
      initialized: prepared.initialized,
      compiled: prepared.compiled,
      recordCount: prepared.compileResult?.recordCount,
      registry: prepared.registry,
      ...(prepared.verification ? { verification: prepared.verification } : {}),
      ...(prepared.warning
        ? {
            warning: prepared.warning,
            retryCommand: prepared.retryCommand,
          }
        : {}),
      url: `http://${options.host}:${options.port}`,
    });

    const server = await serveDkbRuntime({
      host: options.host,
      port: options.port,
      stateRoot: prepared.root,
    });
    try {
      const hostLibrary = await registerHostLibrary(prepared.root);
      await registerHostRuntime(options.name, runtimeCatalogUrl(options.host, options.port), {
        kind: 'process',
        stateRoot: prepared.root,
        library: hostLibrary.name,
        select: 'if-empty',
      });
    } catch (error) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw error;
    }
  });

const runtime = program
  .command('runtime')
  .description('Manage the container-first DKB Runtime');

runtime
  .command('list')
  .description('List Runtime endpoints registered to this host')
  .option('--check', 'Probe each Runtime endpoint')
  .action(async (options: { check?: boolean }) => {
    const { inspectHostRuntimes } = await import('../host/inspection.js');

    presenter().print(await inspectHostRuntimes({ check: Boolean(options.check) }), summarizeHostRuntimes);
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
    const kind = parseRuntimeKind(options.kind);
    let libraryName: string | undefined;
    if (options.library) {
      const known = await registeredHostLibrary(options.library);
      libraryName = known?.name ?? (await registerHostLibrary(options.library)).name;
    }

    await presenter().run('Registering Runtime', async () => {
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
    await presenter().run('Unregistering Runtime', async () => ({
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
    await presenter().run('Selecting Runtime', async () => ({
      status: 'selected',
      ...await selectHostRuntime(name),
      inventoryPath: hostInventoryPath(),
    }), summarizeHostMutation);
  });

runtime
  .command('serve')
  .description('Start the DKB Runtime HTTP API in the current process')
  .option('--host <host>', 'Host to bind', process.env.DKB_RUNTIME_HOST || '127.0.0.1')
  .option('--port <number>', 'Port to bind', parsePositiveInteger, Number.parseInt(process.env.DKB_RUNTIME_PORT || '7331', 10))
  .option('--state-root <path>', 'Runtime state root', process.env.DKB_RUNTIME_STATE_ROOT)
  .option('--name <name>', 'Host-local Runtime name', 'codename-dkb')
  .action(async (options: { host: string; port: number; stateRoot?: string; name: string }) => {
    const { serveDkbRuntime } = await import('@sjshovan/dkb-runtime/runtime/server.js');
    const { defaultRuntimeStateRoot } = await import('@sjshovan/dkb-runtime/runtime/state.js');
    const { registerHostLibrary, registerHostRuntime } = await import('../host/inventory.js');
    const stateRoot = path.resolve(options.stateRoot ?? defaultRuntimeStateRoot());

    const server = await serveDkbRuntime({
      host: options.host,
      port: options.port,
      stateRoot,
    });
    try {
      const hostLibrary = await registerHostLibrary(stateRoot);
      await registerHostRuntime(options.name, runtimeCatalogUrl(options.host, options.port), {
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
    runDockerCompose(options.file, ['up', '-d', 'dkb-runtime']);
    const { hostInventoryPath, registerHostRuntime } = await import('../host/inventory.js');
    const result = await registerHostRuntime(options.name, options.url, {
      kind: 'docker',
      composeFile: options.file,
      select: 'if-empty',
    });
    presenter().print({
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
    runDockerCompose(options.file, ['stop', 'dkb-runtime']);
    printJson({ status: 'stopped', service: 'dkb-runtime', composeFile: path.resolve(options.file) });
  });

runtime
  .command('status')
  .description('Show DKB Runtime status')
  .option('--url <url>', 'Runtime API URL; defaults to the selected Runtime')
  .action(async (options: { url?: string }) => {
    const { DkbRuntimeClient } = await import('@sjshovan/dkb-runtime/runtime/client.js');

    printJson(await new DkbRuntimeClient({ baseUrl: await currentRuntimeUrl(options.url) }).status());
  });

runtime
  .command('library')
  .description('Show the single Library served by the DKB Runtime')
  .option('--url <url>', 'Runtime API URL; defaults to the selected Runtime')
  .action(async (options: { url?: string }) => {
    const { DkbRuntimeClient } = await import('@sjshovan/dkb-runtime/runtime/client.js');

    printJson(await new DkbRuntimeClient({ baseUrl: await currentRuntimeUrl(options.url) }).library());
  });

const stack = program
  .command('stack')
  .description('Operate a complete local DKB developer-preview stack');

stack
  .command('up')
  .description('Start or update a named local DKB stack')
  .argument('[name]', 'Stack name', 'local')
  .option('--target <target>', 'Pipeline target: default, fastembed-faiss, tei-faiss, tei-faiss-768, or tei-meilisearch', parseStackTarget, 'default')
  .action(async (name: string, options: { target: import('../stack/manager.js').DkbStackTarget }) => {
    const { upDkbStack } = await import('../stack/manager.js');
    await presenter().run('Starting DKB stack', async () => upDkbStack(name, options.target), summarizeStackStatus);
  });

stack
  .command('down')
  .description('Stop a named stack while preserving its state')
  .argument('[name]', 'Stack name', 'local')
  .action(async (name: string) => {
    const { downDkbStack } = await import('../stack/manager.js');
    await presenter().run('Stopping DKB stack', async () => downDkbStack(name));
  });

stack
  .command('status')
  .description('Show services in a named local stack')
  .argument('[name]', 'Stack name', 'local')
  .option('--check', 'Probe Registry, Runtime, and selected managed-index endpoints')
  .action(async (name: string, options: { check?: boolean }) => {
    const { statusDkbStack } = await import('../stack/manager.js');
    presenter().print(await statusDkbStack(name, Boolean(options.check)), summarizeStackStatus);
  });

stack
  .command('logs')
  .description('Show logs for a named stack or one service')
  .argument('[name]', 'Stack name', 'local')
  .argument('[service]', 'Compose service name')
  .option('--follow', 'Continue streaming new log output')
  .action(async (name: string, service: string | undefined, options: { follow?: boolean }) => {
    if (jsonRequested) throw new DkbError('dkb stack logs is a streaming command and does not support --json.');
    const { logsDkbStack } = await import('../stack/manager.js');
    await logsDkbStack(name, service, Boolean(options.follow));
  });

stack
  .command('doctor')
  .description('Diagnose local stack configuration and service health')
  .argument('[name]', 'Stack name', 'local')
  .action(async (name: string) => {
    const { doctorDkbStack } = await import('../stack/manager.js');
    const result = await presenter().check('Stack diagnostics', async () => doctorDkbStack(name), (value) => value.ok, summarizeStackStatus);
    if (!result.ok) process.exitCode = 1;
  });

stack
  .command('backup')
  .description('Create a verified backup of a stopped local stack')
  .argument('[name]', 'Stack name', 'local')
  .option('--output <path>', 'Backup .tar.gz path')
  .action(async (name: string, options: { output?: string }) => {
    const { backupDkbStack } = await import('../stack/manager.js');
    await presenter().run('Backing up DKB stack', async () => backupDkbStack(name, options.output), (value) => {
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
    await presenter().run('Restoring DKB stack', async () => restoreDkbStack(archive, Boolean(options.replace)));
  });

stack
  .command('upgrade')
  .description('Upgrade a stopped stack from a digest-pinned release lock')
  .argument('[name]', 'Stack name', 'local')
  .requiredOption('--lock <path>', 'Digest-pinned dkb.stack-lock.v1 file')
  .action(async (name: string, options: { lock: string }) => {
    const { upgradeDkbStack } = await import('../stack/manager.js');
    await presenter().run('Upgrading DKB stack', async () => upgradeDkbStack(name, options.lock));
  });

const registry = program
  .command('registry')
  .description('Manage the DKB package registry');

registry
  .command('list')
  .description('List Registry endpoints registered to this host')
  .option('--check', 'Probe each Registry endpoint')
  .action(async (options: { check?: boolean }) => {
    const { inspectHostRegistries } = await import('../host/inspection.js');

    presenter().print(await inspectHostRegistries({ check: Boolean(options.check) }), summarizeHostRegistries);
  });

registry
  .command('register')
  .description('Register a known Registry endpoint with this host')
  .argument('<name>', 'Host-local Registry name')
  .argument('<url>', 'Registry API URL')
  .option('--no-verify', 'Register without probing the endpoint')
  .action(async (name: string, url: string, options: { verify?: boolean }) => {
    const { hostInventoryPath, registerHostRegistry } = await import('../host/inventory.js');
    const { normalizeRegistryUrl, verifyRegistryEndpoint } = await import('./registryConfig.js');

    await presenter().run('Registering Registry', async () => {
      const normalizedUrl = normalizeRegistryUrl(url);
      const verification = options.verify === false ? undefined : await verifyRegistryEndpoint(normalizedUrl);
      const result = await registerHostRegistry(name, normalizedUrl, { select: 'if-empty' });
      return {
        status: 'registered',
        ...result,
        inventoryPath: hostInventoryPath(),
        ...(verification ? { verification } : {}),
        ...(verification && !verification.ok
          ? { warning: `Registry ${result.registry.url} was registered, but it could not be verified.`, retryCommand: 'dkb registry list --check' }
          : options.verify === false
            ? { warning: `Registry ${result.registry.url} was registered without verification.`, retryCommand: 'dkb registry list --check' }
            : {}),
      };
    }, summarizeHostMutation);
  });

registry
  .command('unregister')
  .description('Forget a Registry endpoint when no registered Library uses it')
  .argument('<name>', 'Registered Registry name')
  .action(async (name: string) => {
    const { hostInventoryPath, unregisterHostRegistry } = await import('../host/inventory.js');
    await presenter().run('Unregistering Registry', async () => ({
      status: 'unregistered',
      ...await unregisterHostRegistry(name),
      inventoryPath: hostInventoryPath(),
    }), summarizeHostMutation);
  });

registry
  .command('status')
  .description('Show and verify the configured DKB registry')
  .option('--url <url>', 'Registry API URL to verify instead of the configured registry')
  .option('--root <path>', 'DKB Library whose upstream Registry should be inspected')
  .action(async (options: { url?: string; root?: string }) => {
    const { configuredRegistry, verifyRegistryEndpoint } = await import('./registryConfig.js');
    const configured = await configuredRegistry({ url: options.url, root: options.root });
    const verification = await verifyRegistryEndpoint(configured.url);

    presenter().print({
      registry: configured,
      verification,
    }, summarizeRegistryStatus);

    if (!verification.ok) {
      process.exitCode = 1;
    }
  });

registry
  .command('use')
  .description('Set the upstream Registry URL for the current DKB Library')
  .argument('<name-or-url>', 'Registered Registry name or Registry API URL')
  .option('--root <path>', 'DKB Library to configure')
  .option('--global', 'Set the user-wide fallback instead of a folder-specific URL')
  .option('--no-verify', 'Save the URL without validating it first')
  .action(async (nameOrUrl: string, options: { root?: string; global?: boolean; verify?: boolean }) => {
    const { normalizeRegistryUrl, verifyRegistryEndpoint, writeConfiguredRegistryUrl } = await import('./registryConfig.js');
    const { hostInventoryPath, registerHostLibrary, registerHostRegistry, registeredHostRegistry } = await import('../host/inventory.js');

    if (options.global && options.root) {
      throw new DkbError('Registry configuration cannot use --global and --root together.');
    }

    await presenter().run('Configuring registry', async () => {
      const known = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/iu.test(nameOrUrl)
        ? await registeredHostRegistry(nameOrUrl)
        : null;
      const url = known?.registry.url ?? normalizeRegistryUrl(nameOrUrl);
      const verification = options.verify === false ? undefined : await verifyRegistryEndpoint(url);
      const hostRegistry = known ?? await registerHostRegistry(undefined, url, { select: true });
      if (known) {
        await registerHostRegistry(known.name, known.registry.url, { select: true });
      }
      const configuredRoot = options.global ? undefined : await currentLibraryRoot(options.root);
      const configured = await writeConfiguredRegistryUrl(url, {
        root: configuredRoot,
        global: Boolean(options.global),
      });
      if (configuredRoot) {
        await registerHostLibrary(configuredRoot, {
          registryName: hostRegistry.name,
          registryUrl: configured.url,
        });
      }

      return {
        status: 'configured',
        registry: configured,
        host: { registry: hostRegistry.name, inventoryPath: hostInventoryPath() },
        ...(verification ? { verification } : {}),
        ...(verification && !verification.ok
          ? {
              warning: `Upstream registry URL was saved, but ${configured.url} could not be verified.`,
              retryCommand: `dkb registry status --url ${configured.url}`,
            }
          : options.verify === false
            ? {
                warning: `Upstream registry ${configured.url} was saved without verification.`,
                retryCommand: `dkb registry status --url ${configured.url}`,
              }
            : {}),
      };
    }, summarizeRegistryConfiguration);
  });

registry
  .command('compiler-serve', { hidden: true })
  .description('Start the DKB Registry compiler service')
  .option('--host <host>', 'Host to bind', process.env.DKB_REGISTRY_COMPILER_HOST || '127.0.0.1')
  .option('--port <number>', 'Port to bind', parsePositiveInteger, Number.parseInt(process.env.DKB_REGISTRY_COMPILER_PORT || '7333', 10))
  .action(async (options: { host: string; port: number }) => {
    const { serveDkbRegistryCompiler } = await import('@sjshovan/dkb-compiler/server.js');

    await serveDkbRegistryCompiler({
      host: options.host,
      port: options.port,
    });
  });

registry
  .command('login')
  .description('Authenticate this host with a Registry')
  .option('--url <url>', 'Registry API URL')
  .option('--token <token>', 'Registry API bearer token (prefer masked input or --token-stdin)')
  .option('--token-stdin', 'Read the Registry token from standard input')
  .action(async (options: { url?: string; token?: string; tokenStdin?: boolean }) => {
    const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
    const { saveRegistryCredential, registryCredentialsPath } = await import('@sjshovan/dkb-registry-client/credentials.js');
    const { configuredRegistry } = await import('./registryConfig.js');
    const { registryTokenInput } = await import('./registryAuth.js');
    const configured = await configuredRegistry({ url: options.url });

    await presenter().run('Authenticating registry', async () => {
      const token = await registryTokenInput(options);
      const identity = await new DkbRegistryClient({ baseUrl: configured.url, token }).whoAmI();
      await saveRegistryCredential(configured.url, {
        token,
        savedAt: new Date().toISOString(),
        user: identity.user.email,
        team: identity.team.slug,
      });
      return {
        status: 'authenticated',
        registry: configured.url,
        credentialsPath: registryCredentialsPath(),
        user: identity.user,
        team: identity.team,
        token: identity.token,
      };
    }, (value) => {
      const result = value as { registry: string; user: { email: string }; team: { slug: string }; token: { name: string; expiresAt?: string | null } };
      return [
        `Registry: ${result.registry}`,
        `Account: ${result.user.email}`,
        `Team: ${result.team.slug}`,
        `Credential: ${result.token.name}${result.token.expiresAt ? ` (expires ${result.token.expiresAt})` : ''}`,
      ];
    });
  });

registry
  .command('whoami')
  .description('Show the account and team for the active Registry credential')
  .option('--url <url>', 'Registry API URL')
  .option('--token <token>', 'Registry API bearer token', process.env.DKB_REGISTRY_TOKEN)
  .action(async (options: { url?: string; token?: string }) => {
    const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
    const { configuredRegistry } = await import('./registryConfig.js');
    const configured = await configuredRegistry({ url: options.url });
    const identity = await new DkbRegistryClient({ baseUrl: configured.url, token: options.token }).whoAmI();
    presenter().print({ registry: configured.url, ...identity }, (value) => {
      const result = value as { registry: string; user: { email: string }; team: { slug: string }; token: { name: string; abilities: string[]; expiresAt?: string | null } };
      return [
        `Registry: ${result.registry}`,
        `Account: ${result.user.email}`,
        `Team: ${result.team.slug}`,
        `Credential: ${result.token.name}`,
        `Scopes: ${result.token.abilities.join(', ') || 'none'}`,
        `Expires: ${result.token.expiresAt ?? 'never'}`,
      ];
    });
  });

registry
  .command('logout')
  .description('Remove the saved Registry credential from this host')
  .option('--url <url>', 'Registry API URL')
  .option('--revoke', 'Revoke the current token on the Registry before removing it')
  .action(async (options: { url?: string; revoke?: boolean }) => {
    const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
    const { loadRegistryCredentialSync, removeRegistryCredential, registryCredentialsPath } = await import('@sjshovan/dkb-registry-client/credentials.js');
    const { configuredRegistry } = await import('./registryConfig.js');
    const configured = await configuredRegistry({ url: options.url });

    await presenter().run('Removing registry credential', async () => {
      const credential = loadRegistryCredentialSync(configured.url);
      if (options.revoke && !credential) {
        throw new DkbError(`No saved credential exists for ${configured.url}; there is nothing to revoke.`);
      }
      if (options.revoke && credential) {
        await new DkbRegistryClient({ baseUrl: configured.url, token: credential.token }).revokeCurrentToken();
      }
      const removed = await removeRegistryCredential(configured.url);
      return {
        status: removed ? 'removed' : 'not configured',
        registry: configured.url,
        revoked: Boolean(options.revoke && credential),
        credentialsPath: registryCredentialsPath(),
      };
    }, (value) => {
      const result = value as { status: string; registry: string; revoked: boolean };
      return [
        `Registry: ${result.registry}`,
        `Local credential: ${result.status}`,
        `Remote token: ${result.revoked ? 'revoked' : 'unchanged'}`,
      ];
    });
  });

registry
  .command('packages')
  .description('List packages in the configured registry')
  .option('--url <url>', 'Registry API URL')
  .option('--token <token>', 'Registry API bearer token', process.env.DKB_REGISTRY_TOKEN)
  .action(async (options: { url?: string; token?: string }) => {
    const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
    const { configuredRegistry } = await import('./registryConfig.js');
    const registryConfig = await configuredRegistry({ url: options.url });
    presenter().print(await new DkbRegistryClient({ baseUrl: registryConfig.url, token: options.token }).packages(), summarizePackageListing);
  });

registry
  .command('keys')
  .description('List registry public signing keys')
  .option('--url <url>', 'Registry API URL')
  .option('--token <token>', 'Registry API bearer token', process.env.DKB_REGISTRY_TOKEN)
  .action(async (options: { url?: string; token?: string }) => {
    const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
    const { configuredRegistry } = await import('./registryConfig.js');
    const registryConfig = await configuredRegistry({ url: options.url });
    presenter().print(await new DkbRegistryClient({ baseUrl: registryConfig.url, token: options.token }).publicKeys(), summarizeKeyListing);
  });

const registryRemote = registry
  .command('remote')
  .description('Manage hosted runtime registrations');

registryRemote
  .command('claim')
  .description('Register a hosted runtime for a published package release')
  .argument('<package@version>', 'Published package release')
  .requiredOption('--url <url>', 'Public runtime URL')
  .option('--registry-url <url>', 'Registry API URL')
  .option('--token <token>', 'Registry API bearer token', process.env.DKB_REGISTRY_TOKEN)
  .action(async (release: string, options: { url: string; registryUrl?: string; token?: string }) => {
    const separator = release.lastIndexOf('@');

    if (separator <= 0 || separator === release.length - 1) {
      throw new DkbError('Remote claim requires package@version.');
    }

    const { configuredRegistry } = await import('./registryConfig.js');
    const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
    const registryConfig = await configuredRegistry({ url: options.registryUrl });
    const packageId = release.slice(0, separator);
    const version = release.slice(separator + 1);

    await presenter().run('Registering hosted runtime', async () => new DkbRegistryClient({ baseUrl: registryConfig.url, token: options.token }).claimRemoteEndpoint(packageId, version, options.url));
  });

registry
  .command('pull')
  .description('Pull a DKB package archive from the registry')
  .argument('<package-id>', 'Registry package id')
  .option('--version <version>', 'Package version')
  .option('--output <path>', 'Archive path to write')
  .option('--force', 'Replace an existing output archive')
  .option('--url <url>', 'Registry API URL')
  .option('--token <token>', 'Registry API bearer token', process.env.DKB_REGISTRY_TOKEN)
  .action(async (packageId: string, options: { version?: string; output?: string; force?: boolean; url?: string; token?: string }) => {
    const outputPath = path.resolve(options.output ?? defaultPackageArchiveName(packageId, options.version));

    if (!options.force && await exists(outputPath)) {
      throw new DkbError(`Output archive already exists: ${outputPath}. Use --force to replace it.`);
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
    const { configuredRegistry } = await import('./registryConfig.js');
    const registryConfig = await configuredRegistry({ url: options.url });
    const client = new DkbRegistryClient({ baseUrl: registryConfig.url, token: options.token });
    await presenter().run('Pulling package', async (progress) => {
      const release = await client.packageRelease(packageId, options.version);
      const download = await client.writePackageArchive(packageId, outputPath, release.version, {
        progress,
        force: Boolean(options.force),
      });
      return {
        status: 'pulled',
        packageId,
        version: release.version,
        archivePath: outputPath,
        archiveBytes: download.bytes,
        registry: registryConfig.url,
        ...(download.warning ? { warning: download.warning, cleanupPath: download.cleanupPath } : {}),
      };
    }, summarizeArtifactTransport);
  });

registry
  .command('verify')
  .description('Verify a DKB package receipt from the registry')
  .argument('<package-id>', 'Registry package id')
  .option('--version <version>', 'Package version')
  .option('--url <url>', 'Registry API URL')
  .option('--token <token>', 'Registry API bearer token', process.env.DKB_REGISTRY_TOKEN)
  .action(async (packageId: string, options: { version?: string; url?: string; token?: string }) => {
    const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
    const { DKB_PACKAGE_EXTENSION } = await import('@sjshovan/dkb-library/archive.js');
    const { verifyDkbArchiveFile } = await import('@sjshovan/dkb-runtime/runtime/registryInstall.js');
    const { configuredRegistry } = await import('./registryConfig.js');
    const registryConfig = await configuredRegistry({ url: options.url });
    const client = new DkbRegistryClient({ baseUrl: registryConfig.url, token: options.token });
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-verify-download-'));
    const archivePath = path.join(tempRoot, `${packageId}${DKB_PACKAGE_EXTENSION}`);
    try {
      const result = await presenter().check('Package verification', async (progress) => {
        const release = await client.packageRelease(packageId, options.version);
        await client.writePackageArchive(packageId, archivePath, release.version, { progress });
        const publicKeys = await client.publicKeys() as { keys: Parameters<typeof verifyDkbArchiveFile>[0]['trustedKeys'] };
        return verifyDkbArchiveFile({ archivePath, trustedKeys: publicKeys.keys, expectedArchiveHash: release.archiveHash, progress });
      }, (value) => value.ok);
      if (!result.ok) process.exitCode = 1;
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

registry
  .command('rotate-key', { hidden: true })
  .description('Rotate a Registry publisher account key')
  .argument('<account-id>', 'Publisher account id')
  .option('--url <url>', 'Registry API URL')
  .option('--token <token>', 'Registry API bearer token', process.env.DKB_REGISTRY_TOKEN)
  .action(async (accountId: string, options: { url?: string; token?: string }) => {
    const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
    const { configuredRegistry } = await import('./registryConfig.js');
    const registryConfig = await configuredRegistry({ url: options.url });
    await presenter().run('Rotating publisher key', async () => new DkbRegistryClient({ baseUrl: registryConfig.url, token: options.token }).rotateAccountKey(accountId));
  });

registry
  .command('rotate-registry-key', { hidden: true })
  .description('Rotate a Registry signing key')
  .option('--url <url>', 'Registry API URL')
  .option('--token <token>', 'Registry API bearer token', process.env.DKB_REGISTRY_TOKEN)
  .action(async (options: { url?: string; token?: string }) => {
    const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
    const { configuredRegistry } = await import('./registryConfig.js');
    const registryConfig = await configuredRegistry({ url: options.url });
    await presenter().run('Rotating registry key', async () => new DkbRegistryClient({ baseUrl: registryConfig.url, token: options.token }).rotateRegistryKey());
  });

registry
  .command('revoke-key', { hidden: true })
  .description('Revoke a Registry signing key')
  .argument('<key-id>', 'Signing key id')
  .option('--url <url>', 'Registry API URL')
  .option('--token <token>', 'Registry API bearer token', process.env.DKB_REGISTRY_TOKEN)
  .action(async (keyId: string, options: { url?: string; token?: string }) => {
    const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
    const { configuredRegistry } = await import('./registryConfig.js');
    const registryConfig = await configuredRegistry({ url: options.url });
    await presenter().run('Revoking signing key', async () => new DkbRegistryClient({ baseUrl: registryConfig.url, token: options.token }).revokeKey(keyId));
  });

program
  .command('publish')
  .description('Publish a DKB or immutable Collection revision to the configured Registry')
  .argument('[path]', 'DKB or Collection folder to publish', '.')
  .option('--url <url>', 'Registry API URL')
  .option('--account <id>', 'Publisher account id')
  .option('--name <name>', 'Publisher display name')
  .option('--email <email>', 'Publisher email')
  .option('--force', 'Replace an existing package version')
  .option('--remote-url <url>', 'Register a public hosted runtime after publishing')
  .option('--public', 'Publish the package to the public catalog')
  .option('--token <token>', 'Registry API bearer token', process.env.DKB_REGISTRY_TOKEN)
  .action(async (target: string, options: { url?: string; account?: string; name?: string; email?: string; force?: boolean; remoteUrl?: string; public?: boolean; token?: string }) => {
    const sourcePath = path.resolve(target);
    const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
    const { configuredRegistry } = await import('./registryConfig.js');
    const sourceManifest = await loadManifest(sourcePath);
    const libraryRoot = sourceManifest.type === 'collection'
      ? await currentLibraryRoot(undefined, sourcePath)
      : undefined;
    const registryConfig = await configuredRegistry({ url: options.url, root: libraryRoot });
    const client = new DkbRegistryClient({ baseUrl: registryConfig.url, token: options.token });
    if (sourceManifest.type === 'collection') {
      const { publishCollectionFromLibrary } = await import('@sjshovan/dkb-registry-client/collections.js');
      await presenter().run('Publishing Collection', async () => publishCollectionFromLibrary({
        collectionPath: sourcePath,
        libraryRoot: libraryRoot!,
        client,
        visibility: options.public ? 'public' : 'private',
      }), summarizeCollectionRevision);
      return;
    }
    if (sourceManifest.type !== 'dkb') {
      throw new DkbError('Libraries are runtime configuration and cannot be published. Publish a DKB or Collection folder.');
    }
    await presenter().run('Publishing DKB', async () => client.publish({
      sourcePath,
      accountId: options.account,
      accountName: options.name,
      accountEmail: options.email,
      force: Boolean(options.force),
      remoteUrl: options.remoteUrl,
      visibility: options.public || options.remoteUrl ? 'public' : 'private',
    }), summarizePublishResult);
  });

program
  .command('install')
  .description('Install a verified DKB or Collection from the configured Registry')
  .argument('<package-id>', 'Scoped Registry identity')
  .option('--version <version>', 'Package version')
  .option('--revision <revision>', 'Collection revision', parsePositiveInteger)
  .option('--target <name>', 'Exact compiled pipeline target for a DKB; defaults to the Registry target')
  .option('--url <url>', 'Registry API URL')
  .option('--runtime-url <url>', 'Owning Runtime URL; closes live retrieval handles before installation')
  .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
  .option('--force', 'Repair an incomplete install or replace an installed DKB')
  .option('--token <token>', 'Registry API bearer token', process.env.DKB_REGISTRY_TOKEN)
  .action(async (packageId: string, options: { version?: string; revision?: number; target?: string; url?: string; runtimeUrl?: string; library?: string; force?: boolean; token?: string }) => {
    const libraryRoot = await currentLibraryRoot(options.library);
    const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
    const { installDkbFromRegistry } = await import('@sjshovan/dkb-runtime/runtime/registryInstall.js');
    const { configuredRegistry } = await import('./registryConfig.js');
    const registryConfig = await configuredRegistry({ url: options.url, root: libraryRoot });
    const client = new DkbRegistryClient({ baseUrl: registryConfig.url, token: options.token });
    const kind = await client.entryKind(packageId);

    if (kind === 'collection') {
      if (options.version) throw new DkbError('--version applies to DKBs; use --revision for a Collection.');
      if (options.target) throw new DkbError('--target applies to DKBs. Install the Collection, then run dkb pipeline use <target>.');
      const { installRegistryCollection } = await import('@sjshovan/dkb-runtime/runtime/collections.js');
      await presenter().run('Installing Collection', async (progress) => installRegistryCollection({
        client,
        collectionId: packageId,
        revision: options.revision,
        libraryRoot,
        progress,
      }), summarizeCollectionInstall);
      return;
    }
    if (options.revision) throw new DkbError('--revision applies to Collections; use --version for a DKB.');

    if (options.runtimeUrl) {
      const runtime = await currentRuntimeAdminClient(options.runtimeUrl);
      await presenter().run('Installing DKB', async () => runtime.installRegistryDkb({
        registryUrl: registryConfig.url,
        registryToken: options.token,
        packageId,
        version: options.version,
        target: options.target,
        force: Boolean(options.force),
      }), summarizeInstallResult);
      return;
    }

    await presenter().run('Installing DKB', async (progress) => installDkbFromRegistry({
      registryUrl: registryConfig.url,
      registryToken: options.token,
      packageId,
      version: options.version,
      target: options.target,
      runtimeRoot: libraryRoot,
      force: Boolean(options.force),
      progress,
    }), summarizeInstallResult);
  });

program
  .command('list')
  .description('List DKBs and Collections in the current Library')
  .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
  .action(async (options: { library?: string }) => {
    const { listRuntimePackages } = await import('@sjshovan/dkb-runtime/runtime/state.js');
    const { configuredRegistry } = await import('./registryConfig.js');
    const libraryRoot = await currentLibraryRoot(options.library);
    const [listing, upstream] = await Promise.all([
      listRuntimePackages(libraryRoot),
      configuredRegistry({ root: libraryRoot }),
    ]);

    presenter().print({
      ...listing,
      registryUrl: upstream.url,
      registrySource: upstream.source,
    }, summarizeInstalledPackages);
  });

registerPackageLifecycleCommands(program, {
  presenter,
  resolveLibraryRoot: currentLibraryRoot,
  runtimeAdminClient: currentRuntimeAdminClient,
});

const remote = program
  .command('remote')
  .description('Discover and temporarily query public remote DKB runtimes');

remote
  .command('search')
  .description('Search packages that may have verified hosted runtimes')
  .argument('[query]', 'Package search query')
  .option('--registry-url <url>', 'Registry API URL')
  .option('--token <token>', 'Registry API bearer token', process.env.DKB_REGISTRY_TOKEN)
  .action(async (query: string | undefined, options: { registryUrl?: string; token?: string }) => {
    const { configuredRegistry } = await import('./registryConfig.js');
    const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
    const registryConfig = await configuredRegistry({ url: options.registryUrl });

    presenter().print(await new DkbRegistryClient({ baseUrl: registryConfig.url, token: options.token }).searchPackages(query), summarizePackageListing);
  });

remote
  .command('add')
  .description('Persist a verified registry remote, or label a direct URL as unverified')
  .argument('<package-or-url>', 'Package id or runtime URL')
  .option('--version <version>', 'Package version')
  .option('--endpoint <url>', 'Specific verified endpoint URL')
  .option('--registry-url <url>', 'Registry API URL')
  .option('--token <token>', 'Registry API bearer token', process.env.DKB_REGISTRY_TOKEN)
  .action(async (target: string, options: { version?: string; endpoint?: string; registryUrl?: string; token?: string }) => {
    const { addDirectRemote, addRegisteredRemote } = await import('../remote/manager.js');
    await presenter().run('Adding remote', async () => /^https?:\/\//i.test(target)
      ? addDirectRemote({ url: target })
      : addRegisteredRemote({
        packageId: target,
        version: options.version,
        endpointUrl: options.endpoint,
        registryUrl: options.registryUrl,
        token: options.token,
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

registerRuntimeImportCommand(
  runtime.command('import'),
  'Compile a local DKB and activate its verified artifact in the Runtime',
);

registerRuntimeImportCommand(
  program.command('add'),
  'Compile a local DKB and activate its verified artifact in the Runtime',
);

function registerRuntimeImportCommand(command: Command, description: string): void {
  command
    .description(description)
    .argument('<path>', 'Local DKB folder or raw knowledge folder')
    .option('--id <id>', 'Installed DKB id override')
    .option('--name <name>', 'Generated manifest display name for raw folders')
    .option('--force', 'Replace an existing installed DKB with the same id')
    .option('--url <url>', 'Runtime API URL; defaults to the selected Runtime')
    .option('--host-import-root <path>', 'Host staging directory mounted into the runtime', process.env.DKB_RUNTIME_HOST_IMPORT_ROOT || '.dkb/runtime/imports')
    .option('--container-import-root <path>', 'Runtime-visible import mount path', process.env.DKB_RUNTIME_CONTAINER_IMPORT_ROOT || '/imports')
    .option('--no-stage', 'Send the provided path directly to the runtime API')
    .action(runRuntimeImportCommand);
}

interface RuntimeImportCommandOptions {
  id?: string;
  name?: string;
  force?: boolean;
  url?: string;
  hostImportRoot: string;
  containerImportRoot: string;
  stage?: boolean;
}

async function runRuntimeImportCommand(target: string, options: RuntimeImportCommandOptions): Promise<void> {
  const compiledImport = await prepareCompiledRuntimeImport(target, options.id, options.name);
  let stagedImport: Awaited<ReturnType<typeof stageRuntimeImport>> | undefined;

  try {
    stagedImport = options.stage === false
      ? undefined
      : await stageRuntimeImport(compiledImport.path, options.hostImportRoot, options.containerImportRoot, compiledImport.id);
  } catch (error) {
    await compiledImport.cleanup().catch(() => undefined);
    throw error;
  }

  await presenter().run('Activating compiled package in Runtime', async () => {
    let result: unknown;

    try {
      result = await (await currentRuntimeAdminClient(options.url)).importArtifact({
        sourcePath: stagedImport?.containerPath ?? compiledImport.path,
        id: compiledImport.id,
        force: Boolean(options.force),
      });
    } catch (error) {
      if (stagedImport) {
        try {
          await fs.rm(stagedImport.hostPath, { recursive: true, force: true });
        } catch (cleanupError) {
          throw new DkbError(
            `${error instanceof Error ? error.message : String(error)} `
            + `The failed import staging directory also could not be removed: ${stagedImport.hostPath} `
            + `(${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)})`,
          );
        }
      }

      throw error;
    } finally {
      await compiledImport.cleanup().catch(() => undefined);
    }

    if (!stagedImport) {
      return result;
    }

    try {
      await fs.rm(stagedImport.hostPath, { recursive: true, force: true });
      return result;
    } catch (error) {
      const baseResult = result && typeof result === 'object' && !Array.isArray(result)
        ? result as Record<string, unknown>
        : { result };

      return {
        ...baseResult,
        warning: `Import succeeded, but its staging directory could not be removed: ${stagedImport.hostPath}`,
        cleanupPath: stagedImport.hostPath,
      };
    }
  }, summarizeInstallResult);
}

program
  .command('uninstall')
  .alias('remove')
  .description('Uninstall a DKB or Collection from the current Library')
  .argument('<identity>', 'Scoped @namespace/name identity')
  .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
  .option('--url <url>', 'Owning Runtime URL; use when the Library is served by a running Runtime')
  .action(async (identity: string, options: { library?: string; url?: string }) => {
    const { readLibraryState } = await import('@sjshovan/dkb-library/state.js');
    const libraryRoot = await currentLibraryRoot(options.library);
    const entry = (await readLibraryState(libraryRoot)).entries[identity];

    if (entry?.kind === 'collection' && entry.source === 'registry') {
      const { uninstallRegistryCollection } = await import('@sjshovan/dkb-runtime/runtime/collections.js');

      await presenter().run(`Uninstalling Collection ${identity}`, async () => uninstallRegistryCollection({
        libraryRoot,
        collectionId: identity,
      }), summarizeCollectionUninstall);
      return;
    }

    if (entry?.kind === 'collection') {
      const { removeLibraryRoot } = await import('@sjshovan/dkb-library/resolver.js');

      await presenter().run(`Deactivating ${identity}`, async () => removeLibraryRoot(libraryRoot, identity), summarizeLibrarySync);
      return;
    }

    if (options.url) {
      const runtime = await currentRuntimeAdminClient(options.url);
      await presenter().run(`Uninstalling ${identity}`, async () => runtime.removeDkb(identity), summarizeRemoveResult);
      return;
    }

    const { removeDkbFromRuntime } = await import('@sjshovan/dkb-runtime/runtime/state.js');

    await presenter().run(`Uninstalling ${identity}`, async (progress) => removeDkbFromRuntime(identity, libraryRoot, { progress }), summarizeRemoveResult);
  });

program
  .command('retrieve')
  .description('Retrieve grounded evidence from the runtime Library')
  .argument('<need>', 'Knowledge need')
  .option('--intent <intent>', 'Retrieval intent: evidence, records, count, summary, compare', 'evidence')
  .option('-l, --limit <number>', 'Maximum retrieved evidence count', parseLimit, 8)
  .option('--profile', 'Include retrieval profile metadata')
  .option('--url <url>', 'Runtime API URL; defaults to the selected Runtime')
  .action(async (
    need: string,
    options: { intent: 'evidence' | 'records' | 'count' | 'summary' | 'compare'; limit: number; profile?: boolean; url?: string },
  ) => {
    const { DkbRuntimeClient } = await import('@sjshovan/dkb-runtime/runtime/client.js');

    presenter().print(await new DkbRuntimeClient({ baseUrl: await currentRuntimeUrl(options.url) }).retrieve({
      need,
      intent: options.intent,
      limit: options.limit,
      profile: Boolean(options.profile),
    }), summarizeRetrievalResult);
  });

program
  .command('artifact')
  .description('Inspect, validate, and package immutable DKB Builds')
  .addCommand(new Command('inspect')
    .description('Inspect the active Evidence and Retrieval Build graph')
    .argument('<path>', 'Compiled DKB package directory')
    .action(async (target: string) => {
      const { validateCompiledPackage } = await import('@sjshovan/dkb-library/builds.js');

      printJson(await validateCompiledPackage(path.resolve(target)));
    }))
  .addCommand(new Command('validate')
    .description('Validate the immutable Evidence and Retrieval Build chain')
    .argument('<path>', 'Compiled DKB package directory')
    .action(async (target: string) => {
      const { validateCompiledPackage } = await import('@sjshovan/dkb-library/builds.js');
      const result = await presenter().check('Compiled Build validation', async () => validateCompiledPackage(path.resolve(target)), (value) => value.ok);

      if (!result.ok) {
        process.exitCode = 1;
      }
    }))
  .addCommand(new Command('pack')
    .description('Create a deterministic .dkbpkg archive from a validated Build graph')
    .argument('<path>', 'Compiled DKB package directory')
    .requiredOption('--out <path>', 'Archive path to write')
    .action(async (target: string, options: { out: string }) => {
      const { packCompiledPackage } = await import('@sjshovan/dkb-library/archive.js');

      await presenter().run('Packing compiled package', async () => packCompiledPackage(path.resolve(target), path.resolve(options.out)), summarizeArtifactTransport);
    }))
  .addCommand(new Command('install')
    .description('Install a validated extracted compiled artifact into a runtime without recompiling source')
    .argument('<path>', 'Extracted directory containing a compiled DKB artifact manifest')
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .option('--id <id>', 'Installed DKB id override')
    .option('--force', 'Replace an existing installed DKB with the same id')
    .action(async (target: string, options: { library?: string; id?: string; force?: boolean }) => {
      const { importCompiledDkbArtifactIntoRuntime } = await import('@sjshovan/dkb-runtime/runtime/state.js');
      const libraryRoot = await currentLibraryRoot(options.library);

      await presenter().run('Installing compiled artifact', async (progress) => importCompiledDkbArtifactIntoRuntime({
        sourcePath: path.resolve(target),
        id: options.id,
        force: Boolean(options.force),
        progress,
      }, libraryRoot), summarizeInstallResult);
    }))
  .addCommand(new Command('uninstall')
    .description('Remove an installed compiled artifact from a local runtime')
    .argument('<id>', 'Installed DKB id')
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .action(async (id: string, options: { library?: string }) => {
      const { removeDkbFromRuntime } = await import('@sjshovan/dkb-runtime/runtime/state.js');
      const libraryRoot = await currentLibraryRoot(options.library);

      await presenter().run(`Uninstalling ${id}`, async (progress) => removeDkbFromRuntime(id, libraryRoot, { progress }), summarizeRemoveResult);
    }))
  .addCommand(new Command('tools')
    .description('Inspect OCI transport and signing tool availability')
    .action(async () => {
      const { inspectOciToolAvailability } = await import('@sjshovan/dkb-library/oci.js');

      printJson(await inspectOciToolAvailability());
    }))
  .addCommand(new Command('oci-push')
    .description('Push a .dkbpkg artifact to an OCI registry using ORAS')
    .argument('<archive>', 'Compiled .dkbpkg archive')
    .argument('<ref>', 'OCI reference, for example localhost:5000/dkb/name:version')
    .action(async (archive: string, ref: string) => {
      const { orasPushArtifact } = await import('@sjshovan/dkb-library/oci.js');

      await presenter().run('Pushing artifact', async () => orasPushArtifact({ archivePath: path.resolve(archive), ref }), summarizeArtifactTransport);
    }))
  .addCommand(new Command('oci-pull')
    .description('Pull a .dkbpkg artifact from an OCI registry using ORAS')
    .argument('<ref>', 'OCI reference, for example localhost:5000/dkb/name:version')
    .requiredOption('--out <path>', 'Output directory')
    .action(async (ref: string, options: { out: string }) => {
      const { orasPullArtifact } = await import('@sjshovan/dkb-library/oci.js');

      await presenter().run('Pulling artifact', async () => orasPullArtifact({ ref, outputDir: path.resolve(options.out) }), summarizeArtifactTransport);
    }))
  .addCommand(new Command('cosign-keypair')
    .description('Create a local Cosign key pair')
    .requiredOption('--out <prefix>', 'Output key prefix')
    .requiredOption('--password <password>', 'Cosign key password')
    .action(async (options: { out: string; password: string }) => {
      const { cosignGenerateKeyPair } = await import('@sjshovan/dkb-library/oci.js');

      await presenter().run('Creating Cosign key pair', async () => cosignGenerateKeyPair({ outputPrefix: path.resolve(options.out), password: options.password }));
    }))
  .addCommand(new Command('cosign-sign')
    .description('Sign an OCI artifact with Cosign')
    .argument('<ref>', 'OCI reference to sign')
    .requiredOption('--key <path>', 'Cosign private key')
    .requiredOption('--password <password>', 'Cosign key password')
    .action(async (ref: string, options: { key: string; password: string }) => {
      const { cosignSignArtifact } = await import('@sjshovan/dkb-library/oci.js');

      await presenter().run('Signing artifact', async () => cosignSignArtifact({ ref, keyPath: path.resolve(options.key), password: options.password }));
    }))
  .addCommand(new Command('cosign-verify')
    .description('Verify a signed OCI artifact with Cosign')
    .argument('<ref>', 'OCI reference to verify')
    .requiredOption('--key <path>', 'Cosign public key')
    .action(async (ref: string, options: { key: string }) => {
      const { cosignVerifyArtifact } = await import('@sjshovan/dkb-library/oci.js');
      const result = await presenter().check('Artifact signature verification', async () => cosignVerifyArtifact({ ref, publicKeyPath: path.resolve(options.key) }), (value) => value.ok);

      if (!result.ok) {
        process.exitCode = 1;
      }
    }));

program
  .command('validate')
  .description('Validate a DKB, Collection, or Library')
  .argument('<path>', 'Directory containing a DKB manifest')
  .action(async (target: string) => {
    const resolved = path.resolve(target);
    const manifestFile = path.join(resolved, 'dkb.json');
    const manifest = await exists(manifestFile)
      ? JSON.parse(await fs.readFile(manifestFile, 'utf8')) as { type?: unknown; name?: unknown }
      : null;
    const output = manifest?.type === 'dkb'
      ? await loadDkb(resolved).then((dkb) => ({
          id: dkb.manifest.id,
          name: dkb.manifest.name,
          version: dkb.manifest.version,
          type: 'dkb',
        }))
      : manifest?.type === 'collection'
        ? await loadCollection(resolved).then((collection) => ({
            id: collection.manifest.id,
            name: collection.manifest.name,
            version: collection.manifest.version,
            type: 'collection',
          }))
        : await import('@sjshovan/dkb-protocol/manifest.js').then((module) => module.loadLibrary(resolved)).then((library) => ({
            id: library.manifest.id,
            name: library.manifest.name,
            version: library.manifest.version,
            type: 'library',
          }));

    printJson({
      ok: true,
      ...output,
    });
  });

const plugin = program
  .command('plugin')
  .description('Manage trusted filesystem plugins for this Library or the current user');

plugin
  .command('add')
  .description('Copy a plugin directory into DKB plugin storage')
  .argument('<source>', 'Plugin directory, or its plugin.mjs entrypoint')
  .option('--root <path>', 'Library or Runtime root', '.')
  .option('--global', 'Install for the current user instead of this Library')
  .action(async (source: string, options: { root: string; global?: boolean }) => {
    const { addPlugin } = await import('../providers/management.js');
    await presenter().run('Adding plugin', async () => addPlugin({
      root: path.resolve(options.root),
      source,
      scope: options.global ? 'global' : 'local',
    }), summarizePluginMutation);
  });

plugin
  .command('link')
  .description('Link a development plugin into DKB plugin storage')
  .argument('<source>', 'Plugin directory, or its plugin.mjs entrypoint')
  .option('--root <path>', 'Library or Runtime root', '.')
  .option('--global', 'Link for the current user instead of this Library')
  .action(async (source: string, options: { root: string; global?: boolean }) => {
    const { linkPlugin } = await import('../providers/management.js');
    await presenter().run('Linking plugin', async () => linkPlugin({
      root: path.resolve(options.root),
      source,
      scope: options.global ? 'global' : 'local',
    }), summarizePluginMutation);
  });

plugin
  .command('remove')
  .description('Remove an unselected plugin from DKB plugin storage')
  .argument('<id>', 'Namespaced plugin id, such as @team/provider')
  .option('--root <path>', 'Library or Runtime root', '.')
  .option('--global', 'Remove from current-user storage instead of this Library')
  .action(async (id: string, options: { root: string; global?: boolean }) => {
    const { removePlugin } = await import('../providers/management.js');
    await presenter().run('Removing plugin', async () => removePlugin({
      root: path.resolve(options.root),
      id,
      scope: options.global ? 'global' : 'local',
    }), summarizePluginMutation);
  });

plugin
  .command('list')
  .description('List local, current-user, and bundled plugins')
  .argument('[path]', 'Library or Runtime root', '.')
  .action(async (target: string) => {
    const { listPlugins } = await import('../providers/management.js');
    presenter().print(await listPlugins({ root: path.resolve(target) }), summarizePluginList);
  });

const pipeline = program
  .command('pipeline')
  .description('Inspect, select, and verify the provider pipeline');

pipeline
  .command('list')
  .description('List configured pipeline targets')
  .argument('[path]', 'Library, Runtime, or DKB root', '.')
  .action(async (target: string) => {
    const { listPipelineTargets } = await import('../providers/management.js');
    presenter().print(await listPipelineTargets({ root: path.resolve(target) }), summarizePipelineList);
  });

pipeline
  .command('show')
  .description('Show the resolved target, providers, precedence, and build digest')
  .argument('[path]', 'Library or Runtime root', '.')
  .option('--target <name>', 'Show a configured target other than the active target')
  .action(async (target: string, options: { target?: string }) => {
    const [{ DkbProviderHost }, { DEFAULT_DKB_DISTRIBUTION }] = await Promise.all([
      import('@sjshovan/dkb-pipeline/host.js'),
      import('@sjshovan/dkb-distribution-default'),
    ]);
    const host = await DkbProviderHost.create({ root: path.resolve(target), target: options.target, distribution: DEFAULT_DKB_DISTRIBUTION });

    try {
      presenter().print(host.describe(), summarizePipeline);
    } finally {
      await host.dispose();
    }
  });

pipeline
  .command('use')
  .description('Prepare and atomically activate a pipeline target')
  .argument('<name>', 'Configured target name')
  .argument('[path]', 'Library, Runtime, or DKB root', '.')
  .option('--runtime-url <url>', 'Owning Runtime URL')
  .option('--registry-url <url>', 'Registry API URL used to fetch missing signed builds')
  .option('--token <token>', 'Registry API bearer token', process.env.DKB_REGISTRY_TOKEN)
  .action(async (name: string, target: string, options: { runtimeUrl?: string; registryUrl?: string; token?: string }) => {
    const root = path.resolve(target);
    const manifest = await loadManifest(root);

    await presenter().run(`Activating pipeline ${name}`, async () => {
      if (manifest.type === 'dkb') {
        const [{ DkbProviderHost }, { DEFAULT_DKB_DISTRIBUTION }, { resolveProviderRetrievalProfile }, { activateStoredPackageBuild }] = await Promise.all([
          import('@sjshovan/dkb-pipeline/host.js'),
          import('@sjshovan/dkb-distribution-default'),
          import('@sjshovan/dkb-pipeline/profile.js'),
          import('@sjshovan/dkb-library/builds.js'),
        ]);
        const host = await DkbProviderHost.create({ root, target: name, distribution: DEFAULT_DKB_DISTRIBUTION });
        try {
          const resolved = await resolveProviderRetrievalProfile(host);
          try {
            await activateStoredPackageBuild({
              root,
              target: name,
              evidenceProfileDigest: resolved.evidenceProfileDigest,
              retrievalProfileDigest: resolved.retrievalProfileDigest,
              compatibilityDigest: stableHash(resolved.compatibility),
            });
          } catch (error) {
            if (!/No stored Retrieval Build exists/u.test(error instanceof Error ? error.message : String(error))) throw error;
            const { compileComposeProject } = await import('@sjshovan/dkb-compiler/compile.js');
            await compileComposeProject(root, { mode: 'package', target: name });
          }
        } finally {
          await host.dispose();
        }
        const { activatePipelineTarget } = await import('../providers/management.js');
        return activatePipelineTarget({ root, name });
      }
      if (manifest.type !== 'library') {
        throw new DkbError(`Pipeline activation requires a DKB or Library root, got ${manifest.type}`);
      }
      const [{ readLibraryState }, { ensurePackageBuildForTarget }] = await Promise.all([
        import('@sjshovan/dkb-library/state.js'),
        import('@sjshovan/dkb-compiler/compile.js'),
      ]);
      const state = await readLibraryState(root);
      const localPreparations = [];
      for (const entry of Object.values(state.entries)
        .filter((item) => item.kind === 'dkb' && item.source === 'local' && item.status === 'installed')
        .sort((left, right) => left.identity.localeCompare(right.identity))) {
        localPreparations.push({
          package: entry.identity,
          ...await ensurePackageBuildForTarget(path.resolve(root, entry.path), { target: name, contextRoot: root }),
        });
      }
      const { configuredRegistry } = await import('./registryConfig.js');
      const registry = await configuredRegistry({ url: options.registryUrl, root });
      const runtime = await currentRuntimeAdminClient(options.runtimeUrl, 40 * 60_000);
      const switched = await runtime.switchPipeline({
        target: name,
        registryUrl: registry.url,
        registryToken: options.token,
      });
      if (!switched || typeof switched !== 'object' || Array.isArray(switched)) {
        throw new DkbError('Runtime returned an invalid pipeline-switch response');
      }
      return { ...switched as Record<string, unknown>, localPreparations };
    }, (result) => result && typeof result === 'object' && !Array.isArray(result)
      && (result as Record<string, unknown>).status === 'pipeline_switched'
      ? summarizePipelineSwitch(result)
      : summarizePipeline(result));
  });

pipeline
  .command('set')
  .description('Validate and atomically save a complete pipeline target')
  .argument('<name>', 'Target name')
  .option('--root <path>', 'Library or Runtime root', '.')
  .option('--evidence <id>', 'Fused Evidence provider')
  .option('--parser <id>', 'Parser provider; requires --chunker')
  .option('--chunker <id>', 'Chunker provider; requires --parser')
  .requiredOption('--embedding <id>', 'Document and query embedding provider')
  .requiredOption('--index <id>', 'Packaged or managed index provider')
  .requiredOption('--retrieval <id>', 'Retrieval and ranking provider')
  .option('--processor <ids...>', 'Ordered processor plugin ids')
  .option('--provider-options <json>', 'Provider options object keyed by plugin id')
  .option('--no-activate', 'Save the target without making it active')
  .action(async (name: string, options: {
    root: string;
    evidence?: string;
    parser?: string;
    chunker?: string;
    embedding: string;
    index: string;
    retrieval: string;
    processor?: string[];
    providerOptions?: string;
    activate: boolean;
  }) => {
    if (Boolean(options.evidence) === Boolean(options.parser || options.chunker)) {
      throw new DkbError('Select either --evidence or both --parser and --chunker.');
    }
    if (!options.evidence && (!options.parser || !options.chunker)) {
      throw new DkbError('--parser and --chunker must be selected together.');
    }
    const providerOptions = options.providerOptions
      ? parseJsonObject(options.providerOptions, '--provider-options') as Record<string, Record<string, unknown>>
      : {};
    const { setPipelineTarget } = await import('../providers/management.js');
    await presenter().run('Updating pipeline', async () => setPipelineTarget({
      root: path.resolve(options.root),
      name,
      activate: options.activate,
      patch: {
        ...(options.evidence ? { evidence: options.evidence } : { parser: options.parser, chunker: options.chunker }),
        embedding: options.embedding,
        index: options.index,
        retrieval: options.retrieval,
        processors: options.processor ?? [],
        options: providerOptions,
      },
    }), summarizePipeline);
  });

pipeline
  .command('verify')
  .description('Load the selected providers and report their health')
  .argument('[path]', 'Library or Runtime root', '.')
  .option('--target <name>', 'Verify a configured target other than the active target')
  .action(async (target: string, options: { target?: string }) => {
    const { verifyPipeline } = await import('../providers/management.js');
    const result = await presenter().check('Pipeline verification', async () => verifyPipeline({
      root: path.resolve(target),
      ...(options.target ? { target: options.target } : {}),
    }), (value) => value.ok, summarizePipelineVerification);

    if (!result.ok) {
      process.exitCode = 1;
    }
  });

const build = program
  .command('build')
  .description('Compile and manage stored Evidence and Retrieval Builds')
  .argument('[path]', 'Directory containing dkb.json', '.')
  .option('--force', 'Rebuild generated artifacts even when the local compile cache is valid')
  .option('--pipeline <name>', 'Configured pipeline target')
  .action(async (target: string, options: { force?: boolean; pipeline?: string }) => runCompileCommand('Building', target, options));

program
  .command('compile')
  .description('Compile a DKB or Library with its selected pipeline target')
  .argument('[path]', 'Directory containing dkb.json', '.')
  .option('--force', 'Rebuild generated artifacts even when the local compile cache is valid')
  .option('--pipeline <name>', 'Configured pipeline target')
  .option('--target <name>', 'Compatibility name for --pipeline')
  .action(async (target: string, options: { force?: boolean; pipeline?: string; target?: string }) => runCompileCommand('Compiling', target, options));

async function runCompileCommand(
  activity: 'Building' | 'Compiling',
  target: string,
  options: { force?: boolean; pipeline?: string; target?: string },
): Promise<void> {
  if (options.pipeline && options.target && options.pipeline !== options.target) {
    throw new DkbError('--pipeline and --target must name the same pipeline when both are provided.');
  }
  const root = path.resolve(target);
  const manifest = await loadManifest(root);
  const { compileComposeProject } = await import('@sjshovan/dkb-compiler/compile.js');
  const pipelineTarget = options.pipeline ?? options.target;

  await presenter().run(`${activity} ${root}`, async () => compileComposeProject(root, {
    force: Boolean(options.force),
    mode: manifest.type === 'dkb' ? 'package' : 'library',
    ...(pipelineTarget ? { target: pipelineTarget } : {}),
  }), summarizeCompileResult);
}

build
  .command('list')
  .description('List stored Evidence and Retrieval Builds')
  .argument('[path]', 'Compiled DKB root', '.')
  .action(async (target: string) => {
    const { listPackageBuilds } = await import('@sjshovan/dkb-library/builds.js');
    presenter().print(await listPackageBuilds(path.resolve(target)), summarizeBuildList);
  });

build
  .command('inspect')
  .description('Inspect one Evidence or Retrieval Build')
  .argument('<digest>', 'Evidence, Retrieval Build, or profile digest')
  .argument('[path]', 'Compiled DKB root', '.')
  .action(async (digest: string, target: string) => {
    const { inspectPackageBuild } = await import('@sjshovan/dkb-library/builds.js');
    presenter().print(await inspectPackageBuild(path.resolve(target), digest), summarizeBuildInspect);
  });

build
  .command('prune')
  .description('Remove inactive Builds while retaining the active Runtime graph')
  .argument('[path]', 'Compiled DKB root', '.')
  .action(async (target: string) => {
    const { prunePackageBuilds } = await import('@sjshovan/dkb-library/builds.js');
    await presenter().run('Pruning inactive Builds', async () => prunePackageBuilds(path.resolve(target)), summarizeBuildPrune);
  });

program
  .command('compiler')
  .description('Manage the selected Evidence provider service')
  .addCommand(new Command('inspect')
    .description('Inspect the selected Evidence provider')
    .option('--root <path>', 'Library or Runtime root', '.')
    .option('--target <name>', 'Configured pipeline target')
    .action(async (options: { root: string; target?: string }) => {
      presenter().print(await runEvidenceLifecycle(options.root, options.target, 'inspect'), summarizeCompilerStatus);
    }))
  .addCommand(new Command('start')
    .description('Start or reuse the selected Evidence provider service')
    .option('--root <path>', 'Library or Runtime root', '.')
    .option('--target <name>', 'Configured pipeline target')
    .option('--restart', 'Replace any existing provider service')
    .action(async (options: { root: string; target?: string; restart?: boolean }) => {
      await presenter().run('Starting Evidence service', async () => runEvidenceLifecycle(options.root, options.target, 'start', { restart: Boolean(options.restart) }), summarizeCompilerStatus);
    }))
  .addCommand(new Command('status')
    .description('Show selected Evidence provider service status')
    .option('--root <path>', 'Library or Runtime root', '.')
    .option('--target <name>', 'Configured pipeline target')
    .action(async (options: { root: string; target?: string }) => {
      presenter().print(await runEvidenceLifecycle(options.root, options.target, 'status'), summarizeCompilerStatus);
    }))
  .addCommand(new Command('stop')
    .description('Stop the selected Evidence provider service')
    .option('--root <path>', 'Library or Runtime root', '.')
    .option('--target <name>', 'Configured pipeline target')
    .action(async (options: { root: string; target?: string }) => {
      await presenter().run('Stopping Evidence service', async () => runEvidenceLifecycle(options.root, options.target, 'stop'), summarizeCompilerStatus);
    }))
  .addCommand(new Command('doctor')
    .description('Diagnose selected Evidence provider readiness')
    .option('--root <path>', 'Library or Runtime root', '.')
    .option('--target <name>', 'Configured pipeline target')
    .action(async (options: { root: string; target?: string }) => {
      const result = await runEvidenceLifecycle(options.root, options.target, 'doctor') as { ok?: unknown };
      presenter().print(result, summarizeCompilerStatus);

      if (!result.ok) {
        process.exitCode = 1;
      }
    }));

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

    presenter().print((await queryKnowledgeTarget(target, query, { limit: options.limit })).response, summarizeQueryResult);
  });

program
  .command('read-targets')
  .description('Describe queryable DKB Read API targets from compiled Library artifacts')
  .argument('<library-path>', 'Directory containing compiled Library, Collection, or DKB artifacts')
  .argument('<query>', 'Natural-language lookup intent for ranking chunk targets')
  .option('-l, --limit <number>', 'Maximum target count', parseLimit, 10)
  .action(async (target: string, query: string, options: { limit: number }) => {
    const { describeQueryTargets } = await import('@sjshovan/dkb-runtime/read/runtime.js');

    printJson(await describeQueryTargets(target, query, options.limit));
  });

program
  .command('read')
  .description('Execute a DKB Read API request JSON file against compiled Library artifacts')
  .argument('<library-path>', 'Directory containing compiled Library, Collection, or DKB artifacts')
  .argument('<request-path>', 'Path to a DKB Read API request JSON file')
  .action(async (target: string, requestPath: string) => {
    const fs = await import('node:fs/promises');
    const { readDkb } = await import('@sjshovan/dkb-runtime/read/runtime.js');

    printJson(await readDkb(target, JSON.parse(await fs.readFile(requestPath, 'utf8'))));
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
      printJsonValue({ ok: false, error: { code: 'DKB_ERROR', message } });
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

function summarizeCompileResult(value: unknown): string[] {
  const result = value as {
    registryId?: unknown;
    recordCount?: unknown;
    cacheHit?: unknown;
    artifactManifestPath?: unknown;
    profile?: {
      timingsMs?: Record<string, unknown>;
      aggregateTimingsMs?: Record<string, unknown>;
      statistics?: {
        corpus?: Record<string, unknown>;
        storage?: Record<string, unknown>;
        providerStages?: Array<Record<string, unknown>>;
      };
    };
  };
  const total = milliseconds(result.profile?.timingsMs?.total);
  const aggregate = milliseconds(result.profile?.aggregateTimingsMs?.total);
  const corpus = result.profile?.statistics?.corpus;
  const storage = result.profile?.statistics?.storage;
  const providerStage = result.profile?.statistics?.providerStages?.[0];
  const ingestionTimings = providerStage?.ingestionTimingsMs && typeof providerStage.ingestionTimingsMs === 'object'
    ? providerStage.ingestionTimingsMs as Record<string, unknown>
    : undefined;
  const embeddingTimings = providerStage?.embeddingTimingsMs && typeof providerStage.embeddingTimingsMs === 'object'
    ? providerStage.embeddingTimingsMs as Record<string, unknown>
    : undefined;
  const recordsPerSource = corpus?.recordsPerSource && typeof corpus.recordsPerSource === 'object'
    ? corpus.recordsPerSource as Record<string, unknown>
    : undefined;

  return [
    `registry: ${String(result.registryId ?? 'unknown')}`,
    countLabel(result.recordCount, 'record') ?? '',
    `cache: ${result.cacheHit ? 'hit' : 'updated'}`,
    total ? `total: ${total}` : '',
    aggregate ? `artifact work: ${aggregate}` : '',
    milliseconds(ingestionTimings?.total) ? `ingestion: ${milliseconds(ingestionTimings?.total)}` : '',
    milliseconds(embeddingTimings?.total) ? `embedding: ${milliseconds(embeddingTimings?.total)}` : '',
    finiteBytes(corpus?.sourceBytes) ? `source: ${formatBytes(Number(corpus?.sourceBytes))} across ${String(corpus?.sourceFiles ?? 0)} files` : '',
    finiteBytes(corpus?.evidenceTextBytes) ? `evidence text: ${formatBytes(Number(corpus?.evidenceTextBytes))} across ${String(corpus?.evidenceRecords ?? 0)} records` : '',
    typeof recordsPerSource?.p50 === 'number' && typeof recordsPerSource?.p95 === 'number'
      ? `chunks per source: p50 ${recordsPerSource.p50}, p95 ${recordsPerSource.p95}, max ${String(recordsPerSource.max ?? 0)}`
      : '',
    finiteBytes(storage?.totalDerivedBytes)
      ? `derived storage: ${formatBytes(Number(storage?.totalDerivedBytes))}${typeof storage?.sourceToDerivedRatio === 'number' ? ` (${storage.sourceToDerivedRatio}x source)` : ''}`
      : '',
    typeof result.artifactManifestPath === 'string' ? `artifact: ${result.artifactManifestPath}` : '',
  ];
}

function finiteBytes(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function summarizePluginMutation(value: unknown): string[] {
  const result = value as { id?: unknown; version?: unknown; scope?: unknown; path?: unknown; removed?: unknown };
  return [
    `plugin: ${String(result.id ?? '-')}`,
    result.version ? `version: ${String(result.version)}` : '',
    `scope: ${String(result.scope ?? 'local')}`,
    typeof result.removed === 'boolean' ? `removed: ${result.removed ? 'yes' : 'not installed'}` : '',
    typeof result.path === 'string' ? `path: ${result.path}` : '',
  ];
}

function summarizePluginList(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : [];

  return humanSummary({
    plugins: entries.map((item) => {
      const entry = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      return {
        id: entry.id ?? '-',
        version: entry.version ?? '-',
        scope: entry.scope ?? '-',
        selected: entry.selected ? 'yes' : '',
        status: entry.valid ? 'ready' : 'invalid',
      };
    }),
  });
}

function summarizePipeline(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const providers = Array.isArray(result.providers) ? result.providers : [];
  const processors = Array.isArray(result.processors) ? result.processors : [];

  return [
    `target: ${String(result.target ?? '-')}`,
    typeof result.root === 'string' ? `context: ${result.root}` : '',
    typeof result.configDigest === 'string' ? `configuration: ${result.configDigest}` : '',
    typeof result.buildDigest === 'string' ? `build: ${result.buildDigest}` : '',
    ...humanSummary({ providers: [...providers, ...processors] }),
  ];
}

function summarizePipelineSwitch(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const packages = Array.isArray(result.packages) ? result.packages : [];
  const localPreparations = Array.isArray(result.localPreparations) ? result.localPreparations : [];

  return [
    `pipeline: ${String(result.target ?? '-')}`,
    `previous: ${String(result.previousTarget ?? '-')}`,
    typeof result.libraryPath === 'string' ? `library: ${result.libraryPath}` : '',
    typeof result.compatibilityDigest === 'string' ? `compatibility: ${result.compatibilityDigest}` : '',
    ...humanSummary({
      localBuilds: localPreparations.map((value) => {
        const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        return {
          package: item.package ?? '-',
          preparation: item.preparation ?? '-',
          status: 'ready',
        };
      }),
    }),
    ...humanSummary({
      packages: packages.map((value) => {
        const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        return {
          package: item.id ?? '-',
          version: item.version ?? '-',
          source: item.source ?? '-',
          build: item.preparation ?? '-',
          status: 'ready',
        };
      }),
    }),
  ];
}

function summarizePipelineList(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const targets = Array.isArray(result.targets) ? result.targets : [];
  return [
    typeof result.root === 'string' ? `context: ${result.root}` : '',
    ...humanSummary({
      targets: targets.map((value) => {
        const target = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        return {
          default: target.active ? '*' : '',
          name: target.name ?? '-',
          providers: Array.isArray(target.providers) ? target.providers.join(', ') : '-',
        };
      }),
    }),
  ];
}

function summarizeBuildList(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const evidence = Array.isArray(result.evidence) ? result.evidence : [];
  const retrieval = Array.isArray(result.retrieval) ? result.retrieval : [];
  const rows: Array<Record<string, unknown>> = [
    ...evidence.map((value) => ({ ...(value as Record<string, unknown>), kind: 'evidence', digest: (value as Record<string, unknown>).evidenceDigest })),
    ...retrieval.map((value) => ({ ...(value as Record<string, unknown>), kind: 'retrieval', digest: (value as Record<string, unknown>).buildDigest })),
  ];
  return [
    typeof result.root === 'string' ? `package: ${result.root}` : '',
    ...humanSummary({
      builds: rows.map((row) => ({
        active: row.active ? '*' : '',
        kind: row.kind,
        profile: shortDigest(row.profileDigest),
        digest: shortDigest(row.digest),
      })),
    }),
  ];
}

function summarizeBuildInspect(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const lock = result.lock && typeof result.lock === 'object' ? result.lock as Record<string, unknown> : {};
  return [
    `kind: ${String(result.kind ?? '-')}`,
    `status: ${result.active ? 'active' : 'ready'}`,
    typeof result.path === 'string' ? `path: ${result.path}` : '',
    `digest: ${String(lock.evidenceDigest ?? lock.retrievalBuildDigest ?? '-')}`,
  ];
}

function summarizeBuildPrune(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const removed = Array.isArray(result.removed) ? result.removed : [];
  const retained = Array.isArray(result.retained) ? result.retained : [];
  return [`removed: ${removed.length}`, `retained: ${retained.length}`];
}

function shortDigest(value: unknown): string {
  return typeof value === 'string' && value.startsWith('sha256:') ? `${value.slice(7, 19)}…` : String(value ?? '-');
}

function summarizePipelineVerification(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const health = Array.isArray(result.health) ? result.health : [];
  const pipeline = result.pipeline && typeof result.pipeline === 'object' ? result.pipeline as Record<string, unknown> : {};

  return [
    `target: ${String(pipeline.target ?? '-')}`,
    ...humanSummary({ providers: health }),
  ];
}

function summarizeInitResult(value: unknown): string[] {
  const result = value as {
    status?: unknown;
    type?: unknown;
    root?: unknown;
    manifest?: unknown;
    registry?: { url?: unknown; source?: unknown };
    host?: { library?: unknown; inventoryPath?: unknown };
    warning?: unknown;
    retryCommand?: unknown;
  };

  return [
    `status: ${String(result.status ?? 'initialized')}`,
    `type: ${String(result.type ?? 'package')}`,
    typeof result.root === 'string' ? `path: ${result.root}` : '',
    typeof result.manifest === 'string' ? `manifest: ${result.manifest}` : '',
    typeof result.registry?.url === 'string'
      ? `registry: ${result.registry.url} (${String(result.registry.source ?? 'project')})`
      : '',
    result.host?.library ? `host Library: ${String(result.host.library)}` : '',
    result.host?.inventoryPath ? `inventory: ${String(result.host.inventoryPath)}` : '',
    typeof result.warning === 'string' ? `warning: ${result.warning}` : '',
    typeof result.retryCommand === 'string' ? `retry: ${result.retryCommand}` : '',
  ];
}

function summarizeHostLibraries(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const libraries = Array.isArray(result.libraries) ? result.libraries : [];

  return [
    `inventory: ${String(result.inventoryPath ?? '-')}`,
    `default: ${String(result.selected ?? 'none')}`,
    '',
    ...humanSummary({
      results: libraries.map((value) => {
        const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        return {
          default: item.selected ? '*' : '',
          name: item.name ?? '-',
          status: item.status ?? '-',
          registry: item.registry ?? '-',
          path: item.path ?? '-',
        };
      }),
    }),
  ];
}

function summarizeHostRegistries(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const registries = Array.isArray(result.registries) ? result.registries : [];

  return [
    `inventory: ${String(result.inventoryPath ?? '-')}`,
    `default: ${String(result.selected ?? 'none')}`,
    `network checks: ${result.checked ? 'enabled' : 'skipped'}`,
    '',
    ...humanSummary({
      results: registries.map((value) => {
        const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        return {
          default: item.selected ? '*' : '',
          name: item.name ?? '-',
          status: item.status ?? '-',
          usedBy: Array.isArray(item.usedBy) && item.usedBy.length > 0 ? item.usedBy.join(', ') : '-',
          url: item.url ?? '-',
        };
      }),
    }),
  ];
}

function summarizeHostRuntimes(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const runtimes = Array.isArray(result.runtimes) ? result.runtimes : [];

  return [
    `inventory: ${String(result.inventoryPath ?? '-')}`,
    `default: ${String(result.selected ?? 'none')}`,
    `network checks: ${result.checked ? 'enabled' : 'skipped'}`,
    '',
    ...humanSummary({
      results: runtimes.map((value) => {
        const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        return {
          default: item.selected ? '*' : '',
          name: item.name ?? '-',
          kind: item.kind ?? '-',
          status: item.status ?? '-',
          library: item.library ?? '-',
          url: item.url ?? '-',
        };
      }),
    }),
  ];
}

function summarizeHostMutation(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const library = result.library && typeof result.library === 'object' ? result.library as Record<string, unknown> : {};
  const registry = result.registry && typeof result.registry === 'object' ? result.registry as Record<string, unknown> : {};
  const runtime = result.runtime && typeof result.runtime === 'object' ? result.runtime as Record<string, unknown> : {};

  return [
    `status: ${String(result.status ?? 'updated')}`,
    result.name ? `name: ${String(result.name)}` : '',
    library.displayName ? `Library: ${String(library.displayName)}` : '',
    library.path ? `path: ${String(library.path)}` : '',
    library.registry ? `registry: ${String(library.registry)}` : '',
    registry.url ? `registry: ${String(registry.url)}` : '',
    runtime.kind ? `kind: ${String(runtime.kind)}` : '',
    runtime.library ? `Library: ${String(runtime.library)}` : '',
    runtime.url ? `URL: ${String(runtime.url)}` : '',
    result.path && !library.path ? `path: ${String(result.path)}` : '',
    result.url && !registry.url && !runtime.url ? `URL: ${String(result.url)}` : '',
    result.composeFile ? `compose file: ${String(result.composeFile)}` : '',
    typeof result.selectedCleared === 'boolean' ? `default cleared: ${result.selectedCleared ? 'yes' : 'no'}` : '',
    result.inventoryPath ? `inventory: ${String(result.inventoryPath)}` : '',
    result.warning ? `warning: ${String(result.warning)}` : '',
    result.retryCommand ? `retry: ${String(result.retryCommand)}` : '',
  ].filter(Boolean);
}

function summarizeLibrarySync(value: unknown): string[] {
  const result = value as { status?: unknown; lock?: { generation?: unknown; entries?: Record<string, unknown> } };
  const count = Object.keys(result.lock?.entries ?? {}).length;
  return [
    `status: ${String(result.status ?? 'synchronized')}`,
    `generation: ${String(result.lock?.generation ?? '-')}`,
    `active entries: ${count}`,
  ];
}

function summarizeCollectionMutation(value: unknown): string[] {
  const result = value as {
    identity?: unknown;
    collectionIdentity?: unknown;
    dkbIdentity?: unknown;
    selector?: unknown;
    status?: unknown;
    root?: unknown;
  };
  return [
    `status: ${String(result.status ?? 'updated')}`,
    result.identity ? `collection: ${String(result.identity)}` : '',
    result.collectionIdentity ? `collection: ${String(result.collectionIdentity)}` : '',
    result.dkbIdentity ? `DKB: ${String(result.dkbIdentity)}${result.selector ? `@${String(result.selector)}` : ''}` : '',
    result.root ? `path: ${String(result.root)}` : '',
  ];
}

function summarizeCollectionOverview(value: unknown): string[] {
  const result = value as {
    identity?: unknown;
    displayName?: unknown;
    active?: unknown;
    members?: Array<{ identity?: unknown; selector?: unknown }>;
  };
  const members = result.members ?? [];
  const tree = members.length === 0
    ? ['(none)']
    : members.map((member, index) => `${index === members.length - 1 ? '└──' : '├──'} ${String(member.identity ?? '-')}@${String(member.selector ?? 'latest')}`);
  return [
    String(result.identity ?? '-'),
    `name: ${String(result.displayName ?? '-')}`,
    `status: ${result.active ? 'active' : 'inactive'}`,
    ...tree,
  ];
}

function summarizeCollectionRevision(value: unknown): string[] {
  const result = value as {
    collectionId?: unknown;
    revision?: unknown;
    digest?: unknown;
    manifest?: { members?: unknown[] };
  };
  return [
    'status: published',
    `collection: ${String(result.collectionId ?? '-')}`,
    `revision: r${String(result.revision ?? '-')}`,
    `members: ${String(result.manifest?.members?.length ?? 0)}`,
    typeof result.digest === 'string' ? `digest: ${result.digest}` : '',
  ];
}

function summarizeCollectionInstall(value: unknown): string[] {
  const result = value as {
    status?: unknown;
    collectionId?: unknown;
    revision?: unknown;
    members?: unknown[];
    libraryRoot?: unknown;
  };
  return [
    `status: ${humanStatus(result.status ?? 'installed')}`,
    `collection: ${String(result.collectionId ?? '-')}`,
    `revision: r${String(result.revision ?? '-')}`,
    `members: ${String(result.members?.length ?? 0)}`,
    typeof result.libraryRoot === 'string' ? `library: ${result.libraryRoot}` : '',
  ];
}

function summarizeCollectionUninstall(value: unknown): string[] {
  const result = value as {
    status?: unknown;
    collectionId?: unknown;
    removedDkbs?: unknown[];
    libraryRoot?: unknown;
  };
  return [
    `status: ${humanStatus(result.status ?? 'removed')}`,
    `collection: ${String(result.collectionId ?? '-')}`,
    `pruned DKBs: ${String(result.removedDkbs?.length ?? 0)}`,
    typeof result.libraryRoot === 'string' ? `library: ${result.libraryRoot}` : '',
  ];
}

function summarizeLibraryOverview(value: unknown): string[] {
  const result = value as {
    root?: unknown;
    name?: unknown;
    registryUrl?: unknown;
    generation?: unknown;
    entries?: Array<Record<string, unknown>>;
    counts?: Record<string, unknown>;
  };
  const entries = (result.entries ?? []).map((entry) => ({
    identity: entry.identity ?? '-',
    kind: entry.kind ?? '-',
    source: entry.source ?? '-',
    version: entry.version ?? '-',
    status: entry.status ?? '-',
  }));
  return [
    `library: ${String(result.name ?? '-')}`,
    typeof result.root === 'string' ? `path: ${result.root}` : '',
    `registry: ${String(result.registryUrl ?? 'not configured')}`,
    `generation: ${String(result.generation ?? 0)}`,
    `installed: ${String(result.counts?.installed ?? 0)}, inactive: ${String(result.counts?.inactive ?? 0)}, broken: ${String(result.counts?.broken ?? 0)}, untracked: ${String(result.counts?.untracked ?? 0)}`,
    ...humanSummary({ packages: entries }),
  ];
}

function summarizeLibraryStorage(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const packages = Array.isArray(result.packages)
    ? result.packages.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];

  return [
    typeof result.libraryRoot === 'string' ? `library: ${result.libraryRoot}` : '',
    `total: ${formatBytes(Number(result.totalBytes ?? 0))}`,
    `library state: ${formatBytes(Number(result.libraryStateBytes ?? 0))}`,
    '',
    ...humanSummary({ packages: packages.map((entry) => ({
      id: entry.id ?? '-',
      source: entry.source ?? '-',
      knowledge: formatBytes(Number(entry.sourceBytes ?? 0)),
      builds: formatBytes(Number(entry.buildBytes ?? 0)),
      generated: formatBytes(Number(entry.otherGeneratedBytes ?? 0)),
      total: formatBytes(Number(entry.totalBytes ?? 0)),
    })) }),
  ];
}

function summarizeRegistryConfiguration(value: unknown): string[] {
  const result = value as {
    status?: unknown;
    registry?: { url?: unknown; source?: unknown };
    verification?: { ok?: unknown };
    warning?: unknown;
    retryCommand?: unknown;
  };

  return [
    `status: ${String(result.status ?? 'configured')}`,
    typeof result.registry?.url === 'string'
      ? `registry: ${result.registry.url} (${String(result.registry.source ?? 'project')})`
      : '',
    result.verification ? `verification: ${result.verification.ok ? 'passed' : 'failed'}` : 'verification: skipped',
    typeof result.warning === 'string' ? `warning: ${result.warning}` : '',
    typeof result.retryCommand === 'string' ? `retry: ${result.retryCommand}` : '',
  ];
}

function summarizeRegistryStatus(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const registry = result.registry && typeof result.registry === 'object' ? result.registry as Record<string, unknown> : {};
  const verification = result.verification && typeof result.verification === 'object'
    ? result.verification as Record<string, unknown>
    : {};
  const checks = Array.isArray(verification.checks)
    ? verification.checks.map((value) => {
      const check = value && typeof value === 'object' ? value as Record<string, unknown> : {};

      return {
        name: check.name ?? '-',
        ok: check.ok === true,
        impact: check.required === false ? 'OPTIONAL' : 'BLOCKING',
        ...(check.status === undefined ? {} : { status: check.status }),
        ...(check.message === undefined ? {} : { message: check.message }),
      };
    })
    : [];

  return [
    `registry: ${String(registry.url ?? '-')}`,
    `source: ${String(registry.source ?? '-')}`,
    `status: ${verification.ok === true ? 'OK' : 'FAILED'}`,
    '',
    ...humanSummary({ checks }),
  ];
}

function summarizeInstalledPackages(value: unknown): string[] {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const packages = Array.isArray(record.packages) ? record.packages : [];

  return [
    typeof record.libraryRoot === 'string' ? `library: ${record.libraryRoot}` : '',
    typeof record.registryUrl === 'string'
      ? `registry: ${record.registryUrl}${record.registrySource ? ` (${String(record.registrySource)})` : ''}`
      : '',
    ...humanSummary({ packages: packages.map((item) => {
      const entry = item && typeof item === 'object' ? item as Record<string, unknown> : {};

      return {
        id: entry.id ?? '-',
        version: entry.version ?? '-',
        status: entry.status ?? '-',
        records: entry.recordCount ?? '-',
      };
    }) }),
  ];
}

function summarizeKeyListing(value: unknown): string[] {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const items = Array.isArray(record.keys) ? record.keys : [];
  const keys = items
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      id: item.id ?? '-',
      role: item.subjectType ?? item.role ?? '-',
      subject: item.subjectId ?? '-',
      status: item.status ?? '-',
      fingerprint: item.publicKeyFingerprint ?? item.fingerprint ?? '-',
    }));

  return humanSummary({ results: keys });
}

function summarizeRetrievalResult(value: unknown): string[] {
  const outer = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const response = outer.response && typeof outer.response === 'object'
    ? outer.response as Record<string, unknown>
    : outer;
  const sufficiency = response.sufficiency && typeof response.sufficiency === 'object'
    ? response.sufficiency as Record<string, unknown>
    : {};
  const evidence = Array.isArray(response.evidence)
    ? response.evidence.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
  const lines = [
    `status: ${humanStatus(response.status ?? 'unknown')}`,
    `evidence: ${evidence.length} ${evidence.length === 1 ? 'item' : 'items'}`,
    sufficiency.reason ? `sufficiency: ${humanStatus(sufficiency.reason)}` : '',
    typeof sufficiency.confidence === 'number' ? `confidence: ${(sufficiency.confidence * 100).toFixed(1)}%` : '',
  ];

  for (const [index, item] of evidence.entries()) {
    const source = item.source && typeof item.source === 'object' ? item.source as Record<string, unknown> : {};
    const locator = source.locator && typeof source.locator === 'object'
      ? source.locator as Record<string, unknown>
      : {};
    const citation = source.evidenceId ?? source.chunkId ?? `${index + 1}`;
    const location = typeof locator.path === 'string'
      ? `${locator.path}${locator.line ? `:${String(locator.line)}` : ''}`
      : Object.keys(locator).length > 0
        ? JSON.stringify(locator)
        : '-';
    const text = typeof item.text === 'string'
      ? item.text
      : item.value !== undefined
        ? JSON.stringify(item.value)
        : item.rows !== undefined
          ? JSON.stringify(item.rows)
          : '';

    lines.push(
      '',
      `[${String(citation)}] ${String(item.label ?? 'Evidence')}`,
      `  Package: ${String(source.dkbId ?? '-')}${source.packageVersion ? `@${String(source.packageVersion)}` : ''}`,
      `  Source: ${location}`,
      ...clipText(text, 800).split('\n').map((line) => `  ${line}`),
    );
  }

  return lines;
}

function summarizeQueryResult(value: unknown): string[] {
  const response = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const items = Array.isArray(response.results)
    ? response.results.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
  const results = items.map((item) => ({
    score: typeof item.score === 'number' ? item.score.toFixed(4) : '-',
    package: item.dkbId ?? '-',
    id: item.id ?? '-',
    title: item.title ?? '-',
    source: item.source ?? '-',
  }));

  return [
    typeof response.query === 'string' ? `query: ${response.query}` : '',
    `results: ${results.length}`,
    '',
    ...humanSummary({ results }),
  ];
}

function clipText(value: string, maximum: number): string {
  const compact = value.trim();

  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 1).trimEnd()}…`;
}

function summarizeStackStatus(value: unknown): string[] {
  const stack = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const services = Array.isArray(stack.services)
    ? stack.services.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
  const checks = Array.isArray(stack.checks)
    ? stack.checks.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];

  return [
    `stack: ${String(stack.name ?? 'local')}`,
    stack.status ? `status: ${humanStatus(stack.status)}` : '',
    stack.target ? `target: ${String(stack.target)}` : '',
    stack.registryUrl ? `registry: ${String(stack.registryUrl)}` : '',
    stack.runtimeUrl ? `runtime: ${String(stack.runtimeUrl)}` : '',
    stack.stateRoot ? `state: ${String(stack.stateRoot)}` : '',
    ...(services.length > 0 ? [
      '',
      ...humanSummary({ results: services.map((service) => ({
        service: service.name ?? '-',
        status: humanStatus(service.status ?? '-').toUpperCase(),
        health: humanStatus(service.health ?? '-').toUpperCase(),
      })) }),
    ] : []),
    ...(checks.length > 0 ? [
      '',
      ...humanSummary({ results: checks.map((check) => ({
        component: stackComponentLabel(check.component),
        status: humanStatus(check.status ?? '-').toUpperCase(),
        message: check.message ?? '-',
      })) }),
    ] : []),
  ];
}

function stackComponentLabel(value: unknown): string {
  switch (String(value)) {
    case 'registry-web': return 'Registry';
    case 'dkb-runtime': return 'Runtime';
    case 'meilisearch': return 'Meilisearch';
    case 'docker': return 'Docker';
    case 'compose': return 'Compose';
    case 'secrets': return 'Secrets';
    default: return String(value ?? '-');
  }
}

function summarizeCompilerStatus(value: unknown): string[] {
  const status = value as {
    available?: unknown;
    docker?: unknown;
    image?: unknown;
    running?: unknown;
    ready?: unknown;
    serviceReady?: unknown;
    url?: unknown;
    serviceUrl?: unknown;
    drift?: unknown;
    serviceVersion?: unknown;
    actions?: unknown;
    status?: unknown;
  };
  const actual = status.status && typeof status.status === 'object'
    ? status.status as typeof status
    : status;
  const actions = Array.isArray(status.actions) ? status.actions : [];
  const ready = Boolean(actual.ready ?? actual.serviceReady);
  const running = Boolean(actual.running ?? actual.available);
  const url = actual.url ?? actual.serviceUrl;
  const drift = Array.isArray(actual.drift) ? actual.drift : [];

  return [
    `docker: ${actual.docker ? 'available' : 'unavailable'}`,
    `image: ${String(actual.image ?? 'unknown')}`,
    `service: ${ready ? 'ready' : running ? 'starting' : 'stopped'}`,
    typeof url === 'string' ? `url: ${url}` : '',
    typeof actual.serviceVersion === 'string' ? `service version: ${actual.serviceVersion}` : '',
    drift.length > 0 ? `drift: ${drift.join(', ')}` : 'drift: none',
    ...actions.map((item) => `action: ${String(item)}`),
  ];
}

function summarizeCompilerCompileResult(value: unknown): string[] {
  const result = value as {
    compiler?: { id?: unknown; model?: unknown };
    recordCount?: unknown;
    outputPath?: unknown;
  };

  return [
    `compiler: ${String(result.compiler?.id ?? 'unknown')}`,
    typeof result.compiler?.model === 'string' ? `model: ${result.compiler.model}` : '',
    countLabel(result.recordCount, 'record') ?? '',
    typeof result.outputPath === 'string' ? `output: ${result.outputPath}` : '',
  ];
}

function summarizeInstallResult(value: unknown): string[] {
  const result = value as {
    status?: unknown;
    id?: unknown;
    packageId?: unknown;
    version?: unknown;
    catalog?: { recordCount?: unknown; packageCount?: unknown };
    search?: { upsert?: { documentCount?: unknown; timingsMs?: { total?: unknown } } };
    packagePath?: unknown;
    warning?: unknown;
    cleanupPath?: unknown;
  };

  return [
    `status: ${humanStatus(result.status ?? 'ok')}`,
    `package: ${String(result.packageId ?? result.id ?? 'unknown')}${result.version ? `@${String(result.version)}` : ''}`,
    countLabel(result.catalog?.recordCount ?? result.search?.upsert?.documentCount, 'record') ?? '',
    countLabel(result.catalog?.packageCount, 'package') ?? '',
    milliseconds(result.search?.upsert?.timingsMs?.total) ? `search activation: ${milliseconds(result.search?.upsert?.timingsMs?.total)}` : '',
    typeof result.packagePath === 'string' ? `path: ${result.packagePath}` : '',
    typeof result.warning === 'string' ? `warning: ${result.warning}` : '',
    typeof result.cleanupPath === 'string' ? `cleanup path: ${result.cleanupPath}` : '',
  ];
}

function summarizeRemoveResult(value: unknown): string[] {
  const result = value as { status?: unknown; id?: unknown; libraryPath?: unknown; warning?: unknown };

  return [
    `status: ${humanStatus(result.status ?? 'ok')}`,
    `package: ${String(result.id ?? 'unknown')}`,
    typeof result.libraryPath === 'string' ? `library: ${result.libraryPath}` : '',
    typeof result.warning === 'string' ? `warning: ${result.warning}` : '',
  ];
}

function summarizePublishResult(value: unknown): string[] {
  const result = value as {
    status?: unknown;
    packageId?: unknown;
    version?: unknown;
    archivePath?: unknown;
    compiled?: { recordCount?: unknown };
    receipt?: { packageId?: unknown; version?: unknown };
    warning?: unknown;
    retryCommand?: unknown;
  };
  const packageId = result.packageId ?? result.receipt?.packageId;
  const version = result.version ?? result.receipt?.version;

  return [
    `status: ${humanStatus(result.status ?? 'published')}`,
    `package: ${String(packageId ?? 'unknown')}${version ? `@${String(version)}` : ''}`,
    countLabel(result.compiled?.recordCount, 'record') ?? '',
    typeof result.archivePath === 'string' ? `archive: ${result.archivePath}` : '',
    typeof result.warning === 'string' ? `warning: ${result.warning}` : '',
    typeof result.retryCommand === 'string' ? `retry: ${result.retryCommand}` : '',
  ];
}

function summarizeArtifactTransport(value: unknown): string[] {
  const result = value as {
    status?: unknown;
    archivePath?: unknown;
    outputDir?: unknown;
    ref?: unknown;
    digest?: unknown;
    archiveBytes?: unknown;
    packageId?: unknown;
    version?: unknown;
    registry?: unknown;
    warning?: unknown;
    retryCommand?: unknown;
    cleanupPath?: unknown;
  };

  return [
    `status: ${humanStatus(result.status ?? 'ok')}`,
    typeof result.packageId === 'string' ? `package: ${result.packageId}${result.version ? `@${String(result.version)}` : ''}` : '',
    typeof result.ref === 'string' ? `ref: ${result.ref}` : '',
    typeof result.digest === 'string' ? `digest: ${result.digest}` : '',
    typeof result.archivePath === 'string' ? `archive: ${result.archivePath}` : '',
    typeof result.outputDir === 'string' ? `output: ${result.outputDir}` : '',
    typeof result.registry === 'string' ? `registry: ${result.registry}` : '',
    typeof result.archiveBytes === 'number' ? `size: ${result.archiveBytes} bytes` : '',
    typeof result.warning === 'string' ? `warning: ${result.warning}` : '',
    typeof result.retryCommand === 'string' ? `retry: ${result.retryCommand}` : '',
    typeof result.cleanupPath === 'string' ? `cleanup path: ${result.cleanupPath}` : '',
  ];
}

function parseLimit(value: string): number {
  const limit = Number.parseInt(value, 10);

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new DkbError('Limit must be an integer between 1 and 100');
  }

  return limit;
}

async function runEvidenceLifecycle(
  root: string,
  target: string | undefined,
  operation: 'inspect' | 'start' | 'status' | 'stop' | 'doctor',
  options?: { restart?: boolean },
): Promise<unknown> {
  const [{ DkbProviderHost }, { DEFAULT_DKB_DISTRIBUTION }] = await Promise.all([
    import('@sjshovan/dkb-pipeline/host.js'),
    import('@sjshovan/dkb-distribution-default'),
  ]);
  const host = await DkbProviderHost.create({ root: path.resolve(root), ...(target ? { target } : {}), distribution: DEFAULT_DKB_DISTRIBUTION });

  try {
    const provider = host.provider<import('@sjshovan/dkb-pipeline/types.js').DkbEvidenceProvider>('evidence');
    const action = provider.lifecycle?.[operation];

    if (!action) {
      throw new DkbError(`Selected Evidence provider ${host.config.target.evidence} does not support compiler ${operation}`);
    }
    return operation === 'start'
      ? await (action as NonNullable<import('@sjshovan/dkb-pipeline/types.js').DkbProviderLifecycle['start']>)(options)
      : await (action as () => Promise<unknown>)();
  } finally {
    await host.dispose();
  }
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new DkbError(`${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DkbError(`${label} must be a JSON object`);
  }

  return parsed as Record<string, unknown>;
}

function humanStatus(value: unknown): string {
  return String(value).replace(/_/g, ' ');
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

async function stageRuntimeImport(source: string, hostRoot: string, containerRoot: string, id?: string): Promise<{
  hostPath: string;
  containerPath: string;
}> {
  const resolvedSource = path.resolve(source);
  const stat = await fs.stat(resolvedSource);

  if (!stat.isDirectory()) {
    throw new DkbError(`Runtime import source must be a directory: ${resolvedSource}`);
  }

  const stageId = `${safeCliId(id ?? path.basename(resolvedSource))}-${Date.now().toString(36)}`;
  const hostTarget = path.resolve(hostRoot, stageId);

  await fs.rm(hostTarget, { recursive: true, force: true });
  await fs.mkdir(path.dirname(hostTarget), { recursive: true });
  await fs.cp(resolvedSource, hostTarget, {
    recursive: true,
    filter: (candidate) => !isEphemeralDkbStatePath(resolvedSource, candidate),
  });

  return {
    hostPath: hostTarget,
    containerPath: `${containerRoot.replace(/\/+$/g, '')}/${stageId}`,
  };
}

async function prepareCompiledRuntimeImport(source: string, id?: string, name?: string): Promise<{
  id: string;
  path: string;
  cleanup(): Promise<void>;
}> {
  const resolvedSource = path.resolve(source);
  const stat = await fs.stat(resolvedSource);

  if (!stat.isDirectory()) {
    throw new DkbError(`Runtime import source must be a directory: ${resolvedSource}`);
  }

  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-runtime-add-'));
  const packageRoot = path.join(temporaryRoot, 'package');

  try {
    await fs.cp(resolvedSource, packageRoot, {
      recursive: true,
      filter: (candidate) => !isDkbStatePath(resolvedSource, candidate),
    });
    const sourceManifestPath = path.join(resolvedSource, 'dkb.json');
    let manifest: Awaited<ReturnType<typeof loadManifest>>;

    if (await exists(sourceManifestPath)) {
      manifest = await loadManifest(packageRoot);
    } else {
      const identity = id
        ? parseDkbIdentity(id, 'Imported DKB identity').identity
        : `@local/${safeCliId(path.basename(resolvedSource) || 'dkb')}`;
      await fs.writeFile(path.join(packageRoot, 'dkb.json'), `${JSON.stringify({
        manifestVersion: 1,
        type: 'dkb',
        name: identity,
        displayName: name ?? identityDisplayName(identity),
        version: '0.1.0',
        permissions: { read: true, write: false },
        meta: { generatedBy: '@sjshovan/dkb-cli' },
      }, null, 2)}\n`, 'utf8');
      manifest = await loadManifest(packageRoot);
    }

    if (manifest.type !== 'dkb') {
      throw new DkbError(`dkb runtime import accepts one DKB at a time; received ${manifest.type}. Install Collections through the Registry or import their DKBs individually.`);
    }
    const identity = parseDkbIdentity(manifest.name, 'Imported DKB identity').identity;
    if (id && parseDkbIdentity(id, 'Imported DKB identity').identity !== identity) {
      throw new DkbError(`Imported DKB identity override ${id} does not match its manifest ${identity}.`);
    }
    const { compileComposeProject } = await import('@sjshovan/dkb-compiler/compile.js');
    // Compile the sanitized staging copy with the trusted local source as its
    // provider context. This preserves Library-local pipeline overrides while
    // ensuring plugin code and configuration never enter the import artifact.
    await compileComposeProject(packageRoot, {
      force: true,
      mode: 'package',
      contextRoot: resolvedSource,
    });

    return {
      id: identity,
      path: packageRoot,
      cleanup: () => fs.rm(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function isDkbStatePath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);

  return relative === '.dkb' || relative.startsWith(`.dkb${path.sep}`);
}

function isEphemeralDkbStatePath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  const excluded = [
    path.join('.dkb', 'cache'),
    path.join('.dkb', 'locks'),
    path.join('.dkb', 'runs'),
    path.join('.dkb', 'plugins'),
    path.join('.dkb', 'config.json'),
  ];

  return excluded.some((entry) => relative === entry || relative.startsWith(`${entry}${path.sep}`));
}

async function resolveInitName(name: string | undefined): Promise<string> {
  const trimmed = name?.trim();

  if (trimmed) {
    return trimmed;
  }

  const input = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  try {
    const answer = (await input.question('DKB name: ')).trim();

    if (!answer) {
      throw new DkbError('DKB name is required');
    }

    return answer;
  } finally {
    input.close();
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);

    return true;
  } catch {
    return false;
  }
}

function safeCliId(value: string): string {
  const id = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

  return id || 'dkb';
}

function defaultPackageArchiveName(packageId: string, version?: string): string {
  const suffix = version ? `-${safeCliId(version)}` : '';

  return `${safeCliId(packageId)}${suffix}.dkbpkg`;
}

function titleFromId(value: string): string {
  return value
    .split(/[-_.\s]+/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ') || value;
}
