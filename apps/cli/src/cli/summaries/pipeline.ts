import { countLabel, formatBytes, humanSummary, milliseconds } from '../presentation.js';

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
