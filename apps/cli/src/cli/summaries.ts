import { countLabel, formatBytes, humanSummary, milliseconds } from './presentation.js';

export function summarizeCompileResult(value: unknown): string[] {
  const result = value as {
    registryId?: unknown;
    recordCount?: unknown;
    cacheHit?: unknown;
    retrievalManifestPath?: unknown;
    profile?: {
      timingsMs?: Record<string, unknown>;
      aggregateTimingsMs?: Record<string, unknown>;
      statistics?: {
        corpus?: Record<string, unknown>;
        storage?: Record<string, unknown>;
        providerStages?: Array<Record<string, unknown>>;
      };
    };
  };
  const total = milliseconds(result.profile?.timingsMs?.total);
  const aggregate = milliseconds(result.profile?.aggregateTimingsMs?.total);
  const corpus = result.profile?.statistics?.corpus;
  const storage = result.profile?.statistics?.storage;
  const providerStage = result.profile?.statistics?.providerStages?.[0];
  const ingestionTimings = providerStage?.ingestionTimingsMs && typeof providerStage.ingestionTimingsMs === 'object'
    ? providerStage.ingestionTimingsMs as Record<string, unknown>
    : undefined;
  const embeddingTimings = providerStage?.embeddingTimingsMs && typeof providerStage.embeddingTimingsMs === 'object'
    ? providerStage.embeddingTimingsMs as Record<string, unknown>
    : undefined;
  const recordsPerSource = corpus?.recordsPerSource && typeof corpus.recordsPerSource === 'object'
    ? corpus.recordsPerSource as Record<string, unknown>
    : undefined;

  return [
    `registry: ${String(result.registryId ?? 'unknown')}`,
    countLabel(result.recordCount, 'record') ?? '',
    `cache: ${result.cacheHit ? 'hit' : 'updated'}`,
    total ? `total: ${total}` : '',
    aggregate ? `artifact work: ${aggregate}` : '',
    milliseconds(ingestionTimings?.total) ? `ingestion: ${milliseconds(ingestionTimings?.total)}` : '',
    milliseconds(embeddingTimings?.total) ? `embedding: ${milliseconds(embeddingTimings?.total)}` : '',
    finiteBytes(corpus?.sourceBytes) ? `source: ${formatBytes(Number(corpus?.sourceBytes))} across ${String(corpus?.sourceFiles ?? 0)} files` : '',
    finiteBytes(corpus?.evidenceTextBytes) ? `evidence text: ${formatBytes(Number(corpus?.evidenceTextBytes))} across ${String(corpus?.evidenceRecords ?? 0)} records` : '',
    typeof recordsPerSource?.p50 === 'number' && typeof recordsPerSource?.p95 === 'number'
      ? `chunks per source: p50 ${recordsPerSource.p50}, p95 ${recordsPerSource.p95}, max ${String(recordsPerSource.max ?? 0)}`
      : '',
    finiteBytes(storage?.totalDerivedBytes)
      ? `derived storage: ${formatBytes(Number(storage?.totalDerivedBytes))}${typeof storage?.sourceToDerivedRatio === 'number' ? ` (${storage.sourceToDerivedRatio}x source)` : ''}`
      : '',
    typeof result.retrievalManifestPath === 'string' ? `retrieval build: ${result.retrievalManifestPath}` : '',
  ];
}

function finiteBytes(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function summarizePluginMutation(value: unknown): string[] {
  const result = value as { id?: unknown; version?: unknown; scope?: unknown; path?: unknown; removed?: unknown };
  return [
    `plugin: ${String(result.id ?? '-')}`,
    result.version ? `version: ${String(result.version)}` : '',
    `scope: ${String(result.scope ?? 'local')}`,
    typeof result.removed === 'boolean' ? `removed: ${result.removed ? 'yes' : 'not installed'}` : '',
    typeof result.path === 'string' ? `path: ${result.path}` : '',
  ];
}

export function summarizePluginList(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : [];

  return humanSummary({
    plugins: entries.map((item) => {
      const entry = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      return {
        id: entry.id ?? '-',
        version: entry.version ?? '-',
        scope: entry.scope ?? '-',
        selected: entry.selected ? 'yes' : '',
        status: entry.valid ? 'ready' : 'invalid',
      };
    }),
  });
}

export function summarizePipeline(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const providers = Array.isArray(result.providers) ? result.providers : [];
  const processors = Array.isArray(result.processors) ? result.processors : [];

  return [
    `target: ${String(result.target ?? '-')}`,
    typeof result.root === 'string' ? `context: ${result.root}` : '',
    typeof result.configDigest === 'string' ? `configuration: ${result.configDigest}` : '',
    typeof result.buildDigest === 'string' ? `build: ${result.buildDigest}` : '',
    ...humanSummary({ providers: [...providers, ...processors] }),
  ];
}

export function summarizePipelineSwitch(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const packages = Array.isArray(result.packages) ? result.packages : [];
  const localPreparations = Array.isArray(result.localPreparations) ? result.localPreparations : [];

  return [
    `pipeline: ${String(result.target ?? '-')}`,
    `previous: ${String(result.previousTarget ?? '-')}`,
    typeof result.libraryPath === 'string' ? `library: ${result.libraryPath}` : '',
    typeof result.compatibilityDigest === 'string' ? `compatibility: ${result.compatibilityDigest}` : '',
    ...humanSummary({
      localBuilds: localPreparations.map((value) => {
        const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        return {
          package: item.package ?? '-',
          preparation: item.preparation ?? '-',
          status: 'ready',
        };
      }),
    }),
    ...humanSummary({
      packages: packages.map((value) => {
        const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        return {
          package: item.id ?? '-',
          version: item.version ?? '-',
          source: item.source ?? '-',
          build: item.preparation ?? '-',
          status: 'ready',
        };
      }),
    }),
  ];
}

export function summarizePipelineList(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const targets = Array.isArray(result.targets) ? result.targets : [];
  return [
    typeof result.root === 'string' ? `context: ${result.root}` : '',
    ...humanSummary({
      targets: targets.map((value) => {
        const target = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        return {
          default: target.active ? '*' : '',
          name: target.name ?? '-',
          providers: Array.isArray(target.providers) ? target.providers.join(', ') : '-',
        };
      }),
    }),
  ];
}

export function summarizeBuildList(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const evidence = Array.isArray(result.evidence) ? result.evidence : [];
  const retrieval = Array.isArray(result.retrieval) ? result.retrieval : [];
  const rows: Array<Record<string, unknown>> = [
    ...evidence.map((value) => ({ ...(value as Record<string, unknown>), kind: 'evidence', digest: (value as Record<string, unknown>).evidenceDigest })),
    ...retrieval.map((value) => ({ ...(value as Record<string, unknown>), kind: 'retrieval', digest: (value as Record<string, unknown>).buildDigest })),
  ];
  return [
    typeof result.root === 'string' ? `package: ${result.root}` : '',
    ...humanSummary({
      builds: rows.map((row) => ({
        active: row.active ? '*' : '',
        kind: row.kind,
        profile: shortDigest(row.profileDigest),
        digest: shortDigest(row.digest),
      })),
    }),
  ];
}

export function summarizeBuildInspect(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const lock = result.lock && typeof result.lock === 'object' ? result.lock as Record<string, unknown> : {};
  return [
    `kind: ${String(result.kind ?? '-')}`,
    `status: ${result.active ? 'active' : 'ready'}`,
    typeof result.path === 'string' ? `path: ${result.path}` : '',
    `digest: ${String(lock.evidenceDigest ?? lock.retrievalBuildDigest ?? '-')}`,
  ];
}

export function summarizeBuildPrune(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const removed = Array.isArray(result.removed) ? result.removed : [];
  const retained = Array.isArray(result.retained) ? result.retained : [];
  return [`removed: ${removed.length}`, `retained: ${retained.length}`];
}

function shortDigest(value: unknown): string {
  return typeof value === 'string' && value.startsWith('sha256:') ? `${value.slice(7, 19)}…` : String(value ?? '-');
}

export function summarizePipelineVerification(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const health = Array.isArray(result.health) ? result.health : [];
  const pipeline = result.pipeline && typeof result.pipeline === 'object' ? result.pipeline as Record<string, unknown> : {};

  return [
    `target: ${String(pipeline.target ?? '-')}`,
    ...humanSummary({ providers: health }),
  ];
}

export function summarizeInitResult(value: unknown): string[] {
  const result = value as {
    status?: unknown;
    type?: unknown;
    root?: unknown;
    manifest?: unknown;
    registry?: { url?: unknown; source?: unknown };
    host?: { library?: unknown; inventoryPath?: unknown };
    warning?: unknown;
    retryCommand?: unknown;
  };

  return [
    `status: ${String(result.status ?? 'initialized')}`,
    `type: ${String(result.type ?? 'package')}`,
    typeof result.root === 'string' ? `path: ${result.root}` : '',
    typeof result.manifest === 'string' ? `manifest: ${result.manifest}` : '',
    typeof result.registry?.url === 'string'
      ? `registry: ${result.registry.url} (${String(result.registry.source ?? 'project')})`
      : '',
    result.host?.library ? `host Library: ${String(result.host.library)}` : '',
    result.host?.inventoryPath ? `inventory: ${String(result.host.inventoryPath)}` : '',
    typeof result.warning === 'string' ? `warning: ${result.warning}` : '',
    typeof result.retryCommand === 'string' ? `retry: ${result.retryCommand}` : '',
  ];
}

export function summarizeHostLibraries(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const libraries = Array.isArray(result.libraries) ? result.libraries : [];

  return [
    `inventory: ${String(result.inventoryPath ?? '-')}`,
    `default: ${String(result.selected ?? 'none')}`,
    '',
    ...humanSummary({
      results: libraries.map((value) => {
        const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        return {
          default: item.selected ? '*' : '',
          name: item.name ?? '-',
          status: item.status ?? '-',
          registry: item.registry ?? '-',
          path: item.path ?? '-',
        };
      }),
    }),
  ];
}

export function summarizeHostRegistries(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const registries = Array.isArray(result.registries) ? result.registries : [];

  return [
    `inventory: ${String(result.inventoryPath ?? '-')}`,
    `default: ${String(result.selected ?? 'none')}`,
    `network checks: ${result.checked ? 'enabled' : 'skipped'}`,
    '',
    ...humanSummary({
      results: registries.map((value) => {
        const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        return {
          default: item.selected ? '*' : '',
          name: item.name ?? '-',
          status: item.status ?? '-',
          usedBy: Array.isArray(item.usedBy) && item.usedBy.length > 0 ? item.usedBy.join(', ') : '-',
          url: item.url ?? '-',
        };
      }),
    }),
  ];
}

export function summarizeHostRuntimes(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const runtimes = Array.isArray(result.runtimes) ? result.runtimes : [];

  return [
    `inventory: ${String(result.inventoryPath ?? '-')}`,
    `default: ${String(result.selected ?? 'none')}`,
    `network checks: ${result.checked ? 'enabled' : 'skipped'}`,
    '',
    ...humanSummary({
      results: runtimes.map((value) => {
        const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        return {
          default: item.selected ? '*' : '',
          name: item.name ?? '-',
          kind: item.kind ?? '-',
          status: item.status ?? '-',
          library: item.library ?? '-',
          url: item.url ?? '-',
        };
      }),
    }),
  ];
}

export function summarizeHostMutation(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const library = result.library && typeof result.library === 'object' ? result.library as Record<string, unknown> : {};
  const registry = result.registry && typeof result.registry === 'object' ? result.registry as Record<string, unknown> : {};
  const runtime = result.runtime && typeof result.runtime === 'object' ? result.runtime as Record<string, unknown> : {};

  return [
    `status: ${String(result.status ?? 'updated')}`,
    result.name ? `name: ${String(result.name)}` : '',
    library.displayName ? `Library: ${String(library.displayName)}` : '',
    library.path ? `path: ${String(library.path)}` : '',
    library.registry ? `registry: ${String(library.registry)}` : '',
    registry.url ? `registry: ${String(registry.url)}` : '',
    runtime.kind ? `kind: ${String(runtime.kind)}` : '',
    runtime.library ? `Library: ${String(runtime.library)}` : '',
    runtime.url ? `URL: ${String(runtime.url)}` : '',
    result.path && !library.path ? `path: ${String(result.path)}` : '',
    result.url && !registry.url && !runtime.url ? `URL: ${String(result.url)}` : '',
    result.composeFile ? `compose file: ${String(result.composeFile)}` : '',
    typeof result.selectedCleared === 'boolean' ? `default cleared: ${result.selectedCleared ? 'yes' : 'no'}` : '',
    result.inventoryPath ? `inventory: ${String(result.inventoryPath)}` : '',
    result.warning ? `warning: ${String(result.warning)}` : '',
    result.retryCommand ? `retry: ${String(result.retryCommand)}` : '',
  ].filter(Boolean);
}

export function summarizeLibrarySync(value: unknown): string[] {
  const result = value as { status?: unknown; lock?: { generation?: unknown; entries?: Record<string, unknown> } };
  const count = Object.keys(result.lock?.entries ?? {}).length;
  return [
    `status: ${String(result.status ?? 'synchronized')}`,
    `generation: ${String(result.lock?.generation ?? '-')}`,
    `active entries: ${count}`,
  ];
}

export function summarizeCollectionMutation(value: unknown): string[] {
  const result = value as {
    identity?: unknown;
    collectionIdentity?: unknown;
    dkbIdentity?: unknown;
    selector?: unknown;
    status?: unknown;
    root?: unknown;
  };
  return [
    `status: ${String(result.status ?? 'updated')}`,
    result.identity ? `collection: ${String(result.identity)}` : '',
    result.collectionIdentity ? `collection: ${String(result.collectionIdentity)}` : '',
    result.dkbIdentity ? `DKB: ${String(result.dkbIdentity)}${result.selector ? `@${String(result.selector)}` : ''}` : '',
    result.root ? `path: ${String(result.root)}` : '',
  ];
}

export function summarizeCollectionOverview(value: unknown): string[] {
  const result = value as {
    identity?: unknown;
    displayName?: unknown;
    active?: unknown;
    members?: Array<{ identity?: unknown; selector?: unknown }>;
  };
  const members = result.members ?? [];
  const tree = members.length === 0
    ? ['(none)']
    : members.map((member, index) => `${index === members.length - 1 ? '└──' : '├──'} ${String(member.identity ?? '-')}@${String(member.selector ?? 'latest')}`);
  return [
    String(result.identity ?? '-'),
    `name: ${String(result.displayName ?? '-')}`,
    `status: ${result.active ? 'active' : 'inactive'}`,
    ...tree,
  ];
}

export function summarizeCollectionRevision(value: unknown): string[] {
  const result = value as {
    collectionId?: unknown;
    revision?: unknown;
    digest?: unknown;
    manifest?: { members?: unknown[] };
  };
  return [
    'status: published',
    `collection: ${String(result.collectionId ?? '-')}`,
    `revision: r${String(result.revision ?? '-')}`,
    `members: ${String(result.manifest?.members?.length ?? 0)}`,
    typeof result.digest === 'string' ? `digest: ${result.digest}` : '',
  ];
}

export function summarizeCollectionInstall(value: unknown): string[] {
  const result = value as {
    status?: unknown;
    collectionId?: unknown;
    revision?: unknown;
    members?: unknown[];
    libraryRoot?: unknown;
  };
  return [
    `status: ${humanStatus(result.status ?? 'installed')}`,
    `collection: ${String(result.collectionId ?? '-')}`,
    `revision: r${String(result.revision ?? '-')}`,
    `members: ${String(result.members?.length ?? 0)}`,
    typeof result.libraryRoot === 'string' ? `library: ${result.libraryRoot}` : '',
  ];
}

export function summarizeCollectionUninstall(value: unknown): string[] {
  const result = value as {
    status?: unknown;
    collectionId?: unknown;
    removedDkbs?: unknown[];
    libraryRoot?: unknown;
  };
  return [
    `status: ${humanStatus(result.status ?? 'removed')}`,
    `collection: ${String(result.collectionId ?? '-')}`,
    `pruned DKBs: ${String(result.removedDkbs?.length ?? 0)}`,
    typeof result.libraryRoot === 'string' ? `library: ${result.libraryRoot}` : '',
  ];
}

export function summarizeLibraryOverview(value: unknown): string[] {
  const result = value as {
    root?: unknown;
    name?: unknown;
    registryUrl?: unknown;
    generation?: unknown;
    entries?: Array<Record<string, unknown>>;
    counts?: Record<string, unknown>;
  };
  const entries = (result.entries ?? []).map((entry) => ({
    identity: entry.identity ?? '-',
    kind: entry.kind ?? '-',
    source: entry.source ?? '-',
    version: entry.version ?? '-',
    status: entry.status ?? '-',
  }));
  return [
    `library: ${String(result.name ?? '-')}`,
    typeof result.root === 'string' ? `path: ${result.root}` : '',
    `registry: ${String(result.registryUrl ?? 'not configured')}`,
    `generation: ${String(result.generation ?? 0)}`,
    `installed: ${String(result.counts?.installed ?? 0)}, inactive: ${String(result.counts?.inactive ?? 0)}, broken: ${String(result.counts?.broken ?? 0)}, untracked: ${String(result.counts?.untracked ?? 0)}`,
    ...humanSummary({ packages: entries }),
  ];
}

export function summarizeLibraryStorage(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const packages = Array.isArray(result.packages)
    ? result.packages.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];

  return [
    typeof result.libraryRoot === 'string' ? `library: ${result.libraryRoot}` : '',
    `total: ${formatBytes(Number(result.totalBytes ?? 0))}`,
    `library state: ${formatBytes(Number(result.libraryStateBytes ?? 0))}`,
    '',
    ...humanSummary({ packages: packages.map((entry) => ({
      id: entry.id ?? '-',
      source: entry.source ?? '-',
      knowledge: formatBytes(Number(entry.sourceBytes ?? 0)),
      builds: formatBytes(Number(entry.buildBytes ?? 0)),
      generated: formatBytes(Number(entry.otherGeneratedBytes ?? 0)),
      total: formatBytes(Number(entry.totalBytes ?? 0)),
    })) }),
  ];
}

export function summarizeRegistryConfiguration(value: unknown): string[] {
  const result = value as {
    status?: unknown;
    registry?: { url?: unknown; source?: unknown };
    verification?: { ok?: unknown };
    warning?: unknown;
    retryCommand?: unknown;
  };

  return [
    `status: ${String(result.status ?? 'configured')}`,
    typeof result.registry?.url === 'string'
      ? `registry: ${result.registry.url} (${String(result.registry.source ?? 'project')})`
      : '',
    result.verification ? `verification: ${result.verification.ok ? 'passed' : 'failed'}` : 'verification: skipped',
    typeof result.warning === 'string' ? `warning: ${result.warning}` : '',
    typeof result.retryCommand === 'string' ? `retry: ${result.retryCommand}` : '',
  ];
}

export function summarizeRegistryStatus(value: unknown): string[] {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const registry = result.registry && typeof result.registry === 'object' ? result.registry as Record<string, unknown> : {};
  const verification = result.verification && typeof result.verification === 'object'
    ? result.verification as Record<string, unknown>
    : {};
  const checks = Array.isArray(verification.checks)
    ? verification.checks.map((value) => {
      const check = value && typeof value === 'object' ? value as Record<string, unknown> : {};

      return {
        name: check.name ?? '-',
        ok: check.ok === true,
        impact: check.required === false ? 'OPTIONAL' : 'BLOCKING',
        ...(check.status === undefined ? {} : { status: check.status }),
        ...(check.message === undefined ? {} : { message: check.message }),
      };
    })
    : [];

  return [
    `registry: ${String(registry.url ?? '-')}`,
    `source: ${String(registry.source ?? '-')}`,
    `status: ${verification.ok === true ? 'OK' : 'FAILED'}`,
    '',
    ...humanSummary({ checks }),
  ];
}

export function summarizeInstalledPackages(value: unknown): string[] {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const packages = Array.isArray(record.packages) ? record.packages : [];

  return [
    typeof record.libraryRoot === 'string' ? `library: ${record.libraryRoot}` : '',
    typeof record.registryUrl === 'string'
      ? `registry: ${record.registryUrl}${record.registrySource ? ` (${String(record.registrySource)})` : ''}`
      : '',
    ...humanSummary({ packages: packages.map((item) => {
      const entry = item && typeof item === 'object' ? item as Record<string, unknown> : {};

      return {
        id: entry.id ?? '-',
        version: entry.version ?? '-',
        status: entry.status ?? '-',
        records: entry.recordCount ?? '-',
      };
    }) }),
  ];
}

export function summarizeKeyListing(value: unknown): string[] {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const items = Array.isArray(record.keys) ? record.keys : [];
  const keys = items
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      id: item.id ?? '-',
      role: item.subjectType ?? item.role ?? '-',
      subject: item.subjectId ?? '-',
      status: item.status ?? '-',
      fingerprint: item.publicKeyFingerprint ?? item.fingerprint ?? '-',
    }));

  return humanSummary({ results: keys });
}

export function summarizeRetrievalResult(value: unknown): string[] {
  const outer = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const response = outer.response && typeof outer.response === 'object'
    ? outer.response as Record<string, unknown>
    : outer;
  const sufficiency = response.sufficiency && typeof response.sufficiency === 'object'
    ? response.sufficiency as Record<string, unknown>
    : {};
  const evidence = Array.isArray(response.evidence)
    ? response.evidence.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
  const lines = [
    `status: ${humanStatus(response.status ?? 'unknown')}`,
    `evidence: ${evidence.length} ${evidence.length === 1 ? 'item' : 'items'}`,
    sufficiency.reason ? `sufficiency: ${humanStatus(sufficiency.reason)}` : '',
    typeof sufficiency.confidence === 'number' ? `confidence: ${(sufficiency.confidence * 100).toFixed(1)}%` : '',
  ];

  for (const [index, item] of evidence.entries()) {
    const source = item.source && typeof item.source === 'object' ? item.source as Record<string, unknown> : {};
    const locator = source.locator && typeof source.locator === 'object'
      ? source.locator as Record<string, unknown>
      : {};
    const citation = source.evidenceId ?? source.chunkId ?? `${index + 1}`;
    const location = typeof locator.path === 'string'
      ? `${locator.path}${locator.line ? `:${String(locator.line)}` : ''}`
      : Object.keys(locator).length > 0
        ? JSON.stringify(locator)
        : '-';
    const text = typeof item.text === 'string'
      ? item.text
      : item.value !== undefined
        ? JSON.stringify(item.value)
        : item.rows !== undefined
          ? JSON.stringify(item.rows)
          : '';

    lines.push(
      '',
      `[${String(citation)}] ${String(item.label ?? 'Evidence')}`,
      `  Package: ${String(source.dkbId ?? '-')}${source.packageVersion ? `@${String(source.packageVersion)}` : ''}`,
      `  Source: ${location}`,
      ...clipText(text, 800).split('\n').map((line) => `  ${line}`),
    );
  }

  return lines;
}

export function summarizeQueryResult(value: unknown): string[] {
  const response = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const items = Array.isArray(response.results)
    ? response.results.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
  const results = items.map((item) => ({
    score: typeof item.score === 'number' ? item.score.toFixed(4) : '-',
    package: item.dkbId ?? '-',
    id: item.id ?? '-',
    title: item.title ?? '-',
    source: item.source ?? '-',
  }));

  return [
    typeof response.query === 'string' ? `query: ${response.query}` : '',
    `results: ${results.length}`,
    '',
    ...humanSummary({ results }),
  ];
}

function clipText(value: string, maximum: number): string {
  const compact = value.trim();

  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 1).trimEnd()}…`;
}

export function summarizeStackStatus(value: unknown): string[] {
  const stack = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const services = Array.isArray(stack.services)
    ? stack.services.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
  const checks = Array.isArray(stack.checks)
    ? stack.checks.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];

  return [
    `stack: ${String(stack.name ?? 'local')}`,
    stack.status ? `status: ${humanStatus(stack.status)}` : '',
    stack.target ? `target: ${String(stack.target)}` : '',
    stack.runtimeTarget && stack.runtimeTarget !== stack.target
      ? `runtime target: ${String(stack.runtimeTarget)}`
      : '',
    stack.registryUrl ? `registry: ${String(stack.registryUrl)}` : '',
    stack.runtimeUrl ? `runtime: ${String(stack.runtimeUrl)}` : '',
    stack.stateRoot ? `state: ${String(stack.stateRoot)}` : '',
    ...(services.length > 0 ? [
      '',
      ...humanSummary({ results: services.map((service) => ({
        service: service.name ?? '-',
        status: humanStatus(service.status ?? '-').toUpperCase(),
        health: humanStatus(service.health ?? '-').toUpperCase(),
      })) }),
    ] : []),
    ...(checks.length > 0 ? [
      '',
      ...humanSummary({ results: checks.map((check) => ({
        component: stackComponentLabel(check.component),
        status: humanStatus(check.status ?? '-').toUpperCase(),
        message: check.message ?? '-',
      })) }),
    ] : []),
  ];
}

function stackComponentLabel(value: unknown): string {
  switch (String(value)) {
    case 'registry-web': return 'Registry';
    case 'dkb-runtime': return 'Runtime';
    case 'dkb-tei': return 'TEI';
    case 'dkb-embedder': return 'FastEmbed';
    case 'dkb-faiss': return 'FAISS';
    case 'meilisearch': return 'Meilisearch';
    case 'docker': return 'Docker';
    case 'compose': return 'Compose';
    case 'secrets': return 'Secrets';
    default: return String(value ?? '-').split(/[-_]/u)
      .filter(Boolean)
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join(' ');
  }
}

export function summarizeCompilerStatus(value: unknown): string[] {
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

export function summarizeInstallResult(value: unknown): string[] {
  const result = value as {
    status?: unknown;
    id?: unknown;
    packageId?: unknown;
    version?: unknown;
    catalog?: { recordCount?: unknown; packageCount?: unknown };
    search?: { upsert?: { documentCount?: unknown; timingsMs?: { total?: unknown } } };
    packagePath?: unknown;
    warning?: unknown;
    cleanupPath?: unknown;
  };

  return [
    `status: ${humanStatus(result.status ?? 'ok')}`,
    `package: ${String(result.packageId ?? result.id ?? 'unknown')}${result.version ? `@${String(result.version)}` : ''}`,
    countLabel(result.catalog?.recordCount ?? result.search?.upsert?.documentCount, 'record') ?? '',
    countLabel(result.catalog?.packageCount, 'package') ?? '',
    milliseconds(result.search?.upsert?.timingsMs?.total) ? `search activation: ${milliseconds(result.search?.upsert?.timingsMs?.total)}` : '',
    typeof result.packagePath === 'string' ? `path: ${result.packagePath}` : '',
    typeof result.warning === 'string' ? `warning: ${result.warning}` : '',
    typeof result.cleanupPath === 'string' ? `cleanup path: ${result.cleanupPath}` : '',
  ];
}

export function summarizeRemoveResult(value: unknown): string[] {
  const result = value as { status?: unknown; id?: unknown; libraryPath?: unknown; warning?: unknown };

  return [
    `status: ${humanStatus(result.status ?? 'ok')}`,
    `package: ${String(result.id ?? 'unknown')}`,
    typeof result.libraryPath === 'string' ? `library: ${result.libraryPath}` : '',
    typeof result.warning === 'string' ? `warning: ${result.warning}` : '',
  ];
}

export function summarizePublishResult(value: unknown): string[] {
  const result = value as {
    status?: unknown;
    packageId?: unknown;
    version?: unknown;
    archivePath?: unknown;
    compiled?: { recordCount?: unknown };
    receipt?: { packageId?: unknown; version?: unknown };
    warning?: unknown;
    retryCommand?: unknown;
  };
  const packageId = result.packageId ?? result.receipt?.packageId;
  const version = result.version ?? result.receipt?.version;

  return [
    `status: ${humanStatus(result.status ?? 'published')}`,
    `package: ${String(packageId ?? 'unknown')}${version ? `@${String(version)}` : ''}`,
    countLabel(result.compiled?.recordCount, 'record') ?? '',
    typeof result.archivePath === 'string' ? `archive: ${result.archivePath}` : '',
    typeof result.warning === 'string' ? `warning: ${result.warning}` : '',
    typeof result.retryCommand === 'string' ? `retry: ${result.retryCommand}` : '',
  ];
}

export function summarizeArtifactTransport(value: unknown): string[] {
  const result = value as {
    status?: unknown;
    archivePath?: unknown;
    outputDir?: unknown;
    ref?: unknown;
    digest?: unknown;
    archiveBytes?: unknown;
    packageId?: unknown;
    version?: unknown;
    registry?: unknown;
    warning?: unknown;
    retryCommand?: unknown;
    cleanupPath?: unknown;
  };

  return [
    `status: ${humanStatus(result.status ?? 'ok')}`,
    typeof result.packageId === 'string' ? `package: ${result.packageId}${result.version ? `@${String(result.version)}` : ''}` : '',
    typeof result.ref === 'string' ? `ref: ${result.ref}` : '',
    typeof result.digest === 'string' ? `digest: ${result.digest}` : '',
    typeof result.archivePath === 'string' ? `archive: ${result.archivePath}` : '',
    typeof result.outputDir === 'string' ? `output: ${result.outputDir}` : '',
    typeof result.registry === 'string' ? `registry: ${result.registry}` : '',
    typeof result.archiveBytes === 'number' ? `size: ${result.archiveBytes} bytes` : '',
    typeof result.warning === 'string' ? `warning: ${result.warning}` : '',
    typeof result.retryCommand === 'string' ? `retry: ${result.retryCommand}` : '',
    typeof result.cleanupPath === 'string' ? `cleanup path: ${result.cleanupPath}` : '',
  ];
}
function humanStatus(value: unknown): string {
  return String(value).replace(/_/g, ' ');
}
