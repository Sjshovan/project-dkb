import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { identityDisplayName, parseDkbIdentity } from '@sjshovan/dkb-protocol/identity.js';
import type { CliPresenter } from './presentation.js';
import { summarizeInitResult } from './summaries.js';

export interface CoreCommandContext {
  presenter(): CliPresenter;
  parsePositiveInteger(value: string): number;
  runtimeCatalogUrl(host: string, port: number): string;
}

export function registerCoreCommands(program: Command, context: CoreCommandContext): void {
  const { presenter, parsePositiveInteger, runtimeCatalogUrl } = context;
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
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
