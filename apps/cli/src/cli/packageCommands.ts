import type { Command } from 'commander';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { parseDkbIdentity } from '@sjshovan/dkb-protocol/identity.js';
import type { CliPresenter } from './presentation.js';
import { humanSummary } from './presentation.js';
import { summarizePackageListing } from './packagePresentation.js';
import { configuredRegistry } from './registryConfig.js';

interface RuntimeInstaller {
  installRegistryDkb(input: {
    registryUrl: string;
    registryToken?: string;
    packageId: string;
    version?: string;
    target?: string;
    force?: boolean;
  }): Promise<unknown>;
}

export interface PackageCommandDependencies {
  presenter(): CliPresenter;
  resolveLibraryRoot(explicit?: string): Promise<string>;
  runtimeAdminClient(explicit?: string): Promise<RuntimeInstaller>;
}

export function registerPackageLifecycleCommands(
  program: Command,
  dependencies: PackageCommandDependencies,
): void {
  program
    .command('search')
    .description('Search the configured Registry for DKBs and Collections')
    .argument('[query]', 'Package name, namespace, or description')
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .option('--url <url>', 'Registry API URL')
    .option('--token <token>', 'Registry API bearer token', process.env.DKB_REGISTRY_TOKEN)
    .action(async (query: string | undefined, options: RegistryOptions) => {
      const libraryRoot = await dependencies.resolveLibraryRoot(options.library);
      const registry = await configuredRegistry({ url: options.url, root: libraryRoot });
      const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
      const result = await new DkbRegistryClient({ baseUrl: registry.url, token: options.token }).searchPackages(query);

      dependencies.presenter().print({ registryUrl: registry.url, ...asRecord(result) }, summarizePackageListing);
    });

  program
    .command('show')
    .description('Show one installed DKB or Collection and its active build')
    .argument('<identity>', 'Scoped @namespace/name identity')
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .action(async (identity: string, options: { library?: string }) => {
      const libraryRoot = await dependencies.resolveLibraryRoot(options.library);
      const { inspectInstalledPackage } = await import('@sjshovan/dkb-library/packageInfo.js');

      dependencies.presenter().print(await inspectInstalledPackage(libraryRoot, identity), summarizeInstalledPackage);
    });

  program
    .command('outdated')
    .description('Check installed Registry DKBs for newer published versions')
    .argument('[identity]', 'Check one installed DKB instead of the entire Library')
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .option('--url <url>', 'Registry API URL override')
    .option('--token <token>', 'Registry API bearer token', process.env.DKB_REGISTRY_TOKEN)
    .action(async (identity: string | undefined, options: RegistryOptions) => {
      const result = await inspectOutdatedPackages(identity, options, dependencies);
      dependencies.presenter().print(result, summarizeOutdatedPackages);
    });

  program
    .command('upgrade')
    .description('Upgrade one installed Registry DKB to its latest published version')
    .argument('<identity>', 'Scoped @namespace/name identity')
    .option('--dry-run', 'Show the planned version change without modifying the Library')
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .option('--url <url>', 'Registry API URL override')
    .option('--runtime-url <url>', 'Owning Runtime URL; closes live retrieval handles during upgrade')
    .option('--token <token>', 'Registry API bearer token', process.env.DKB_REGISTRY_TOKEN)
    .action(async (identity: string, options: RegistryOptions & { dryRun?: boolean; runtimeUrl?: string }) => {
      const normalizedIdentity = parseDkbIdentity(identity, 'Installed package identity').identity;
      const libraryRoot = await dependencies.resolveLibraryRoot(options.library);
      const [{ readLibraryState }, { maybeReadRuntimeLock }, { DkbRegistryClient }] = await Promise.all([
        import('@sjshovan/dkb-library/state.js'),
        import('@sjshovan/dkb-library/builds.js'),
        import('@sjshovan/dkb-registry-client/client.js'),
      ]);
      const entry = (await readLibraryState(libraryRoot)).entries[normalizedIdentity];

      if (!entry) {
        throw new DkbError(`${normalizedIdentity} is not installed. Run dkb list or dkb install ${normalizedIdentity}.`);
      }
      if (entry.kind !== 'dkb' || !entry.version) {
        throw new DkbError('dkb upgrade updates DKB packages. Update a Collection with dkb install <collection> --revision <revision>.');
      }
      if (entry.source !== 'registry') {
        throw new DkbError(`${normalizedIdentity} is editable local knowledge and has no Registry version to upgrade.`);
      }

      const configured = await configuredRegistry({ url: options.url, root: libraryRoot });
      const registryUrl = options.url ?? entry.registryUrl ?? configured.url;
      const client = new DkbRegistryClient({ baseUrl: registryUrl, token: options.token });
      const latestVersion = await client.latestPackageVersion(normalizedIdentity);
      const plan = {
        status: latestVersion === entry.version ? 'up_to_date' : 'update_available',
        packageId: normalizedIdentity,
        currentVersion: entry.version,
        latestVersion,
        registryUrl,
        libraryRoot,
      };

      if (options.dryRun || latestVersion === entry.version) {
        dependencies.presenter().print({ ...plan, dryRun: Boolean(options.dryRun) }, summarizeUpgrade);
        return;
      }

      const target = (await maybeReadRuntimeLock(libraryRoot))?.target;
      await dependencies.presenter().run(`Upgrading ${normalizedIdentity}`, async (progress) => {
        if (options.runtimeUrl) {
          return dependencies.runtimeAdminClient(options.runtimeUrl).then((runtime) => runtime.installRegistryDkb({
            registryUrl,
            registryToken: options.token,
            packageId: normalizedIdentity,
            version: latestVersion,
            ...(target ? { target } : {}),
            force: true,
          }));
        }

        const { installDkbFromRegistry } = await import('@sjshovan/dkb-runtime/runtime/registryInstall.js');
        return installDkbFromRegistry({
          registryUrl,
          registryToken: options.token,
          packageId: normalizedIdentity,
          version: latestVersion,
          ...(target ? { target } : {}),
          runtimeRoot: libraryRoot,
          force: true,
          progress,
        });
      }, summarizeUpgradeResult);
    });
}

interface RegistryOptions {
  library?: string;
  url?: string;
  token?: string;
}

async function inspectOutdatedPackages(
  identity: string | undefined,
  options: RegistryOptions,
  dependencies: PackageCommandDependencies,
): Promise<{
  libraryRoot: string;
  packages: Array<{
    id: string;
    current: string;
    latest: string;
    status: 'UPDATE AVAILABLE' | 'UP TO DATE';
    registry: string;
  }>;
  updates: number;
}> {
  const libraryRoot = await dependencies.resolveLibraryRoot(options.library);
  const { readLibraryState } = await import('@sjshovan/dkb-library/state.js');
  const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
  const state = await readLibraryState(libraryRoot);
  const normalizedIdentity = identity
    ? parseDkbIdentity(identity, 'Installed package identity').identity
    : undefined;
  const selected = normalizedIdentity ? state.entries[normalizedIdentity] : undefined;

  if (normalizedIdentity && !selected) {
    throw new DkbError(`${normalizedIdentity} is not installed. Run dkb list to see installed knowledge.`);
  }
  if (selected && (selected.kind !== 'dkb' || selected.source !== 'registry' || !selected.version)) {
    throw new DkbError(`${normalizedIdentity} is not a Registry-installed DKB package.`);
  }

  const configured = await configuredRegistry({ url: options.url, root: libraryRoot });
  const entries = Object.values(state.entries)
    .filter((entry) => entry.kind === 'dkb' && entry.source === 'registry' && entry.version)
    .filter((entry) => !normalizedIdentity || entry.identity === normalizedIdentity)
    .sort((left, right) => left.identity.localeCompare(right.identity));
  const packages = await Promise.all(entries.map(async (entry) => {
    const registryUrl = options.url ?? entry.registryUrl ?? configured.url;
    const latest = await new DkbRegistryClient({ baseUrl: registryUrl, token: options.token })
      .latestPackageVersion(entry.identity);
    const available = latest !== entry.version;

    return {
      id: entry.identity,
      current: entry.version!,
      latest,
      status: available ? 'UPDATE AVAILABLE' as const : 'UP TO DATE' as const,
      registry: registryUrl,
    };
  }));

  return {
    libraryRoot,
    packages,
    updates: packages.filter((entry) => entry.status === 'UPDATE AVAILABLE').length,
  };
}

function summarizeInstalledPackage(value: unknown): string[] {
  const result = asRecord(value);
  const build = isRecord(result.activeBuild) ? result.activeBuild : {};

  return [
    `package: ${String(result.identity ?? '-')}`,
    result.displayName ? `name: ${String(result.displayName)}` : '',
    result.description ? `description: ${String(result.description)}` : '',
    `kind: ${String(result.kind ?? '-')}`,
    `source: ${String(result.source ?? '-')}`,
    `status: ${String(result.status ?? '-')}`,
    result.version ? `version: ${String(result.version)}` : '',
    result.revision ? `revision: r${String(result.revision)}` : '',
    `artifact: ${String(result.artifactStatus ?? '-')}`,
    `receipt: ${String(result.receiptStatus ?? '-')}`,
    typeof result.records === 'number' ? `records: ${result.records}` : '',
    typeof result.sources === 'number' ? `sources: ${result.sources}` : '',
    build.target ? `active pipeline: ${String(build.target)}` : 'active pipeline: none',
    build.evidenceDigest ? `evidence build: ${shortDigest(build.evidenceDigest)}` : '',
    build.retrievalBuildDigest ? `retrieval build: ${shortDigest(build.retrievalBuildDigest)}` : '',
    result.registryUrl ? `registry: ${String(result.registryUrl)}` : '',
    `installed: ${String(result.installedAt ?? '-')}`,
    `path: ${String(result.path ?? '-')}`,
  ];
}

function summarizeOutdatedPackages(value: unknown): string[] {
  const result = asRecord(value);

  return [
    typeof result.libraryRoot === 'string' ? `library: ${result.libraryRoot}` : '',
    `updates: ${String(result.updates ?? 0)}`,
    ...humanSummary({ packages: Array.isArray(result.packages) ? result.packages : [] }),
  ];
}

function summarizeUpgrade(value: unknown): string[] {
  const result = asRecord(value);

  return [
    `status: ${String(result.status ?? '-')}`,
    `package: ${String(result.packageId ?? '-')}`,
    `current: ${String(result.currentVersion ?? '-')}`,
    `latest: ${String(result.latestVersion ?? '-')}`,
    result.dryRun ? 'mode: dry run; no changes made' : '',
    `registry: ${String(result.registryUrl ?? '-')}`,
    `library: ${String(result.libraryRoot ?? '-')}`,
  ];
}

function summarizeUpgradeResult(value: unknown): string[] {
  const result = asRecord(value);

  return [
    `status: ${String(result.status ?? 'installed')}`,
    `package: ${String(result.packageId ?? result.id ?? '-')}${result.version ? `@${String(result.version)}` : ''}`,
    typeof result.packagePath === 'string' ? `path: ${result.packagePath}` : '',
    typeof result.warning === 'string' ? `warning: ${result.warning}` : '',
  ];
}

function shortDigest(value: unknown): string {
  const digest = String(value ?? '');
  return digest.length > 20 ? `${digest.slice(0, 18)}…` : digest;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
