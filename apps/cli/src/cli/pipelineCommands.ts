import path from 'node:path';
import { Command } from 'commander';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import type { DkbDistribution } from '@sjshovan/dkb-pipeline/host.js';
import type { DkbRuntimeClient } from '@sjshovan/dkb-runtime/runtime/client.js';
import type { CliPresenter } from './presentation.js';
import { nativeRuntimeStateRoot } from '../host/runtimeLocation.js';
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
  summarizePluginConformance,
  summarizePluginList,
  summarizePluginMutation,
  summarizePluginScaffold,
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
    .command('init')
    .description('Create a DKB plugin API v3 project')
    .argument('<id>', 'Namespaced plugin id, such as @team/provider')
    .requiredOption('--kind <kind>', 'Provider kind')
    .argument('[directory]', 'Destination directory')
    .action(async (id: string, directory: string | undefined, options: { kind: string }) => {
      const { scaffoldPlugin } = await import('../providers/scaffolding.js');
      await presenter().run('Creating plugin', () => scaffoldPlugin({ id, kind: options.kind, ...(directory ? { directory } : {}) }), summarizePluginScaffold);
    });

  plugin
    .command('verify')
    .description('Validate plugin definition and options without running setup; use plugin test for contracts')
    .argument('<path>', 'Plugin directory, or its plugin.mjs entrypoint')
    .action(async (target: string) => {
      const { verifyPluginPath } = await import('../providers/verification.js');
      await presenter().check('Verifying plugin', () => verifyPluginPath(target), (result) => result.ok, summarizePluginConformance);
    });

  plugin
    .command('test')
    .description('Run the public DKB conformance suite against a plugin')
    .argument('<path>', 'Plugin directory, or its plugin.mjs entrypoint')
    .option('--fixture <dkb>', 'Editable DKB used for Evidence and index checks')
    .action(async (target: string, options: { fixture?: string }) => {
      const { testPluginPath } = await import('../providers/verification.js');
      await presenter().check('Testing plugin', () => testPluginPath(target, options.fixture), (result) => result.ok, summarizePluginConformance);
    });

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
    .description('List Pipelines available to one Runtime')
    .option('--runtime <runtime>', 'Registered Runtime name')
    .action(async (options: { runtime?: string }) => {
      const selected = await runtimeSelection(options.runtime);
      if (!nativeRuntimeStateRoot(selected.runtime)) {
        presenter().print(await (await currentRuntimeAdminClient(selected.runtime.url)).pipelines(), summarizePipelineList);
        return;
      }
      // A running Runtime is authoritative for provider health because its
      // container/process environment owns sidecar endpoints and credentials.
      // Keep the local catalog as an offline inspection fallback.
      try {
        presenter().print(await (await currentRuntimeAdminClient(selected.runtime.url)).pipelines(), summarizePipelineList);
        return;
      } catch {
        // The registered local Runtime may be stopped. Its resolved recipes and
        // immutable build coverage remain useful without a network dependency.
      }
      const local = await localRuntimeSelection(options.runtime);
      const { runtimePipelineCatalog } = await import('@sjshovan/dkb-runtime/runtime/pipelineCatalog.js');
      presenter().print(await runtimePipelineCatalog({
        distribution: await defaultDistribution(),
        root: local.instance.stateRoot,
        libraryRoot: local.instance.libraryRoot,
        activeTarget: local.instance.target,
      }), summarizePipelineList);
    });

  pipeline
    .command('show')
    .description('Show the resolved target, providers, precedence, and build digest')
    .argument('<pipeline>', 'Configured Pipeline name')
    .option('--runtime <runtime>', 'Registered Runtime name')
    .action(async (pipelineName: string, options: { runtime?: string }) => {
      const selection = await runtimeSelection(options.runtime);
      if (!nativeRuntimeStateRoot(selection.runtime)) {
        const catalog = await (await currentRuntimeAdminClient(selection.runtime.url)).pipelines() as { targets?: Array<Record<string, unknown>> };
        const target = catalog.targets?.find((entry) => entry.name === pipelineName);
        if (!target) throw new DkbError(`Pipeline ${pipelineName} is not available on Runtime ${selection.name}.`);
        presenter().print(target, summarizePipeline);
        return;
      }
      const selected = await localRuntimeSelection(options.runtime);
      const distribution = await defaultDistribution();
      const [{ DkbProviderHost }, { resolveHostProviderIdentityOptions }] = await Promise.all([
        import('@sjshovan/dkb-pipeline/host.js'),
        import('../providers/externalIdentities.js'),
      ]);
      const { targetOptions } = await resolveHostProviderIdentityOptions({
        distribution,
        root: selected.instance.stateRoot,
        libraryRoot: selected.instance.libraryRoot,
        target: pipelineName,
      });
      const host = await DkbProviderHost.create({
        root: selected.instance.stateRoot,
        libraryRoot: selected.instance.libraryRoot,
        target: pipelineName,
        targetOptions,
        distribution,
      });

      try {
        presenter().print(host.describe(), summarizePipeline);
      } finally {
        await host.dispose();
      }
    });

  pipeline
    .command('use')
    .description('Prepare and atomically activate a Pipeline for one Runtime')
    .argument('<name>', 'Configured Pipeline name')
    .option('--runtime <runtime>', 'Registered Runtime name')
    .option('--runtime-url <url>', 'Owning Runtime URL')
    .option('--registry-url <url>', 'Confirm the installed Registry origin and scope an environment token')
    .action(async (name: string, options: { runtime?: string; runtimeUrl?: string; registryUrl?: string }) => {
      const selected = await runtimeSelection(options.runtime);
      await presenter().run(`Activating pipeline ${name}`, async (progress) => {
        const { prepareLocalRuntimePipeline, useRuntimePipeline } = await import('../providers/runtimePipeline.js');
        let local: Awaited<ReturnType<typeof prepareLocalRuntimePipeline>> | undefined;
        if (nativeRuntimeStateRoot(selected.runtime)) {
          const selection = await localRuntimeSelection(options.runtime);
          local = await prepareLocalRuntimePipeline({ root: selection.instance.libraryRoot,
            stateRoot: selection.instance.stateRoot, target: name, distribution: await defaultDistribution() });
        }
        return useRuntimePipeline({
          client: await currentRuntimeAdminClient(options.runtimeUrl ?? selected.runtime.url, 40 * 60_000),
          name: selected.name, target: name, kind: selected.runtime.kind,
          ...(options.registryUrl ? { registryUrl: options.registryUrl } : {}),
          ...(local ? { local } : {}), progress,
        });
      }, summarizePipelineSwitch);
    });

  pipeline
    .command('set')
    .description('Validate and atomically save a complete pipeline target')
    .argument('<name>', 'Target name')
    .option('--root <path>', 'Library or Runtime root', '.')
    .option('--evidence <id>', 'Fused Evidence provider')
    .option('--parser <id>', 'Parser provider; requires --chunker')
    .option('--chunker <id>', 'Chunker provider; requires --parser')
    .option('--embedding <id>', 'Document and query embedding provider when the target requires vectors')
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
      embedding?: string;
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
          ...(options.embedding ? { embedding: options.embedding } : {}),
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
    .argument('<pipeline>', 'Configured Pipeline name')
    .option('--runtime <runtime>', 'Registered Runtime name')
    .action(async (pipelineName: string, options: { runtime?: string }) => {
      const selection = await runtimeSelection(options.runtime);
      if (!nativeRuntimeStateRoot(selection.runtime)) {
        const catalog = await (await currentRuntimeAdminClient(selection.runtime.url)).pipelines() as { targets?: Array<Record<string, unknown>> };
        const target = catalog.targets?.find((entry) => entry.name === pipelineName);
        if (!target) throw new DkbError(`Pipeline ${pipelineName} is not available on Runtime ${selection.name}.`);
        const result = { ok: target.health === 'ready', pipeline: target, health: target.healthDetails ?? [] };
        presenter().print(result, summarizePipelineVerification);
        if (!result.ok) process.exitCode = 1;
        return;
      }
      const selected = await localRuntimeSelection(options.runtime);
      const distribution = await defaultDistribution();
      const [{ verifyPipeline }, { resolveHostProviderIdentityOptions }] = await Promise.all([
        import('../providers/management.js'),
        import('../providers/externalIdentities.js'),
      ]);
      const { targetOptions } = await resolveHostProviderIdentityOptions({
        distribution,
        root: selected.instance.stateRoot,
        libraryRoot: selected.instance.libraryRoot,
        target: pipelineName,
      });
      const result = await presenter().check('Pipeline verification', async () => verifyPipeline({
        distribution,
        root: selected.instance.stateRoot,
        libraryRoot: selected.instance.libraryRoot,
        target: pipelineName,
        targetOptions,
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
    const { compileLocalKnowledgeTarget } = await import('../providers/localCompilation.js');
    const pipelineTarget = options.pipeline ?? options.target;

    await presenter().run(`${activity} ${root}`, async () => compileLocalKnowledgeTarget(root, {
      force: Boolean(options.force),
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

async function localRuntimeSelection(name?: string) {
  const [selected, { registeredHostLibrary }, { maybeReadRuntimeBindingFromStateRoot }] = await Promise.all([
    runtimeSelection(name),
    import('../host/inventory.js'),
    import('@sjshovan/dkb-runtime/runtime/state.js'),
  ]);
  const nativeRoot = nativeRuntimeStateRoot(selected.runtime);
  if (!nativeRoot) {
    throw new DkbError(`Runtime ${selected.name} does not expose native host Pipeline state. Local compilation cannot use Docker or remote state through a saved host path. `
      + `Inspect its own catalog with: dkb pipeline list --runtime ${selected.name}. Pipeline preparation must run in its owning environment.`, 'unsupported_capability');
  }
  if (!selected.runtime.library) {
    throw new DkbError(`Runtime ${selected.name} has no host Library association. Run: dkb runtime library use <library> --runtime ${selected.name}`);
  }
  const library = await registeredHostLibrary(selected.runtime.library);
  if (!library) {
    throw new DkbError(`Runtime ${selected.name} refers to unknown Library ${selected.runtime.library}. Run: dkb library list`);
  }
  const { localHostLibraryPath } = await import('../host/libraryLocation.js');
  const libraryRoot = localHostLibraryPath(library.library);
  const stateRoot = path.resolve(nativeRoot);
  const binding = await maybeReadRuntimeBindingFromStateRoot(stateRoot);
  return {
    ...selected,
    instance: {
      stateRoot,
      libraryRoot,
      target: binding?.target ?? 'default',
    },
  };
}

async function runtimeSelection(name?: string) {
  const { registeredHostRuntime, selectedHostRuntime } = await import('../host/inventory.js');
  const selected = name ? await registeredHostRuntime(name) : await selectedHostRuntime();
  if (!selected) {
    throw new DkbError(name
      ? `Unknown host Runtime: ${name}. Run: dkb runtime list`
      : 'No default Runtime is selected. Run: dkb runtime use <name>');
  }
  return selected;
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
