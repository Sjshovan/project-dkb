import fs from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { loadCollection, loadDkb } from '@sjshovan/dkb-protocol/manifest.js';
import type { DkbRuntimeContext } from '@sjshovan/dkb-runtime/runtime/context.js';
import type { CliPresenter } from './presentation.js';
import {
  summarizeArtifactTransport,
  summarizeInstallResult,
  summarizeRemoveResult,
} from './summaries.js';

export interface ArtifactCommandContext {
  presenter(): CliPresenter;
  printJson(value: unknown): void;
  currentLibraryRoot(explicit?: string, cwd?: string): Promise<string>;
  defaultRuntimeContext(): Promise<DkbRuntimeContext>;
}

export function registerArtifactCommands(program: Command, context: ArtifactCommandContext): void {
  const { presenter, printJson, currentLibraryRoot, defaultRuntimeContext } = context;
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
          runtime: await defaultRuntimeContext(),
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

        await presenter().run(`Uninstalling ${id}`, async (progress) => removeDkbFromRuntime(id, libraryRoot, { runtime: await defaultRuntimeContext(), progress }), summarizeRemoveResult);
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
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
