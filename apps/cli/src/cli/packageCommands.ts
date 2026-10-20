import type { Command } from 'commander';
import type { DkbRuntimeClient } from '@sjshovan/dkb-runtime/runtime/client.js';
import { DkbError } from '@sjshovan/dkb-protocol/errors.js';
import { parseDkbIdentity } from '@sjshovan/dkb-protocol/identity.js';
import type { CliPresenter } from './presentation.js';
import { formatBytes, humanSummary } from './presentation.js';
import { summarizeRegistryCatalog } from './packagePresentation.js';
import { configuredRegistry } from './registryConfig.js';
import { resolveCliLibraryReference, type CliLibraryReference } from './context.js';
import { executeCliLibraryOperation, refreshCliLibraryMutation } from './libraryOperation.js';
import type { DkbRuntimePackageListing } from '@sjshovan/dkb-runtime/runtime/state.js';

export interface PackageCommandDependencies {
  presenter(): CliPresenter;
  resolveLibraryRoot(explicit?: string): Promise<string>;
  runtimeAdminClient(explicit?: string): Promise<Pick<DkbRuntimeClient, 'reload'>>;
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
        : await configuredRegistry({ library: await resolveCliLibraryReference({ explicit: options.library }) });
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
    .option('--evidence <id>', 'Inspect one inert Evidence record from an exact retained build')
    .option('--evidence-build <digest>', 'Exact Evidence Build digest for --evidence')
    .option('--version <version>', 'Exact installed package version for --evidence')
    .option('--verify', 'Recheck portable-tree, build, receipt-chain, and Registry signatures')
    .option('--verify-build <digest>', 'Verify one exact stored build against its installed origin and pinned receipt chain')
    .option('--cursor <path>', 'Continue a directory listing after this relative path')
    .option('--limit <number>', 'Maximum directory entries, from 1 to 100', parseContentsLimit, 100)
    .action(async (identity: string, options: { library?: string; contents?: string; preview?: string; evidence?: string; evidenceBuild?: string; version?: string; verify?: boolean; verifyBuild?: string; cursor?: string; limit: number }) => {
      const selected = [options.contents !== undefined, options.preview !== undefined, options.evidence !== undefined, Boolean(options.verify), options.verifyBuild !== undefined].filter(Boolean).length;
      if (selected > 1) throw new DkbError('--contents, --preview, --evidence, --verify, and --verify-build cannot be combined.');
      if (options.evidence ? !options.evidenceBuild || !options.version : options.evidenceBuild || options.version) throw new DkbError('--evidence requires --evidence-build and --version; these options must be used together.');
      if ((options.cursor || options.limit !== 100) && options.contents === undefined) {
        throw new DkbError('--cursor and --limit require --contents.');
      }
      const inspection = await import('@sjshovan/dkb-library/packageInfo.js');
      const input: Record<string, unknown> = { identity };
      for (const key of ['contents', 'preview', 'evidence', 'evidenceBuild', 'version', 'cursor'] as const) {
        if (options[key] !== undefined) input[key] = options[key];
      }
      if (options.contents !== undefined) input.limit = options.limit;
      const inspect = <T extends object>(operation: (root: string) => Promise<T>) =>
        executeCliLibraryOperation({ library: options.library, command: 'package.show', input }, operation);

      if (options.evidence) {
        const result = await inspect(libraryRoot => inspection.inspectInstalledEvidence({ libraryRoot, identity, version: options.version!, evidenceDigest: options.evidenceBuild!, evidenceId: options.evidence! }));
        dependencies.presenter().print(result, () => [
          `${result.identity}@${result.version} · ${result.evidenceId}`,
          `Evidence Build: ${result.evidenceDigest}`,
          'Inert source data; inspection does not certify Registry signatures or activate a Runtime.',
          result.title.value, result.text.value,
          ...(result.text.truncated ? [`Text truncated from ${result.text.bytes} bytes.`] : []),
          `Source locator: ${result.locator.value}`,
        ]);
        return;
      }

      if (options.verifyBuild) {
        const libraryRoot = await dependencies.resolveLibraryRoot(options.library);
        const { verifyInstalledBuildTrust } = await import('@sjshovan/dkb-runtime/runtime/buildTrust.js');
        const result = await dependencies.presenter().check(`Verifying build for ${identity}`,
          () => verifyInstalledBuildTrust({ libraryRoot, identity, buildDigest: options.verifyBuild! }),
          (value) => value.status.endsWith('-verified'),
          (value) => humanSummary({ status: value.status, message: value.message, buildDigest: value.buildDigest }));
        if (result.status === 'failed' || result.status === 'unverified') process.exitCode = 1;
        return;
      }

      if (options.contents !== undefined) {
        dependencies.presenter().print(await inspect(libraryRoot => inspection.listInstalledPackageContents({
          libraryRoot, identity, directory: options.contents, cursor: options.cursor, limit: options.limit,
        })), summarizePackageContents);
        return;
      }
      if (options.preview !== undefined) {
        dependencies.presenter().print(await inspect(libraryRoot => inspection.previewInstalledPackageFile({ libraryRoot, identity, file: options.preview! })), summarizePackagePreview);
        return;
      }
      if (options.verify) {
        const libraryRoot = await dependencies.resolveLibraryRoot(options.library);
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

      dependencies.presenter().print(await inspect(libraryRoot => inspection.inspectInstalledPackage(libraryRoot, identity)), summarizeInstalledPackage);
    });

  program
    .command('outdated')
    .description('Check installed Registry DKBs for newer published versions')
    .argument('[identity]', 'Check one installed DKB instead of the entire Library')
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .option('--url <url>', 'Registry API URL override')
    .action(async (identity: string | undefined, options: RegistryOptions) => {
      const result = await inspectOutdatedPackages(identity, options);
      dependencies.presenter().print(result, summarizeOutdatedPackages);
    });

  program
    .command('upgrade')
    .description('Upgrade one installed Registry DKB to its latest published version')
    .argument('<identity>', 'Scoped @namespace/name identity')
    .option('--dry-run', 'Show the planned version change without modifying the Library')
    .option('--library <library>', 'Library name or path; defaults to the nearest or selected Library')
    .option('--url <url>', 'Registry API URL override')
    .option('--runtime-url <url>', 'Refresh this Runtime after upgrade; never changes the destination Library')
    .action(async (identity: string, options: RegistryOptions & { dryRun?: boolean; runtimeUrl?: string }) => {
      const normalizedIdentity = parseDkbIdentity(identity, 'Installed package identity').identity;
      const reference = await resolveCliLibraryReference({ explicit: options.library });
      const listing = await installedPackages(reference);
      const libraryRoot = reference.kind === 'local' ? reference.path : reference.name;
      const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
      const entry = listing.packages.find(item => item.id === normalizedIdentity && item.status !== 'untracked');

      if (!entry) {
        throw new DkbError(`${normalizedIdentity} is not installed. Run dkb list or dkb install ${normalizedIdentity}.`);
      }
      if (entry.kind !== 'dkb' || !entry.version) {
        throw new DkbError('dkb upgrade updates DKB packages. Update a Collection with dkb collection update <collection> --revision <revision>.');
      }
      if (entry.source !== 'registry') {
        throw new DkbError(`${normalizedIdentity} is editable local knowledge and has no Registry version to upgrade.`);
      }

      const registryUrl = options.url ?? entry.registryUrl ?? (await configuredRegistry({ library: reference })).url;
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
        if (reference.kind === 'docker') {
          const { installCliDockerPackage } = await import('./packageInstallation.js');
          return installCliDockerPackage(reference, { identity: normalizedIdentity, version: latestVersion, url: registryUrl,
            force: true, expectedLibraryGeneration: listing.generation, progress, runtimeUrl: options.runtimeUrl,
            runtimeClient: dependencies.runtimeAdminClient });
        }
        const { installDkbFromRegistry } = await import('@sjshovan/dkb-runtime/runtime/registryInstall.js');
        const result = await installDkbFromRegistry({
          registryUrl,
          packageId: normalizedIdentity,
          version: latestVersion,
          libraryRoot,
          force: true,
          progress,
          expectedLibraryGeneration: listing.generation,
        });
        return refreshCliLibraryMutation(result, reference, dependencies.runtimeAdminClient, options.runtimeUrl);
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
  const reference = await resolveCliLibraryReference({ explicit: options.library });
  const libraryRoot = reference.kind === 'local' ? reference.path : reference.name;
  const { DkbRegistryClient } = await import('@sjshovan/dkb-registry-client/client.js');
  const listing = await installedPackages(reference);
  const normalizedIdentity = identity
    ? parseDkbIdentity(identity, 'Installed package identity').identity
    : undefined;
  const selected = listing.packages.find(entry => entry.id === normalizedIdentity && entry.status !== 'untracked');

  if (normalizedIdentity && !selected) {
    throw new DkbError(`${normalizedIdentity} is not installed. Run dkb list to see installed knowledge.`);
  }
  if (selected && (selected.kind !== 'dkb' || selected.source !== 'registry' || !selected.version)) {
    throw new DkbError(`${normalizedIdentity} is not a Registry-installed DKB package.`);
  }

  const entries = listing.packages
    .filter((entry) => entry.kind === 'dkb' && entry.source === 'registry' && entry.status !== 'untracked' && entry.version)
    .filter((entry) => !normalizedIdentity || entry.id === normalizedIdentity)
    .sort((left, right) => left.id.localeCompare(right.id));
  const fallback = !options.url && entries.some(entry => !entry.registryUrl)
    ? (await configuredRegistry({ library: reference })).url : undefined;
  const packages = await Promise.all(entries.map(async (entry) => {
    const registryUrl = options.url ?? entry.registryUrl ?? fallback!;
    const latest = await new DkbRegistryClient({ baseUrl: registryUrl })
      .latestPackageVersion(entry.id);
    const available = latest !== entry.version;

    return {
      id: entry.id,
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

async function installedPackages(reference: CliLibraryReference): Promise<DkbRuntimePackageListing> {
  const result = await executeCliLibraryOperation({ reference, command: 'library.packages' }, async root => {
    const { listLibraryPackages } = await import('@sjshovan/dkb-runtime/runtime/state.js');
    return listLibraryPackages(root);
  });
  if (!Number.isSafeInteger(result.generation) || result.generation < 0) {
    throw new DkbError('Library owner CLI does not report an applied-state generation. Select a matching rebuilt CLI image before checking or upgrading packages.', 'library_owner_protocol_mismatch');
  }
  return result;
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
