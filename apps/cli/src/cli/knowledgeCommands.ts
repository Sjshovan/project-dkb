import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { identityDisplayName, parseDkbIdentity } from '@sjshovan/dkb-protocol/identity.js';
import { loadManifest } from '@sjshovan/dkb-protocol/manifest.js';
import type { DkbRuntimeContext } from '@sjshovan/dkb-runtime/runtime/context.js';
import type { DkbRuntimeClient } from '@sjshovan/dkb-runtime/runtime/client.js';
import type { CliPresenter } from './presentation.js';
import { registerPackageLifecycleCommands } from './packageCommands.js';
import { registerRemoteCommands } from './remoteCommands.js';
import {
  summarizeCollectionInstall,
  summarizeCollectionRevision,
  summarizeCollectionUninstall,
  summarizeInstalledPackages,
  summarizeInstallResult,
  summarizeLibrarySync,
  summarizePublishResult,
  summarizeRemoveResult,
  summarizeRetrievalResult,
} from './summaries.js';

export interface KnowledgeCommandContext {
  presenter(): CliPresenter;
  printJson(value: unknown): void;
  currentLibraryRoot(explicit?: string, cwd?: string): Promise<string>;
  currentRuntimeUrl(explicit?: string): Promise<string>;
  currentRuntimeAdminClient(explicit?: string, timeoutMs?: number): Promise<DkbRuntimeClient>;
  defaultRuntimeContext(): Promise<DkbRuntimeContext>;
  parsePositiveInteger(value: string): number;
  parseLimit(value: string): number;
}

export function registerKnowledgeCommands(program: Command, runtime: Command, context: KnowledgeCommandContext): void {
  const {
    presenter,
    printJson,
    currentLibraryRoot,
    currentRuntimeUrl,
    currentRuntimeAdminClient,
    defaultRuntimeContext,
    parsePositiveInteger,
    parseLimit,
  } = context;
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
          runtime: await defaultRuntimeContext(),
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
        runtime: await defaultRuntimeContext(),
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
    runtimeContext: defaultRuntimeContext,
  });

  registerRemoteCommands(program, {
    presenter,
    printJson,
    currentRuntimeAdminClient,
    parsePositiveInteger,
    parseLimit,
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

      await presenter().run(`Uninstalling ${identity}`, async (progress) => removeDkbFromRuntime(identity, libraryRoot, { runtime: await defaultRuntimeContext(), progress }), summarizeRemoveResult);
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
