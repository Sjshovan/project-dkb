import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { parseDkbIdentity } from '@sjshovan/dkb-protocol/identity.js';
import type { CliPresenter } from './presentation.js';
import type { DkbRuntimeClient } from '@sjshovan/dkb-runtime/runtime/client.js';
import type { DkbServingRuntimeRefresh } from '../runtime/refresh.js';
import {
  summarizeRegistryBuildRequest,
  summarizePackageListing,
  summarizeRegistryContents,
  summarizeRegistryEntry,
  summarizeRegistryPipeline,
  summarizeRegistryPipelines,
} from './packagePresentation.js';
import {
  summarizeArtifactTransport,
  summarizeHostMutation,
  summarizeHostRegistries,
  summarizeKeyListing,
  summarizeRegistryConfiguration,
  summarizeRegistryStatus,
} from './summaries.js';

export interface RegistryCommandContext {
  presenter(): CliPresenter;
  currentLibraryRoot(explicit?: string, cwd?: string): Promise<string>;
  currentRuntimeAdminClient(url?: string): Promise<DkbRuntimeClient>;
  parsePositiveInteger(value: string): number;
}

export function registerRegistryCommands(program: Command, context: RegistryCommandContext): void {
  const { presenter, parsePositiveInteger } = context;
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

  const registryPipeline = registry
    .command('pipeline')
    .description('Inspect trusted compiler Pipelines advertised by a Registry');

  registryPipeline
    .command('list')
    .description('List trusted Registry compiler Pipelines')
    .option('--url <url>', 'Registry API URL')
    .action(async (options: { url?: string }) => {
      const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
      const { configuredRegistry } = await import('./registryConfig.js');
      const configured = await configuredRegistry({ url: options.url });
      presenter().print(await new DkbRegistryClient({ baseUrl: configured.url }).pipelines(), summarizeRegistryPipelines);
    });

  registryPipeline
    .command('show')
    .description('Inspect one trusted Registry compiler Pipeline')
    .argument('<name>', 'Registry Pipeline name')
    .option('--url <url>', 'Registry API URL')
    .action(async (name: string, options: { url?: string }) => {
      const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
      const { configuredRegistry } = await import('./registryConfig.js');
      const configured = await configuredRegistry({ url: options.url });
      const catalog = await new DkbRegistryClient({ baseUrl: configured.url }).pipelines();
      const pipeline = catalog.pipelines.find((candidate) => candidate.name === name);
      if (!pipeline) {
        throw new DkbError(`Registry ${configured.url} does not advertise Pipeline ${name}. Run: dkb registry pipeline list --url ${configured.url}`);
      }
      presenter().print(pipeline, summarizeRegistryPipeline);
    });

  registry
    .command('build')
    .description('Request another trusted Registry build for an immutable DKB release')
    .argument('<package-id>', 'Scoped Registry package identity')
    .requiredOption('--version <version>', 'Exact immutable package version')
    .requiredOption('--pipeline <name>', 'Advertised Registry Pipeline')
    .option('--url <url>', 'Registry API URL')
    .action(async (identity: string, options: { version: string; pipeline: string; url?: string }) => {
      const packageId = parseDkbIdentity(identity, 'Registry package identity').identity;
      const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
      const { configuredRegistry } = await import('./registryConfig.js');
      const configured = await configuredRegistry({ url: options.url });
      const client = new DkbRegistryClient({ baseUrl: configured.url });
      const catalog = await client.pipelines();
      const pipeline = catalog.pipelines.find((candidate) => candidate.name === options.pipeline);
      if (!pipeline) {
        throw new DkbError(`Registry ${configured.url} does not advertise Pipeline ${options.pipeline}. Run: dkb registry pipeline list --url ${configured.url}`);
      }
      if (!pipeline.available) {
        throw new DkbError(`Registry Pipeline ${options.pipeline} is unavailable. Run: dkb registry pipeline show ${options.pipeline} --url ${configured.url}`);
      }
      await presenter().run('Requesting Registry build', async () => ({
        packageId,
        version: options.version,
        ...await client.requestBuild(
          packageId,
          options.version,
          pipeline.name,
          {
            retrievalProfileDigest: pipeline.retrievalProfileDigest,
            compatibilityDigest: pipeline.compatibilityDigest,
          },
        ),
      }), summarizeRegistryBuildRequest);
    });

  registry
    .command('cancel-build')
    .description('Cancel a queued or running Registry compilation without changing published builds')
    .argument('<package-id>', 'Scoped Registry package identity')
    .requiredOption('--version <version>', 'Exact immutable package version')
    .requiredOption('--job <id>', 'Compilation job ID', parsePositiveInteger)
    .option('--url <url>', 'Registry API URL')
    .action(async (identity: string, options: { version: string; job: number; url?: string }) => {
      const packageId = parseDkbIdentity(identity, 'Registry package identity').identity;
      const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
      const { configuredRegistry } = await import('./registryConfig.js');
      const configured = await configuredRegistry({ url: options.url });
      await presenter().run('Requesting build cancellation', async () => {
        const result = await new DkbRegistryClient({ baseUrl: configured.url }).cancelBuild(packageId, options.version, options.job);
        return {
          packageId,
          version: options.version,
          ...result,
          ...(result.status === 'cancelling' ? {
            warning: 'Cancellation is pending. The compiler has not yet confirmed it stopped; publication is blocked.',
            retryCommand: `dkb registry cancel-build ${packageId} --version ${options.version} --job ${options.job} --url ${configured.url}`,
          } : {}),
        };
      }, summarizeRegistryBuildRequest);
    });

  registry
    .command('use')
    .description('Set the upstream Registry URL for the current DKB Library')
    .argument('<name-or-url>', 'Registered Registry name or Registry API URL')
    .option('--root <library>', 'Registered Library name or local Library path to configure')
    .option('--global', 'Set the user-wide fallback instead of a folder-specific URL')
    .option('--no-verify', 'Save the URL without validating it first')
    .action(async (nameOrUrl: string, options: { root?: string; global?: boolean; verify?: boolean }) => {
      const { normalizeRegistryUrl, verifyRegistryEndpoint, writeConfiguredRegistryUrl } = await import('./registryConfig.js');
      const { hostInventoryPath, registerHostLibrary, registerDockerHostLibrary, registeredHostLibrary, registerHostRegistry, registeredHostRegistry } = await import('../host/inventory.js');
      const { resolveCliLibraryReference } = await import('./context.js');
      const { executeCliLibraryOperation } = await import('./libraryOperation.js');
      const { withRuntimeRefreshes } = await import('../runtime/refresh.js');

      if (options.global && options.root) {
        throw new DkbError('Registry configuration cannot use --global and --root together.');
      }

      await presenter().run('Configuring registry', async (progress) => {
        const known = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/iu.test(nameOrUrl)
          ? await registeredHostRegistry(nameOrUrl)
          : null;
        const url = known?.registry.url ?? normalizeRegistryUrl(nameOrUrl);
        const verification = options.verify === false ? undefined : await verifyRegistryEndpoint(url);
        const reference = options.global ? undefined : await resolveCliLibraryReference({ explicit: options.root, allowUnavailableManifest: true });
        const write = async (root?: string) => {
          const configured = await writeConfiguredRegistryUrl(url, { root, global: Boolean(options.global) });
          return { status: configured.changed ? 'configured' : 'unchanged', registry: configured };
        };
        const result = reference ? await executeCliLibraryOperation({ reference, command: 'library.registry.use',
          input: { registryUrl: url }, progress, runtimeClient: context.currentRuntimeAdminClient }, write) : await write();
        const configured = result.registry;
        let host: { registry: string; inventoryPath: string } | undefined;
        let hostWarning: string | undefined;
        try {
          // Convenience state follows the authoritative Library commit, never precedes it.
          const hostRegistry = await registerHostRegistry(known?.name, url, { select: true });
          if (reference?.kind === 'docker') {
            const registered = await registeredHostLibrary(reference.name);
            await registerDockerHostLibrary(reference.storage, { name: reference.name,
              displayName: registered?.library.displayName ?? reference.name, registryName: hostRegistry.name, registryUrl: configured.url });
          } else if (reference) {
            await registerHostLibrary(reference.path, { registryName: hostRegistry.name, registryUrl: configured.url });
          }
          host = { registry: hostRegistry.name, inventoryPath: hostInventoryPath() };
        } catch {
          hostWarning = 'Registry configuration was saved, but the host inventory could not be updated. Repair the host inventory and repeat this command to synchronize it.';
        }

        const verificationWarning = verification && !verification.ok
          ? `Upstream registry URL was saved, but ${configured.url} could not be verified.`
          : options.verify === false ? `Upstream registry ${configured.url} was saved without verification.` : undefined;
        const warning = [verificationWarning, hostWarning].filter(Boolean).join(' ');
        return withRuntimeRefreshes({
          status: result.status,
          registry: configured,
          ...(host ? { host } : {}),
          ...(verification ? { verification } : {}),
          ...(warning ? { warning } : {}),
          ...(verificationWarning ? { retryCommand: `dkb registry status --url ${configured.url}` } : {}),
        }, (result as typeof result & { runtimeRefreshes?: DkbServingRuntimeRefresh[] }).runtimeRefreshes ?? []);
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
    .option('--token-stdin', 'Read the Registry token from standard input')
    .option('--device', 'Use a headless device authorization flow')
    .option('--scope <scope...>', 'Request Registry scopes', ['registry:read'])
    .action(async (options: { url?: string; tokenStdin?: boolean; device?: boolean; scope: string[] }) => {
      const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
      const { saveRegistryCredential, registryCredentialsPath } = await import('@sjshovan/dkb-registry-client/credentials.js');
      const { configuredRegistry } = await import('./registryConfig.js');
      const { browserRegistryLogin, deviceRegistryLogin, registryTokenInput } = await import('./registryAuth.js');
      const configured = await configuredRegistry({ url: options.url });

      await presenter().run('Authenticating registry', async (progress) => {
        if (options.device && options.tokenStdin) throw new DkbError('--device and --token-stdin cannot be used together.');
        const anonymous = new DkbRegistryClient({ baseUrl: configured.url, token: '' });
        const exchanged = options.tokenStdin || process.env.DKB_REGISTRY_TOKEN?.trim()
          ? null
          : options.device
            ? await deviceRegistryLogin(anonymous, options.scope, progress)
            : await browserRegistryLogin(anonymous, options.scope, progress);
        const token = exchanged?.accessToken ?? await registryTokenInput({ tokenStdin: options.tokenStdin });
        const identity = await new DkbRegistryClient({ baseUrl: configured.url, token }).whoAmI();
        await saveRegistryCredential(configured.url, {
          token,
          savedAt: new Date().toISOString(),
          user: identity.user.email,
          team: identity.team.slug,
          abilities: identity.token.abilities,
          expiresAt: identity.token.expiresAt,
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
    .action(async (options: { url?: string }) => {
      const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
      const { configuredRegistry } = await import('./registryConfig.js');
      const configured = await configuredRegistry({ url: options.url });
      const identity = await new DkbRegistryClient({ baseUrl: configured.url }).whoAmI();
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
    .action(async (options: { url?: string }) => {
      const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
      const { configuredRegistry } = await import('./registryConfig.js');
      const registryConfig = await configuredRegistry({ url: options.url });
      presenter().print(await new DkbRegistryClient({ baseUrl: registryConfig.url }).packages(), summarizePackageListing);
    });

  registry
    .command('show')
    .description('Inspect a remote DKB or Collection without installing it')
    .argument('<identity>', 'Scoped @namespace/name identity')
    .option('--version <version>', 'Exact DKB version')
    .option('--revision <number>', 'Exact Collection revision', parsePositiveInteger)
    .option('--url <url>', 'Registry API URL')
    .option('--contents [path]', 'List signed source metadata for a DKB version')
    .option('--cursor <cursor>', 'Continue a source inventory page')
    .option('--limit <number>', 'Maximum source entries, from 1 to 200', parseRegistryContentsLimit, 100)
    .action(async (identity: string, options: {
      version?: string;
      revision?: number;
      url?: string;
      contents?: string | boolean;
      cursor?: string;
      limit: number;
    }) => {
      if (options.version && options.revision !== undefined) throw new DkbError('--version and --revision cannot be combined.');
      if ((options.cursor || options.limit !== 100) && options.contents === undefined) {
        throw new DkbError('--cursor and --limit require --contents.');
      }
      const normalizedIdentity = parseDkbIdentity(identity, 'Registry entry identity').identity;
      const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
      const { configuredRegistry } = await import('./registryConfig.js');
      const registryConfig = await configuredRegistry({ url: options.url });
      const client = new DkbRegistryClient({ baseUrl: registryConfig.url });
      const kind = options.revision !== undefined
        ? 'collection'
        : options.version || options.contents !== undefined
          ? 'dkb'
          : await client.entryKind(normalizedIdentity);

      if (kind === 'collection') {
        if (options.version) throw new DkbError('--version applies only to DKB entries; use --revision for a Collection.');
        if (options.contents !== undefined) throw new DkbError('Remote Contents are available for DKB versions; Collection details expose exact members.');
        presenter().print(await client.collectionDetails(normalizedIdentity, options.revision), summarizeRegistryEntry);
        return;
      }
      if (options.revision !== undefined) throw new DkbError('--revision applies only to Collections; use --version for a DKB.');
      const detail = await client.packageDetails(normalizedIdentity, options.version);
      if (options.contents !== undefined) {
        presenter().print(await client.sourceContents(normalizedIdentity, detail.selectedVersion.version, {
          path: typeof options.contents === 'string' ? options.contents : '.',
          cursor: options.cursor,
          perPage: options.limit,
        }), summarizeRegistryContents);
        return;
      }
      presenter().print(detail, summarizeRegistryEntry);
    });

  registry
    .command('keys')
    .description('List registry public signing keys')
    .option('--url <url>', 'Registry API URL')
    .action(async (options: { url?: string }) => {
      const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
      const { configuredRegistry } = await import('./registryConfig.js');
      const registryConfig = await configuredRegistry({ url: options.url });
      presenter().print(await new DkbRegistryClient({ baseUrl: registryConfig.url }).publicKeys(), summarizeKeyListing);
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
    .action(async (release: string, options: { url: string; registryUrl?: string }) => {
      const separator = release.lastIndexOf('@');

      if (separator <= 0 || separator === release.length - 1) {
        throw new DkbError('Remote claim requires package@version.');
      }

      const { configuredRegistry } = await import('./registryConfig.js');
      const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
      const registryConfig = await configuredRegistry({ url: options.registryUrl });
      const packageId = release.slice(0, separator);
      const version = release.slice(separator + 1);

      await presenter().run('Registering hosted runtime', async () => new DkbRegistryClient({ baseUrl: registryConfig.url }).claimRemoteEndpoint(packageId, version, options.url));
    });

  registry
    .command('pull')
    .description('Pull a DKB package archive from the registry')
    .argument('<package-id>', 'Registry package id')
    .option('--version <version>', 'Package version')
    .option('--output <path>', 'Archive path to write')
    .option('--force', 'Replace an existing output archive')
    .option('--url <url>', 'Registry API URL')
    .action(async (packageId: string, options: { version?: string; output?: string; force?: boolean; url?: string }) => {
      const outputPath = path.resolve(options.output ?? defaultPackageArchiveName(packageId, options.version));

      if (!options.force && await exists(outputPath)) {
        throw new DkbError(`Output archive already exists: ${outputPath}. Use --force to replace it.`);
      }

      await fs.mkdir(path.dirname(outputPath), { recursive: true });

      const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
      const { configuredRegistry } = await import('./registryConfig.js');
      const registryConfig = await configuredRegistry({ url: options.url });
      const client = new DkbRegistryClient({ baseUrl: registryConfig.url });
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
    .action(async (packageId: string, options: { version?: string; url?: string }) => {
      const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
      const { DKB_PACKAGE_EXTENSION } = await import('@sjshovan/dkb-library/archive.js');
      const { verifyDkbArchiveFile } = await import('@sjshovan/dkb-runtime/runtime/registryInstall.js');
      const { configuredRegistry } = await import('./registryConfig.js');
      const registryConfig = await configuredRegistry({ url: options.url });
      const client = new DkbRegistryClient({ baseUrl: registryConfig.url });
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
    .action(async (accountId: string, options: { url?: string }) => {
      const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
      const { configuredRegistry } = await import('./registryConfig.js');
      const registryConfig = await configuredRegistry({ url: options.url });
      await presenter().run('Rotating publisher key', async () => new DkbRegistryClient({ baseUrl: registryConfig.url }).rotateAccountKey(accountId));
    });

  registry
    .command('rotate-registry-key', { hidden: true })
    .description('Rotate a Registry signing key')
    .option('--url <url>', 'Registry API URL')
    .action(async (options: { url?: string }) => {
      const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
      const { configuredRegistry } = await import('./registryConfig.js');
      const registryConfig = await configuredRegistry({ url: options.url });
      await presenter().run('Rotating registry key', async () => new DkbRegistryClient({ baseUrl: registryConfig.url }).rotateRegistryKey());
    });

  registry
    .command('revoke-key', { hidden: true })
    .description('Revoke a Registry signing key')
    .argument('<key-id>', 'Signing key id')
    .option('--url <url>', 'Registry API URL')
    .action(async (keyId: string, options: { url?: string }) => {
      const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
      const { configuredRegistry } = await import('./registryConfig.js');
      const registryConfig = await configuredRegistry({ url: options.url });
      await presenter().run('Revoking signing key', async () => new DkbRegistryClient({ baseUrl: registryConfig.url }).revokeKey(keyId));
    });
}

function defaultPackageArchiveName(packageId: string, version?: string): string {
  const suffix = version ? `-${safeCliId(version)}` : '';
  return `${safeCliId(packageId)}${suffix}.dkbpkg`;
}

function safeCliId(value: string): string {
  const id = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return id || 'dkb';
}

function parseRegistryContentsLimit(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new DkbError('Registry contents limit must be between 1 and 200.');
  }
  return parsed;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
