#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Command, CommanderError } from 'commander';
import { DkbError } from '../protocol/errors.js';
import { loadCollection, loadDkb, loadManifest } from '../protocol/manifest.js';
import { DKB_ARTIFACTS_DIR } from '../protocol/paths.js';
import { DKB_PROTOCOL_VERSION } from '../protocol/version.js';
import {
  countLabel,
  createCliPresenter,
  milliseconds,
  printJson as printJsonValue,
  type CliPresenter,
} from './presentation.js';

const program = new Command();

program
  .name('dkb')
  .description('Portable, read-only durable knowledgebase protocol CLI')
  .version(DKB_PROTOCOL_VERSION)
  .option('--json', 'Force machine-readable JSON output')
  .option('--no-progress', 'Disable interactive spinners and progress output');

program
  .command('init')
  .description('Create a new DKB folder, or initialize the current folder as a registry')
  .argument('[name]', 'DKB package id or display name')
  .option('--dir <path>', 'Parent directory where the DKB folder should be created')
  .option('--here', 'Initialize the current directory as a registry manifest')
  .option('--yes', 'Use defaults without prompting when possible')
  .option('--owner <id>', 'Owner id to write into dkb.json')
  .option('--email <email>', 'Owner email to write into dkb.json')
  .option('--collection <id>', 'Optional collection id metadata')
  .action(async (name: string | undefined, options: { dir?: string; here?: boolean; yes?: boolean; owner?: string; email?: string; collection?: string }) => {
    if (options.here) {
      const { registryManifestForFolder } = await import('./serve.js');
      const root = path.resolve(options.dir ?? '.');
      if (!options.yes && !name?.trim() && !process.stdin.isTTY) {
        throw new DkbError('DKB name is required in noninteractive mode unless --yes is set.');
      }
      const displayName = options.yes && !name?.trim() ? undefined : await resolveInitName(name);
      const manifest = {
        ...registryManifestForFolder(root),
        ...(displayName ? { name: displayName } : {}),
        ...(options.owner || options.email
          ? {
              owner: {
                id: options.owner ?? 'local',
                email: options.email,
              },
            }
          : {}),
      };
      const manifestPath = path.join(root, 'dkb.json');

      if (await exists(manifestPath)) {
        throw new DkbError(`dkb.json already exists at ${manifestPath}`);
      }

      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      await fs.mkdir(path.join(root, '.dkb'), { recursive: true });

      printJson({
        ok: true,
        type: 'registry',
        root,
        manifest: manifestPath,
      });

      return;
    }

    const displayName = options.yes && !name?.trim() ? path.basename(path.resolve(options.dir ?? '.')) || 'DKB' : await resolveInitName(name);
    const id = safeCliId(displayName);
    const root = path.resolve(options.dir ?? '.', id);

    await fs.mkdir(root, { recursive: true });
    const manifestPath = path.join(root, 'dkb.json');

    if (await exists(manifestPath)) {
      throw new DkbError(`dkb.json already exists at ${manifestPath}`);
    }

    await fs.writeFile(manifestPath, `${JSON.stringify({
      name: displayName,
      version: '0.1.0',
      description: '',
      author: options.owner || options.email
        ? {
            id: options.owner ?? 'local',
            email: options.email,
          }
        : undefined,
      collection: options.collection
        ? options.collection
        : undefined,
    }, null, 2)}\n`, 'utf8');

    printJson({
      ok: true,
      root,
      manifest: manifestPath,
    });
  });

program
  .command('serve')
  .description('Serve the nearest DKB registry from the current folder')
  .option('--root <path>', 'Registry root to serve instead of discovering from the current folder')
  .option('--host <host>', 'Host to bind', process.env.DKB_RUNTIME_HOST || '127.0.0.1')
  .option('--port <number>', 'Port to bind', parsePositiveInteger, Number.parseInt(process.env.DKB_RUNTIME_PORT || '7331', 10))
  .action(async (options: { root?: string; host: string; port: number }) => {
    const { prepareServeRegistry } = await import('./serve.js');
    const { serveDkbRuntime } = await import('../runtime/server.js');
    const prepared = await prepareServeRegistry({
      root: options.root,
    });

    console.error(JSON.stringify({
      event: 'dkb.serve.registry_resolved',
      root: prepared.root,
      initialized: prepared.initialized,
      compiled: prepared.compiled,
      recordCount: prepared.compileResult?.recordCount,
    }));

    await serveDkbRuntime({
      host: options.host,
      port: options.port,
      stateRoot: prepared.root,
    });
  });

const runtime = program
  .command('runtime')
  .description('Manage the container-first DKB Runtime');

runtime
  .command('serve')
  .description('Start the DKB Runtime HTTP API in the current process')
  .option('--host <host>', 'Host to bind', process.env.DKB_RUNTIME_HOST || '127.0.0.1')
  .option('--port <number>', 'Port to bind', parsePositiveInteger, Number.parseInt(process.env.DKB_RUNTIME_PORT || '7331', 10))
  .option('--state-root <path>', 'Runtime state root', process.env.DKB_RUNTIME_STATE_ROOT)
  .action(async (options: { host: string; port: number; stateRoot?: string }) => {
    const { serveDkbRuntime } = await import('../runtime/server.js');

    await serveDkbRuntime({
      host: options.host,
      port: options.port,
      stateRoot: options.stateRoot,
    });
  });

runtime
  .command('start')
  .description('Start the local Docker-backed DKB Runtime')
  .option('-f, --file <path>', 'Docker compose file', process.env.DKB_RUNTIME_COMPOSE_FILE || 'docker-compose.yml')
  .action((options: { file: string }) => {
    runDockerCompose(options.file, ['up', '-d', 'dkb-runtime']);
  });

runtime
  .command('stop')
  .description('Stop the local Docker-backed DKB Runtime')
  .option('-f, --file <path>', 'Docker compose file', process.env.DKB_RUNTIME_COMPOSE_FILE || 'docker-compose.yml')
  .action((options: { file: string }) => {
    runDockerCompose(options.file, ['stop', 'dkb-runtime']);
  });

runtime
  .command('status')
  .description('Show DKB Runtime status')
  .option('--url <url>', 'Runtime API URL', process.env.DKB_RUNTIME_URL || 'http://127.0.0.1:7331')
  .action(async (options: { url: string }) => {
    const { DkbRuntimeClient } = await import('../runtime/client.js');

    await presenter().run('Checking runtime status', async () => new DkbRuntimeClient({ baseUrl: options.url }).status());
  });

runtime
  .command('registries')
  .description('List registries managed by the DKB Runtime')
  .option('--url <url>', 'Runtime API URL', process.env.DKB_RUNTIME_URL || 'http://127.0.0.1:7331')
  .action(async (options: { url: string }) => {
    const { DkbRuntimeClient } = await import('../runtime/client.js');

    printJson(await new DkbRuntimeClient({ baseUrl: options.url }).registries());
  });

const registry = program
  .command('registry')
  .description('Manage the DKB package registry');

registry
  .command('serve')
  .description('Start a local development DKB Registry HTTP API in the current process')
  .option('--host <host>', 'Host to bind', process.env.DKB_REGISTRY_HOST || '127.0.0.1')
  .option('--port <number>', 'Port to bind', parsePositiveInteger, Number.parseInt(process.env.DKB_REGISTRY_PORT || '7332', 10))
  .option('--root <path>', 'Local development registry storage root', process.env.DKB_REGISTRY_ROOT || '.dkb/mock-registry')
  .action(async (options: { host: string; port: number; root: string }) => {
    const { serveDkbRegistry } = await import('../registry/server.js');

    await serveDkbRegistry({
      host: options.host,
      port: options.port,
      registryRoot: options.root,
    });
  });

registry
  .command('status')
  .description('Show and verify the configured DKB registry')
  .option('--url <url>', 'Registry API URL to verify instead of the configured registry')
  .action(async (options: { url?: string }) => {
    const { configuredRegistry, verifyRegistryEndpoint } = await import('../registry/config.js');
    const configured = await configuredRegistry({ url: options.url });
    const verification = await verifyRegistryEndpoint(configured.url);

    printJson({
      registry: configured,
      verification,
    });

    if (!verification.ok) {
      process.exitCode = 1;
    }
  });

registry
  .command('use')
  .description('Set the default DKB registry URL')
  .argument('<url>', 'Registry API URL')
  .option('--no-verify', 'Save the URL without validating it first')
  .action(async (url: string, options: { verify?: boolean }) => {
    const { verifyRegistryEndpoint, writeConfiguredRegistryUrl } = await import('../registry/config.js');
    const verification = options.verify === false ? undefined : await verifyRegistryEndpoint(url);

    if (verification && !verification.ok) {
      printJson({ registry: { url }, verification });
      throw new DkbError('Registry validation failed. Use --no-verify only if you intentionally want to save this URL anyway.');
    }

    const configured = await writeConfiguredRegistryUrl(url);

    printJson({
      ok: true,
      registry: configured,
      ...(verification ? { verification } : {}),
    });
  });

registry
  .command('compiler-serve', { hidden: true })
  .description('Start the DKB Registry compiler service')
  .option('--host <host>', 'Host to bind', process.env.DKB_REGISTRY_COMPILER_HOST || '127.0.0.1')
  .option('--port <number>', 'Port to bind', parsePositiveInteger, Number.parseInt(process.env.DKB_REGISTRY_COMPILER_PORT || '7333', 10))
  .action(async (options: { host: string; port: number }) => {
    const { serveDkbRegistryCompiler } = await import('../registry/compilerService.js');

    await serveDkbRegistryCompiler({
      host: options.host,
      port: options.port,
    });
  });

registry
  .command('login')
  .description('Create or refresh a registry publisher session')
  .option('--root <path>', 'Local development registry storage root')
  .option('--url <url>', 'Registry API URL')
  .option('--account <id>', 'Publisher account id')
  .option('--name <name>', 'Publisher display name')
  .option('--email <email>', 'Publisher email')
  .action(async (options: { root?: string; url?: string; account?: string; name?: string; email?: string }) => {
    if (!options.root) {
      const { DkbRegistryClient } = await import('../registry/client.js');
      const { configuredRegistry } = await import('../registry/config.js');
      const registryConfig = await configuredRegistry({ url: options.url });

      printJson(await new DkbRegistryClient({ baseUrl: registryConfig.url }).login({
        accountId: options.account,
        name: options.name,
        email: options.email,
      }));

      return;
    }

    const { loginMockRegistry } = await import('../registry/packageRegistry.js');

    printJson(await loginMockRegistry({
      registryRoot: options.root,
      accountId: options.account,
      name: options.name,
      email: options.email,
    }));
  });

registry
  .command('packages')
  .description('List packages in the configured registry')
  .option('--root <path>', 'Local development registry storage root')
  .option('--url <url>', 'Registry API URL')
  .option('--token <token>', 'Registry API bearer token', process.env.DKB_REGISTRY_TOKEN)
  .action(async (options: { root?: string; url?: string; token?: string }) => {
    if (!options.root) {
      const { DkbRegistryClient } = await import('../registry/client.js');
      const { configuredRegistry } = await import('../registry/config.js');
      const registryConfig = await configuredRegistry({ url: options.url });

      printJson(await new DkbRegistryClient({ baseUrl: registryConfig.url, token: options.token }).packages());

      return;
    }

    const { listMockRegistryPackages } = await import('../registry/packageRegistry.js');

    printJson(await listMockRegistryPackages(options.root));
  });

registry
  .command('keys')
  .description('List registry public signing keys')
  .option('--root <path>', 'Local development registry storage root')
  .option('--url <url>', 'Registry API URL')
  .option('--token <token>', 'Registry API bearer token', process.env.DKB_REGISTRY_TOKEN)
  .action(async (options: { root?: string; url?: string; token?: string }) => {
    if (!options.root) {
      const { DkbRegistryClient } = await import('../registry/client.js');
      const { configuredRegistry } = await import('../registry/config.js');
      const registryConfig = await configuredRegistry({ url: options.url });

      printJson(await new DkbRegistryClient({ baseUrl: registryConfig.url, token: options.token }).publicKeys());

      return;
    }

    const { registryPublicKeys } = await import('../registry/packageRegistry.js');

    printJson(await registryPublicKeys(options.root));
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

    const { configuredRegistry } = await import('../registry/config.js');
    const { DkbRegistryClient } = await import('../registry/client.js');
    const registryConfig = await configuredRegistry({ url: options.registryUrl });
    const packageId = release.slice(0, separator);
    const version = release.slice(separator + 1);

    printJson(await new DkbRegistryClient({ baseUrl: registryConfig.url, token: options.token }).claimRemoteEndpoint(packageId, version, options.url));
  });

registry
  .command('pull')
  .description('Pull a DKB package archive from the registry')
  .argument('<package-id>', 'Registry package id')
  .option('--version <version>', 'Package version')
  .option('--output <path>', 'Archive path to write')
  .option('--root <path>', 'Local development registry storage root')
  .option('--url <url>', 'Registry API URL')
  .option('--token <token>', 'Registry API bearer token', process.env.DKB_REGISTRY_TOKEN)
  .action(async (packageId: string, options: { version?: string; output?: string; root?: string; url?: string; token?: string }) => {
    const outputPath = path.resolve(options.output ?? defaultPackageArchiveName(packageId, options.version));

    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    if (!options.root) {
      const { DkbRegistryClient } = await import('../registry/client.js');
      const { configuredRegistry } = await import('../registry/config.js');
      const registryConfig = await configuredRegistry({ url: options.url });
      const client = new DkbRegistryClient({ baseUrl: registryConfig.url, token: options.token });

      await fs.writeFile(outputPath, await client.packageArchive(packageId, options.version));
      printJson({
        status: 'pulled',
        packageId,
        version: options.version,
        archivePath: outputPath,
        registry: registryConfig.url,
      });

      return;
    }

    const { exportMockRegistryPackageArchive } = await import('../registry/packageRegistry.js');
    const result = await exportMockRegistryPackageArchive({
      registryRoot: options.root,
      packageId,
      version: options.version,
    });

    await fs.copyFile(result.archivePath, outputPath);
    printJson({
      ...result,
      status: 'pulled',
      archivePath: outputPath,
    });
  });

registry
  .command('verify')
  .description('Verify a DKB package receipt from the registry')
  .argument('<package-id>', 'Registry package id')
  .option('--version <version>', 'Package version')
  .option('--root <path>', 'Local development registry storage root')
  .option('--url <url>', 'Registry API URL')
  .option('--token <token>', 'Registry API bearer token', process.env.DKB_REGISTRY_TOKEN)
  .action(async (packageId: string, options: { version?: string; root?: string; url?: string; token?: string }) => {
    if (!options.root) {
      const { DkbRegistryClient } = await import('../registry/client.js');
      const { DKB_PACKAGE_EXTENSION } = await import('../registry/archive.js');
      const { verifyDkbArchiveFile } = await import('../registry/packageRegistry.js');
      const { configuredRegistry } = await import('../registry/config.js');
      const registryConfig = await configuredRegistry({ url: options.url });
      const client = new DkbRegistryClient({ baseUrl: registryConfig.url, token: options.token });
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-verify-download-'));
      const archivePath = path.join(tempRoot, `${packageId}${DKB_PACKAGE_EXTENSION}`);

      try {
        await fs.writeFile(archivePath, await client.packageArchive(packageId, options.version));
        const publicKeys = await client.publicKeys() as { keys: Parameters<typeof verifyDkbArchiveFile>[0]['trustedKeys'] };
        const result = await verifyDkbArchiveFile({
          archivePath,
          trustedKeys: publicKeys.keys,
        });

        printJson(result);

        if (!result.ok) {
          process.exitCode = 1;
        }
      } finally {
        await fs.rm(tempRoot, { recursive: true, force: true });
      }

      return;
    }

    const { verifyDownloadedMockRelease } = await import('../registry/packageRegistry.js');

    const result = await verifyDownloadedMockRelease({
      registryRoot: options.root,
      packageId,
      version: options.version,
    });

    printJson(result);

    if (!result.ok) {
      process.exitCode = 1;
    }
  });

registry
  .command('rotate-key', { hidden: true })
  .description('Rotate a local/admin registry publisher account key')
  .argument('<account-id>', 'Publisher account id')
  .option('--root <path>', 'Local development registry storage root', process.env.DKB_REGISTRY_ROOT || '.dkb/mock-registry')
  .option('--url <url>', 'Registry API URL for HTTP mode')
  .action(async (accountId: string, options: { root: string; url?: string }) => {
    if (options.url) {
      const { DkbRegistryClient } = await import('../registry/client.js');

      printJson(await new DkbRegistryClient({ baseUrl: options.url }).rotateAccountKey(accountId));

      return;
    }

    const { rotateMockRegistryAccountKey } = await import('../registry/packageRegistry.js');

    printJson(await rotateMockRegistryAccountKey({
      registryRoot: options.root,
      accountId,
    }));
  });

registry
  .command('rotate-registry-key', { hidden: true })
  .description('Rotate a local/admin registry signing key')
  .option('--root <path>', 'Local development registry storage root', process.env.DKB_REGISTRY_ROOT || '.dkb/mock-registry')
  .option('--url <url>', 'Registry API URL for HTTP mode')
  .action(async (options: { root: string; url?: string }) => {
    if (options.url) {
      const { DkbRegistryClient } = await import('../registry/client.js');

      printJson(await new DkbRegistryClient({ baseUrl: options.url }).rotateRegistryKey());

      return;
    }

    const { rotateMockRegistrySigningKey } = await import('../registry/packageRegistry.js');

    printJson(await rotateMockRegistrySigningKey({
      registryRoot: options.root,
    }));
  });

registry
  .command('revoke-key', { hidden: true })
  .description('Revoke a local/admin registry signing key')
  .argument('<key-id>', 'Signing key id')
  .option('--root <path>', 'Local development registry storage root', process.env.DKB_REGISTRY_ROOT || '.dkb/mock-registry')
  .option('--url <url>', 'Registry API URL for HTTP mode')
  .action(async (keyId: string, options: { root: string; url?: string }) => {
    if (options.url) {
      const { DkbRegistryClient } = await import('../registry/client.js');

      printJson(await new DkbRegistryClient({ baseUrl: options.url }).revokeKey(keyId));

      return;
    }

    const { revokeMockRegistryKey } = await import('../registry/packageRegistry.js');

    printJson(await revokeMockRegistryKey({
      registryRoot: options.root,
      keyId,
    }));
  });

program
  .command('publish')
  .description('Publish a DKB folder to the configured registry')
  .argument('[path]', 'DKB folder to publish', '.')
  .option('--registry <path>', 'Local development registry storage root')
  .option('--url <url>', 'Registry API URL')
  .option('--account <id>', 'Publisher account id')
  .option('--name <name>', 'Publisher display name')
  .option('--email <email>', 'Publisher email')
  .option('--force', 'Replace an existing package version')
  .option('--remote-url <url>', 'Register a public hosted runtime after publishing')
  .option('--public', 'Publish the package to the public catalog')
  .option('--token <token>', 'Registry API bearer token', process.env.DKB_REGISTRY_TOKEN)
  .action(async (target: string, options: { registry?: string; url?: string; account?: string; name?: string; email?: string; force?: boolean; remoteUrl?: string; public?: boolean; token?: string }) => {
    const sourcePath = path.resolve(target);

    if (!options.registry) {
      const { DkbRegistryClient } = await import('../registry/client.js');
      const { configuredRegistry } = await import('../registry/config.js');
      const registryConfig = await configuredRegistry({ url: options.url });

      await presenter().run('Publishing package', async () => new DkbRegistryClient({ baseUrl: registryConfig.url, token: options.token }).publish({
        sourcePath,
        accountId: options.account,
        accountName: options.name,
        accountEmail: options.email,
        force: Boolean(options.force),
        remoteUrl: options.remoteUrl,
        visibility: options.public || options.remoteUrl ? 'public' : 'private',
      }), summarizePublishResult);

      return;
    }

    const { publishDkbToMockRegistry } = await import('../registry/packageRegistry.js');
    const registryRoot = options.registry;

    if (!registryRoot) {
      throw new DkbError('Local registry mode requires --registry.');
    }

    await presenter().run('Publishing package', async () => publishDkbToMockRegistry({
      registryRoot,
      sourcePath,
      accountId: options.account,
      accountName: options.name,
      accountEmail: options.email,
      force: Boolean(options.force),
    }), summarizePublishResult);
  });

program
  .command('install')
  .description('Install a verified DKB package from the configured registry')
  .argument('<package-id>', 'Registry package id')
  .option('--version <version>', 'Package version')
  .option('--registry <path>', 'Local development registry storage root')
  .option('--url <url>', 'Registry API URL')
  .option('--runtime-root <path>', 'Managed runtime state root', process.env.DKB_RUNTIME_STATE_ROOT)
  .option('--force', 'Replace an existing installed DKB')
  .option('--token <token>', 'Registry API bearer token', process.env.DKB_REGISTRY_TOKEN)
  .action(async (packageId: string, options: { version?: string; registry?: string; url?: string; runtimeRoot?: string; force?: boolean; token?: string }) => {
    if (!options.registry) {
      const { DkbRegistryClient } = await import('../registry/client.js');
      const { DKB_PACKAGE_EXTENSION } = await import('../registry/archive.js');
      const { installDkbArchiveIntoRuntime } = await import('../registry/packageRegistry.js');
      const { configuredRegistry } = await import('../registry/config.js');
      const registryConfig = await configuredRegistry({ url: options.url });
      const client = new DkbRegistryClient({ baseUrl: registryConfig.url, token: options.token });

      await presenter().run('Installing package', async (progress) => {
        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-install-download-'));
        const archivePath = path.join(tempRoot, `${packageId}${DKB_PACKAGE_EXTENSION}`);

        try {
          await fs.writeFile(archivePath, await client.packageArchive(packageId, options.version, { progress }));
          const publicKeys = await client.publicKeys() as { keys: Parameters<typeof installDkbArchiveIntoRuntime>[0]['trustedKeys'] };

          return await installDkbArchiveIntoRuntime({
            archivePath,
            trustedKeys: publicKeys.keys,
            runtimeRoot: options.runtimeRoot,
            force: Boolean(options.force),
            progress,
          });
        } finally {
          await fs.rm(tempRoot, { recursive: true, force: true });
        }
      }, summarizeInstallResult);

      return;
    }

    const { installDkbFromMockRegistry } = await import('../registry/packageRegistry.js');
    const registryRoot = options.registry;

    if (!registryRoot) {
      throw new DkbError('Local registry mode requires --registry.');
    }

    await presenter().run('Installing package', async (progress) => installDkbFromMockRegistry({
      registryRoot,
      runtimeRoot: options.runtimeRoot,
      packageId,
      version: options.version,
      force: Boolean(options.force),
      progress,
    }), summarizeInstallResult);
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
    const { configuredRegistry } = await import('../registry/config.js');
    const { DkbRegistryClient } = await import('../registry/client.js');
    const registryConfig = await configuredRegistry({ url: options.registryUrl });

    printJson(await new DkbRegistryClient({ baseUrl: registryConfig.url, token: options.token }).searchPackages(query));
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
    const result = /^https?:\/\//i.test(target)
      ? await addDirectRemote({ url: target })
      : await addRegisteredRemote({
          packageId: target,
          version: options.version,
          endpointUrl: options.endpoint,
          registryUrl: options.registryUrl,
          token: options.token,
        });

    printJson(result);
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

    await removeRegisteredRemote(id);
    printJson({ status: 'removed', remoteId: id });
  });

remote
  .command('discover')
  .description('Read a site /.well-known/dkb.json discovery document through the runtime')
  .argument('<url>', 'Site URL or direct /.well-known/dkb.json URL')
  .option('--url <url>', 'Runtime API URL', process.env.DKB_RUNTIME_URL || 'http://127.0.0.1:7331')
  .action(async (targetUrl: string, options: { url: string }) => {
    const { DkbRuntimeClient } = await import('../runtime/client.js');

    printJson(await new DkbRuntimeClient({ baseUrl: options.url }).remoteDiscover(targetUrl));
  });

remote
  .command('attach')
  .description('Create a temporary session to a public remote DKB endpoint')
  .argument('<url>', 'Site URL or direct /.well-known/dkb.json URL')
  .option('--ttl <seconds>', 'Session lifetime in seconds', parsePositiveInteger)
  .option('--url <url>', 'Runtime API URL', process.env.DKB_RUNTIME_URL || 'http://127.0.0.1:7331')
  .action(async (targetUrl: string, options: { ttl?: number; url: string }) => {
    const { DkbRuntimeClient } = await import('../runtime/client.js');

    printJson(await new DkbRuntimeClient({ baseUrl: options.url }).remoteAttach({
      url: targetUrl,
      ttlSeconds: options.ttl,
    }));
  });

remote
  .command('sessions')
  .description('List temporary remote DKB sessions held by the runtime process')
  .option('--url <url>', 'Runtime API URL', process.env.DKB_RUNTIME_URL || 'http://127.0.0.1:7331')
  .action(async (options: { url: string }) => {
    const { DkbRuntimeClient } = await import('../runtime/client.js');

    printJson(await new DkbRuntimeClient({ baseUrl: options.url }).remoteSessions());
  });

remote
  .command('detach')
  .description('Remove a temporary remote DKB session from the runtime process')
  .argument('<session-id>', 'Remote session id returned by dkb remote attach')
  .option('--url <url>', 'Runtime API URL', process.env.DKB_RUNTIME_URL || 'http://127.0.0.1:7331')
  .action(async (sessionId: string, options: { url: string }) => {
    const { DkbRuntimeClient } = await import('../runtime/client.js');

    printJson(await new DkbRuntimeClient({ baseUrl: options.url }).remoteDetach(sessionId));
  });

remote
  .command('query')
  .description('Query a persistent verified remote, or a temporary remote session')
  .argument('<remote-or-session-id>', 'Persistent remote id or session id')
  .argument('<need>', 'Knowledge need')
  .option('--intent <intent>', 'Retrieval intent: evidence, records, count, summary, compare', 'evidence')
  .option('-l, --limit <number>', 'Maximum retrieved evidence count', parseLimit, 8)
  .option('--profile', 'Include retrieval profile metadata')
  .option('--url <url>', 'Runtime API URL', process.env.DKB_RUNTIME_URL || 'http://127.0.0.1:7331')
  .action(async (
    sessionId: string,
    need: string,
    options: { intent: 'evidence' | 'records' | 'count' | 'summary' | 'compare'; limit: number; profile?: boolean; url: string },
  ) => {
    const { listRegisteredRemotes, queryRegisteredRemote } = await import('../remote/manager.js');
    const persistent = (await listRegisteredRemotes()).remotes.find((remote) => remote.id === sessionId);

    if (persistent) {
      printJson(await queryRegisteredRemote({
        id: sessionId,
        request: {
          need,
          intent: options.intent,
          limit: options.limit,
          profile: Boolean(options.profile),
        },
      }));

      return;
    }

    const { DkbRuntimeClient } = await import('../runtime/client.js');

    printJson(await new DkbRuntimeClient({ baseUrl: options.url }).remoteRetrieve(sessionId, {
      need,
      intent: options.intent,
      limit: options.limit,
      profile: Boolean(options.profile),
    }));
  });

runtime
  .command('compile')
  .description('Compile the runtime registry or one installed DKB')
  .argument('[id]', 'Installed DKB id')
  .option('--url <url>', 'Runtime API URL', process.env.DKB_RUNTIME_URL || 'http://127.0.0.1:7331')
  .action(async (id: string | undefined, options: { url: string }) => {
    const { DkbRuntimeClient } = await import('../runtime/client.js');

    await presenter().run(id ? `Compiling installed package ${id}` : 'Compiling runtime registry', async () => new DkbRuntimeClient({ baseUrl: options.url }).compile(id), summarizeCompileResult);
  });

runtime
  .command('watch')
  .description('Start or stop runtime source watching')
  .argument('<action>', 'start or stop')
  .option('--url <url>', 'Runtime API URL', process.env.DKB_RUNTIME_URL || 'http://127.0.0.1:7331')
  .action(async (action: string, options: { url: string }) => {
    const { DkbRuntimeClient } = await import('../runtime/client.js');
    const client = new DkbRuntimeClient({ baseUrl: options.url });

    if (action === 'start') {
      printJson(await client.startWatch());

      return;
    }

    if (action === 'stop') {
      printJson(await client.stopWatch());

      return;
    }

    throw new DkbError('Runtime watch action must be start or stop');
  });

program
  .command('add')
  .description('Import a DKB folder/package into the managed runtime registry')
  .argument('<path>', 'Local DKB package, registry folder, or raw folder')
  .option('--id <id>', 'Installed DKB id override')
  .option('--name <name>', 'Generated manifest display name for raw folders')
  .option('--force', 'Replace an existing installed DKB with the same id')
  .option('--no-compile', 'Import without compiling afterward')
  .option('--url <url>', 'Runtime API URL', process.env.DKB_RUNTIME_URL || 'http://127.0.0.1:7331')
  .option('--host-import-root <path>', 'Host staging directory mounted into the runtime', process.env.DKB_RUNTIME_HOST_IMPORT_ROOT || '.dkb/runtime/imports')
  .option('--container-import-root <path>', 'Runtime-visible import mount path', process.env.DKB_RUNTIME_CONTAINER_IMPORT_ROOT || '/imports')
  .option('--no-stage', 'Send the provided path directly to the runtime API')
  .action(async (target: string, options: {
    id?: string;
    name?: string;
    force?: boolean;
    compile?: boolean;
    url: string;
    hostImportRoot: string;
    containerImportRoot: string;
    stage?: boolean;
  }) => {
    const { DkbRuntimeClient } = await import('../runtime/client.js');
    const sourcePath = options.stage === false
      ? target
      : await stageRuntimeImport(target, options.hostImportRoot, options.containerImportRoot, options.id);

    await presenter().run('Importing package into runtime', async () => new DkbRuntimeClient({ baseUrl: options.url }).importDkb({
      sourcePath,
      id: options.id,
      name: options.name,
      force: Boolean(options.force),
      compile: options.compile,
    }), summarizeInstallResult);
  });

program
  .command('remove')
  .description('Remove an installed DKB from the managed runtime registry')
  .argument('<id>', 'Installed DKB id')
  .option('--url <url>', 'Runtime API URL', process.env.DKB_RUNTIME_URL || 'http://127.0.0.1:7331')
  .action(async (id: string, options: { url: string }) => {
    const { DkbRuntimeClient } = await import('../runtime/client.js');

    await presenter().run(`Removing package ${id}`, async () => new DkbRuntimeClient({ baseUrl: options.url }).removeDkb(id), summarizeRemoveResult);
  });

program
  .command('retrieve')
  .description('Retrieve grounded evidence from the managed runtime registry')
  .argument('<need>', 'Knowledge need')
  .option('--intent <intent>', 'Retrieval intent: evidence, records, count, summary, compare', 'evidence')
  .option('-l, --limit <number>', 'Maximum retrieved evidence count', parseLimit, 8)
  .option('--profile', 'Include retrieval profile metadata')
  .option('--url <url>', 'Runtime API URL', process.env.DKB_RUNTIME_URL || 'http://127.0.0.1:7331')
  .action(async (
    need: string,
    options: { intent: 'evidence' | 'records' | 'count' | 'summary' | 'compare'; limit: number; profile?: boolean; url: string },
  ) => {
    const { DkbRuntimeClient } = await import('../runtime/client.js');

    printJson(await new DkbRuntimeClient({ baseUrl: options.url }).retrieve({
      need,
      intent: options.intent,
      limit: options.limit,
      profile: Boolean(options.profile),
    }));
  });

program
  .command('artifact')
  .description('Inspect, validate, and package compiled DKB artifacts')
  .addCommand(new Command('inspect')
    .description('Inspect .dkb/artifacts/dkb-artifact.json')
    .argument('<path>', 'Directory containing a compiled DKB artifact manifest')
    .action(async (target: string) => {
      const { inspectDkbArtifactManifest } = await import('../artifacts/manifest.js');

      printJson(await inspectDkbArtifactManifest(path.resolve(target)));
    }))
  .addCommand(new Command('validate')
    .description('Validate a compiled DKB artifact manifest and listed files')
    .argument('<path>', 'Directory containing a compiled DKB artifact manifest')
    .action(async (target: string) => {
      const { validateDkbArtifactManifest } = await import('../artifacts/manifest.js');
      const result = await validateDkbArtifactManifest(path.resolve(target));

      printJson(result);

      if (!result.ok) {
        process.exitCode = 1;
      }
    }))
  .addCommand(new Command('pack')
    .description('Create a deterministic .dkbpkg archive from a validated compiled artifact')
    .argument('<path>', 'Directory containing a compiled DKB artifact manifest')
    .requiredOption('--out <path>', 'Archive path to write')
    .action(async (target: string, options: { out: string }) => {
      const { packDkbArtifact } = await import('../artifacts/manifest.js');

      await presenter().run('Packing compiled artifact', async () => packDkbArtifact(path.resolve(target), path.resolve(options.out)), summarizeArtifactTransport);
    }))
  .addCommand(new Command('install')
    .description('Install a validated extracted compiled artifact into a runtime without recompiling source')
    .argument('<path>', 'Extracted directory containing a compiled DKB artifact manifest')
    .option('--runtime-root <path>', 'Runtime registry root', process.env.DKB_RUNTIME_STATE_ROOT || process.env.DKB_REGISTRY_PATH || '.dkb/runtime')
    .option('--id <id>', 'Installed DKB id override')
    .option('--force', 'Replace an existing installed DKB with the same id')
    .action(async (target: string, options: { runtimeRoot: string; id?: string; force?: boolean }) => {
      const { importCompiledDkbArtifactIntoRuntime } = await import('../runtime/state.js');

      await presenter().run('Installing compiled artifact', async (progress) => importCompiledDkbArtifactIntoRuntime({
        sourcePath: path.resolve(target),
        id: options.id,
        force: Boolean(options.force),
        progress,
      }, path.resolve(options.runtimeRoot)), summarizeInstallResult);
    }))
  .addCommand(new Command('uninstall')
    .description('Remove an installed compiled artifact from a local runtime')
    .argument('<id>', 'Installed DKB id')
    .option('--runtime-root <path>', 'Runtime registry root', process.env.DKB_RUNTIME_STATE_ROOT || process.env.DKB_REGISTRY_PATH || '.dkb/runtime')
    .action(async (id: string, options: { runtimeRoot: string }) => {
      const { removeDkbFromRuntime } = await import('../runtime/state.js');

      await presenter().run(`Uninstalling ${id}`, async (progress) => removeDkbFromRuntime(id, path.resolve(options.runtimeRoot), { progress }), summarizeRemoveResult);
    }))
  .addCommand(new Command('tools')
    .description('Inspect OCI transport and signing tool availability')
    .action(async () => {
      const { inspectOciToolAvailability } = await import('../oci/tools.js');

      printJson(await inspectOciToolAvailability());
    }))
  .addCommand(new Command('oci-push')
    .description('Push a .dkbpkg artifact to an OCI registry using ORAS')
    .argument('<archive>', 'Compiled .dkbpkg archive')
    .argument('<ref>', 'OCI reference, for example localhost:5000/dkb/name:version')
    .action(async (archive: string, ref: string) => {
      const { orasPushArtifact } = await import('../oci/tools.js');

      await presenter().run('Pushing artifact', async () => orasPushArtifact({ archivePath: path.resolve(archive), ref }), summarizeArtifactTransport);
    }))
  .addCommand(new Command('oci-pull')
    .description('Pull a .dkbpkg artifact from an OCI registry using ORAS')
    .argument('<ref>', 'OCI reference, for example localhost:5000/dkb/name:version')
    .requiredOption('--out <path>', 'Output directory')
    .action(async (ref: string, options: { out: string }) => {
      const { orasPullArtifact } = await import('../oci/tools.js');

      await presenter().run('Pulling artifact', async () => orasPullArtifact({ ref, outputDir: path.resolve(options.out) }), summarizeArtifactTransport);
    }))
  .addCommand(new Command('cosign-keypair')
    .description('Create a local Cosign key pair')
    .requiredOption('--out <prefix>', 'Output key prefix')
    .requiredOption('--password <password>', 'Cosign key password')
    .action(async (options: { out: string; password: string }) => {
      const { cosignGenerateKeyPair } = await import('../oci/tools.js');

      printJson(await cosignGenerateKeyPair({ outputPrefix: path.resolve(options.out), password: options.password }));
    }))
  .addCommand(new Command('cosign-sign')
    .description('Sign an OCI artifact with Cosign')
    .argument('<ref>', 'OCI reference to sign')
    .requiredOption('--key <path>', 'Cosign private key')
    .requiredOption('--password <password>', 'Cosign key password')
    .action(async (ref: string, options: { key: string; password: string }) => {
      const { cosignSignArtifact } = await import('../oci/tools.js');

      printJson(await cosignSignArtifact({ ref, keyPath: path.resolve(options.key), password: options.password }));
    }))
  .addCommand(new Command('cosign-verify')
    .description('Verify a signed OCI artifact with Cosign')
    .argument('<ref>', 'OCI reference to verify')
    .requiredOption('--key <path>', 'Cosign public key')
    .action(async (ref: string, options: { key: string }) => {
      const { cosignVerifyArtifact } = await import('../oci/tools.js');
      const result = await cosignVerifyArtifact({ ref, publicKeyPath: path.resolve(options.key) });

      printJson(result);

      if (!result.ok) {
        process.exitCode = 1;
      }
    }));

program
  .command('validate')
  .description('Validate a DKB package or implicit registry')
  .argument('<path>', 'Directory containing dkb.json or nested DKB packages')
  .action(async (target: string) => {
    const resolved = path.resolve(target);
    const manifestFile = path.join(resolved, 'dkb.json');
    const manifest = await exists(manifestFile)
      ? JSON.parse(await fs.readFile(manifestFile, 'utf8')) as { type?: unknown; dependencies?: unknown }
      : null;
    const isProjectManifest = manifest?.type === 'registry'
      || (manifest?.dependencies !== undefined && typeof manifest.dependencies === 'object' && !Array.isArray(manifest.dependencies));
    const isDkb = Boolean(manifest) && !isProjectManifest;
    const output = isDkb
      ? await loadDkb(resolved).then((dkb) => ({
          id: dkb.manifest.id,
          name: dkb.manifest.name,
          version: dkb.manifest.version,
          type: 'dkb',
        }))
      : await import('../protocol/manifest.js').then((module) => module.loadRegistry(resolved)).then((registry) => ({
          id: registry.manifest.id,
          name: registry.manifest.name,
          version: registry.manifest.version,
          type: 'registry',
        }));

    printJson({
      ok: true,
      ...output,
    });
  });

program
  .command('compile')
  .description('Compile a DKB package or implicit registry')
  .argument('<path>', 'Directory containing dkb.json or nested DKB packages')
  .option('--force', 'Rebuild generated artifacts even when the local compile cache is valid')
  .option('--compiler <name>', 'Compiler profile: native or llamaindex', 'native')
  .option('--artifact-profile <name>', 'Artifact profile: full or faiss-package', 'full')
  .action(async (target: string, options: { force?: boolean; compiler: string; artifactProfile: string }) => {
    const { compileComposeProject } = await import('../compiler/compile.js');
    if (options.compiler !== 'native' && options.compiler !== 'llamaindex') {
      throw new DkbError(`Unknown compiler profile ${options.compiler}. Expected native or llamaindex.`);
    }
    if (options.artifactProfile !== 'full' && options.artifactProfile !== 'faiss-package') {
      throw new DkbError(`Unknown artifact profile ${options.artifactProfile}. Expected full or faiss-package.`);
    }
    const compiler = options.compiler;
    const artifactProfile = options.artifactProfile;

    await presenter().run(`Compiling ${path.resolve(target)}`, async () => compileComposeProject(target, {
      force: Boolean(options.force),
      compiler,
      artifactProfile,
    }), summarizeCompileResult);
  });

program
  .command('compiler')
  .description('Use the standalone LlamaIndex/FastEmbed/Docling local compiler without starting a DKB runtime')
  .addCommand(new Command('inspect')
    .description('Report whether the standalone LlamaIndex compiler image and local service are available')
    .action(async () => {
      const { inspectLlamaIndexCompiler } = await import('../compiler/llamaindex.js');
      await presenter().run('Inspecting compiler environment', async () => inspectLlamaIndexCompiler(), summarizeCompilerStatus);
    }))
  .addCommand(new Command('start')
    .description('Start or reuse the warm local LlamaIndex compiler service')
    .option('--restart', 'Replace any existing compiler service container')
    .action(async (options: { restart?: boolean }) => {
      const { startLlamaIndexCompilerService } = await import('../compiler/llamaindex.js');
      await presenter().run('Starting compiler service', async () => startLlamaIndexCompilerService({ forceRestart: Boolean(options.restart) }), summarizeCompilerStatus);
    }))
  .addCommand(new Command('status')
    .description('Show warm local LlamaIndex compiler service status')
    .action(async () => {
      const { compilerServiceStatus } = await import('../compiler/llamaindex.js');
      await presenter().run('Checking compiler service', async () => compilerServiceStatus(), summarizeCompilerStatus);
    }))
  .addCommand(new Command('stop')
    .description('Stop the warm local LlamaIndex compiler service')
    .action(async () => {
      const { stopLlamaIndexCompilerService } = await import('../compiler/llamaindex.js');
      await presenter().run('Stopping compiler service', async () => stopLlamaIndexCompilerService(), summarizeCompilerStatus);
    }))
  .addCommand(new Command('doctor')
    .description('Diagnose Docker/image/service readiness for the warm compiler')
    .action(async () => {
      const { doctorLlamaIndexCompilerService } = await import('../compiler/llamaindex.js');
      await presenter().run('Checking compiler doctor', async () => doctorLlamaIndexCompilerService(), summarizeCompilerStatus);
    }))
  .addCommand(new Command('compile')
    .description('Compile one DKB folder with LlamaIndex, Docling rich-file routing, and FastEmbed/ONNX')
    .argument('<path>', 'Directory containing one DKB dkb.json manifest')
    .option('--model <name>', 'FastEmbed model name')
    .action(async (target: string, options: { model?: string }) => {
      const root = path.resolve(target);
      const dkb = await loadDkb(root);
      const { compileDkbWithLlamaIndex } = await import('../compiler/llamaindex.js');
      const result = await compileDkbWithLlamaIndex(dkb, { model: options.model });
      const outputPath = path.join(root, DKB_ARTIFACTS_DIR, 'llamaindex.compiler.json');

      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      presenter().print({
        compiler: result.compiler,
        recordCount: result.records.length,
        outputPath,
      }, summarizeCompilerCompileResult);
    }));

program
  .command('verify')
  .description('Verify a compiled DKB registry against dkb-lock.json')
  .argument('<path>', 'Directory containing DKB packages and dkb-lock.json')
  .option('--strict', 'Require all generated artifacts to be built')
  .action(async (target: string, options: { strict?: boolean }) => {
    const { verifyComposeProject } = await import('../compiler/compile.js');
    const result = await verifyComposeProject(target);
    const strictFailures = options.strict
      ? Object.entries(result.ok ? result.checks : result.checks)
        .filter(([, check]) => !check.ok)
        .map(([name]) => name)
      : [];
    const output = {
      ...result,
      strict: Boolean(options.strict),
      strictFailures,
    };

    printJson(output);

    if (!result.ok || strictFailures.length > 0) {
      process.exitCode = 1;
    }
  });

program
  .command('inspect')
  .description('Inspect a DKB package or implicit registry before use')
  .argument('<path>', 'Directory containing a DKB manifest')
  .option('--json', 'Emit JSON output', true)
  .action(async (target: string) => {
    const { inspectTarget } = await import('../inspect/index.js');

    printJson(await inspectTarget(target));
  });

program
  .command('health')
  .description('Check manifest, source, artifact, verification, queue, and space identity health')
  .argument('[path]', 'Directory containing dkb.json or nested DKB packages', process.env.DKB_REGISTRY_PATH || '.')
  .option('--queue-root <path>', 'Write queue root to inspect', process.env.DKB_QUEUE_ROOT || process.env.DKB_WRITE_QUEUE_ROOT)
  .action(async (target: string, options: { queueRoot?: string }) => {
    const { healthReport } = await import('../lifecycle/health.js');

    printJson(await healthReport(target, options.queueRoot));
  });

program
  .command('restore')
  .description('Rebuild generated registry artifacts from source knowledge without mutating it')
  .argument('[path]', 'Directory containing dkb.json or nested DKB packages', process.env.DKB_REGISTRY_PATH || '.')
  .action(async (target: string) => {
    const { restoreIndexes } = await import('../lifecycle/health.js');

    printJson(await restoreIndexes(target));
  });

program
  .command('query')
  .description('Run deterministic search against a DKB package or implicit registry')
  .argument('<registry-path>', 'Directory containing dkb.json or nested DKB packages')
  .argument('<query>', 'Search query')
  .option('-l, --limit <number>', 'Maximum result count', parseLimit)
  .action(async (target: string, query: string, options: { limit?: number }) => {
    const { queryKnowledgeTarget } = await import('../knowledge/target.js');

    printJson((await queryKnowledgeTarget(target, query, { limit: options.limit })).response);
  });

program
  .command('read-targets')
  .description('Describe queryable DKB Read API targets from a compiled DKB registry')
  .argument('<registry-path>', 'Directory containing DKB packages and compiled chunk artifacts')
  .argument('<query>', 'Natural-language lookup intent for ranking chunk targets')
  .option('-l, --limit <number>', 'Maximum target count', parseLimit, 10)
  .action(async (target: string, query: string, options: { limit: number }) => {
    const { describeQueryTargets } = await import('../read/runtime.js');

    printJson(await describeQueryTargets(target, query, options.limit));
  });

program
  .command('read')
  .description('Execute a DKB Read API request JSON file against a compiled DKB registry')
  .argument('<registry-path>', 'Directory containing DKB packages and compiled chunk artifacts')
  .argument('<request-path>', 'Path to a DKB Read API request JSON file')
  .action(async (target: string, requestPath: string) => {
    const fs = await import('node:fs/promises');
    const { readDkb } = await import('../read/runtime.js');

    printJson(await readDkb(target, JSON.parse(await fs.readFile(requestPath, 'utf8'))));
  });

program
  .command('search-health')
  .description('Report local DKB search backend health')
  .argument('<registry-path>', 'Directory containing dkb.json or nested DKB packages')
  .action(async (target: string) => {
    const { describeSearchBackend } = await import('../indexes/vectorStore.js');

    printJson(await describeSearchBackend(path.resolve(target, DKB_ARTIFACTS_DIR)));
  });

program
  .command('search-sync')
  .description('Sync compiled chunk documents into the configured search backend')
  .argument('<registry-path>', 'Directory containing DKB packages and compiled chunk artifacts')
  .action(async (target: string) => {
    const { loadCompose } = await import('../protocol/manifest.js');
    const { readSourceIndex, SOURCE_VECTOR_PATH } = await import('../indexes/sourceIndex.js');
    const { vectorDocumentsForSourceUnits, writeSearchArtifacts } = await import('../indexes/vectorStore.js');
    const registry = await loadCompose(target);
    const sourceIndex = await readSourceIndex(target);

    printJson(await writeSearchArtifacts(registry.manifest.id, path.resolve(target, SOURCE_VECTOR_PATH), vectorDocumentsForSourceUnits(sourceIndex.units)));
  });

program
  .command('search-query')
  .description('Query the configured DKB search backend directly')
  .argument('<registry-path>', 'Directory containing DKB packages and compiled chunk artifacts')
  .argument('<query>', 'Search query')
  .option('-l, --limit <number>', 'Maximum result count', parseLimit, 10)
  .action(async (target: string, query: string, options: { limit: number }) => {
    const { loadCompose } = await import('../protocol/manifest.js');
    const { readSourceIndex } = await import('../indexes/sourceIndex.js');
    const { searchBackendQuery, vectorDocumentsForSourceUnits } = await import('../indexes/vectorStore.js');
    const registry = await loadCompose(target);
    const sourceIndex = await readSourceIndex(target);

    printJson(await searchBackendQuery({
      registryId: registry.manifest.id,
      artifactRoot: path.resolve(target, DKB_ARTIFACTS_DIR),
      documents: vectorDocumentsForSourceUnits(sourceIndex.units),
      query,
      limit: options.limit,
    }));
  });

program
  .command('search-reset')
  .description('Delete configured DKB search backend indexes for a DKB registry')
  .argument('<registry-path>', 'Directory containing dkb.json or nested DKB packages')
  .action(async (target: string) => {
    const { loadCompose } = await import('../protocol/manifest.js');
    const { resetSearchBackend } = await import('../indexes/vectorStore.js');
    const registry = await loadCompose(target);

    printJson(await resetSearchBackend(registry.manifest.id, path.resolve(target, DKB_ARTIFACTS_DIR)));
  });

program
  .command('watch')
  .description('Watch a DKB registry and rebuild indexes on source changes')
  .argument('<registry-path>', 'Directory containing dkb.json or nested DKB packages')
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
  .description('Audit whether DKB package or registry chunk artifacts are protocol aligned')
  .argument('<path>', 'Directory containing dkb.json or nested DKB packages')
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
  .option('--root <path>', 'Runtime or registry root', process.env.DKB_RUNTIME_STATE_ROOT || process.env.DKB_REGISTRY_PATH || '.')
  .action(async (options: { root: string }) => {
    const { latestTrace } = await import('../runtime/trace.js');

    printJson(await latestTrace(options.root));
  });

trace
  .command('list')
  .description('List recent retrieval traces')
  .option('--root <path>', 'Runtime or registry root', process.env.DKB_RUNTIME_STATE_ROOT || process.env.DKB_REGISTRY_PATH || '.')
  .option('--limit <number>', 'Maximum trace summaries to return', parseLimit, 20)
  .action(async (options: { root: string; limit: number }) => {
    const { listTraces } = await import('../runtime/trace.js');

    printJson(await listTraces(options.root, options.limit));
  });

trace
  .command('get')
  .description('Show one retrieval trace by id')
  .argument('<trace-id>', 'Trace id from trace list/latest')
  .option('--root <path>', 'Runtime or registry root', process.env.DKB_RUNTIME_STATE_ROOT || process.env.DKB_REGISTRY_PATH || '.')
  .action(async (traceId: string, options: { root: string }) => {
    const { getTrace } = await import('../runtime/trace.js');

    printJson(await getTrace(options.root, traceId));
  });

const mcp = program
  .command('mcp')
  .description('Serve DKB collections through Model Context Protocol');

mcp
  .command('serve')
  .description('Start the DKB MCP server over stdio')
  .action(async () => {
    const { serveDkbMcpServer } = await import('../mcp/server.js');

    serveDkbMcpServer();
  });

program.exitOverride();

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError && (error.code === 'commander.helpDisplayed' || error.code === 'commander.version')) {
    process.exitCode = error.exitCode;
  } else {
    const message = error instanceof DkbError || error instanceof Error ? error.message : String(error);

    console.error(message);
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

function printJson(value: unknown): void {
  printJsonValue(value);
}

function summarizeCompileResult(value: unknown): string[] {
  const result = value as {
    registryId?: unknown;
    recordCount?: unknown;
    cacheHit?: unknown;
    artifactManifestPath?: unknown;
    profile?: { timingsMs?: Record<string, unknown>; aggregateTimingsMs?: Record<string, unknown> };
  };
  const total = milliseconds(result.profile?.timingsMs?.total);
  const aggregate = milliseconds(result.profile?.aggregateTimingsMs?.total);

  return [
    `registry: ${String(result.registryId ?? 'unknown')}`,
    countLabel(result.recordCount, 'record') ?? '',
    `cache: ${result.cacheHit ? 'hit' : 'updated'}`,
    total ? `total: ${total}` : '',
    aggregate ? `artifact work: ${aggregate}` : '',
    typeof result.artifactManifestPath === 'string' ? `artifact: ${result.artifactManifestPath}` : '',
  ];
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
  };

  return [
    `status: ${String(result.status ?? 'ok')}`,
    `package: ${String(result.packageId ?? result.id ?? 'unknown')}${result.version ? `@${String(result.version)}` : ''}`,
    countLabel(result.catalog?.recordCount ?? result.search?.upsert?.documentCount, 'record') ?? '',
    countLabel(result.catalog?.packageCount, 'package') ?? '',
    milliseconds(result.search?.upsert?.timingsMs?.total) ? `search activation: ${milliseconds(result.search?.upsert?.timingsMs?.total)}` : '',
    typeof result.packagePath === 'string' ? `path: ${result.packagePath}` : '',
  ];
}

function summarizeRemoveResult(value: unknown): string[] {
  const result = value as { status?: unknown; id?: unknown; registryPath?: unknown };

  return [
    `status: ${String(result.status ?? 'ok')}`,
    `package: ${String(result.id ?? 'unknown')}`,
    typeof result.registryPath === 'string' ? `runtime: ${result.registryPath}` : '',
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
  };
  const packageId = result.packageId ?? result.receipt?.packageId;
  const version = result.version ?? result.receipt?.version;

  return [
    `status: ${String(result.status ?? 'published')}`,
    `package: ${String(packageId ?? 'unknown')}${version ? `@${String(version)}` : ''}`,
    countLabel(result.compiled?.recordCount, 'record') ?? '',
    typeof result.archivePath === 'string' ? `archive: ${result.archivePath}` : '',
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
  };

  return [
    `status: ${String(result.status ?? 'ok')}`,
    typeof result.ref === 'string' ? `ref: ${result.ref}` : '',
    typeof result.digest === 'string' ? `digest: ${result.digest}` : '',
    typeof result.archivePath === 'string' ? `archive: ${result.archivePath}` : '',
    typeof result.outputDir === 'string' ? `output: ${result.outputDir}` : '',
    typeof result.archiveBytes === 'number' ? `size: ${result.archiveBytes} bytes` : '',
  ];
}

function parseLimit(value: string): number {
  const limit = Number.parseInt(value, 10);

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new DkbError('Limit must be an integer between 1 and 100');
  }

  return limit;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new DkbError('Value must be a positive integer');
  }

  return parsed;
}

function descriptionForTestCommand(command: 'lifecycle'): string {
  return {
    lifecycle: 'Run isolated add/update/remove DKB lifecycle checks',
  }[command];
}

function defaultBaseUrl(): string {
  return process.env.DKB_MODEL_BASE_URL || 'http://127.0.0.1:1234/v1';
}

function runDockerCompose(composeFile: string, args: string[]): void {
  const result = spawnSync('docker', ['compose', '-f', composeFile, ...args], {
    stdio: 'inherit',
  });

  if (result.error) {
    throw new DkbError(`Unable to run docker compose: ${result.error.message}`);
  }

  if (result.status && result.status !== 0) {
    throw new DkbError(`docker compose exited with code ${result.status}`);
  }
}

async function stageRuntimeImport(source: string, hostRoot: string, containerRoot: string, id?: string): Promise<string> {
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
    filter: (candidate) => !isDkbStatePath(resolvedSource, candidate),
  });

  return `${containerRoot.replace(/\/+$/g, '')}/${stageId}`;
}

function isDkbStatePath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);

  return relative === '.dkb' || relative.startsWith(`.dkb${path.sep}`);
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
