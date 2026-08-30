import path from 'node:path';
import { Command } from 'commander';
import { stableHash } from '@sjshovan/dkb-protocol/contracts/hash.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { loadManifest } from '@sjshovan/dkb-protocol/manifest.js';
import type { DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import type { DkbRuntimeClient } from '@sjshovan/dkb-runtime/runtime/client.js';
import type { CliPresenter } from './presentation.js';
import {
  summarizeBuildInspect,
  summarizeBuildList,
  summarizeBuildPrune,
  summarizeCompileResult,
  summarizeCompilerStatus,
  summarizePipeline,
  summarizePipelineList,
  summarizePipelineSwitch,
  summarizePipelineVerification,
  summarizePluginList,
  summarizePluginMutation,
} from './summaries.js';

export interface PipelineCommandContext {
  presenter(): CliPresenter;
  currentRuntimeAdminClient(explicit?: string, timeoutMs?: number): Promise<DkbRuntimeClient>;
  defaultDistribution(): Promise<DkbDistribution>;
}

export function registerPipelineCommands(program: Command, context: PipelineCommandContext): void {
  const { presenter, currentRuntimeAdminClient, defaultDistribution } = context;
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
        distribution: await defaultDistribution(),
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
      presenter().print(await listPlugins({ distribution: await defaultDistribution(), root: path.resolve(target) }), summarizePluginList);
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
      presenter().print(await listPipelineTargets({ distribution: await defaultDistribution(), root: path.resolve(target) }), summarizePipelineList);
    });

  pipeline
    .command('show')
    .description('Show the resolved target, providers, precedence, and build digest')
    .argument('[path]', 'Library or Runtime root', '.')
    .option('--target <name>', 'Show a configured target other than the active target')
    .action(async (target: string, options: { target?: string }) => {
      const { DkbProviderHost } = await import('@sjshovan/dkb-pipeline/host.js');
      const host = await DkbProviderHost.create({
        root: path.resolve(target),
        target: options.target,
        distribution: await defaultDistribution(),
      });

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
    .action(async (name: string, target: string, options: { runtimeUrl?: string; registryUrl?: string }) => {
      const root = path.resolve(target);
      const manifest = await loadManifest(root);

      await presenter().run(`Activating pipeline ${name}`, async () => {
        if (manifest.type === 'dkb') {
          const [{ DkbProviderHost }, { resolveProviderRetrievalProfile }, { activateStoredPackageBuild }] = await Promise.all([
            import('@sjshovan/dkb-pipeline/host.js'),
            import('@sjshovan/dkb-pipeline/profile.js'),
            import('@sjshovan/dkb-library/builds.js'),
          ]);
          const host = await DkbProviderHost.create({ root, target: name, distribution: await defaultDistribution() });
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
          return activatePipelineTarget({ distribution: await defaultDistribution(), root, name });
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
        const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
        const registryClient = new DkbRegistryClient({ baseUrl: registry.url });
        const grants: Record<string, { plan: import('@sjshovan/dkb-protocol/builds.js').DkbInstallPlan; installGrant: string }> = {};
        for (const entry of Object.values(state.entries)
          .filter((item) => item.kind === 'dkb' && item.source === 'registry' && item.status === 'installed')
          .sort((left, right) => left.identity.localeCompare(right.identity))) {
          if (!entry.version) throw new DkbError(`Installed Registry DKB ${entry.identity} has no resolved version.`);
          const request = await registryClient.requestBuild(entry.identity, entry.version, name);
          if (request.status === 'queued') {
            if (!request.jobId) throw new DkbError(`Registry queued ${entry.identity}@${entry.version} without a build job id.`);
            await waitForRegistryBuild(registryClient, entry.identity, entry.version, request.jobId);
          }
          const grant = await registryClient.createInstallGrant(entry.identity, entry.version, name);
          grants[entry.identity] = { plan: grant.plan, installGrant: grant.installGrant };
        }
        const runtime = await currentRuntimeAdminClient(options.runtimeUrl, 40 * 60_000);
        const switched = await runtime.switchPipeline({
          target: name,
          registryUrl: registry.url,
          grants,
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
        distribution: await defaultDistribution(),
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
        distribution: await defaultDistribution(),
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
        presenter().print(await runEvidenceLifecycle(await defaultDistribution(), options.root, options.target, 'inspect'), summarizeCompilerStatus);
      }))
    .addCommand(new Command('start')
      .description('Start or reuse the selected Evidence provider service')
      .option('--root <path>', 'Library or Runtime root', '.')
      .option('--target <name>', 'Configured pipeline target')
      .option('--restart', 'Replace any existing provider service')
      .action(async (options: { root: string; target?: string; restart?: boolean }) => {
        await presenter().run('Starting Evidence service', async () => runEvidenceLifecycle(await defaultDistribution(), options.root, options.target, 'start', { restart: Boolean(options.restart) }), summarizeCompilerStatus);
      }))
    .addCommand(new Command('status')
      .description('Show selected Evidence provider service status')
      .option('--root <path>', 'Library or Runtime root', '.')
      .option('--target <name>', 'Configured pipeline target')
      .action(async (options: { root: string; target?: string }) => {
        presenter().print(await runEvidenceLifecycle(await defaultDistribution(), options.root, options.target, 'status'), summarizeCompilerStatus);
      }))
    .addCommand(new Command('stop')
      .description('Stop the selected Evidence provider service')
      .option('--root <path>', 'Library or Runtime root', '.')
      .option('--target <name>', 'Configured pipeline target')
      .action(async (options: { root: string; target?: string }) => {
        await presenter().run('Stopping Evidence service', async () => runEvidenceLifecycle(await defaultDistribution(), options.root, options.target, 'stop'), summarizeCompilerStatus);
      }))
    .addCommand(new Command('doctor')
      .description('Diagnose selected Evidence provider readiness')
      .option('--root <path>', 'Library or Runtime root', '.')
      .option('--target <name>', 'Configured pipeline target')
      .action(async (options: { root: string; target?: string }) => {
        const result = await runEvidenceLifecycle(await defaultDistribution(), options.root, options.target, 'doctor') as { ok?: unknown };
        presenter().print(result, summarizeCompilerStatus);

        if (!result.ok) {
          process.exitCode = 1;
        }
      }));
}

async function waitForRegistryBuild(
  client: import('@sjshovan/dkb-registry-client/client.js').DkbRegistryClient,
  packageId: string,
  version: string,
  jobId: number,
  timeoutMs = 30 * 60_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = await client.buildJob(packageId, version, jobId);
    if (job.status === 'published') return;
    if (job.status === 'failed' || job.status === 'revoked') {
      throw new DkbError(`Registry build failed for ${packageId}@${version} (${job.target}): ${job.error ?? job.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new DkbError(`Timed out waiting for Registry build ${jobId} for ${packageId}@${version}.`);
}

async function runEvidenceLifecycle(
  distribution: DkbDistribution,
  root: string,
  target: string | undefined,
  operation: 'inspect' | 'start' | 'status' | 'stop' | 'doctor',
  options?: { restart?: boolean },
): Promise<unknown> {
  const { DkbProviderHost } = await import('@sjshovan/dkb-pipeline/host.js');
  const host = await DkbProviderHost.create({ root: path.resolve(root), ...(target ? { target } : {}), distribution });

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
