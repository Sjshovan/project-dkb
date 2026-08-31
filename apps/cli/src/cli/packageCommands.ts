import type { Command } from 'commander';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { parseDkbIdentity } from '@sjshovan/dkb-protocol/identity.js';
import type { CliPresenter } from './presentation.js';
import { formatBytes, humanSummary } from './presentation.js';
import { summarizeRegistryCatalog } from './packagePresentation.js';
import { configuredRegistry } from './registryConfig.js';

interface RuntimeInstaller {
  installRegistryDkb(input: {
    registryUrl: string;
    installGrant: string;
    plan: import('@sjshovan/dkb-protocol/builds.js').DkbInstallPlan;
    force?: boolean;
  }): Promise<unknown>;
  reload(): Promise<unknown>;
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
    .option('--type <type>', 'Entry type: all, dkb, or collection', parseCatalogType, 'all')
    .option('--page <number>', 'Catalog page', parseCatalogPage, 1)
    .option('--per-page <number>', 'Entries per type, from 1 to 50', parseCatalogPageSize, 20)
    .action(async (query: string | undefined, options: RegistryOptions & { type: 'all' | 'dkb' | 'collection'; page: number; perPage: number }) => {
      const registry = options.url
        ? await configuredRegistry({ url: options.url })
        : await configuredRegistry({ root: await dependencies.resolveLibraryRoot(options.library) });
      const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
      const result = await new DkbRegistryClient({ baseUrl: registry.url }).catalog({
        query,
        type: options.type,
        page: options.page,
        perPage: options.perPage,
      });

      dependencies.presenter().print({ registryUrl: registry.url, ...result }, summarizeRegistryCatalog);
    });

  program
    .command('show')
    .description('Inspect one installed DKB or Collection, its contents, provenance, and builds')
    .argument('<identity>', 'Scoped @namespace/name identity')
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .option('--contents <directory>', 'List one portable package directory; use . for the root')
    .option('--preview <file>', 'Read a bounded inert text preview of one portable package file')
    .option('--verify', 'Recheck portable-tree, build, receipt-chain, and Registry signatures')
    .option('--cursor <path>', 'Continue a directory listing after this relative path')
    .option('--limit <number>', 'Maximum directory entries, from 1 to 100', parseContentsLimit, 100)
    .action(async (identity: string, options: { library?: string; contents?: string; preview?: string; verify?: boolean; cursor?: string; limit: number }) => {
      const libraryRoot = await dependencies.resolveLibraryRoot(options.library);
      const selected = [options.contents !== undefined, options.preview !== undefined, Boolean(options.verify)].filter(Boolean).length;
      if (selected > 1) throw new DkbError('--contents, --preview, and --verify cannot be combined.');
      if ((options.cursor || options.limit !== 100) && options.contents === undefined) {
        throw new DkbError('--cursor and --limit require --contents.');
      }
      const inspection = await import('@sjshovan/dkb-library/packageInfo.js');

      if (options.contents !== undefined) {
        dependencies.presenter().print(await inspection.listInstalledPackageContents({
          libraryRoot, identity, directory: options.contents, cursor: options.cursor, limit: options.limit,
        }), summarizePackageContents);
        return;
      }
      if (options.preview !== undefined) {
        dependencies.presenter().print(await inspection.previewInstalledPackageFile({ libraryRoot, identity, file: options.preview }), summarizePackagePreview);
        return;
      }
      if (options.verify) {
        const detail = await inspection.inspectInstalledPackage(libraryRoot, identity);
        let trustedKeys: import('@sjshovan/dkb-protocol/types.js').DkbSigningKeyRecord[] | undefined;
        let keyWarning: string | undefined;
        if (detail.source === 'registry') {
          try {
            const registry = await configuredRegistry({ url: detail.registryUrl, root: libraryRoot });
            const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
            const response = await new DkbRegistryClient({ baseUrl: registry.url }).publicKeys() as { keys?: unknown };
            if (!Array.isArray(response.keys)) throw new DkbError('Registry returned an invalid signing-key document.');
            trustedKeys = response.keys as import('@sjshovan/dkb-protocol/types.js').DkbSigningKeyRecord[];
          } catch (error) {
            keyWarning = `Registry signing keys could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        const result = await dependencies.presenter().check(
          `Verifying ${detail.identity}`,
          async () => inspection.verifyInstalledPackage({ libraryRoot, identity, trustedKeys, keyWarning }),
          (value) => value.status !== 'failed',
          summarizePackageVerification,
        );
        if (result.status === 'failed') process.exitCode = 1;
        return;
      }

      dependencies.presenter().print(await inspection.inspectInstalledPackage(libraryRoot, identity), summarizeInstalledPackage);
    });

  program
    .command('outdated')
    .description('Check installed Registry DKBs for newer published versions')
    .argument('[identity]', 'Check one installed DKB instead of the entire Library')
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .option('--url <url>', 'Registry API URL override')
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
    .action(async (identity: string, options: RegistryOptions & { dryRun?: boolean; runtimeUrl?: string }) => {
      const normalizedIdentity = parseDkbIdentity(identity, 'Installed package identity').identity;
      const libraryRoot = await dependencies.resolveLibraryRoot(options.library);
      const [{ readLibraryState }, { DkbRegistryClient }] = await Promise.all([
        import('@sjshovan/dkb-library/state.js'),
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

      const registryUrl = options.url ?? entry.registryUrl ?? (await configuredRegistry({ root: libraryRoot })).url;
      const client = new DkbRegistryClient({ baseUrl: registryUrl });
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

      await dependencies.presenter().run(`Upgrading ${normalizedIdentity}`, async (progress) => {
        if (options.runtimeUrl) {
          const grant = await client.createInstallGrant(normalizedIdentity, latestVersion);
          return dependencies.runtimeAdminClient(options.runtimeUrl).then((runtime) => runtime.installRegistryDkb({
            registryUrl,
            installGrant: grant.installGrant,
            plan: grant.plan,
            force: true,
          }));
        }

        const { installDkbFromRegistry } = await import('@sjshovan/dkb-runtime/runtime/registryInstall.js');
        const result = await installDkbFromRegistry({
          registryUrl,
          packageId: normalizedIdentity,
          version: latestVersion,
          libraryRoot,
          force: true,
          progress,
        });
        const { refreshServingLocalRuntimes, withRuntimeRefreshes } = await import('../runtime/refresh.js');
        return withRuntimeRefreshes(result, await refreshServingLocalRuntimes(
          libraryRoot,
          async (url) => dependencies.runtimeAdminClient(url) as Promise<import('@sjshovan/dkb-runtime/runtime/client.js').DkbRuntimeClient>,
        ));
      }, summarizeUpgradeResult);
    });
}

interface RegistryOptions {
  library?: string;
  url?: string;
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
    const latest = await new DkbRegistryClient({ baseUrl: registryUrl })
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
  const builds = Array.isArray(result.builds) ? result.builds : [];
  const source = isRecord(result.sourceSummary) ? result.sourceSummary : {};
  const provenance = isRecord(result.provenance) ? result.provenance : {};
  const integrity = isRecord(result.integrity) ? result.integrity : {};
  const manifest = isRecord(result.manifest) ? result.manifest : {};

  return [
    `package: ${String(result.identity ?? '-')}`,
    manifest.displayName ? `name: ${String(manifest.displayName)}` : '',
    manifest.description ? `description: ${String(manifest.description)}` : '',
    `kind: ${String(result.kind ?? '-')}`,
    `source: ${String(result.source ?? '-')}`,
    `status: ${String(result.status ?? '-')}`,
    result.version ? `version: ${String(result.version)}` : '',
    result.revision ? `revision: r${String(result.revision)}` : '',
    `integrity: ${String(integrity.status ?? '-')}`,
    `receipt: ${String(provenance.receiptStatus ?? '-')}`,
    `install chain: ${String(provenance.installChainStatus ?? '-')}`,
    typeof source.files === 'number' ? `source files: ${source.files}` : '',
    typeof source.bytes === 'number' ? `source size: ${formatBytes(source.bytes)}` : '',
    typeof source.evidenceRecords === 'number' ? `Evidence records: ${source.evidenceRecords}` : '',
    typeof source.searchableSources === 'number' ? `searchable sources: ${source.searchableSources}` : '',
    `stored builds: ${builds.length}`,
    result.registryUrl ? `registry: ${String(result.registryUrl)}` : '',
    `installed: ${String(result.installedAt ?? '-')}`,
    `path: ${String(result.path ?? '-')}`,
  ];
}

function summarizePackageContents(value: unknown): string[] {
  const result = asRecord(value);
  const entries = Array.isArray(result.entries) ? result.entries : [];
  return [
    `package: ${String(result.identity ?? '-')}`,
    `directory: ${String(result.directory ?? '.')}`,
    ...humanSummary(entries),
    result.nextCursor ? `next: dkb show ${String(result.identity)} --contents ${String(result.directory)} --cursor "${String(result.nextCursor)}"` : '',
  ];
}

function summarizePackagePreview(value: unknown): string[] {
  const result = asRecord(value);
  return [
    `package: ${String(result.identity ?? '-')}`,
    `path: ${String(result.path ?? '-')}`,
    typeof result.bytes === 'number' ? `size: ${formatBytes(result.bytes)}` : '',
    `type: ${String(result.mediaType ?? '-')}`,
    `searchable: ${result.sourceId ? 'yes' : 'no'}`,
    typeof result.evidenceRecords === 'number' ? `Evidence records: ${result.evidenceRecords}` : '',
    result.previewable === false ? 'preview: binary or unsupported text encoding' : '',
    result.truncated ? 'warning: preview is truncated to 256 KiB' : '',
    typeof result.content === 'string' ? result.content : '',
  ];
}

function summarizePackageVerification(value: unknown): string[] {
  const result = asRecord(value);
  const checks = Array.isArray(result.checks) ? result.checks : [];
  return [
    `package: ${String(result.identity ?? '-')}`,
    `status: ${String(result.status ?? '-')}`,
    `checked: ${String(result.checkedAt ?? '-')}`,
    ...humanSummary(checks),
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

function parseContentsLimit(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) throw new DkbError('Package contents limit must be between 1 and 100.');
  return parsed;
}

function parseCatalogType(value: string): 'all' | 'dkb' | 'collection' {
  if (value === 'all' || value === 'dkb' || value === 'collection') return value;
  throw new DkbError('Registry search type must be all, dkb, or collection.');
}

function parseCatalogPage(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new DkbError('Registry search page must be a positive integer.');
  return parsed;
}

function parseCatalogPageSize(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) throw new DkbError('Registry search per-page must be between 1 and 50.');
  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
