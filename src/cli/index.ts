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

const program = new Command();

program
  .name('dkb')
  .description('Portable, read-only durable knowledgebase protocol CLI')
  .version(DKB_PROTOCOL_VERSION);

program
  .command('init')
  .description('Create a new DKB folder with dkb.json')
  .argument('[name]', 'DKB package id or display name')
  .option('--dir <path>', 'Parent directory where the DKB folder should be created')
  .option('--owner <id>', 'Owner id to write into dkb.json')
  .option('--email <email>', 'Owner email to write into dkb.json')
  .option('--collection <id>', 'Optional collection id metadata')
  .action(async (name: string | undefined, options: { dir?: string; owner?: string; email?: string; collection?: string }) => {
    const displayName = await resolveInitName(name);
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

    printJson(await new DkbRuntimeClient({ baseUrl: options.url }).status());
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
  .description('Manage the mock DKB package registry');

registry
  .command('serve')
  .description('Start the mock DKB Registry HTTP API in the current process')
  .option('--host <host>', 'Host to bind', process.env.DKB_REGISTRY_HOST || '127.0.0.1')
  .option('--port <number>', 'Port to bind', parsePositiveInteger, Number.parseInt(process.env.DKB_REGISTRY_PORT || '7332', 10))
  .option('--root <path>', 'Registry storage root', process.env.DKB_REGISTRY_ROOT || '.dkb/mock-registry')
  .action(async (options: { host: string; port: number; root: string }) => {
    const { serveDkbRegistry } = await import('../registry/server.js');

    await serveDkbRegistry({
      host: options.host,
      port: options.port,
      registryRoot: options.root,
    });
  });

registry
  .command('login')
  .description('Create or refresh a mock registry publisher account')
  .option('--root <path>', 'Registry storage root for local mode', process.env.DKB_REGISTRY_ROOT || '.dkb/mock-registry')
  .option('--url <url>', 'Registry API URL for HTTP mode')
  .option('--account <id>', 'Publisher account id')
  .option('--name <name>', 'Publisher display name')
  .option('--email <email>', 'Publisher email')
  .action(async (options: { root: string; url?: string; account?: string; name?: string; email?: string }) => {
    if (options.url) {
      const { DkbRegistryClient } = await import('../registry/client.js');

      printJson(await new DkbRegistryClient({ baseUrl: options.url }).login({
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
  .description('List packages in the mock registry')
  .option('--root <path>', 'Registry storage root for local mode', process.env.DKB_REGISTRY_ROOT || '.dkb/mock-registry')
  .option('--url <url>', 'Registry API URL for HTTP mode')
  .action(async (options: { root: string; url?: string }) => {
    if (options.url) {
      const { DkbRegistryClient } = await import('../registry/client.js');

      printJson(await new DkbRegistryClient({ baseUrl: options.url }).packages());

      return;
    }

    const { listMockRegistryPackages } = await import('../registry/packageRegistry.js');

    printJson(await listMockRegistryPackages(options.root));
  });

registry
  .command('keys')
  .description('List mock registry public signing keys')
  .option('--root <path>', 'Registry storage root for local mode', process.env.DKB_REGISTRY_ROOT || '.dkb/mock-registry')
  .option('--url <url>', 'Registry API URL for HTTP mode')
  .action(async (options: { root: string; url?: string }) => {
    if (options.url) {
      const { DkbRegistryClient } = await import('../registry/client.js');

      printJson(await new DkbRegistryClient({ baseUrl: options.url }).publicKeys());

      return;
    }

    const { registryPublicKeys } = await import('../registry/packageRegistry.js');

    printJson(await registryPublicKeys(options.root));
  });

registry
  .command('rotate-key')
  .description('Rotate a mock registry publisher account key')
  .argument('<account-id>', 'Publisher account id')
  .option('--root <path>', 'Registry storage root for local mode', process.env.DKB_REGISTRY_ROOT || '.dkb/mock-registry')
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
  .command('rotate-registry-key')
  .description('Rotate the mock registry signing key')
  .option('--root <path>', 'Registry storage root for local mode', process.env.DKB_REGISTRY_ROOT || '.dkb/mock-registry')
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
  .command('revoke-key')
  .description('Revoke a mock registry signing key')
  .argument('<key-id>', 'Signing key id')
  .option('--root <path>', 'Registry storage root for local mode', process.env.DKB_REGISTRY_ROOT || '.dkb/mock-registry')
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
  .description('Publish a DKB folder to the mock registry')
  .argument('[path]', 'DKB folder to publish', '.')
  .option('--registry <path>', 'Local registry storage root', process.env.DKB_REGISTRY_ROOT || '.dkb/mock-registry')
  .option('--url <url>', 'Registry API URL for HTTP mode')
  .option('--account <id>', 'Publisher account id')
  .option('--name <name>', 'Publisher display name')
  .option('--email <email>', 'Publisher email')
  .option('--force', 'Replace an existing package version')
  .action(async (target: string, options: { registry: string; url?: string; account?: string; name?: string; email?: string; force?: boolean }) => {
    const sourcePath = path.resolve(target);

    if (options.url) {
      const { DkbRegistryClient } = await import('../registry/client.js');

      printJson(await new DkbRegistryClient({ baseUrl: options.url }).publish({
        sourcePath,
        accountId: options.account,
        accountName: options.name,
        accountEmail: options.email,
        force: Boolean(options.force),
      }));

      return;
    }

    const { publishDkbToMockRegistry } = await import('../registry/packageRegistry.js');

    printJson(await publishDkbToMockRegistry({
      registryRoot: options.registry,
      sourcePath,
      accountId: options.account,
      accountName: options.name,
      accountEmail: options.email,
      force: Boolean(options.force),
    }));
  });

program
  .command('install')
  .description('Install a verified DKB package from the mock registry')
  .argument('<package-id>', 'Registry package id')
  .option('--version <version>', 'Package version')
  .option('--registry <path>', 'Local registry storage root', process.env.DKB_REGISTRY_ROOT || '.dkb/mock-registry')
  .option('--url <url>', 'Registry API URL for HTTP mode')
  .option('--runtime-root <path>', 'Managed runtime state root', process.env.DKB_RUNTIME_STATE_ROOT)
  .option('--force', 'Replace an existing installed DKB')
  .action(async (packageId: string, options: { version?: string; registry: string; url?: string; runtimeRoot?: string; force?: boolean }) => {
    if (options.url) {
      const { DkbRegistryClient } = await import('../registry/client.js');
      const { DKB_PACKAGE_EXTENSION } = await import('../registry/archive.js');
      const { installDkbArchiveIntoRuntime } = await import('../registry/packageRegistry.js');
      const client = new DkbRegistryClient({ baseUrl: options.url });
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dkb-install-download-'));
      const archivePath = path.join(tempRoot, `${packageId}${DKB_PACKAGE_EXTENSION}`);

      try {
        await fs.writeFile(archivePath, await client.packageArchive(packageId, options.version));
        const publicKeys = await client.publicKeys() as { keys: Parameters<typeof installDkbArchiveIntoRuntime>[0]['trustedKeys'] };

        printJson(await installDkbArchiveIntoRuntime({
          archivePath,
          trustedKeys: publicKeys.keys,
          runtimeRoot: options.runtimeRoot,
          force: Boolean(options.force),
        }));
      } finally {
        await fs.rm(tempRoot, { recursive: true, force: true });
      }

      return;
    }

    const { installDkbFromMockRegistry } = await import('../registry/packageRegistry.js');

    printJson(await installDkbFromMockRegistry({
      registryRoot: options.registry,
      runtimeRoot: options.runtimeRoot,
      packageId,
      version: options.version,
      force: Boolean(options.force),
    }));
  });

const remote = program
  .command('remote')
  .description('Discover and temporarily query public remote DKB runtimes');

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
  .description('Retrieve evidence from a temporary remote DKB session')
  .argument('<session-id>', 'Remote session id returned by dkb remote attach')
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

    printJson(await new DkbRuntimeClient({ baseUrl: options.url }).compile(id));
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

    printJson(await new DkbRuntimeClient({ baseUrl: options.url }).importDkb({
      sourcePath,
      id: options.id,
      name: options.name,
      force: Boolean(options.force),
      compile: options.compile,
    }));
  });

program
  .command('remove')
  .description('Remove an installed DKB from the managed runtime registry')
  .argument('<id>', 'Installed DKB id')
  .option('--url <url>', 'Runtime API URL', process.env.DKB_RUNTIME_URL || 'http://127.0.0.1:7331')
  .action(async (id: string, options: { url: string }) => {
    const { DkbRuntimeClient } = await import('../runtime/client.js');

    printJson(await new DkbRuntimeClient({ baseUrl: options.url }).removeDkb(id));
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
  .action(async (target: string, options: { force?: boolean }) => {
    const { compileComposeProject } = await import('../compiler/compile.js');

    printJson(await compileComposeProject(target, { force: Boolean(options.force) }));
  });

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
  .argument('<registry-path>', 'Directory containing DKB packages and .dkb/artifacts/kr.index')
  .argument('<query>', 'Natural-language lookup intent for ranking KR targets')
  .option('-l, --limit <number>', 'Maximum target count', parseLimit, 10)
  .action(async (target: string, query: string, options: { limit: number }) => {
    const { describeQueryTargets } = await import('../read/runtime.js');

    printJson(await describeQueryTargets(target, query, options.limit));
  });

program
  .command('read')
  .description('Execute a DKB Read API request JSON file against a compiled DKB registry')
  .argument('<registry-path>', 'Directory containing DKB packages and .dkb/artifacts/kr.index')
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
  .description('Sync compiled KR index documents into the configured search backend')
  .argument('<registry-path>', 'Directory containing DKB packages and .dkb/artifacts/kr.index')
  .action(async (target: string) => {
    const { loadCompose } = await import('../protocol/manifest.js');
    const { readKrIndex, writeVectorArtifacts } = await import('../indexes/knowledgeIndex.js');
    const registry = await loadCompose(target);
    const records = await readKrIndex(target);

    printJson(await writeVectorArtifacts(target, registry.manifest.id, records));
  });

program
  .command('search-query')
  .description('Query the configured DKB search backend directly')
  .argument('<registry-path>', 'Directory containing DKB packages and .dkb/artifacts/kr.index')
  .argument('<query>', 'Search query')
  .option('-l, --limit <number>', 'Maximum result count', parseLimit, 10)
  .action(async (target: string, query: string, options: { limit: number }) => {
    const { loadCompose } = await import('../protocol/manifest.js');
    const { readKrIndex } = await import('../indexes/knowledgeIndex.js');
    const { searchBackendQuery } = await import('../indexes/vectorStore.js');
    const registry = await loadCompose(target);

    printJson(await searchBackendQuery({
      registryId: registry.manifest.id,
      artifactRoot: path.resolve(target, DKB_ARTIFACTS_DIR),
      records: await readKrIndex(target),
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
  .description('Audit whether DKB package or registry region descriptors are protocol aligned')
  .argument('<path>', 'Directory containing dkb.json or nested DKB packages')
  .option('--strict', 'Exit with code 1 when any region descriptor is ignored')
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

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
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

function titleFromId(value: string): string {
  return value
    .split(/[-_.\s]+/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ') || value;
}
