import { formatBytes, humanSummary } from '../presentation.js';
import { humanStatus } from './utils.js';

export function summarizeLibrarySync(value: unknown): string[] {
  const result = value as { status?: unknown; warning?: string; lock?: { generation?: unknown; entries?: Record<string, unknown> } };
  const count = Object.keys(result.lock?.entries ?? {}).length;
  return [
    `status: ${String(result.status ?? 'synchronized')}`,
    `generation: ${String(result.lock?.generation ?? '-')}`,
    `active entries: ${count}`,
    ...(result.warning ? [`warning: ${result.warning}`] : []),
  ];
}

export function summarizeLibraryRecovery(value: unknown): string[] {
  const result = value as { status: string; libraryPath: string; transactionId?: string; warning?: string };
  return [
    `status: ${humanStatus(result.status)}`,
    `path: ${result.libraryPath}`,
    ...(result.transactionId ? [`transaction: ${result.transactionId}`] : []),
    ...(result.warning ? [`warning: ${result.warning}`] : []),
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
    warning?: string;
  };
  return [
    `status: ${String(result.status ?? 'updated')}`,
    result.identity ? `collection: ${String(result.identity)}` : '',
    result.collectionIdentity ? `collection: ${String(result.collectionIdentity)}` : '',
    result.dkbIdentity ? `DKB: ${String(result.dkbIdentity)}${result.selector ? `@${String(result.selector)}` : ''}` : '',
    result.root ? `path: ${String(result.root)}` : '',
    ...(result.warning ? [`warning: ${result.warning}`] : []),
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
