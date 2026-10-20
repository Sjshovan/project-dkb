import { formatBytes, humanSummary } from './presentation.js';

export function summarizePackageListing(value: unknown): string[] {
  const record = isRecord(value) ? value : {};
  const items = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.packages)
      ? record.packages
      : [];
  const packages = items.filter(isRecord).map((item) => ({
    id: item.id ?? item.packageId ?? '-',
    version: item.latestVersion ?? item.version ?? '-',
    visibility: item.visibility ?? '-',
    name: item.name ?? '-',
  }));

  return [
    typeof record.registryUrl === 'string' ? `registry: ${record.registryUrl}` : '',
    ...humanSummary({ packages }),
  ];
}

export function summarizeRegistryCatalog(value: unknown): string[] {
  const record = isRecord(value) ? value : {};
  const entries = Array.isArray(record.entries) ? record.entries.filter(isRecord) : [];
  return [
    typeof record.registryUrl === 'string' ? `registry: ${record.registryUrl}` : '',
    ...humanSummary({
      entries: entries.map((entry) => ({
        type: String(entry.type ?? '-').toUpperCase(),
        id: entry.id ?? '-',
        release: entry.latestVersion ?? (typeof entry.latestRevision === 'number' ? `r${entry.latestRevision}` : '-'),
        visibility: entry.visibility ?? '-',
        name: entry.name ?? '-',
      })),
    }),
  ];
}

export function summarizeRegistryEntry(value: unknown): string[] {
  const record = isRecord(value) ? value : {};
  const entry = isRecord(record.entry) ? record.entry : {};
  if (record.type === 'collection') {
    const revision = isRecord(record.selectedRevision) ? record.selectedRevision : {};
    const manifest = isRecord(revision.manifest) ? revision.manifest : {};
    return [
      `collection: ${String(entry.id ?? '-')}`,
      entry.description ? `description: ${String(entry.description)}` : '',
      `visibility: ${String(entry.visibility ?? '-')}`,
      `revision: r${String(revision.revision ?? '-')}`,
      `digest: ${String(revision.digest ?? '-')}`,
      ...humanSummary({ members: Array.isArray(manifest.members) ? manifest.members : [] }),
    ];
  }
  const release = isRecord(record.selectedVersion) ? record.selectedVersion : {};
  return [
    `DKB: ${String(entry.id ?? '-')}`,
    entry.description ? `description: ${String(entry.description)}` : '',
    `visibility: ${String(entry.visibility ?? '-')}`,
    `version: ${String(release.version ?? '-')}`,
    `status: ${String(release.status ?? '-')}`,
    `receipt: ${String(release.receiptHash ?? '-')}`,
    `source: ${String(release.sourceHash ?? '-')}`,
    `records: ${String(release.recordCount ?? 0)}`,
    `default target: ${String(release.defaultTarget ?? '-')}`,
    ...humanSummary({ builds: Array.isArray(release.builds) ? release.builds : [] }),
  ];
}

export function summarizeRegistryContents(value: unknown): string[] {
  const record = isRecord(value) ? value : {};
  const inventory = isRecord(record.sourceInventory) ? record.sourceInventory : {};
  const entries = Array.isArray(record.entries) ? record.entries.filter(isRecord) : [];
  return [
    `package: ${String(record.packageId ?? '-')}`,
    `version: ${String(record.version ?? '-')}`,
    `inventory: ${String(inventory.hash ?? '-')}`,
    `files: ${String(inventory.count ?? entries.length)}`,
    typeof inventory.bytes === 'number' ? `inventory size: ${formatBytes(inventory.bytes)}` : '',
    ...humanSummary({
      entries: entries.map((entry) => ({
        path: entry.path ?? '-',
        size: typeof entry.bytes === 'number' ? formatBytes(entry.bytes) : '-',
        hash: typeof entry.hash === 'string' ? shortDigest(entry.hash) : '-',
      })),
    }),
    record.nextCursor ? `next cursor: ${String(record.nextCursor)}` : '',
  ];
}

export function summarizeRegistryPipelines(value: unknown): string[] {
  const record = isRecord(value) ? value : {};
  const pipelines = Array.isArray(record.pipelines) ? record.pipelines.filter(isRecord) : [];
  return [
    `default Pipeline: ${String(record.default ?? '-')}`,
    ...humanSummary({
      pipelines: pipelines.map((pipeline) => ({
        name: pipeline.name ?? '-',
        default: pipeline.default === true ? 'YES' : '',
        status: pipeline.available === true ? 'AVAILABLE' : 'UNAVAILABLE',
        providers: Array.isArray(pipeline.providers)
          ? pipeline.providers.filter(isRecord).map((provider) => provider.id).join(' -> ')
          : '-',
        services: Array.isArray(pipeline.requiredServices) && pipeline.requiredServices.length > 0
          ? pipeline.requiredServices.join(', ')
          : pipeline.resolutionError ? 'not resolved' : 'none',
      })),
    }),
  ];
}

export function summarizeRegistryPipeline(value: unknown): string[] {
  const pipeline = isRecord(value) ? value : {};
  return [
    `Pipeline: ${String(pipeline.name ?? '-')}${pipeline.default === true ? ' (default)' : ''}`,
    `status: ${pipeline.available === true ? 'available' : 'unavailable'}`,
    ...(isRecord(pipeline.resolutionError) ? [`Recovery: ${String(pipeline.resolutionError.message)}`] : []),
    `Evidence Profile: ${String(pipeline.evidenceProfileDigest ?? '-')}`,
    `Retrieval Profile: ${String(pipeline.retrievalProfileDigest ?? '-')}`,
    `compatibility: ${String(pipeline.compatibilityDigest ?? '-')}`,
    `compiler build: ${String(pipeline.buildDigest ?? '-')}`,
    `required services: ${Array.isArray(pipeline.requiredServices) && pipeline.requiredServices.length > 0 ? pipeline.requiredServices.join(', ') : pipeline.resolutionError ? 'not resolved' : 'none'}`,
    ...humanSummary({ providers: Array.isArray(pipeline.providers) ? pipeline.providers : [] }),
    ...humanSummary({ processors: Array.isArray(pipeline.processors) ? pipeline.processors : [] }),
  ];
}

export function summarizeRegistryBuildRequest(value: unknown): string[] {
  const record = isRecord(value) ? value : {};
  return [
    `package: ${String(record.packageId ?? '-')}`,
    `version: ${String(record.version ?? '-')}`,
    `Pipeline: ${String(record.target ?? '-')}`,
    `status: ${String(record.status ?? '-')}`,
    record.evidenceDigest ? `Evidence: ${String(record.evidenceDigest)}` : '',
    record.jobId ? `job: ${String(record.jobId)}` : '',
    record.warning ? `Warning: ${String(record.warning)}` : '',
    record.retryCommand ? `Retry: ${String(record.retryCommand)}` : '',
  ];
}

function shortDigest(value: string): string {
  return value.length > 20 ? `${value.slice(0, 18)}…` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
